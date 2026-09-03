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

        def __call__(self, **kwargs):
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
