"""세 플랫폼 래퍼가 공유하는 부트스트랩의 런타임 분기."""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


def _load_launcher() -> ModuleType:
    path = Path(__file__).parents[3] / "tools" / "launch.py"
    spec = importlib.util.spec_from_file_location("nodal_launch_tool", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher = _load_launcher()


def test_runtime_modes_map_to_explicit_uv_install_branches() -> None:
    assert launcher.sync_command("uv", "core") == ["uv", "sync", "--frozen"]
    assert launcher.sync_command("uv", "cpu") == [
        "uv",
        "sync",
        "--frozen",
        "--group",
        "diffusion",
    ]
    assert launcher.sync_command("uv", "cuda") == [
        "uv",
        "sync",
        "--frozen",
        "--extra",
        "cuda",
    ]


def test_noninteractive_first_run_chooses_visible_lightweight_mode(tmp_path: Path) -> None:
    runtime, persist = launcher.choose_runtime(
        None,
        environ={},
        config=tmp_path / "missing",
        interactive=False,
    )
    assert runtime == "core"
    assert persist is False


def test_saved_runtime_is_reused_and_invalid_value_is_rejected(tmp_path: Path) -> None:
    config = tmp_path / "runtime"
    config.write_text("cuda\n", encoding="utf-8")
    assert launcher.choose_runtime(None, environ={}, config=config, interactive=False) == (
        "cuda",
        False,
    )

    config.write_text("mystery\n", encoding="utf-8")
    with pytest.raises(ValueError, match="core, cpu, cuda"):
        launcher.choose_runtime(None, environ={}, config=config, interactive=False)
