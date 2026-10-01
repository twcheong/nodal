"""`nodal serve`의 MCP 합성 옵션과 시작 진단."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import uvicorn

import nodal_nodes_core.cli as cli
import nodal_server.app as server_app
import nodal_server.templates as templates
from nodal import ExtensionRecord, ExtensionsResult
from nodal_server.templates import Rejection, TemplateCatalog


class _Registry:
    def __len__(self) -> int:
        return 3


def test_serve_parser_accepts_templates_and_repeated_origins(tmp_path: Path) -> None:
    args = cli._parser().parse_args(
        [
            "serve",
            "--templates",
            str(tmp_path),
            "--mcp-allow-origin",
            "https://one.example",
            "--mcp-allow-origin",
            "https://two.example",
        ]
    )

    assert args.templates == tmp_path
    assert args.mcp_allow_origin == ["https://one.example", "https://two.example"]


def test_extensions_flag_is_available_on_all_registry_commands(tmp_path: Path) -> None:
    """실행·검증·목록·서버가 같은 확장 경로를 재현한다."""
    for command, extra in (
        ("run", ["graph.json"]),
        ("validate", ["graph.json"]),
        ("serve", []),
        ("nodes", []),
    ):
        args = cli._parser().parse_args([command, *extra, "--extensions", str(tmp_path)])
        assert args.extensions == tmp_path


def test_serve_logs_catalog_rejections_and_memory_asset_warning(
    monkeypatch: Any,
    capsys: Any,
    tmp_path: Path,
) -> None:
    rejected = Rejection(tmp_path / "broken.nodal.json", "정의 이름이 파일명과 다르다")
    catalog = TemplateCatalog(
        tmp_path,
        templates=(object(),),  # _serve는 시작 개수만 읽는다.
        rejections=(rejected,),
    )
    registry = _Registry()
    ext_result = ExtensionsResult(
        root=tmp_path,
        loaded=(
            ExtensionRecord(
                id="com.example.good",
                name="Good",
                version="0.1.0",
                nodal_api="^0.1",
                root=tmp_path / "good-pack",
                node_count=2,
            ),
        ),
        failed=(
            ExtensionRecord(
                id="com.example.bad",
                name="Bad",
                version="0.0.1",
                nodal_api="^99.0",
                root=tmp_path / "bad-pack",
                error="nodal_api 범위 불일치",
            ),
        ),
    )
    created: dict[str, Any] = {}
    launched: dict[str, Any] = {}

    monkeypatch.setattr(
        cli, "_build_registry_with_extensions", lambda *args, **kwargs: (registry, ext_result)
    )
    monkeypatch.setattr(cli, "_build_model_store", lambda root: None)
    monkeypatch.setattr(cli, "_print_models_line", lambda models: None)
    monkeypatch.setattr(
        templates,
        "load_catalog",
        lambda root, **kwargs: catalog,  # extension_sources 는 무시
    )

    def create_app(*args: Any, **kwargs: Any) -> str:
        created.update({"registry": args[0], **kwargs})
        return "app"

    monkeypatch.setattr(server_app, "create_app", create_app)
    monkeypatch.setattr(
        uvicorn,
        "run",
        lambda app, **kwargs: launched.update({"app": app, **kwargs}),
    )
    args = SimpleNamespace(
        pack=[],
        models=None,
        templates=tmp_path,
        extensions=None,
        assets=None,
        host="127.0.0.1",
        port=8188,
        mcp_allow_origin=["https://client.example"],
        log_level="info",
    )

    assert cli._serve(args) == 0

    output = capsys.readouterr().out
    assert "확장: 로드 1개 · 실패 1개" in output
    assert "bad-pack: nodal_api 범위 불일치" in output
    assert "로드 1개 · 거부 1개" in output
    assert "broken.nodal.json: 정의 이름이 파일명과 다르다" in output
    assert "경고: 에셋 저장소가 메모리다" in output
    assert created == {
        "registry": registry,
        "assets_root": None,
        "models": None,
        "template_catalog": catalog,
        "extensions": ext_result,
        "mcp_host": "127.0.0.1",
        "mcp_port": 8188,
        "mcp_allowed_origins": ["https://client.example"],
        "web_root": None,
    }
    assert launched == {
        "app": "app",
        "host": "127.0.0.1",
        "port": 8188,
        "log_level": "info",
    }


def test_launch_uses_persistent_user_directories_and_web_build(
    monkeypatch: Any,
    capsys: Any,
    tmp_path: Path,
) -> None:
    web = tmp_path / "web"
    paths = {
        "assets": tmp_path / "home" / "assets",
        "models": tmp_path / "home" / "models",
        "templates": tmp_path / "home" / "templates",
        "extensions": tmp_path / "home" / "extensions",
    }
    args = cli._parser().parse_args(
        [
            "launch",
            "--web",
            str(web),
            "--assets",
            str(paths["assets"]),
            "--models",
            str(paths["models"]),
            "--templates",
            str(paths["templates"]),
            "--extensions",
            str(paths["extensions"]),
            "--no-browser",
        ]
    )
    served: dict[str, Any] = {}
    monkeypatch.setattr(cli, "_serve", lambda received: served.update(vars(received)) or 0)

    assert cli._launch(args) == 0

    assert all(path.is_dir() for path in paths.values())
    assert served["web"] == web
    assert served["extensions"] == paths["extensions"]
    output = capsys.readouterr().out
    assert f"확장: {paths['extensions']}" in output


def test_build_registry_reports_extension_failures_on_stderr(capsys: Any, tmp_path: Path) -> None:
    """`run`·`nodes` 처럼 `_build_registry` 만 쓰는 명령도 실패를 조용히 넘기지
    않는다 — `_serve` 전용이 아니다."""
    ext_root = tmp_path / "extensions"
    broken = ext_root / "broken-pack"
    broken.mkdir(parents=True)
    (broken / "nodal.toml").write_text(
        '[extension]\nid = "com.example.broken"\nnodal_api = "^99.0"\n',
        encoding="utf-8",
    )

    registry = cli._build_registry(extensions_dir=ext_root)

    assert "math.Add" in registry  # 기본 팩은 정상적으로 계속 올라온다
    err = capsys.readouterr().err
    assert "확장 로드 실패 1개" in err
    assert "com.example.broken" in err or "broken-pack" in err
