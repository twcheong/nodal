"""AI restoration wiring, tile seams, real WebM timing/audio, and cancellation."""

import io
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from nodal import CancelToken, Failure, NodeContext, RecordingEventSink
from nodal.events import Cancelled
from nodal.models import CPU, DevicePlan
from nodal_nodes_diffusion import registry, upscale
from nodal_server.assets import AssetStore


def context(token=None):
    return NodeContext(
        "upscale",
        "test",
        RecordingEventSink(),
        token or CancelToken(),
        assets=AssetStore(),
        models=SimpleNamespace(plan=DevicePlan(CPU)),
    )


def arguments(**updates):
    return (
        dict(
            video=None,
            source="",
            model_path="missing.pth",
            short_edge="720",
            tile_size=256,
            ctx=context(),
        )
        | updates
    )


def test_registered_without_loading_runtime_and_h3_socket_is_compatible():
    from nodal_nodes_diffusion.h3 import H3Video

    schema = next(s for s in registry() if s.id == "diffusion.UpscaleVideo")
    assert schema.output_node and not schema.cacheable
    assert schema.inputs["video"].default is None
    assert upscale.UpscaleVideo.returns["video"] == H3Video


@pytest.mark.parametrize(
    "size,edge,expected",
    [
        ((384, 576), 720, (720, 1080)),
        ((384, 576), 1080, (1080, 1620)),
        ((512, 288), 720, (1280, 720)),
        ((512, 288), 1080, (1920, 1080)),
    ],
)
def test_target_size_preserves_orientation_and_ratio(size, edge, expected):
    assert upscale.target_size(*size, edge) == expected


@pytest.mark.parametrize(
    "socket,value",
    [("short_edge", "480"), ("tile_size", 63), ("tile_size", 100), ("model_path", "missing.pth")],
)
def test_invalid_inputs_point_to_socket(socket, value):
    result = upscale.UpscaleVideo().run(**arguments(**{socket: value}))
    assert isinstance(result, Failure) and result.socket == socket


def test_model_loader_rejects_executable_formats(tmp_path, monkeypatch):
    path = tmp_path / "model.pt"
    path.write_bytes(b"not-weights")
    with pytest.raises(ValueError, match="가중치"):
        upscale.model_file(str(path))
    safe = tmp_path / "model.safetensors"
    safe.write_bytes(b"placeholder")
    monkeypatch.setenv("NODAL_UPSCALE_MODEL", str(safe))
    assert upscale.model_file("") == safe.resolve()


def test_sources_accept_h3_asset_saved_path_and_asset_string(tmp_path):
    ctx = context()
    ref = ctx.assets.put(b"clip", media_type="video/webm")
    assert upscale.source_bytes(ref, "", ctx) == b"clip"
    assert upscale.source_bytes(None, "asset:" + ref.hash, ctx) == b"clip"
    path = tmp_path / "clip.webm"
    path.write_bytes(b"clip")
    assert upscale.source_bytes(None, str(path), ctx) == b"clip"
    for video, source in ((ref, str(path)), (None, ""), (None, "asset:missing")):
        with pytest.raises(ValueError):
            upscale.source_bytes(video, source, ctx)


def test_tiling_covers_odd_edges_without_seams_and_checks_cancellation():
    torch = pytest.importorskip("torch")
    np = pytest.importorskip("numpy")
    from PIL import Image

    class Model:
        scale, device, dtype = 2, "cpu", torch.float32

        def __call__(self, image):
            return image.repeat_interleave(2, -1).repeat_interleave(2, -2)

    pixels = np.random.default_rng(7).integers(0, 256, (77, 131, 3), dtype=np.uint8)
    result = upscale.tiled_restore(Image.fromarray(pixels), Model(), 64, lambda: None)
    assert np.array_equal(np.asarray(result), np.repeat(np.repeat(pixels, 2, 0), 2, 1))
    token = CancelToken()
    token.cancel()
    with pytest.raises(Cancelled):
        upscale.tiled_restore(Image.fromarray(pixels), Model(), 64, token.raise_if_cancelled)


@pytest.fixture
def clip(tmp_path):
    pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    from PIL import Image

    from nodal_nodes_diffusion.video import encode_webm

    path = tmp_path / "original.webm"
    frames = [Image.new("RGB", (240, 360), (i * 30, 40, 80)) for i in range(4)]
    wave = np.tile(np.sin(np.arange(8000) * 0.04).astype(np.float32) * 0.05, (2, 1))
    encode_webm(path, frames, wave, 48000, check_cancelled=lambda: None)
    return path


def decoded(data):
    import av
    import numpy as np

    with av.open(io.BytesIO(data)) as media:
        frames = list(media.decode(video=0))
    with av.open(io.BytesIO(data)) as media:
        audio = np.concatenate([f.to_ndarray() for f in media.decode(audio=0)], axis=1)
    return frames, audio


@pytest.fixture
def fake_restorer(monkeypatch):
    from PIL import Image

    calls = {}

    @contextmanager
    def load(path, ctx):
        calls["loaded"] = True
        try:
            yield SimpleNamespace(scale=4)
        finally:
            calls["released"] = True

    monkeypatch.setattr(upscale, "restorer", load)
    monkeypatch.setattr(
        upscale,
        "tiled_restore",
        lambda image, *a: image.resize(
            (image.width * 4, image.height * 4), Image.Resampling.NEAREST
        ),
    )
    return calls


