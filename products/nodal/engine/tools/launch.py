"""macOS·Windows·Linux 원클릭 래퍼가 공유하는 nodal 부트스트랩."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

RUNTIME_CHOICES = ("core", "cpu", "cuda")
RUNTIME_SYNC_ARGS = {
    "core": (),
    "cpu": ("--group", "diffusion"),
    "cuda": ("--extra", "cuda"),
}
RUNTIME_LABELS = {
    "core": "기본 기능 (torch 없음 · diffusion 실행 불가)",
    "cpu": "CPU diffusion (torch + diffusers · GPU 가속 없음)",
    "cuda": "NVIDIA CUDA diffusion (torch CUDA 휠)",
}


def sync_command(uv: str, runtime: str) -> list[str]:
    """선택한 런타임을 정확히 동기화하는 uv 명령."""
    return [uv, "sync", "--frozen", *RUNTIME_SYNC_ARGS[runtime]]


def choose_runtime(
    requested: str | None,
    *,
    environ: dict[str, str],
    config: Path,
    interactive: bool,
) -> tuple[str, bool]:
    """런타임과 설정 파일에 저장할지 여부를 정한다."""
    if requested is not None:
        return _validate_runtime(requested), True
    from_environment = environ.get("NODAL_RUNTIME")
    if from_environment:
        return _validate_runtime(from_environment), False
    if config.is_file():
        return _validate_runtime(config.read_text(encoding="utf-8").strip()), False
    if not interactive:
        return "core", False

    print("설치할 실행 모드를 고르세요:")
    print("  1. 기본 기능 — torch 없음 (빠른 기본값)")
    print("  2. CPU diffusion — GPU 없이 모델 실행")
    print("  3. NVIDIA CUDA diffusion")
    answer = input("선택 [1]: ").strip() or "1"
    choices = {"1": "core", "2": "cpu", "3": "cuda"}
    try:
        return choices[answer], True
    except KeyError:
        raise ValueError(f"알 수 없는 실행 모드 선택: {answer!r}") from None


def _validate_runtime(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in RUNTIME_CHOICES:
        allowed = ", ".join(RUNTIME_CHOICES)
        raise ValueError(f"NODAL_RUNTIME 은 {allowed} 중 하나여야 한다: {value!r}")
    return normalized


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="nodal 설치·빌드·실행")
    parser.add_argument("--runtime", choices=RUNTIME_CHOICES)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8188)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--user-root", type=Path, help="기본: ~/.nodal (검증 시 덮어쓰기)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    user_root = args.user_root if args.user_root is not None else Path.home() / ".nodal"
    runtime_file = user_root / "runtime"

    try:
        runtime, persist = choose_runtime(
            args.runtime,
            environ=dict(os.environ),
            config=runtime_file,
            interactive=sys.stdin.isatty(),
        )
    except (OSError, ValueError) as exc:
        print(f"실행 모드 오류: {exc}", file=sys.stderr)
        return 2

    if persist:
        user_root.mkdir(parents=True, exist_ok=True)
        runtime_file.write_text(runtime + "\n", encoding="utf-8")

    uv = shutil.which("uv")
    corepack = shutil.which("corepack")
    if uv is None:
        print("uv 를 찾을 수 없습니다: https://docs.astral.sh/uv/", file=sys.stderr)
        return 2
    if corepack is None:
        print("corepack 을 찾을 수 없습니다. Node.js 20+를 설치하세요.", file=sys.stderr)
        return 2

    print(f"nodal 실행 모드: {runtime} — {RUNTIME_LABELS[runtime]}", flush=True)
    print(f"사용자 확장 경로: {user_root / 'extensions'}", flush=True)

    commands = [
        sync_command(uv, runtime),
        [corepack, "pnpm", "install", "--frozen-lockfile"],
        [corepack, "pnpm", "--filter", "@nodal/web", "build"],
    ]
    try:
        for command in commands:
            subprocess.run(command, cwd=root, check=True)
    except subprocess.CalledProcessError as exc:
        return int(exc.returncode or 1)

    web_root = root / "apps" / "web" / "dist"
    if not (web_root / "index.html").is_file():
        print(f"프론트 빌드가 없습니다: {web_root}", file=sys.stderr)
        return 1
    if args.prepare_only:
        print("설치와 프론트 빌드가 끝났습니다.", flush=True)
        return 0

    launch = [
        uv,
        "run",
        "--no-sync",
        "nodal",
        "launch",
        "--web",
        str(web_root),
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--assets",
        str(user_root / "assets"),
        "--models",
        str(user_root / "models"),
        "--templates",
        str(user_root / "templates"),
        "--extensions",
        str(user_root / "extensions"),
    ]
    if args.no_browser:
        launch.append("--no-browser")
    try:
        return subprocess.run(launch, cwd=root, check=False).returncode
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
