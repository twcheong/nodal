"""H3 wiring and real container checks; these do not assert GPU inference quality."""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from nodal import CancelToken, Failure, NodeContext, RecordingEventSink
from nodal.models import Device, DevicePlan
from nodal_nodes_diffusion import h3, registry
from nodal_server.assets import AssetStore


@pytest.fixture
def model(tmp_path):
    (tmp_path / "modular_model_index.json").write_text(
        '{"_class_name": "MiniMaxH3ModularPipeline"}'
    )
    for name in (
        "transformer",
        "text_encoder",
        "tokenizer",
        "vae",
        "audio_vae",
        "scheduler",
        "audio_scheduler",
    ):
        (tmp_path / name).mkdir()
    return tmp_path


def test_local_models_only(tmp_path, model, monkeypatch):
    monkeypatch.setenv("NODAL_H3_MODEL", str(model))
    assert h3.model_directory("") == model.resolve()
    with pytest.raises(ValueError, match="modular_model_index"):
        h3.model_directory(str(tmp_path / "missing"))
    (model / "audio_vae").rmdir()
    with pytest.raises(ValueError, match="audio_vae"):
        h3.model_directory(str(model))


def test_schema_and_optional_frames():
    schema = next(s for s in registry() if s.id == "diffusion.MiniMaxH3")
    assert schema.output_node and not schema.cacheable
    assert schema.inputs["first_frame"].default is None
    assert schema.inputs["last_frame"].default is None
    for name in ("reference_1", "reference_2", "reference_3"):
        assert schema.inputs[name].default is None
    assert schema.inputs["reference_short_edge"].default == 2048
    assert schema.inputs["seed"].widget["seed"] is True
    assert schema.inputs["seed"].widget["control"] == "fixed"
    assert "video" in schema.outputs


def context():
    return NodeContext(
        "h3",
        "test",
        RecordingEventSink(),
        CancelToken(),
        assets=AssetStore(),
        models=SimpleNamespace(plan=DevicePlan(Device("cuda", 0))),
    )


def arguments(model, **updates):
    return (
        dict(
            model_path=str(model),
            prompt="A cat.",
            first_frame=None,
            last_frame=None,
            width=960,
            height=544,
            num_frames=124,
            steps=3,
            seed=7,
            memory_profile="bf16_offload",
            ctx=context(),
        )
        | updates
    )


@pytest.mark.parametrize(
    "socket,value",
    [
        ("width", 961),
        ("height", 33),
        ("num_frames", 125),
        ("num_frames", 362),
        ("steps", 1),
        ("prompt", " "),
        ("memory_profile", "unknown"),
        ("reference_short_edge", 767),
        ("reference_short_edge", 2080),
    ],
)
def test_invalid_inputs_fail_before_loading(model, socket, value):
    outcome = h3.MiniMaxH3().run(**arguments(model, **{socket: value}))
    assert isinstance(outcome, Failure)
    assert outcome.socket == socket


def test_keyframes_reject_batches():
    np = pytest.importorskip("numpy")
    with pytest.raises(ValueError, match="B=1"):
        h3._keyframe(np.zeros((2, 32, 32, 3), dtype=np.float32))
    assert h3._keyframe(np.ones((1, 32, 64, 4), dtype=np.float32)).size == (64, 32)


