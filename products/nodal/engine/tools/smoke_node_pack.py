"""깨끗한 venv에 nodal과 가이드 노드 팩을 설치해 /api/nodes까지 확인한다."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

EXPECTED_NODE = "guide.InvertBoolean"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default="3.11", help="uv가 만들 Python 버전")
    return parser


def main() -> int:
    args = _parser().parse_args()
    root = Path(__file__).resolve().parents[1]
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("uv 를 찾을 수 없다")

    with tempfile.TemporaryDirectory(prefix="nodal-m75-") as temporary:
        work = Path(temporary)
        environment = work / "venv"
        home = work / "home"
        extensions = home / ".nodal" / "extensions"
        shutil.copytree(root / "examples" / "extensions" / "guide-pack", extensions / "guide-pack")

        subprocess.run([uv, "venv", "--python", args.python, str(environment)], check=True)
        python = _venv_executable(environment, "python")
        subprocess.run(
            [
                uv,
                "pip",
                "install",
                "--python",
                str(python),
                str(root / "packages" / "core"),
                str(root / "packages" / "server"),
                str(root / "packages" / "nodes-core"),
                str(root / "packages" / "nodes-image"),
                str(root / "packages" / "nodes-diffusion"),
            ],
            check=True,
        )

        port = _free_port()
        nodal = _venv_executable(environment, "nodal")
        process_env = dict(os.environ)
        process_env.update({"HOME": str(home), "USERPROFILE": str(home)})
        process = subprocess.Popen(
            [
                str(nodal),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--extensions",
                str(extensions),
            ],
            env=process_env,
        )
        try:
            body = _wait_for_nodes(port, process)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

        node_ids = {item["id"] for item in body["nodes"]}
        if EXPECTED_NODE not in node_ids:
            raise SystemExit(f"{EXPECTED_NODE} 가 /api/nodes 에 없다")

        print(f"platform={platform.platform()}")
        print(f"python={args.python}")
        print(f"extensions={extensions}")
        print(f"endpoint=http://127.0.0.1:{port}/api/nodes")
        print(f"node={EXPECTED_NODE}")
    return 0


def _venv_executable(environment: Path, name: str) -> Path:
    if os.name == "nt":
        suffix = ".exe" if name in ("python", "nodal") else ""
        return environment / "Scripts" / f"{name}{suffix}"
    return environment / "bin" / name


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_for_nodes(port: int, process: subprocess.Popen[bytes]) -> dict[str, object]:
    url = f"http://127.0.0.1:{port}/api/nodes"
    for _ in range(200):
        if process.poll() is not None:
            raise SystemExit(f"nodal serve 가 먼저 종료됐다: {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=0.2) as response:
                return json.loads(response.read())
        except OSError:
            time.sleep(0.1)
    raise SystemExit(f"서버가 준비되지 않았다: {url}")


if __name__ == "__main__":
    raise SystemExit(main())
