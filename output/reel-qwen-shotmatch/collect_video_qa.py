"""Collect completed local runs and extract review material; never submit GPU jobs."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from nodal_job import request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
QA_PYTHON = REPO / ".venv/Scripts/python.exe"
ASR_PYTHON = Path("C:/Users/nexta/miniconda3/envs/GPTSoVits/python.exe")
ASR_LARGE = REPO / "models/asr/whisper-large-v3-turbo"
ASR_MODEL = (
    REPO
    / "output/reel-DcvQpQfJ6EB/qa-model-cache"
    / "models--Systran--faster-whisper-small/snapshots"
    / "536b0662742c02347bc0e980a01041f333bce120"
)


def run(command: list[str]) -> None:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    subprocess.run(command, cwd=REPO, env=env, check=True)


def collect(number: int) -> None:
    prefix = ROOT / f"shot-{number:02d}-video"
    receipt_path = Path(str(prefix) + ".receipt.json")
    if not receipt_path.exists():
        print(f"Shot {number:02d}: not submitted", flush=True)
        return
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    result = request(receipt["server_url"] + "/api/runs/" + receipt["run_id"])
    print(f"Shot {number:02d}: {result['status']}", flush=True)
    if result["status"] != "succeeded":
        if result.get("error"):
            print(json.dumps(result["error"], ensure_ascii=False), flush=True)
        return
    video = ROOT / f"videos/shot-{number:02d}-raw.webm"
    files_path = Path(str(prefix) + ".files.json")
    if not video.exists() or not files_path.exists():
        run(
            [
                sys.executable,
                str(ROOT / "nodal_job.py"),
                "status",
                "--request",
                str(prefix) + ".request.json",
            ]
        )
    output = ROOT / f"qa/shot-{number:02d}"
    if not (output / "generated-facts.json").exists():
        run(
            [
                str(QA_PYTHON),
                str(REPO / "output/original-couple-v2/review_generation.py"),
                str(video),
                "--output",
                str(output),
            ]
        )
    transcript = output / "generated-transcript.json"
    if not transcript.exists():
        run(
            [
                str(ASR_PYTHON),
                str(REPO / "output/original-couple-v2/transcribe_generated.py"),
                "--audio",
                str(output / "generated-audio.wav"),
                "--model",
                str(ASR_MODEL),
                "--output",
                str(transcript),
            ]
        )
    large_transcript = output / "large-transcript.json"
    if (ASR_LARGE / "model.bin").exists() and not large_transcript.exists():
        run(
            [
                str(ASR_PYTHON),
                str(ROOT / "verify_speech.py"),
                str(output / "generated-audio.wav"),
                str(large_transcript),
                "--model",
                str(ASR_LARGE),
            ]
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shot", type=int, choices=range(1, 12))
    args = parser.parse_args()
    for number in [args.shot] if args.shot else range(1, 12):
        collect(number)


if __name__ == "__main__":
    main()
