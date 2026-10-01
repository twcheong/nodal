"""Read-only speech QA with local Whisper; never synthesizes speech or video."""

import argparse
import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser()
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--audio", type=Path)
parser.add_argument("--model", default="small")
parser.add_argument("--output", type=Path)
args = parser.parse_args()
root = Path(__file__).parent
model = WhisperModel(
    args.model,
    device="cpu",
    compute_type="int8",
    cpu_threads=4,
    download_root=str(root.parent / "reel-DcvQpQfJ6EB" / "qa-model-cache"),
)
if args.prepare:
    print("Local speech recognition model ready")
else:
    segments, info = model.transcribe(
        str(args.audio or root / "generated-audio.wav"),
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=False,
        word_timestamps=True,
    )
    result = {
        "detected_language": info.language,
        "language_probability": info.language_probability,
        "segments": [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob,
                "words": [
                    {"word": w.word, "start": w.start, "end": w.end} for w in (s.words or [])
                ],
            }
            for s in segments
        ],
    }
    (args.output or root / "generated-transcript.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False))