@pytest.fixture
def fake_inference(monkeypatch):
    torch = pytest.importorskip("torch")
    pytest.importorskip("diffusers")
    from PIL import Image

    calls = {}

    class Pipe:
        def __init__(self):
            self.transformer = torch.nn.Identity()
            self.transformer_ref = self.transformer

        def update_components(self, **kwargs):
            calls["config"] = kwargs

        def __call__(self, **kwargs):
            calls["grad_enabled"] = torch.is_grad_enabled()
            calls["inference_mode"] = torch.is_inference_mode_enabled()
            calls["inputs"] = kwargs
            for _ in range(kwargs["num_inference_steps"] - 1):
                self.transformer(torch.zeros(1))
            return {
                "videos": [[Image.new("RGB", (32, 32))] * 24],
                "audio": torch.zeros((1, 2, 32000)),
                "sampling_rate": 32000,
            }

    @contextmanager
    def pipeline(root, workflow, profile, ctx):
        calls["workflow"] = workflow
        pipe = Pipe()
        calls["pipe"] = pipe
        try:
            yield pipe
        finally:
            calls["released"] = True

    def encode(path, frames, audio, sampling_rate, **kwargs):
        kwargs["check_cancelled"]()
        path.write_bytes(b"webm-test")
        calls["audio_shape"] = audio.shape

    monkeypatch.setattr(h3, "_pipeline", pipeline)
    monkeypatch.setattr(h3, "require_video_runtime", lambda: None)
    monkeypatch.setattr(h3, "encode_webm", encode)
    return calls


@pytest.mark.parametrize("keyframe", [False, True])
def test_generation_routes_inputs_and_stores_asset(model, fake_inference, keyframe):
    np = pytest.importorskip("numpy")
    args = arguments(model, first_frame=np.zeros((1, 32, 32, 3)) if keyframe else None)
    result = h3.MiniMaxH3().run(**args)
    assert not isinstance(result, Failure)
    asset = result.values[0]
    assert asset.media_type == "video/webm"
    assert fake_inference["workflow"] == ("fl2va" if keyframe else "t2va")
    assert fake_inference["inputs"]["generator"].initial_seed() == 7
    assert fake_inference["audio_shape"] == (2, 32000)
    assert fake_inference["released"]
    assert not fake_inference["grad_enabled"]
    assert not fake_inference["inference_mode"]
    assert not fake_inference["pipe"].transformer._forward_hooks


def test_real_webm_has_video_and_stereo_audio(tmp_path):
    av = pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    from PIL import Image

    from nodal_nodes_diffusion.video import encode_webm

    path = tmp_path / "result.webm"
    frames = [Image.new("RGB", (64, 32), (i * 8, 20, 100)) for i in range(24)]
    wave = np.tile(np.sin(np.arange(32000) * 0.02).astype(np.float32), (2, 1))
    encode_webm(path, frames, wave, 32000, check_cancelled=lambda: None, graph_json='{"test":1}')
    with av.open(str(path)) as media:
        assert media.streams.video[0].codec_context.name == "vp9"
        assert media.streams.audio[0].codec_context.name == "opus"
        assert media.streams.audio[0].codec_context.channels == 2
        assert media.metadata["NODAL_GRAPH"] == '{"test":1}'
        decoded = list(media.decode(video=0))
        assert len(decoded) == 24
        assert (decoded[0].width, decoded[0].height) == (64, 32)
    with av.open(str(path)) as media:
        audio = list(media.decode(audio=0))
        assert 47000 <= sum(frame.samples for frame in audio) <= 49000


def test_cancel_during_sampling_releases_hooks_and_pipeline(model, fake_inference):
    from nodal.events import Cancelled

    args = arguments(model)
    token = CancelToken()

    class CancellingSink:
        def emit(self, event):
            if getattr(event, "step", 0) == 2:
                token.cancel()

    args["ctx"] = NodeContext(
        "h3", "cancel", CancellingSink(), token, models=args["ctx"].models, assets=AssetStore()
    )
    with pytest.raises(Cancelled):
        h3.MiniMaxH3().run(**args)
    assert fake_inference["released"]
    assert not fake_inference["pipe"].transformer._forward_hooks
    assert not fake_inference["pipe"].transformer._forward_pre_hooks
    assert "audio_shape" not in fake_inference


