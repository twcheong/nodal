import json
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw

root = Path(__file__).parent
samples = []
cuts = []
previous = None
all_times = []
with av.open(str(root / "source-video.mp4")) as video:
    stream = video.streams.video[0]
    facts = {"width": stream.width, "height": stream.height, "fps": str(stream.average_rate)}
    next_time = 0.0
    for frame in video.decode(video=0):
        t = float(frame.time)
        all_times.append(t)
        small = np.asarray(frame.to_image().resize((96, 54)), dtype=np.float32)
        if previous is not None:
            difference = float(np.abs(small - previous).mean())
            if difference > 20:
                cuts.append({"time": t, "mean_difference": difference})
        previous = small
        if 24 <= t <= 25 and round(t * 30) % 3 == 0:
            frame.to_image().save(root / f"transition-{t:06.3f}.png")
        if float(frame.time) >= next_time:
            im = frame.to_image()
            im.save(root / f"frame-{next_time:05.1f}.png")
            samples.append((float(frame.time), im))
            next_time += 1.0
    facts["last_sample_seconds"] = samples[-1][0]
    facts["duration_seconds"] = all_times[-1] + 1 / float(stream.average_rate)
    facts["frame_count"] = len(all_times)
    facts["hard_cut_candidates"] = cuts
for batch in range((len(samples) + 11) // 12):
    sheet = Image.new("RGB", (1280, 4 * 390), "#202020")
    draw = ImageDraw.Draw(sheet)
    for i, (t, im) in enumerate(samples[batch * 12 : (batch + 1) * 12]):
        im.thumbnail((635, 355))
        x, y = (i % 2) * 640, (i // 2) * 260
        # Six rows preserve the source's wide framing and readable subtitles.
        im.thumbnail((635, 230))
        sheet.paste(im, (x, y + 25))
        draw.text((x + 5, y + 5), f"{t:.2f}s", fill="white")
    sheet.save(root / f"sheet-{batch}.jpg", quality=95)
(root / "source-facts.json").write_text(json.dumps(facts, indent=2))
print(json.dumps(facts))
