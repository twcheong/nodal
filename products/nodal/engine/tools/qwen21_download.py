"""Explicit opt-in download; separate model license, never bundled in nodal."""

from __future__ import annotations

import json
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL = "Qwen/Qwen-Image-2.1"
REVISION = "790c92633540aa0cb11d9abf19eb46d861714758"


def main() -> None:
    root = Path(__file__).resolve().parent.parent / "models" / "Qwen-Image-2.1"
    print("Qwen Research License: non-commercial research/evaluation only.", flush=True)
    snapshot_download(
        MODEL,
        revision=REVISION,
        local_dir=root,
        ignore_patterns=["assets/*"],
        max_workers=4,
    )
    (root / "nodal-model.json").write_text(
        json.dumps({"repo_id": MODEL, "revision": REVISION, "license": "qwen-research"}, indent=2),
        encoding="utf-8",
    )
    print(root, flush=True)


if __name__ == "__main__":
    main()
