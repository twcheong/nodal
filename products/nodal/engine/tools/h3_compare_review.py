"""Extract deterministic temporal QA sheets and container facts; no image generation."""

from __future__ import annotations

import argparse
import json
from itertools import pairwise
from pathlib import Path
from typing import Any

import av
from PIL import Image, ImageDraw, ImageOps


def inspect(folder: Path) -> dict[str, Any]:
    samples: list[tuple[int, float, Image.Image]] = []
    times: list[float] = []
    with av.open(str(folder / "video.webm")) as media:
        stream = media.streams.video[0]
        facts: dict[str, Any] = {
            "width": stream.width,
            "height": stream.height,
            "fps": str(stream.average_rate),
            "video_codec": stream.codec_context.name,
            "audio_codec": media.streams.audio[0].codec_context.name,
        }
        graph = media.metadata.get("NODAL_GRAPH")
        if graph:
            (folder / "graph.nodal.json").write_text(graph, encoding="utf-8")
        for index, frame in enumerate(media.decode(video=0)):
            time = float(frame.time)
            times.append(time)
            if index % 6 == 0 or index == 123:
                samples.append((index, time, frame.to_image()))
        facts.update(
            frame_count=len(times),
            first_time=times[0],
            last_time=times[-1],
            monotonic_pts=all(b > a for a, b in pairwise(times)),
        )
    facts["expected_container_pass"] = (
        facts["width"] == 768
        and facts["height"] == 1152
        and facts["fps"] == "24"
        and facts["frame_count"] == 124
        and facts["monotonic_pts"]
    )
    facts["identity_pass"] = None  # Never infer identity quality from a valid container.
    for kind in ("full", "face"):
        tile_w, tile_h = (180, 300) if kind == "full" else (220, 230)
        sheet = Image.new("RGB", (tile_w * 6, tile_h * 4), "#1a1d24")
        draw = ImageDraw.Draw(sheet)
        for position, (index, time, frame_image) in enumerate(samples):
            if kind == "face":
                # Fixed normalized QA region, not a face-tracking or identity algorithm.
                w, h = frame_image.size
                frame_image = frame_image.crop((int(w * 0.35), 0, int(w * 0.75), int(h * 0.24)))
            thumb = ImageOps.contain(frame_image, (tile_w - 8, tile_h - 30))
            x, y = (position % 6) * tile_w, (position // 6) * tile_h
            sheet.paste(thumb, (x + (tile_w - thumb.width) // 2, y + 25))
            draw.text((x + 5, y + 5), f"f{index:03d}  {time:.3f}s", fill="white")
        sheet.save(folder / f"qa-{kind}.jpg", quality=95)
    (folder / "qa.json").write_text(json.dumps(facts, indent=2), encoding="utf-8")
    return facts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folders", nargs="+", type=Path)
    for folder in parser.parse_args().folders:
        print(folder, json.dumps(inspect(folder)), flush=True)


if __name__ == "__main__":
    main()