def test_video_crosses_graph_websocket_and_asset_api(model, fake_inference):
    from fastapi.testclient import TestClient

    from nodal_server.app import create_app

    # Omit keyframes and most widgets: verify real graph default resolution too.
    graph = {
        "nodal_version": "1",
        "nodes": {
            "video": {
                "type": "diffusion.MiniMaxH3",
                "inputs": {"model_path": str(model), "memory_profile": "bf16_offload", "steps": 3},
            }
        },
        "outputs": ["video"],
    }
    with (
        TestClient(create_app(registry(), models=context().models)) as client,
        client.websocket_connect("/ws") as socket,
    ):
        response = client.post("/api/runs", json={"graph": graph})
        assert response.status_code == 202, response.text
        messages = []
        for _ in range(30):
            message = socket.receive_json()
            messages.append(message)
            if message["t"] in ("run.done", "run.error"):
                break
        assert messages[-1]["t"] == "run.done", messages
        done = next(m for m in messages if m["t"] == "node.done")
        asset = done["outputs"][0]["asset"]
        assert asset["media_type"] == "video/webm"
        media = client.get(f"/api/assets/{asset['hash']}")
        assert media.status_code == 200
        assert media.headers["content-type"] == "video/webm"
        assert media.content == b"webm-test"


def test_loader_pins_component_paths_and_cleans_up_on_load_failure(model, monkeypatch):
    diffusers = pytest.importorskip("diffusers")
    pytest.importorskip("torch")
    from nodal_nodes_diffusion import devices

    calls = {}

    class Pipe:
        blocks = SimpleNamespace(expected_components=[])

        def load_components(self, **kwargs):
            calls.update(kwargs)
            raise RuntimeError("broken shard")

        def unload_components(self, names):
            calls["unloaded"] = True

    monkeypatch.setattr(diffusers.ModularPipeline, "from_pretrained", lambda *a, **kw: Pipe())
    monkeypatch.setattr(devices, "empty_cache", lambda device: None)
    with (
        pytest.raises(RuntimeError, match="broken shard"),
        h3._pipeline(model, "t2va", "bf16_offload", context()),
    ):
        pytest.fail("failed load must not yield a pipeline")
    assert calls["pretrained_model_name_or_path"] == str(model)
    assert calls["local_files_only"] is True
    assert calls["unloaded"]


def test_pruned_source_is_rejected_before_execution(model):
    from nodal_nodes_diffusion import h3_pruned

    (model / "transformer" / "config.json").write_text(
        '{"_class_name":"MiniMaxH3PrunedTransformer3DModel"}'
    )
    (model / "transformer" / h3_pruned.SOURCE_NAME).write_text(
        "raise AssertionError('unreviewed code executed')"
    )
    with pytest.raises(ValueError, match="검토한 버전"):
        h3.model_directory(str(model))
    with pytest.raises(ValueError, match="검토한 버전"):
        h3_pruned.model_class(model)


def test_convrot_profile_rejects_full_checkpoint_before_loading(model):
    result = h3.MiniMaxH3().run(**arguments(model, memory_profile=h3.CONVROT_PROFILE))
    assert isinstance(result, Failure)
    assert result.socket == "memory_profile"


@pytest.mark.parametrize("pruned", [False, True])
def test_weight_only_keeps_full_model_quantization_and_pruned_precision(model, monkeypatch, pruned):
    diffusers = pytest.importorskip("diffusers")
    pytest.importorskip("torchao.quantization")
    from nodal_nodes_diffusion import devices

    class Pipe:
        blocks = SimpleNamespace(expected_components=[])

        def update_components(self, **components):
            pytest.fail("the test loader must stop before component registration")

        def unload_components(self, names):
            pass

    def loader(*args, **kwargs):
        excluded = kwargs["quantization_config"].modules_to_not_convert
        assert ("adaln_proj" in excluded) is pruned
        assert kwargs["local_files_only"]
        raise RuntimeError("checked quantization configuration")

    monkeypatch.setattr(h3, "is_pruned", lambda root, component="transformer": pruned)
    monkeypatch.setattr(
        h3,
        "model_class",
        lambda root, component="transformer": SimpleNamespace(from_pretrained=loader),
    )
    monkeypatch.setattr(diffusers.MiniMaxH3Transformer3DModel, "from_pretrained", loader)
    monkeypatch.setattr(diffusers.ModularPipeline, "from_pretrained", lambda *a, **kw: Pipe())
    monkeypatch.setattr(devices, "empty_cache", lambda device: None)
    with (
        pytest.raises(RuntimeError, match="checked quantization configuration"),
        h3._pipeline(model, "t2va", "int8_offload", context()),
    ):
        pytest.fail("the test loader stops before allocating weights")


