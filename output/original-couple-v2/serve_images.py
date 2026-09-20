"""Run the existing nodal FLUX node pack without editing its source checkout."""

import os
import sys
from pathlib import Path

SOURCE = Path(
    "C:/Users/nexta/.codex/visualizations/2026/09/03/"
    "01a06627-a929-7202-a91d-f586cde693d6/nodal-flux2-3387c5c"
)
ROOT = Path(__file__).resolve().parent
for package in ("core", "server", "nodes-core", "nodes-image", "nodes-diffusion"):
    sys.path.insert(0, str(SOURCE / "packages" / package / "src"))
os.environ["NODAL_DEVICE"] = "cuda"

from nodal_nodes_core.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(
        main(
            [
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "8200",
                "--assets",
                str(ROOT / "assets"),
                "--templates",
                str(ROOT / "templates"),
                "--models",
                "C:/Users/nexta/.nodal/models",
            ]
        )
    )
