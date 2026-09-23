"""Cut locally generated clips to a reviewed edit list; no generative image operations."""

import argparse
import hashlib
import json
from fractions import Fraction
from pathlib import Path

import av
import numpy as np

RATE = 48000
FPS = 30


def read_audio(path: Path) -> np.ndarray:
    chunks = []
    resampler = av.AudioResampler(format="fltp", layout="stereo", rate=RATE)
    with av.open(str(path)) as media:
        if not media.streams.audio:
            raise ValueError(f"Missing audio: {path}")
        for frame in media.decode(audio=0):
            chunks.extend(part.to_ndarray() for part in resampler.resample(frame))
        chunks.extend(part.to_ndarray() for part in resampler.resample(None))
    return np.concatenate(chunks, axis=1).astype(np.float32)


def tempo(pcm: np.ndarray, speed: float) -> np.ndarray:
    """FFmpeg atempo changes timing while preserving speech pitch."""
    if abs(speed - 1) < 1e-7:
        return pcm
    if not 0.85 <= speed <= 1.35:
        raise ValueError(f"Speech requires excessive retiming ({speed:.3f}); regenerate the shot")
    graph = av.filter.Graph()
    source = graph.add_abuffer(
        sample_rate=RATE, format="fltp", layout="stereo", time_base=Fraction(1, RATE)
    )
    effect = graph.add("atempo", f"{speed:.9f}")
    sink = graph.add("abuffersink")
    source.link_to(effect)
    effect.link_to(sink)
    graph.configure()
    result = []
    output_resampler = av.AudioResampler(format="fltp", layout="stereo", rate=RATE)

    def drain() -> None:
        while True:
            try:
                result.extend(part.to_ndarray() for part in output_resampler.resample(sink.pull()))
            except (av.error.BlockingIOError, av.error.EOFError):
                return

    for start in range(0, pcm.shape[1], 4096):
        frame = av.AudioFrame.from_ndarray(
            np.ascontiguousarray(pcm[:, start : start + 4096]), format="fltp", layout="stereo"
        )
        frame.sample_rate = RATE
        frame.pts, frame.time_base = start, Fraction(1, RATE)
        source.push(frame)
        drain()
    source.push(None)
    drain()
    result.extend(part.to_ndarray() for part in output_resampler.resample(None))
    if not result:
        raise ValueError("Empty atempo output")
    return np.concatenate(result, axis=1)


def assemble(edit_path: Path, destination: Path) -> dict:
    edit = json.loads(edit_path.read_text(encoding="utf-8"))
    if edit["fps"] != FPS:
        raise ValueError("This edit is explicitly matched to the 30fps reference")
    destination.parent.mkdir(parents=True, exist_ok=True)
    report = {"fps": FPS, "shots": [], "edits": str(edit_path), "audio_rate": RATE}
    frame_cursor = 0
    resampler = av.AudioResampler(format="flt", layout="stereo", rate=RATE)
    with av.open(str(destination), "w", format="webm") as target:
        target.metadata["nodal_edit"] = json.dumps(edit, ensure_ascii=False)
        video = target.add_stream("libvpx-vp9", rate=FPS)
        video.width, video.height = 1024, 576
        video.pix_fmt = "yuv420p"
        video.options = {"crf": "18", "b": "0", "deadline": "good", "cpu-used": "4"}
        sound = target.add_stream("libopus", rate=RATE)
        sound.layout, sound.format = "stereo", "flt"
        for shot in edit["shots"]:
            path = (edit_path.parent / shot["file"]).resolve()
            count = int(shot["frames"])
            start, end = float(shot["source_start"]), float(shot["source_end"])
            if count <= 0 or end <= start or start < 0:
                raise ValueError(f"Invalid edit: {shot}")
            with av.open(str(path)) as media:
                source_fps = float(media.streams.video[0].average_rate)
                pictures = [frame.to_image() for frame in media.decode(video=0)]
            if end > len(pictures) / source_fps + 1e-4:
                raise ValueError(f"Edit exceeds source duration: {path}")
            if any(p.size != (1024, 576) for p in pictures):
                raise ValueError(f"Unexpected source dimensions: {path}")
            pcm = read_audio(path)[:, round(start * RATE) : round(end * RATE)]
            speed = (end - start) / (count / FPS)
            pcm = tempo(pcm, speed)
            desired = count * (RATE // FPS)
            padding = max(0, desired - pcm.shape[1])
            if padding > RATE // 10:
                raise ValueError(f"Unexpected audio shortage: {path}, {padding} samples")
            pcm = np.pad(pcm, ((0, 0), (0, padding)))[:, :desired]
            fade = min(240, pcm.shape[1] // 2)
            pcm[:, :fade] *= np.linspace(0, 1, fade)
            pcm[:, -fade:] *= np.linspace(1, 0, fade)
            chosen = []
            for index in range(count):
                second = start + (index / count) * (end - start)
                source_index = min(round(second * source_fps), len(pictures) - 1)
                chosen.append(source_index)
                picture = av.VideoFrame.from_image(pictures[source_index].convert("RGB"))
                picture.pts, picture.time_base = frame_cursor + index, Fraction(1, FPS)
                for packet in video.encode(picture):
                    target.mux(packet)
                low, high = index * 1600, (index + 1) * 1600
                samples = av.AudioFrame.from_ndarray(
                    np.ascontiguousarray(pcm[:, low:high]), format="fltp", layout="stereo"
                )
                samples.sample_rate = RATE
                samples.pts = (frame_cursor + index) * 1600
                samples.time_base = Fraction(1, RATE)
                for converted in resampler.resample(samples):
                    for packet in sound.encode(converted):
                        target.mux(packet)
            report["shots"].append(
                {
                    "shot": shot["shot"],
                    "source": str(path),
                    "output_start_frame": frame_cursor,
                    "output_frames": count,
                    "source_start": start,
                    "source_end": end,
                    "tempo": speed,
                    "padding_samples": padding,
                    "source_frame_indices": chosen,
                    "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
            frame_cursor += count
            print(f"Assembled shot {shot['shot']}: {count} frames", flush=True)
        for converted in resampler.resample(None):
            for packet in sound.encode(converted):
                target.mux(packet)
        for stream in (video, sound):
            for packet in stream.encode(None):
                target.mux(packet)
    report["frame_count"] = frame_cursor
    report["duration_seconds"] = frame_cursor / FPS
    report["sha256"] = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(".edit-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("edits", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = assemble(args.edits, args.output)
    print(json.dumps({"frames": result["frame_count"], "duration": result["duration_seconds"]}))


if __name__ == "__main__":
    main()
