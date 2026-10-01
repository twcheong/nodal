"""Download a pinned MIT-licensed ASR model for local CPU dialogue verification."""

import hashlib
import json
from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent
MODEL = ROOT.parent.parent / "models/asr/whisper-large-v3-turbo"
REPOSITORY = "dropbox-dash/faster-whisper-large-v3-turbo"
REVISION = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"


def main() -> None:
    path = Path(
        snapshot_download(
            REPOSITORY,
            revision=REVISION,
            local_dir=MODEL,
            allow_patterns=[
                "model.bin",
                "config.json",
                "tokenizer.json",
                "preprocessor_config.json",
                "vocabulary.json",
                "README.md",
            ],
        )
    )
    files = []
    for item in sorted(path.iterdir()):
        if not item.is_file():
            continue
        digest = hashlib.sha256()
        with item.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        files.append(
            {"name": item.name, "bytes": item.stat().st_size, "sha256": digest.hexdigest()}
        )
    receipt = {
        "repository": REPOSITORY,
        "revision": REVISION,
        "license": "MIT",
        "model_card": "https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo",
        "purpose": "Read-only local speech QA; never generate or upload user media",
        "path": str(path),
        "files": files,
    }
    (ROOT / "asr-model.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({"model": str(path), "files": len(files)}))


if __name__ == "__main__":
    main()
