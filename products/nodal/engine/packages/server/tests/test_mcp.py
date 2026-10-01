"""MCP 표면의 보안 경계와 템플릿 실행 계약 (design.md §12)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from mcp import Client

from nodal import NodeProgress, NodeRegistry, RunDone
from nodal_server.app import create_app
from nodal_server.hub import EventHub
from nodal_server.mcp_server import MCPService
from nodal_server.queue import RunQueue
from nodal_server.templates import TemplateCatalog, load_catalog


def _template_document() -> dict[str, Any]:
    return {
        "nodal_version": "1",
        "definitions": {
            "demo": {
                "doc": "정수를 그대로 돌려주는 테스트 템플릿.",
                "params": {"value": {"type": "INT"}},
                "nodes": {
                    "out": {
                        "type": "test.Const",
                        "inputs": {"value": {"$param": "value"}},
                    }
                },
                "returns": {"result": {"$link": ["out", "value"]}},
            }
        },
    }


def _catalog(tmp_path: Path) -> TemplateCatalog:
    (tmp_path / "demo.nodal.json").write_text(
        json.dumps(_template_document(), ensure_ascii=False),
        encoding="utf-8",
    )
    # 파일명과 정의 이름이 다르다. list_templates가 이 거부와 이유도 보여야 한다.
    (tmp_path / "broken.nodal.json").write_text(
        json.dumps(_template_document(), ensure_ascii=False),
        encoding="utf-8",
    )
    return load_catalog(tmp_path)


def _initialize(
    client: TestClient,
    *,
    origin: str | None = None,
    host: str = "127.0.0.1:8188",
):
    headers = {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        "host": host,
    }
    if origin is not None:
        headers["origin"] = origin
    return client.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )


def test_mcp_without_origin_is_allowed(registry: NodeRegistry) -> None:
    """비브라우저 클라이언트는 Origin을 보내지 않는다."""
    with TestClient(create_app(registry)) as client:
        response = _initialize(client)

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_mcp_with_server_origin_is_allowed(registry: NodeRegistry) -> None:
    with TestClient(
        create_app(
            registry,
            mcp_allowed_origins=["https://client.example"],
        )
    ) as client:
        server_origin = _initialize(client, origin="http://localhost:8188")
        configured_origin = _initialize(client, origin="https://client.example")

    assert server_origin.status_code == 200
    assert configured_origin.status_code == 200


def test_mcp_with_unfamiliar_origin_is_rejected_with_reason(registry: NodeRegistry) -> None:
    with TestClient(create_app(registry)) as client:
        response = _initialize(client, origin="http://evil.example")

    assert response.status_code == 403
    assert "Origin" in response.text


def test_mcp_checks_host_too(registry: NodeRegistry) -> None:
    with TestClient(create_app(registry)) as client:
        response = _initialize(client, host="attacker.example")

    assert response.status_code in {403, 421}
    assert "Host" in response.text


def test_origin_check_is_not_global_rest_middleware(registry: NodeRegistry) -> None:
    """Vite의 localhost:5173 Origin은 REST 프록시를 깨뜨리지 않는다."""
    with TestClient(create_app(registry)) as client:
        response = client.get(
            "/api/nodes",
            headers={"origin": "http://localhost:5173"},
        )
        unknown = client.get(
            "/not-mcp",
            headers={"origin": "http://evil.example"},
        )

    assert response.status_code == 200
    assert unknown.status_code == 404, "Origin 검사는 정확히 /mcp에만 걸린다"


def test_mcp_and_rest_share_server_instances(
    registry: NodeRegistry,
    tmp_path: Path,
) -> None:
    app = create_app(registry, template_catalog=_catalog(tmp_path))

    assert app.state.mcp.catalog is app.state.catalog
    assert app.state.mcp._runs is app.state.runs
    assert app.state.mcp._hub is app.state.hub
    assert app.state.runs._assets is app.state.assets


async def test_dynamic_tools_and_run_lifecycle(
    registry: NodeRegistry,
    tmp_path: Path,
) -> None:
    catalog = _catalog(tmp_path)
    hub = EventHub()
    runs = RunQueue(registry, hub)
    service = MCPService(catalog, registry, runs, hub)
    runs.start()
    try:
        async with Client(service.server) as client:
            listed = await client.list_tools()
            tools = {tool.name: tool for tool in listed.tools}
            template = catalog.get("demo")
            assert template is not None
            assert set(tools) == {
                "list_templates",
                "get_run",
                "cancel_run",
                "run_template_demo",
            }
            assert "execute_graph" not in tools
            tool_schema = tools[template.tool_name].input_schema
            assert tool_schema["properties"]["use_cache"] == {
                "type": "boolean",
                "description": "실행 간 입력 시그니처 캐시를 사용한다. 기본값은 true.",
                "default": True,
            }
            assert tool_schema["required"] == template.input_schema["required"]
            assert "use_cache" not in template.input_schema["properties"]
            assert "running일 수" in tools["cancel_run"].description
            assert tools[template.tool_name].description == template.describe()

            catalog_result = await client.call_tool("list_templates", {})
            assert catalog_result.is_error is False
            assert [item["id"] for item in catalog_result.structured_content["loaded"]] == ["demo"]
            catalog_schema = catalog_result.structured_content["loaded"][0]["input_schema"]
            assert catalog_schema["properties"]["use_cache"]["default"] is True
            (rejected,) = catalog_result.structured_content["rejected"]
            assert rejected["path"].endswith("broken.nodal.json")
            assert "broken" in rejected["reason"]

            invalid = await client.call_tool("run_template_demo", {})
            assert invalid.is_error is True
            issue = next(
                issue
                for issue in invalid.structured_content["issues"]
                if issue["node_id"] == "call"
            )
            assert issue["socket"] == "value"
            assert runs.pending_count == 0

            created = await client.call_tool("run_template_demo", {"value": 7, "use_cache": False})
            assert created.is_error is False
            assert created.structured_content["status"] == "queued"
            assert hub.subscriber_count == 0, "progress token이 없으면 구독하지 않는다"
            run_id = created.structured_content["run_id"]
            record = runs.get(run_id)
            assert record is not None
            assert record.use_cache is False
            # REST 목록·상세(`_summary`·`_detail`)가 이 값을 그대로 싣는다 — 앱 패널이
            # 실행을 템플릿 그래프에 겹쳐 그릴 때 쓴다.
            assert record.template_id == "demo"

            # 기본 get_run 은 실행이 끝날 때까지 기다린다 — 호출자가 폴링하지 않는다.
            current = await client.call_tool("get_run", {"run_id": run_id})
            detail: dict[str, Any] = current.structured_content
            assert detail["status"] == "succeeded"

            with pytest.raises(Exception, match="wait_seconds"):
                await client.call_tool("get_run", {"run_id": run_id, "wait_seconds": -1})
            snapshot = await client.call_tool("get_run", {"run_id": run_id, "wait_seconds": 0})
            assert snapshot.structured_content["status"] == "succeeded"
            assert detail["use_cache"] is False
            assert detail["elapsed_ms"] is not None
            assert detail["executed"] == ["call:out"]
            assert detail["cached"] == []
            assert detail["progress"]["completed_nodes"] == detail["progress"]["total_nodes"]
            assert detail["results"] == {
                "result": {
                    "socket": "value",
                    "type": "INT",
                    "inline": 7,
                    "asset": None,
                }
            }

            terminal_cancel = await client.call_tool("cancel_run", {"run_id": run_id})
            assert terminal_cancel.is_error is False
            assert terminal_cancel.structured_content["status"] == "succeeded"

            missing_get = await client.call_tool("get_run", {"run_id": "missing"})
            missing_cancel = await client.call_tool("cancel_run", {"run_id": "missing"})
            assert missing_get.is_error is True
            assert missing_get.structured_content["code"] == "run_not_found"
            assert missing_cancel.is_error is True
            assert missing_cancel.structured_content["code"] == "run_not_found"
    finally:
        await service.aclose()
        await runs.aclose()


async def test_progress_forwarder_filters_run_id(
    registry: NodeRegistry,
    tmp_path: Path,
) -> None:
    class Session:
        def __init__(self) -> None:
            self.notifications: list[tuple[str | int, float, float | None, str | None]] = []

        async def send_progress_notification(
            self,
            token: str | int,
            progress: float,
            total: float | None = None,
            message: str | None = None,
        ) -> None:
            self.notifications.append((token, progress, total, message))

    hub = EventHub()
    runs = RunQueue(registry, hub)
    service = MCPService(_catalog(tmp_path), registry, runs, hub)
    session = Session()
    ready = asyncio.Event()
    task = asyncio.create_task(
        service._forward_progress(  # type: ignore[arg-type]
            session,
            "progress-token",
            "wanted",
            ready,
        )
    )
    await ready.wait()

    hub.emit(NodeProgress("node.progress", "other", "slow", 1, 3))
    hub.emit(NodeProgress("node.progress", "wanted", "slow", 2, 3))
    hub.emit(RunDone("run.done", "wanted", 10))
    await task

    assert session.notifications == [("progress-token", 2.0, 3.0, "slow")]
    assert hub.subscriber_count == 0


class _FakeRecord:
    def __init__(self) -> None:
        self.is_terminal = False


class _FakeRuns:
    def __init__(self, record: _FakeRecord | None) -> None:
        self.record = record

    def get(self, _run_id: str) -> _FakeRecord | None:
        return self.record


async def test_get_run_wait_returns_when_the_run_ends_and_gives_up_at_the_deadline() -> None:
    record = _FakeRecord()
    service = MCPService.__new__(MCPService)
    service._runs = _FakeRuns(record)  # type: ignore[assignment]

    async def finish_later() -> None:
        await asyncio.sleep(0.3)
        record.is_terminal = True

    loop = asyncio.get_running_loop()
    started = loop.time()
    finisher = asyncio.create_task(finish_later())
    await service._wait_for_run("r", 30)
    await finisher
    assert 0.25 <= loop.time() - started < 5, "끝나자마자 돌아와야 한다"

    record.is_terminal = False
    started = loop.time()
    await service._wait_for_run("r", 0.2)
    assert loop.time() - started < 2, "기한이 지나면 running 이어도 돌아온다"

    service._runs = _FakeRuns(None)  # type: ignore[assignment]
    started = loop.time()
    await service._wait_for_run("missing", 30)
    assert loop.time() - started < 1, "없는 실행은 기다리지 않는다"
