"""Read-only remote readiness check: python -m nodal_nodes_diffusion.h3_check."""

from __future__ import annotations

import argparse
import importlib
import json
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from .h3 import model_directory
from .video import require_video_runtime


def check(model_path: str) -> dict[str, Any]:
    """Inspect local files and runtime, without loading or downloading weights."""
    report: dict[str, Any] = {"checks_passed": False, "inference_verified": False, "errors": []}
    for package in ("torch", "diffusers", "transformers", "accelerate", "torchao", "av"):
        try:
            report[package] = version(package)
        except PackageNotFoundError:
            report["errors"].append(f"{package}가 설치되지 않았다.")
    try:
        root = model_directory(model_path)
        report["model_path"] = str(root)
        report["weight_files"] = len(list(root.rglob("*.safetensors")))
        if not report["weight_files"]:
            report["errors"].append("safetensors 가중치 파일이 없다.")
    except (ValueError, OSError) as exc:
        report["errors"].append(str(exc))
    try:
        from .devices import DevicePolicy, free_memory, resolve_plan

        plan = resolve_plan(DevicePolicy(preferred="cuda"))
        report["device"] = str(plan.compute)
        available = free_memory(plan.compute)
        report["gpu_free_gib"] = None if available is None else round(available / 2**30, 2)
    except (ImportError, RuntimeError) as exc:
        report["errors"].append(str(exc))
    try:
        require_video_runtime()
        _ = importlib.import_module("diffusers").MiniMaxH3Transformer3DModel
        config = importlib.import_module("torchao.quantization").Int8WeightOnlyConfig(version=2)
        importlib.import_module("diffusers").TorchAoConfig(config)
        importlib.import_module("transformers").TorchAoConfig(config)
        psutil = importlib.import_module("psutil")
        report["ram_available_gib"] = round(psutil.virtual_memory().available / 2**30, 2)
        report["ram_total_gib"] = round(psutil.virtual_memory().total / 2**30, 2)
    except (ImportError, RuntimeError, AttributeError) as exc:
        report["errors"].append(str(exc))
    report["checks_passed"] = not report["errors"]
    report["note"] = "파일/의존성 점검만 수행했다. int8에도 약 75GB 호스트 RAM이 필요할 수 있다."
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="", help="H3 diffusers 폴더. 기본값: NODAL_H3_MODEL")
    report = check(parser.parse_args().model)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["checks_passed"] else 1)


if __name__ == "__main__":
    main()