def test_real_webm_preserves_every_timestamp_and_exact_decoded_audio(clip, fake_restorer):
    import numpy as np

    ctx = context()
    result = upscale.UpscaleVideo().run(
        **arguments(source=str(clip), model_path=str(clip.with_suffix(".pth")), ctx=ctx)
    )
    assert isinstance(result, Failure)  # Missing weights are never silently substituted.
    clip.with_suffix(".pth").write_bytes(b"mock")
    original = ctx.assets.put(clip.read_bytes(), media_type="video/webm")
    result = upscale.UpscaleVideo().run(
        **arguments(video=original, model_path=str(clip.with_suffix(".pth")), ctx=ctx)
    )
    assert not isinstance(result, Failure), result
    data = ctx.assets.get(result.values[0].hash)
    before, sound_before = decoded(clip.read_bytes())
    after, sound_after = decoded(data)
    assert len(after) == len(before) == 4
    assert (after[0].width, after[0].height) == (720, 1080)
    assert [f.pts * f.time_base for f in before] == [f.pts * f.time_base for f in after]
    assert np.array_equal(sound_before, sound_after)
    assert fake_restorer["released"]


def test_cancel_inside_frame_loop_releases_model_and_saves_no_asset(
    clip, fake_restorer, monkeypatch
):
    token = CancelToken()
    ctx = context(token)
    clip.with_suffix(".pth").write_bytes(b"mock")

    def cancel(image, *args):
        token.cancel()
        return image

    monkeypatch.setattr(upscale, "tiled_restore", cancel)
    with pytest.raises(Cancelled):
        upscale.UpscaleVideo().run(
            **arguments(source=str(clip), model_path=str(clip.with_suffix(".pth")), ctx=ctx)
        )
    assert fake_restorer["released"]


def test_target_cannot_exceed_model_scale(clip, tmp_path):
    with pytest.raises(ValueError, match="배율"):
        upscale.restore_webm(
            clip.read_bytes(), tmp_path / "out.webm", lambda x: x, 1080, context(), model_scale=4
        )


def test_real_spandrel_tiny_checkpoint_roundtrip(tmp_path):
    torch = pytest.importorskip("torch")
    pytest.importorskip("spandrel")
    from PIL import Image
    from spandrel.architectures.ESRGAN.__arch.RRDB import RRDBNet

    # Model implementation belongs to Spandrel; random weights test wiring, not quality.
    net = RRDBNet(in_nc=3, out_nc=3, num_filters=8, num_blocks=1, scale=2)
    path = tmp_path / "tiny.pth"
    torch.save(net.state_dict(), path)
    with upscale.restorer(path, context()) as model:
        out = upscale.tiled_restore(Image.new("RGB", (17, 19)), model, 64, lambda: None)
        assert out.size == (34, 38)


def test_invalid_checkpoint_error_is_on_model_socket(clip, tmp_path):
    pytest.importorskip("spandrel")
    bad = tmp_path / "bad.pth"
    bad.write_bytes(b"not a checkpoint")
    result = upscale.UpscaleVideo().run(**arguments(source=str(clip), model_path=str(bad)))
    assert isinstance(result, Failure) and result.socket == "model_path"


def test_existing_h3_output_links_to_upscale_and_reaches_asset_api(clip, fake_restorer):
    from fastapi.testclient import TestClient

    from nodal import NodeResult, node
    from nodal_nodes_diffusion.h3 import H3Video
    from nodal_server.app import create_app

    @node(id="test.ExistingH3Video")
    class Existing:
        returns = {"video": H3Video}

        def run(self, ctx: NodeContext) -> NodeResult:
            return NodeResult(ctx.assets.put(clip.read_bytes(), media_type="video/webm"))

    weights = clip.with_suffix(".pth")
    weights.write_bytes(b"mock")
    graph = {
        "nodal_version": "1",
        "nodes": {
            "existing": {"type": "test.ExistingH3Video"},
            "up": {
                "type": "diffusion.UpscaleVideo",
                "inputs": {
                    "video": {"$link": ["existing", "video"]},
                    "model_path": str(weights),
                },
            },
        },
        "outputs": ["up"],
    }
    nodes = registry()
    nodes.register(Existing)
    with TestClient(create_app(nodes, models=context().models)) as client:
        with client.websocket_connect("/ws") as socket:
            response = client.post("/api/runs", json={"graph": graph})
            assert response.status_code == 202, response.text
            messages = []
            for _ in range(40):
                message = socket.receive_json()
                messages.append(message)
                if message["t"] in ("run.done", "run.error"):
                    break
            assert messages[-1]["t"] == "run.done", messages
        run = client.get("/api/runs/" + response.json()["run_id"]).json()
        ref = run["outputs"]["up"][0]["asset"]
        output = client.get("/api/assets/" + ref["hash"])
        assert output.status_code == 200
        assert len(decoded(output.content)[0]) == 4
