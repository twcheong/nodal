"""샷 테이크 이어 붙이기 — 크기가 다른 클립·소리 없는 클립이 섞여도 그림과 소리가 맞는다."""

import io

import pytest

from nodal import CancelToken, Failure, NodeContext, RecordingEventSink
from nodal_nodes_diffusion.concat import ConcatVideo, parse_sources
from nodal_server.assets import AssetStore


def context(assets):
    return NodeContext("concat", "test", RecordingEventSink(), CancelToken(), assets=assets)


def test_parse_sources_accepts_lines_and_commas_and_rejects_bad_items():
    assert parse_sources("asset:a\n\nasset:b, asset:c") == ["a", "b", "c"]
    with pytest.raises(ValueError):
        parse_sources("a.webm")
    with pytest.raises(ValueError):
        parse_sources("  \n ")


def test_missing_or_non_video_asset_is_reported_on_the_sources_socket():
    assets = AssetStore()
    image = assets.put(b"png", media_type="image/png")
    result = ConcatVideo().run(sources=f"asset:{image.hash}", ctx=context(assets))
    assert isinstance(result, Failure) and result.socket == "sources"
    result = ConcatVideo().run(sources="asset:nope", ctx=context(assets))
    assert isinstance(result, Failure) and result.socket == "sources"


def _webm(tmp_path, name, size, frames, with_audio):
    av = pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    from fractions import Fraction

    from PIL import Image

    from nodal_nodes_diffusion.video import encode_webm

    path = tmp_path / name
    images = [Image.new("RGB", size, (i * 20, 60, 90)) for i in range(frames)]
    if with_audio:
        wave = np.tile(np.sin(np.arange(frames * 2000) * 0.03).astype(np.float32) * 0.1, (2, 1))
        encode_webm(path, images, wave, 48000, check_cancelled=lambda: None)
        return path.read_bytes()
    with av.open(str(path), "w", format="webm") as out:
        stream = out.add_stream("libvpx-vp9", rate=24)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"
        for i, image in enumerate(images):
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = i, Fraction(1, 24)
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return path.read_bytes()


def test_concat_keeps_order_first_size_and_audio_length(tmp_path):
    av = pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    assets = AssetStore()
    first = assets.put(_webm(tmp_path, "a.webm", (256, 144), 12, True), media_type="video/webm")
    second = assets.put(_webm(tmp_path, "b.webm", (144, 256), 6, False), media_type="video/webm")

    result = ConcatVideo().run(
        sources=f"asset:{first.hash}\nasset:{second.hash}", ctx=context(assets)
    )

    assert not isinstance(result, Failure)
    (ref,) = result.values
    assert ref.media_type == "video/webm"
    data = assets.get(ref.hash)
    with av.open(io.BytesIO(data)) as media:
        frames = list(media.decode(video=0))
    with av.open(io.BytesIO(data)) as media:
        audio = [f for f in media.decode(audio=0)]
    assert len(frames) == 18
    # 둘째 클립(세로)도 첫 클립 크기로 맞춰진다.
    assert {(f.width, f.height) for f in frames} == {(256, 144)}
    # 소리 없는 둘째 클립 구간은 무음으로 채워져 전체 소리 길이가 그림 길이와 같다 (0.75초).
    seconds = sum(f.samples for f in audio) / 48000
    assert abs(seconds - 18 / 24) < 0.05
    tail = np.concatenate([f.to_ndarray() for f in audio], axis=1)[:, -2000:]
    assert float(np.abs(tail).max()) < 0.02
