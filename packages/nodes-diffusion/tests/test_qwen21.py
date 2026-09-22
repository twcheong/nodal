"""Guard reference identity, RGBA output, cancellation, and MCP graph routing."""

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from nodal import CancelToken, Failure, NodeContext, RecordingEventSink
from nodal.models import Device, DevicePlan
from nodal_nodes_diffusion import qwen21, registry


@pytest.fixture
def model(tmp_path):
    (tmp_path / "model_index.json").write_text('{"_class_name":"QwenImage21Pipeline"}')
    for name in ("processor", "scheduler", "text_encoder", "transformer", "vae"):
        (tmp_path / name).mkdir()
    return tmp_path


def context(token=None):
    return NodeContext(
        "qwen",
        "test",
        RecordingEventSink(),
        token or CancelToken(),
        models=SimpleNamespace(plan=DevicePlan(Device("cuda", 0))),
    )


def arguments(model, **updates):
    return (
        dict(
            model_path=str(model),
            prompt="A blue teapot",
            width=512,
            height=512,
            steps=2,
            seed=42,
            reference_resolution=512,
            memory_profile="group_offload",
            ctx=context(),
        )
        | updates
    )


def test_local_only_model_validation(model, monkeypatch):
    monkeypatch.setenv(qwen21.MODEL_ENV, str(model))
    assert qwen21.model_directory("") == model
    (model / "model_index.json").write_text('{"_class_name":"QwenImageEditPlusPipeline"}')
    with pytest.raises(ValueError, match=r"Qwen-Image-2\.1"):
        qwen21.model_directory(str(model))


@pytest.mark.parametrize(
    "socket,value",
    [
        ("width", 513),
        ("height", 0),
        ("reference_resolution", 300),
        ("steps", 101),
        ("prompt", " "),
        ("memory_profile", "invalid"),
    ],
)
def test_inputs_fail_before_model_loading(model, socket, value):
    result = qwen21.QwenImage21().run(**arguments(model, **{socket: value}))
    assert isinstance(result, Failure)
    assert result.socket == socket


def test_reference_alpha_order_and_batches():
    np = pytest.importorskip("numpy")
    rgba = np.zeros((1, 32, 32, 4), dtype=np.float32)
    rgba[..., 0] = 1
    images, hashes = qwen21.reference_images((rgba, rgba + 0.25))
    assert images[0].mode == "RGBA"
    assert images[0].getpixel((0, 0)) == (255, 0, 0, 0)
    assert hashes[0] != hashes[1]
    with pytest.raises(ValueError, match="reference_2"):
        qwen21.reference_images((None, rgba))
    with pytest.raises(ValueError, match="B=1"):
        qwen21.reference_images((np.zeros((2, 32, 32, 3)),))
    with pytest.raises(ValueError, match="reference_1"):
        qwen21.reference_images((rgba * float("nan"),))


@pytest.fixture
def fake_pipeline(monkeypatch):
    pytest.importorskip("torch")
    PIL = pytest.importorskip("PIL.Image")
    calls = {}

    class Pipe:
        def __call__(self, **kwargs):
            calls.update(kwargs)
            kwargs["callback_on_step_end"](self, 0, None, {})
            return SimpleNamespace(images=[PIL.new("RGBA", (32, 32), (30, 60, 90, 128))])

    @contextmanager
    def pipeline(*args):
        try:
            yield Pipe()
        finally:
            calls["released"] = True

    monkeypatch.setattr(qwen21, "pipeline", pipeline)
    monkeypatch.setattr(qwen21.importlib.metadata, "version", lambda _: "test")
    return calls


def test_generate_preserves_alpha_seed_and_provenance(model, fake_pipeline):
    np = pytest.importorskip("numpy")
    result = qwen21.QwenImage21().run(**arguments(model))
    assert not isinstance(result, Failure)
    array, metadata = result.values
    assert array.shape == (1, 32, 32, 4)
    assert array.dtype == np.float32
    assert array[0, 0, 0, 3] == pytest.approx(128 / 255)
    assert json.loads(metadata)["run_id"] == "test"
    assert fake_pipeline["generator"].initial_seed() == 42
    assert fake_pipeline["image"] is None
    assert fake_pipeline["released"]


def test_cancel_during_step_releases_pipeline(model, fake_pipeline):
    from nodal.events import Cancelled

    token = CancelToken()

    class Sink:
        def emit(self, event):
            if getattr(event, "step", 0) == 1:
                token.cancel()

    ctx = NodeContext("qwen", "cancel", Sink(), token, models=context().models)
    with pytest.raises(Cancelled):
        qwen21.QwenImage21().run(**arguments(model, ctx=ctx))
    assert fake_pipeline["released"]


def test_registry_and_mcp_templates():
    from nodal_nodes_image import registry as image_registry
    from nodal_server.templates import build_call_graph, load_catalog

    nodes = image_registry(registry())
    schema = next(s for s in nodes if s.id == "diffusion.QwenImage21")
    assert schema.inputs["reference_10"].default is None
    root = Path(__file__).resolve().parents[3] / "examples" / "templates"
    catalog = load_catalog(root)
    assert not [r for r in catalog.rejections if "qwen21" in r.path.name]
    template = catalog.get("qwen21_edit")
    assert template is not None
    graph = build_call_graph(template, {"prompt": "Make it blue", "reference_1": "asset:abc"})
    assert any(n.type == "image.LoadAsset" for n in graph.nodes.values())
