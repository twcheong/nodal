"""nodal의 MCP streamable HTTP 표면 (docs/design.md §12).

템플릿 카탈로그 · 실행 큐 · 에셋 저장소를 REST 서버와 공유한다. 이 모듈은 그래프를
실행하지 않고 `RunQueue`에 넣으며, 템플릿의 JSON Schema를 다시 만들지 않는다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import Sequence
from typing import Any

from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from mcp.server.session import ServerSession
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.exceptions import MCPError
from mcp_types import (
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
)
from starlette.applications import Starlette

from nodal import NodeRegistry, prepare_for_execution

from .hub import EventHub
from .queue import RunQueue, RunRecord
from .templates import (
    AssetReferenceNotSupportedError,
    Template,
    TemplateCatalog,
    build_call_graph,
    collect_results,
)
from .wire import issue_models

__all__ = ["MCPService", "transport_security"]

_LOGGER = logging.getLogger("nodal.server.mcp")

_EMPTY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}
_RUN_ID_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"run_id": {"type": "string"}},
    "required": ["run_id"],
    "additionalProperties": False,
}


def transport_security(
    host: str,
    port: int,
    extra_origins: Sequence[str] = (),
) -> TransportSecuritySettings:
    """`/mcp` 전용 DNS rebinding 방어 설정 (§12.9).

    Origin이 없으면 SDK 미들웨어가 통과시키고, 있으면 이 정확한 목록과 비교한다.
    Host도 함께 검사해 목적지 자체가 다른 요청은 Origin 검사 전에 거부한다.
    """
    origins = [f"http://127.0.0.1:{port}", f"http://localhost:{port}"]
    origins.extend(extra_origins)

    hosts = [f"127.0.0.1:{port}", f"localhost:{port}"]
    if host not in {"0.0.0.0", "::", "127.0.0.1", "localhost"}:
        hosts.append(f"{host}:{port}")

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(dict.fromkeys(hosts)),
        allowed_origins=list(dict.fromkeys(origins)),
    )


class MCPService:
    """카탈로그를 동적 MCP 툴로 내보내는 얇은 배선 층."""

    def __init__(
        self,
        catalog: TemplateCatalog,
        registry: NodeRegistry,
        runs: RunQueue,
        hub: EventHub,
    ) -> None:
        self.catalog = catalog
        self._registry = registry
        self._runs = runs
        self._hub = hub
        self._progress_tasks: set[asyncio.Task[None]] = set()
        self.server: Server[dict[str, Any]] = Server(
            "nodal",
            version="1",
            title="nodal",
            description="검증된 nodal 템플릿을 비동기로 실행한다.",
            on_list_tools=self._list_tools,
            on_call_tool=self._call_tool,
        )

    def streamable_http_app(
        self,
        *,
        host: str,
        port: int,
        allowed_origins: Sequence[str] = (),
    ) -> Starlette:
        """FastAPI와 같은 프로세스에 붙일 `/mcp` ASGI 앱."""
        return self.server.streamable_http_app(
            streamable_http_path="/mcp",
            json_response=True,
            transport_security=transport_security(host, port, allowed_origins),
            host=host,
        )

    async def aclose(self) -> None:
        """연결이 끊긴 progress 전달 작업만 정리한다. 실행은 RunQueue가 소유한다."""
        tasks = tuple(self._progress_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _list_tools(
        self,
        _: ServerRequestContext[dict[str, Any]],
        __: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        tools = [
            Tool(
                name="list_templates",
                description="로드된 템플릿과 거부된 파일 및 그 사유를 모두 보여준다.",
                input_schema=_EMPTY_SCHEMA,
            ),
            Tool(
                name="get_run",
                description="run_id의 현재 상태, 진행률, 결과 에셋 참조를 돌려준다.",
                input_schema=_RUN_ID_SCHEMA,
            ),
            Tool(
                name="cancel_run",
                description="협조적 취소를 요청한다. 종단 상태면 그 상태를 그대로 돌려준다.",
                input_schema=_RUN_ID_SCHEMA,
            ),
        ]
        tools.extend(
            Tool(
                name=template.tool_name,
                description=template.describe(),
                input_schema=template.input_schema,
            )
            for template in self.catalog.templates
        )
        return ListToolsResult(tools=tools)

    async def _call_tool(
        self,
        context: ServerRequestContext[dict[str, Any]],
        request: CallToolRequestParams,
    ) -> CallToolResult:
        arguments = request.arguments or {}
        match request.name:
            case "list_templates":
                return _result(self._catalog_payload())
            case "get_run":
                return self._get_run(_run_id(arguments))
            case "cancel_run":
                return self._cancel_run(_run_id(arguments))

        template = self.catalog.by_tool_name(request.name)
        if template is None:
            raise MCPError(METHOD_NOT_FOUND, f"그런 툴이 없다: {request.name!r}")
        return await self._run_template(template, arguments, context)

    async def _run_template(
        self,
        template: Template,
        arguments: dict[str, Any],
        context: ServerRequestContext[dict[str, Any]],
    ) -> CallToolResult:
        try:
            graph = build_call_graph(template, arguments)
        except AssetReferenceNotSupportedError as exc:
            return _error("asset_reference_not_supported", str(exc))

        prepared = prepare_for_execution(graph, self._registry, graph.outputs)
        if prepared.issues:
            issues = [issue.model_dump(mode="json") for issue in issue_models(prepared.issues)]
            return _error(
                "graph_invalid",
                f"그래프 검증 실패 ({len(issues)}건)",
                issues=issues,
            )

        run_id = uuid.uuid4().hex
        progress_task = await self._start_progress(context, run_id)
        try:
            record = self._runs.enqueue(
                graph,
                graph.outputs,
                run_id=run_id,
                template_id=template.id,
            )
        except BaseException:
            if progress_task is not None:
                progress_task.cancel()
            raise
        return _result({"run_id": record.run_id, "status": record.status.value})

    def _get_run(self, run_id: str) -> CallToolResult:
        record = self._runs.get(run_id)
        if record is None:
            return _error("run_not_found", f"그런 실행이 없다: {run_id!r}")

        results: dict[str, Any] = {}
        if record.status.value == "succeeded" and record.template_id is not None:
            template = self.catalog.get(record.template_id)
            if template is not None:
                results = {
                    name: reference.model_dump(mode="json")
                    for name, reference in collect_results(template, record).items()
                }

        payload: dict[str, Any] = {
            "run_id": record.run_id,
            "status": record.status.value,
            "progress": _progress(record),
            "results": results,
        }
        if record.error is not None:
            payload["error"] = record.error.model_dump(mode="json")
        return _result(payload)

    def _cancel_run(self, run_id: str) -> CallToolResult:
        record = self._runs.cancel(run_id)
        if record is None:
            return _error("run_not_found", f"그런 실행이 없다: {run_id!r}")
        return _result({"run_id": record.run_id, "status": record.status.value})

    def _catalog_payload(self) -> dict[str, Any]:
        return {
            "loaded": [
                {
                    "id": template.id,
                    "tool_name": template.tool_name,
                    "description": template.describe(),
                    "input_schema": template.input_schema,
                    "returns": list(template.returns),
                }
                for template in self.catalog.templates
            ],
            "rejected": [
                {
                    "path": str(rejection.path),
                    "reason": rejection.reason,
                    "details": [
                        {"param": detail.param, "reason": detail.reason}
                        for detail in rejection.details
                    ],
                }
                for rejection in self.catalog.rejections
            ],
        }

    async def _start_progress(
        self,
        context: ServerRequestContext[dict[str, Any]],
        run_id: str,
    ) -> asyncio.Task[None] | None:
        token = context.meta.get("progress_token") if context.meta is not None else None
        if token is None:
            return None

        ready = asyncio.Event()
        task = asyncio.create_task(
            self._forward_progress(context.session, token, run_id, ready),
            name=f"nodal-mcp-progress-{run_id}",
        )
        self._progress_tasks.add(task)
        task.add_done_callback(self._progress_tasks.discard)
        await ready.wait()
        return task

    async def _forward_progress(
        self,
        session: ServerSession,
        token: str | int,
        run_id: str,
        ready: asyncio.Event,
    ) -> None:
        """해당 실행의 node.progress만 MCP 알림으로 옮긴다.

        전송 실패는 실행을 건드리지 않는다. 정확성은 `get_run` 폴링에 있다 (§12.6).
        """
        try:
            with self._hub.subscribe() as subscription:
                ready.set()
                while True:
                    message = await subscription.next()
                    if message.get("run_id") != run_id:
                        continue
                    if message.get("t") == "node.progress":
                        await session.send_progress_notification(
                            token,
                            float(message["step"]),
                            float(message["total"]),
                            str(message["node_id"]),
                        )
                    if message.get("t") in {"run.done", "run.failed", "run.cancelled"}:
                        return
        except asyncio.CancelledError:
            raise
        except Exception:
            _LOGGER.debug("MCP progress 전달을 중단했다: run_id=%s", run_id, exc_info=True)
        finally:
            ready.set()


def _run_id(arguments: dict[str, Any]) -> str:
    run_id = arguments.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise MCPError(INVALID_PARAMS, "run_id는 비어 있지 않은 문자열이어야 한다")
    return run_id


def _progress(record: RunRecord) -> dict[str, Any]:
    return {
        "completed_nodes": record.progress_completed,
        "total_nodes": record.progress_total,
        "node_id": record.progress_node_id,
        "step": record.progress_step,
        "total_steps": record.progress_steps,
    }


def _result(payload: dict[str, Any], *, is_error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(text=json.dumps(payload, ensure_ascii=False))],
        structured_content=payload,
        is_error=is_error,
    )


def _error(
    code: str,
    message: str,
    *,
    issues: list[dict[str, Any]] | None = None,
) -> CallToolResult:
    return _result(
        {"code": code, "message": message, "issues": issues or []},
        is_error=True,
    )
