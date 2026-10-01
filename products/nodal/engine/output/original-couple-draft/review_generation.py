"""Local QA extraction only: never synthesizes or edits a production image/video."""

import argparse
import json
import wave
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw, ImageOps

parser = argparse.ArgumentParser()
parser.add_argument("video", type=Path)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
root = args.output or args.video.parent
root.mkdir(parents=True, exist_ok=True)
samples = []
times = []
with av.open(str(args.video)) as media:
    stream = media.streams.video[0]
    facts = {
        "width": stream.width,
        "height": stream.height,
        "fps": str(stream.average_rate),
        "video_codec": stream.codec_context.name,
        "audio_streams": len(media.streams.audio),
    }
    graph = media.metadata.get("NODAL_GRAPH") or media.metadata.get("nodal_graph")
    if graph:
        (root / "generated-graph.nodal.json").write_text(graph, encoding="utf-8")
    for index, frame in enumerate(media.decode(video=0)):
        times.append(float(frame.time))
        if index % 6 == 0 or index == 123:
            im = frame.to_image()
            im.save(root / f"generated-{index:04d}.png")
            samples.append((index, float(frame.time), im))
    facts["frame_count"] = len(times)
    facts["video_duration_seconds"] = times[-1] - times[0] + 1 / float(stream.average_rate)
sheet = Image.new("RGB", (1536, ((len(samples) + 2) // 3) * 310), "#202020")
draw = ImageDraw.Draw(sheet)
for i, (idx, t, im) in enumerate(samples):
    thumb = ImageOps.contain(im, (504, 280))
    x, y = (i % 3) * 512, (i // 3) * 310
    sheet.paste(thumb, (x, y + 25))
    draw.text((x + 5, y + 5), f"frame {idx} / {t:.3f}s", fill="white")
sheet.save(root / "generated-contact-sheet.jpg", quality=95)
audio = []
with av.open(str(args.video)) as media:
    if media.streams.audio:
        facts["audio_codec"] = media.streams.audio[0].codec_context.name
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in media.decode(audio=0):
            audio.extend(part.to_ndarray().reshape(-1) for part in resampler.resample(frame))
        audio.extend(part.to_ndarray().reshape(-1) for part in resampler.resample(None))
if audio:
    pcm = np.concatenate(audio)
    with wave.open(str(root / "generated-audio.wav"), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm.astype("<i2").tobytes())
    facts["audio_duration_seconds"] = len(pcm) / 16000
    facts["audio_rms"] = float(np.sqrt(np.mean((pcm.astype(float) / 32768) ** 2)))
facts["visual_identity_verified"] = False
facts["speech_accuracy_verified"] = False
(root / "generated-facts.json").write_text(json.dumps(facts, indent=2), encoding="utf-8")
print(json.dumps(facts))
