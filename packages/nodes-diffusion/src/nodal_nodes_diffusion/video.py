"""Browser-playable WebM export. PyAV is optional; use VP9/Opus, not libx264."""

from __future__ import annotations

import importlib
from collections.abc import Callable, Sequence
from fractions import Fraction
from pathlib import Path
from typing import Any


def require_video_runtime() -> Any:
    """Fail before loading weights if the optional encoder is unavailable."""
    try:
        av = importlib.import_module("av")
        av.codec.Codec("libvpx-vp9", "w")
        av.codec.Codec("libopus", "w")
    except (ImportError, ValueError) as exc:
        raise RuntimeError(
            "영상 코덱이 없다. `uv sync --extra cuda --group h3`를 실행하세요."
        ) from exc
    return av


def encode_webm(
    path: Path,
    frames: Sequence[Any],
    audio: Any,
    sampling_rate: int,
    *,
    check_cancelled: Callable[[], None],
    graph_json: str | None = None,
) -> None:
    """Mux 24 fps PIL frames and a (2, samples) stereo waveform into one asset."""
    import numpy as np

    av = require_video_runtime()
    if not frames or sampling_rate <= 0:
        raise ValueError("H3가 빈 영상 또는 잘못된 오디오 샘플레이트를 반환했다.")
    waveform = np.asarray(audio, dtype=np.float32)
    if waveform.ndim != 2 or waveform.shape[0] != 2 or not waveform.shape[1]:
        raise ValueError("H3 오디오는 (2, samples) 스테레오여야 한다.")
    if not np.isfinite(waveform).all():
        raise ValueError("H3 오디오에 유효하지 않은 샘플이 있다.")
    waveform = np.clip(waveform, -1, 1)
    width, height = frames[0].size
    with av.open(str(path), "w", format="webm") as container:
        if graph_json:
            container.metadata["nodal_graph"] = graph_json
        video = container.add_stream("libvpx-vp9", rate=24)
        video.width, video.height = width, height
        video.pix_fmt = "yuv420p"
        video.options = {"crf": "30", "b": "0", "deadline": "good", "cpu-used": "4"}
        sound = container.add_stream("libopus", rate=48000)
        sound.layout = "stereo"
        sound.format = "flt"
        resampler = av.AudioResampler(format="flt", layout="stereo", rate=48000)
        audio_cursor = 0
        # Interleave at frame boundaries so the muxer need not buffer the entire soundtrack.
        for index, frame in enumerate(frames):
            check_cancelled()
            if frame.size != (width, height):
                raise ValueError("영상 프레임 크기가 서로 다르다.")
            picture = av.VideoFrame.from_image(frame.convert("RGB"))
            picture.pts, picture.time_base = index, Fraction(1, 24)
            for packet in video.encode(picture):
                container.mux(packet)
            end = min(round((index + 1) * sampling_rate / 24), waveform.shape[1])
            if end > audio_cursor:
                samples = av.AudioFrame.from_ndarray(
                    np.ascontiguousarray(waveform[:, audio_cursor:end]),
                    format="fltp",
                    layout="stereo",
                )
                samples.sample_rate = sampling_rate
                samples.pts, samples.time_base = audio_cursor, Fraction(1, sampling_rate)
                for converted in resampler.resample(samples):
                    for packet in sound.encode(converted):
                        container.mux(packet)
                audio_cursor = end
        check_cancelled()
        for converted in resampler.resample(None):
            for packet in sound.encode(converted):
                container.mux(packet)
        for stream in (video, sound):
            for packet in stream.encode(None):
                container.mux(packet)
