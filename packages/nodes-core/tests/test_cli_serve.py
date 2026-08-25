"""`nodal serve`의 MCP 합성 옵션과 시작 진단."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import uvicorn

import nodal_nodes_core.cli as cli
import nodal_server.app as server_app
import nodal_server.templates as templates
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
    created: dict[str, Any] = {}
    launched: dict[str, Any] = {}

    monkeypatch.setattr(cli, "_build_registry", lambda *args, **kwargs: registry)
    monkeypatch.setattr(cli, "_build_model_store", lambda root: None)
    monkeypatch.setattr(cli, "_print_models_line", lambda models: None)
    monkeypatch.setattr(templates, "load_catalog", lambda root: catalog)

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
        assets=None,
        host="127.0.0.1",
        port=8188,
        mcp_allow_origin=["https://client.example"],
        log_level="info",
    )

    assert cli._serve(args) == 0

    output = capsys.readouterr().out
    assert "로드 1개 · 거부 1개" in output
    assert "broken.nodal.json: 정의 이름이 파일명과 다르다" in output
    assert "경고: 에셋 저장소가 메모리다" in output
    assert created == {
        "registry": registry,
        "assets_root": None,
        "models": None,
        "template_catalog": catalog,
        "mcp_host": "127.0.0.1",
        "mcp_port": 8188,
        "mcp_allowed_origins": ["https://client.example"],
    }
    assert launched == {
        "app": "app",
        "host": "127.0.0.1",
        "port": 8188,
        "log_level": "info",
    }
