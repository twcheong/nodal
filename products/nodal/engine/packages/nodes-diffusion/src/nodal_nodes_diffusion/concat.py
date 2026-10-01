"""여러 WebM 클립을 한 파일로 잇는다 — 샷별 테이크를 고른 뒤의 편집 내보내기.

클립마다 크기·오디오 유무가 다를 수 있다 (H3 테이크는 같은 설정이면 같지만, 사용자가 해상도를
바꾼 샷이 섞일 수 있다). 첫 클립의 크기를 기준으로 나머지를 비율을 지켜 맞추고(남는 곳은 검정),
오디오가 없는 클립은 그 길이만큼 무음을 넣어 소리와 그림이 어긋나지 않게 한다. 인코딩은
`video.py` 와 같은 VP9/Opus 24fps — 브라우저가 바로 재생한다.
"""

from __future__ import annotations

import io
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from nodal import Failure, NodeContext, NodeResult, Str, node

from .h3 import H3Video
from .video import require_video_runtime

__all__ = ["ConcatVideo", "parse_sources"]

_FPS = 24
_RATE = 48000


def parse_sources(text: str) -> list[str]:
    """줄바꿈·쉼표로 나눈 `asset:<hash>` 목록 → 해시 목록. 형식이 틀리면 ValueError."""
    hashes: list[str] = []
    for raw in text.replace(",", "\n").splitlines():
        item = raw.strip()
        if not item:
            continue
        if not item.startswith("asset:") or len(item) <= len("asset:"):
            raise ValueError(f"asset:<hash> 형식이 아니다: {item!r}")
        hashes.append(item[len("asset:") :])
    if not hashes:
        raise ValueError("이을 클립이 없다")
    return hashes


@node(
    id="diffusion.ConcatVideo",
    title="Concat Videos",
    category="diffusion/video",
    aliases=["이어 붙이기", "영상 합치기", "편집 내보내기", "concat"],
    output_node=True,
    cacheable=True,
)
class ConcatVideo:
    """고른 테이크들을 순서대로 이어 WebM 하나로 만든다."""

    sources: Str = Str(
        "",
        multiline=True,
        doc="이을 WebM 클립. 한 줄에 하나씩 asset:<hash> (순서대로).",
    )
    returns = {"video": H3Video}

    def run(self, sources: str, ctx: NodeContext) -> NodeResult | Failure:
        try:
            hashes = parse_sources(sources)
        except ValueError as exc:
            return Failure(exc, socket="sources")
        clips: list[bytes] = []
        for digest in hashes:
            ref = ctx.assets.ref(digest)
            data = ctx.assets.get(digest)
            if ref is None or data is None or not ref.media_type.startswith("video/"):
                return Failure(ValueError(f"영상 에셋이 없다: asset:{digest}"), socket="sources")
            clips.append(data)
        av = require_video_runtime()
        with TemporaryDirectory(prefix="nodal-concat-") as temporary:
            path = Path(temporary) / "concat.webm"
            _concat(av, clips, path, ctx)
            asset = ctx.assets.put(path.read_bytes(), media_type="video/webm")
        return NodeResult(asset)


def _concat(av: Any, clips: list[bytes], path: Path, ctx: NodeContext) -> None:
    import numpy as np
    from PIL import Image

    width = height = 0
    with av.open(str(path), "w", format="webm") as out:
        video = audio = None
        frame_index = 0
        audio_pts = 0
        for number, data in enumerate(clips, start=1):
            with av.open(io.BytesIO(data)) as source:
                if video is None:
                    first = source.streams.video[0]
                    width, height = first.codec_context.width, first.codec_context.height
                    width, height = width - width % 2, height - height % 2
                    video = out.add_stream("libvpx-vp9", rate=_FPS)
                    video.width, video.height = width, height
                    video.pix_fmt = "yuv420p"
                    video.options = {"crf": "30", "b": "0", "deadline": "good", "cpu-used": "4"}
                    audio = out.add_stream("libopus", rate=_RATE)
                    audio.layout = "stereo"
                    audio.format = "flt"
                clip_frames = 0
                for frame in source.decode(video=0):
                    ctx.raise_if_cancelled()
                    image = _fit(frame.to_image(), width, height, Image)
                    picture = av.VideoFrame.from_image(image)
                    picture.pts, picture.time_base = frame_index, Fraction(1, _FPS)
                    for packet in video.encode(picture):
                        out.mux(packet)
                    frame_index += 1
                    clip_frames += 1
                clip_samples = round(clip_frames * _RATE / _FPS)
                written = 0
                if source.streams.audio:
                    source.seek(0)
                    # 클립마다 새 리샘플러 — 앞 클립의 버퍼가 다음 클립으로 새지 않게 끝에서 비운다.
                    resampler = av.AudioResampler(format="flt", layout="stereo", rate=_RATE)
                    decoded = [
                        f for sound in source.decode(audio=0) for f in resampler.resample(sound)
                    ]
                    decoded += resampler.resample(None)
                    for converted in decoded:
                        take = min(converted.samples, clip_samples - written)
                        if take <= 0:
                            break
                        # packed 스테레오는 (1, 2*n) — 샘플 수의 두 배를 잘라야 한다.
                        chunk = converted.to_ndarray()[:, : 2 * take]
                        written += _write_audio(av, out, audio, chunk, audio_pts + written)
                # 소리가 모자라면(무음 클립 포함) 그림 길이만큼 채운다 — 다음 클립이 어긋나지 않게.
                if written < clip_samples:
                    silence = np.zeros((1, 2 * (clip_samples - written)), dtype=np.float32)
                    written += _write_audio(av, out, audio, silence, audio_pts + written)
                audio_pts += written
            ctx.progress(number, len(clips))
        if video is None or audio is None:
            raise ValueError("이을 영상 프레임이 없다")
        for stream in (video, audio):
            for packet in stream.encode(None):
                out.mux(packet)


def _write_audio(av: Any, out: Any, stream: Any, chunk: Any, pts: int) -> int:
    """packed flt 스테레오(1, 2*n) 또는 (2, n)을 한 번에 인코딩한다. 쓴 샘플 수를 돌려준다."""
    import numpy as np

    array = np.ascontiguousarray(chunk, dtype=np.float32)
    if array.shape[0] == 2:  # planar → packed
        array = np.ascontiguousarray(array.T.reshape(1, -1))
    samples = int(array.shape[1]) // 2
    if samples == 0:
        return 0
    frame = av.AudioFrame.from_ndarray(array, format="flt", layout="stereo")
    frame.sample_rate = _RATE
    frame.pts, frame.time_base = pts, Fraction(1, _RATE)
    for packet in stream.encode(frame):
        out.mux(packet)
    return samples


def _fit(image: Any, width: int, height: int, pil: Any) -> Any:
    """비율을 지켜 (width, height) 안에 넣고 남는 곳은 검정 — 첫 클립과 크기가 다를 때만."""
    image = image.convert("RGB")
    if image.size == (width, height):
        return image
    scale = min(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        pil.Resampling.LANCZOS,
    )
    canvas = pil.new("RGB", (width, height))
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas
