"""Independent local Korean ASR pass without supplying the expected dialogue."""

import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", type=Path)
    args = parser.parse_args()
    cache = (
        Path(__file__).resolve().parent.parent
        / "reel-DcvQpQfJ6EB/qa-model-cache"
        / "models--Systran--faster-whisper-small/snapshots"
        / "536b0662742c02347bc0e980a01041f333bce120"
    )
    model_path = args.model or cache
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=4)
    segments, info = model.transcribe(
        str(args.audio),
        language="ko",
        beam_size=10,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=True,
    )
    result = {
        "method": "Korean forced, beam 10, VAD; no expected text or initial prompt",
        "audio": str(args.audio),
        "model": str(model_path),
        "language": info.language,
        "segments": [
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "words": [
                    {"word": word.word, "start": word.start, "end": word.end}
                    for word in (segment.words or [])
                ],
            }
            for segment in segments
        ],
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
