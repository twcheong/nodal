"""Decode delivery files and verify cut boundaries, timing and preserved upscale audio."""

import argparse
import hashlib
import json
from pathlib import Path

import av
import numpy as np
from PIL import Image


def inspect(path: Path, indices: set[int]) -> tuple[dict, dict[int, np.ndarray]]:
    pictures = {}
    times = []
    with av.open(str(path)) as media:
        stream = media.streams.video[0]
        result = {
            "path": str(path),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "width": stream.width,
            "height": stream.height,
            "fps": float(stream.average_rate),
        }
        for index, frame in enumerate(media.decode(video=0)):
            times.append(float(frame.time))
            if index in indices:
                pictures[index] = frame.to_ndarray(format="rgb24")
    result["frames"] = len(times)
    result["relative_video_times"] = [round(t - times[0], 6) for t in times]
    result["video_duration"] = times[-1] - times[0] + 1 / result["fps"]
    peak = 0.0
    samples = 0
    with av.open(str(path)) as media:
        for frame in media.decode(audio=0):
            samples += frame.samples
            peak = max(peak, float(np.max(np.abs(frame.to_ndarray()))))
        rate = media.streams.audio[0].rate
    result["audio_samples"] = samples
    result["audio_rate"] = rate
    result["audio_seconds"] = samples / rate
    result["audio_peak"] = peak
    digest = hashlib.sha256()
    packet_count = 0
    with av.open(str(path)) as media:
        for packet in media.demux(audio=0):
            if packet.size:
                digest.update(bytes(packet))
                packet_count += 1
    result["audio_packet_payload_sha256"] = digest.hexdigest()
    result["audio_packets"] = packet_count
    return result, pictures


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("--native", type=Path)
    args = parser.parse_args()
    native = args.native or args.video
    edit = json.loads(native.with_suffix(".edit-report.json").read_text(encoding="utf-8"))
    checks = []
    indices = set()
    for shot in edit["shots"]:
        for offset in (0, shot["output_frames"] - 1):
            output_index = shot["output_start_frame"] + offset
            indices.add(output_index)
            checks.append((shot, output_index, shot["source_frame_indices"][offset]))
    result, output = inspect(args.video, set() if args.native else indices)
    errors = []
    if result["frames"] != edit["frame_count"] or result["fps"] != edit["fps"]:
        errors.append("Decoded frame count or fps differs from reviewed edit")
    if abs(result["audio_seconds"] - edit["duration_seconds"]) > 0.002:
        errors.append("Audio duration differs from reviewed edit by more than 2ms")
    if result["audio_peak"] > 1.0:
        errors.append("Decoded audio exceeds full scale")
    expected_times = np.arange(result["frames"]) / edit["fps"]
    if np.max(np.abs(np.array(result["relative_video_times"]) - expected_times)) > 0.0011:
        errors.append("Video timestamps depart from constant frame rate")
    if args.native:
        source, _ = inspect(native, set())
        if (result["width"], result["height"]) != (1920, 1080):
            errors.append("Restored delivery is not 1920x1080")
        for key in ("relative_video_times", "audio_packet_payload_sha256", "audio_packets"):
            if result[key] != source[key]:
                errors.append(f"Upscale changed {key}")
        result["native_sha256"] = source["sha256"]
    else:
        differences = []
        for shot in edit["shots"]:
            relevant = [row for row in checks if row[0]["shot"] == shot["shot"]]
            required = {row[2] for row in relevant}
            with av.open(shot["source"]) as media:
                for index, frame in enumerate(media.decode(video=0)):
                    if index not in required:
                        continue
                    for _, destination_index, source_index in relevant:
                        if source_index != index:
                            continue
                        original_image = frame.to_image().convert("RGB")
                        boxes = shot.get("video_crop_boxes")
                        if boxes:
                            offset = destination_index - shot["output_start_frame"]
                            original_image = original_image.resize(
                                (1024, 576), Image.Resampling.LANCZOS, box=boxes[offset]
                            )
                        original = np.asarray(original_image, dtype=np.float32)
                        restored = output.get(destination_index)
                        if restored is None or restored.shape != original.shape:
                            errors.append(f"Missing or wrongly sized boundary {destination_index}")
                            continue
                        difference = float(np.mean(np.abs(restored - original)))
                        differences.append(
                            {
                                "shot": shot["shot"],
                                "output_frame": destination_index,
                                "source_frame": source_index,
                                "rgb_mean_absolute_error": difference,
                            }
                        )
                        if difference > 5.0:
                            errors.append(f"Wrong image at cut boundary {destination_index}")
        result["cut_boundary_checks"] = differences
    result["errors"] = errors
    result["passed"] = not errors
    destination = args.video.with_suffix(".validation.json")
    destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(
        json.dumps({k: result[k] for k in ("frames", "fps", "audio_seconds", "passed", "errors")})
    )
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