@pytest.mark.parametrize("fail_quantization", [False, True])
@pytest.mark.parametrize(
    "workflow,component", [("fl2va", "transformer"), ("ref2va", "transformer_ref")]
)
def test_pruned_convrot_uses_custom_model_and_always_unloads(
    model, monkeypatch, fail_quantization, workflow, component
):
    diffusers = pytest.importorskip("diffusers")
    transformers = pytest.importorskip("transformers")
    pytest.importorskip("torchao.quantization")
    from nodal_nodes_diffusion import devices

    calls = []

    class Component:
        def requires_grad_(self, enabled):
            assert not enabled

        def quantize_8bit(self, **kwargs):
            assert kwargs == {"device": "cuda:0"}
            calls.append("convrot")
            if fail_quantization:
                raise RuntimeError("quantization failed")

        def enable_group_offload(self, **kwargs):
            assert kwargs["use_stream"] is False

        def to(self, device):
            pass

    class Pruned:
        @staticmethod
        def from_pretrained(path, **kwargs):
            assert path == str(model / component)
            assert kwargs["local_files_only"] and kwargs["use_safetensors"]
            calls.append("pruned")
            return Component()

    class Pipe:
        blocks = SimpleNamespace(expected_components=[SimpleNamespace(name=component)])
        vae = Component()
        audio_vae = Component()

        def update_components(self, **kwargs):
            self.__dict__.update(kwargs)

        def load_components(self, **kwargs):
            assert kwargs["pretrained_model_name_or_path"] == str(model)
            assert kwargs["local_files_only"]
            assert "trust_remote_code" not in kwargs
            calls.append("components")

        def unload_components(self, names):
            calls.append("unload")

    def text_loader(*args, **kwargs):
        calls.append("text")
        result = Component()
        result.model = Component()
        return result

    monkeypatch.setattr(h3, "is_pruned", lambda root, component="transformer": True)
    monkeypatch.setattr(h3, "model_class", lambda root, component="transformer": Pruned)
    monkeypatch.setattr(diffusers.ModularPipeline, "from_pretrained", lambda *a, **kw: Pipe())
    monkeypatch.setattr(
        transformers.Qwen3VLForConditionalGeneration, "from_pretrained", text_loader
    )
    monkeypatch.setattr(devices, "empty_cache", lambda device: calls.append("cache"))
    import diffusers.hooks

    monkeypatch.setattr(diffusers.hooks, "apply_group_offloading", lambda *a, **kw: None)
    if fail_quantization:
        with (
            pytest.raises(RuntimeError, match="quantization failed"),
            h3._pipeline(model, workflow, h3.CONVROT_PROFILE, context()),
        ):
            pytest.fail("failed quantization must not yield")
        assert calls == ["pruned", "convrot", "unload", "cache"]
    else:
        with h3._pipeline(model, workflow, h3.CONVROT_PROFILE, context()):
            assert calls == ["pruned", "convrot", "text", "components"]
        assert calls[-2:] == ["unload", "cache"]


def test_reference_workflow_uses_separate_weights_and_order(model, fake_inference):
    np = pytest.importorskip("numpy")
    (model / "transformer_ref").mkdir()
    result = h3.MiniMaxH3().run(
        **arguments(
            model,
            reference_1=np.zeros((1, 32, 64, 3)),
            reference_2=np.ones((1, 48, 32, 3)),
            reference_short_edge=768,
        )
    )
    assert not isinstance(result, Failure)
    assert fake_inference["workflow"] == "ref2va"
    assert fake_inference["config"] == {"reference_image_short_edge": 768}
    refs = fake_inference["inputs"]["references"]
    assert [ref.image.size for ref in refs] == [(64, 32), (32, 48)]
    assert "image" not in fake_inference["inputs"]
    assert fake_inference["released"]


def test_reference_inputs_fail_before_model_load(model):
    np = pytest.importorskip("numpy")
    image = np.zeros((1, 32, 32, 3))
    for updates, socket in [
        ({"reference_2": image}, "reference_2"),
        ({"reference_1": image, "first_frame": image}, "reference_1"),
        ({"reference_1": image, "last_frame": image}, "reference_1"),
        ({"reference_1": image}, "model_path"),
        ({"reference_1": np.zeros((2, 32, 32, 3))}, "reference_1"),
    ]:
        result = h3.MiniMaxH3().run(**arguments(model, **updates))
        assert isinstance(result, Failure)
        assert result.socket == socket


def test_first_and_last_are_both_forwarded(model, fake_inference):
    np = pytest.importorskip("numpy")
    image = np.zeros((1, 32, 32, 3))
    result = h3.MiniMaxH3().run(**arguments(model, first_frame=image, last_frame=image))
    assert not isinstance(result, Failure)
    assert fake_inference["workflow"] == "fl2va"
    assert "image" in fake_inference["inputs"]
    assert "last_image" in fake_inference["inputs"]


def test_reference_source_hash_is_validated_separately(model):
    from nodal_nodes_diffusion import h3_pruned

    (model / "transformer_ref").mkdir()
    (model / "transformer_ref/config.json").write_text(
        '{"_class_name":"MiniMaxH3PrunedTransformer3DModel"}'
    )
    (model / "transformer_ref" / h3_pruned.SOURCE_NAME).write_text("unreviewed")
    with pytest.raises(ValueError, match="검토한 버전"):
        h3.model_directory(str(model), "transformer_ref")


@pytest.mark.parametrize("mode", ["anchor", "reference"])
async def test_comparison_template_executes_real_image_links(
    model, fake_inference, monkeypatch, mode
):
    from pathlib import Path

    from PIL import Image

    import nodal_nodes_image
    from nodal import LRUCache, NullEventSink, execute
    from nodal_server.templates import build_call_graph, load_catalog

    monkeypatch.setenv("NODAL_H3_MODEL", str(model))
    (model / "transformer_ref").mkdir()
    # Keep model checks but bypass the selected precision profile for this wiring test.
    monkeypatch.setattr(h3, "is_pruned", lambda *args: True)
    monkeypatch.setattr(h3, "reviewed_source", lambda *args: b"")
    source = model / "original.png"
    Image.new("RGB", (1020, 1532), (20, 40, 60)).save(source)
    catalog = load_catalog(Path(__file__).resolve().parents[3] / "examples/templates")
    template = catalog.get(f"h3_compare_{mode}")
    assert template is not None
    graph = build_call_graph(template, {"source": str(source), "prompt": "Small head turn."})
    await execute(
        graph,
        graph.outputs,
        registry=registry(nodal_nodes_image.registry()),
        cache=LRUCache(8),
        events=NullEventSink(),
        cancel_token=CancelToken(),
        assets=AssetStore(),
        models=context().models,
    )
    inputs = fake_inference["inputs"]
    if mode == "anchor":
        assert inputs["image"].size == inputs["last_image"].size == (1020, 1532)
        assert inputs["image"].tobytes() == inputs["last_image"].tobytes()
    else:
        assert [ref.image.size for ref in inputs["references"]] == [(1020, 1532), (360, 340)]
        assert fake_inference["config"] == {"reference_image_short_edge": 768}
