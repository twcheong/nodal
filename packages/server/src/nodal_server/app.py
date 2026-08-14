"""FastAPI 앱 — 라우트 계약 (docs/design.md §6).

> **계약 파일.** 라우트 데코레이터(경로 · 응답 모델 · 상태 코드)는
> `schemas/openapi.json` 을 결정한다. 프론트가 그 산출물에서 타입을 생성하고
> 있으므로 **데코레이터를 바꾸면 프론트가 통째로 어긋난다** (AGENTS.md 협업 규칙 7).

노드 레지스트리는 **주입받는다.** 서버는 어떤 노드 팩도 import 하지 않는다 —
의존성은 `server → core` 한 방향뿐이다 (AGENTS.md 아키텍처 절).

`/ws` 이벤트는 OpenAPI 가 다루지 않는다. `tools/export_openapi.py` 가
`components.schemas` 에 주입하고 `x-nodal-ws-events` 로 표시한다.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Path, Query, UploadFile, WebSocket, status
from fastapi.responses import JSONResponse, Response
from fastapi.websockets import WebSocketDisconnect

from nodal import Cache, NodeRegistry, load_catalog, validate_for_execution

from .assets import AssetStore
from .hub import EventHub
from .queue import RunQueue, RunRecord
from .schemas import (
    AssetInfo,
    CancelRunResponse,
    CreateRunRequest,
    CreateRunResponse,
    ErrorResponse,
    ExtensionsResponse,
    GraphFromPngResponse,
    ModelsResponse,
    NodeSchemaModel,
    NodesResponse,
    RunDetail,
    RunListResponse,
    RunSummary,
    ValidateRequest,
    ValidateResponse,
)
from .wire import error_body, issue_models, node_schema_model, refs_from_values

__all__ = ["create_app"]

_LOGGER = logging.getLogger("nodal.server")

API_VERSION = "1"

#: 모든 엔드포인트가 공유하는 실패 응답. 본문은 언제나 `ErrorResponse` 다.
_ERRORS: dict[int | str, dict[str, object]] = {
    status.HTTP_400_BAD_REQUEST: {"model": ErrorResponse, "description": "요청이 잘못됐다"},
    status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": "대상이 없다"},
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "model": ErrorResponse,
        "description": "그래프 검증 실패. `issues` 가 어느 노드·어느 소켓인지 지목한다",
    },
    status.HTTP_501_NOT_IMPLEMENTED: {
        "model": ErrorResponse,
        "description": "계약은 확정됐지만 아직 구현되지 않았다 (M3)",
    },
}


class _ApiError(HTTPException):
    """OpenAPI 에 선언한 `ErrorResponse`를 그대로 내보내는 내부 예외."""

    def __init__(self, status_code: int, body: ErrorResponse) -> None:
        super().__init__(status_code=status_code)
        self.body = body


def _http_error(
    status_code: int,
    code: str,
    message: str,
    issues: object = (),
) -> _ApiError:
    """`ErrorResponse` 모양을 갖춘 예외. 에러 본문은 언제나 하나의 모양이다."""
    body = error_body(code, message, issues)  # type: ignore[arg-type]
    return _ApiError(status_code, ErrorResponse(error=body))


def create_app(
    registry: NodeRegistry | None = None,
    *,
    cache: Cache | None = None,
    history_limit: int = 100,
) -> FastAPI:
    """앱을 만든다. 테스트가 자기 인스턴스를 갖도록 팩토리로 둔다.

    Args:
        registry: 실행에 쓸 노드 레지스트리. 서버는 노드 팩을 import 하지 않으므로
            호출자가 채워서 넘긴다. 없으면 빈 레지스트리 — 모든 실행이 "등록되지
            않은 노드 타입"으로 실패한다.
        cache: 실행 사이에 공유할 캐시. 없으면 LRU 를 새로 만든다.
        history_limit: 히스토리 보관 상한.
    """
    node_registry = registry if registry is not None else NodeRegistry()
    hub = EventHub()
    assets = AssetStore()
    runs = RunQueue(
        node_registry,
        hub,
        cache=cache,
        assets=assets,
        history_limit=history_limit,
    )

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        runs.start()
        try:
            yield
        finally:
            await runs.aclose()

    app = FastAPI(
        lifespan=lifespan,
        title="nodal API",
        version=API_VERSION,
        summary="노드 그래프 실행 서버",
        description=(
            "캐논 그래프를 그대로 주고받는다. 변환 레이어가 없다.\n\n"
            "모든 실패 응답의 본문은 `ErrorResponse` 이고, `issues[].location` 이 "
            "`nodes.<id>.inputs.<socket>` 경로를 준다 — 프론트는 이것으로 캔버스의 "
            "해당 소켓을 지목한다."
        ),
    )

    @app.exception_handler(_ApiError)
    async def api_error_handler(_: object, exc: _ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.body.model_dump(mode="json"),
        )

    # ---------------------------------------------------------- 노드 · 검증

    @app.get(
        "/api/nodes",
        response_model=NodesResponse,
        summary="전체 노드 스키마",
        description="프론트 팔레트의 유일한 소스. 등록된 모든 노드의 입출력 소켓을 준다.",
        tags=["nodes"],
    )
    async def list_nodes() -> NodesResponse:
        models: list[NodeSchemaModel] = [
            node_schema_model(schema)
            for schema in sorted(node_registry, key=lambda schema: schema.id)
        ]
        return NodesResponse(nodes=models, types_version=load_catalog().version)

    @app.post(
        "/api/graph/validate",
        response_model=ValidateResponse,
        responses=_ERRORS,
        summary="실행 없이 검증만",
        description=(
            "구조 · 노드 타입 · 소켓 타입 호환성을 검사한다. **무효한 그래프도 200** 이다 "
            "— 검증은 질의이지 명령이 아니므로 `valid: false` 가 성공적인 답이다."
        ),
        tags=["graph"],
    )
    async def validate_graph_endpoint(request: ValidateRequest) -> ValidateResponse:
        outputs = request.outputs if request.outputs is not None else list(request.graph.outputs)
        issues = validate_for_execution(request.graph, node_registry, outputs)
        return ValidateResponse(valid=not issues, issues=issue_models(issues))

    # ---------------------------------------------------------------- 실행

    @app.post(
        "/api/runs",
        response_model=CreateRunResponse,
        status_code=status.HTTP_202_ACCEPTED,
        responses=_ERRORS,
        summary="실행 큐에 등록",
        description=(
            "큐에 넣고 즉시 돌아온다. 진행 상황은 `/ws` 로 본다.\n\n"
            "큐 진입 전에 전체 검증을 통과해야 한다 — 실패하면 422 와 `issues`."
        ),
        tags=["runs"],
    )
    async def create_run(request: CreateRunRequest) -> CreateRunResponse:
        outputs = request.outputs if request.outputs is not None else list(request.graph.outputs)
        if not outputs:
            raise _http_error(
                status.HTTP_400_BAD_REQUEST,
                "no_outputs",
                "실행할 출력 노드가 없다. 그래프의 `outputs` 를 채우거나 `outputs` 를 지정하라",
            )

        # 큐 진입 전에 전체 검증. 첫 노드를 돌리기 전에 실패시킨다 (design.md §2 원칙 2).
        issues = validate_for_execution(request.graph, node_registry, outputs)
        if issues:
            raise _http_error(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "graph_invalid",
                f"그래프 검증 실패 ({len(issues)}건)",
                issues,
            )

        record = runs.enqueue(
            request.graph,
            outputs,
            use_cache=request.use_cache,
            priority=request.priority,
        )
        return CreateRunResponse(run_id=record.run_id, status=record.status)

    @app.get(
        "/api/runs",
        response_model=RunListResponse,
        summary="큐와 히스토리",
        tags=["runs"],
    )
    async def list_runs(
        limit: Annotated[int, Query(ge=1, le=500, description="히스토리 최대 개수")] = 50,
    ) -> RunListResponse:
        running = runs.running
        return RunListResponse(
            running=_summary(running) if running is not None else None,
            queued=[_summary(record) for record in runs.queued()],
            history=[_summary(record) for record in runs.history(limit)],
            limit=runs.history_limit,
        )

    @app.get(
        "/api/runs/{run_id}",
        response_model=RunDetail,
        responses=_ERRORS,
        summary="상태와 결과",
        tags=["runs"],
    )
    async def get_run(run_id: Annotated[str, Path(description="실행 ID")]) -> RunDetail:
        record = runs.get(run_id)
        if record is None:
            raise _http_error(
                status.HTTP_404_NOT_FOUND, "run_not_found", f"그런 실행이 없다: {run_id!r}"
            )
        return _detail(record)

    @app.delete(
        "/api/runs/{run_id}",
        response_model=CancelRunResponse,
        responses=_ERRORS,
        summary="취소",
        description=("협조적 취소를 요청한다. 이미 끝난 실행이면 그때의 상태가 그대로 돌아온다."),
        tags=["runs"],
    )
    async def cancel_run(run_id: Annotated[str, Path(description="실행 ID")]) -> CancelRunResponse:
        record = runs.cancel(run_id)
        if record is None:
            raise _http_error(
                status.HTTP_404_NOT_FOUND, "run_not_found", f"그런 실행이 없다: {run_id!r}"
            )
        return CancelRunResponse(run_id=record.run_id, status=record.status)

    # ------------------------------------------------------ 모델 · 에셋 · 확장

    @app.get(
        "/api/models",
        response_model=ModelsResponse,
        summary="발견된 모델 목록",
        description="M4 까지는 빈 목록이 나간다. 형태만 먼저 고정한다.",
        tags=["models"],
    )
    async def list_models() -> ModelsResponse:
        # 모델 스캐너는 M4 다 (roadmap M4). 형태만 고정하고 빈 목록을 낸다 —
        # 프론트가 "아직 없음"과 "엔드포인트 없음"을 구분할 수 있어야 한다.
        return ModelsResponse(models=[], kinds=[])

    @app.post(
        "/api/graph/from-png",
        response_model=GraphFromPngResponse,
        responses=_ERRORS,
        summary="PNG 에서 워크플로 복원",
        description=(
            "PNG 의 `nodal_workflow` iTXt 청크에서 캐논 그래프를 꺼낸다. "
            "프론트의 드래그앤드롭이 이 엔드포인트로 파일을 던진다 — iTXt 파서를 "
            "Python·TS 양쪽에 두지 않기 위해서다.\n\n"
            "**M3 계약 시점에는 아직 구현되지 않았다.** 501 을 돌려준다."
        ),
        tags=["graph"],
    )
    async def graph_from_png(
        file: Annotated[UploadFile, File(description="`nodal_workflow` iTXt 청크를 담은 PNG")],
    ) -> GraphFromPngResponse:
        raise _http_error(
            status.HTTP_501_NOT_IMPLEMENTED,
            "not_implemented",
            "PNG 워크플로 복원은 M3 구현 단계에서 채운다 (계약만 확정됨)",
        )

    @app.post(
        "/api/assets",
        response_model=AssetInfo,
        status_code=status.HTTP_201_CREATED,
        responses=_ERRORS,
        summary="입력 파일 업로드",
        description="content-addressed 로 저장한다. 같은 내용이면 같은 해시가 돌아온다.",
        tags=["assets"],
    )
    async def upload_asset(
        file: Annotated[UploadFile, File(description="업로드할 파일")],
    ) -> AssetInfo:
        data = await file.read()
        try:
            stored = assets.put(
                data,
                media_type=file.content_type or "application/octet-stream",
                filename=file.filename,
            )
        except ValueError as exc:
            raise _http_error(status.HTTP_400_BAD_REQUEST, "asset_too_large", str(exc)) from exc
        # width/height 는 M3 구현에서 이미지 디코딩이 붙을 때 채운다.
        # 저장소는 바이트만 알고 픽셀 크기는 넣는 쪽이 알려준다 (nodal.AssetRef).
        return AssetInfo(
            hash=stored.hash,
            size_bytes=stored.size_bytes,
            media_type=stored.media_type,
            filename=file.filename,
            width=stored.width,
            height=stored.height,
        )

    @app.get(
        "/api/assets/{asset_hash}",
        response_class=Response,
        responses={
            200: {
                "content": {
                    "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
                },
                "description": "파일 내용 그대로. `Content-Type` 은 업로드 시 판별된 것",
            },
            **_ERRORS,
        },
        summary="content-addressed 조회",
        tags=["assets"],
    )
    async def get_asset(asset_hash: Annotated[str, Path(description="내용 해시")]) -> Response:
        data = assets.get(asset_hash)
        ref = assets.ref(asset_hash)
        if data is None or ref is None:
            raise _http_error(
                status.HTTP_404_NOT_FOUND, "asset_not_found", f"그런 에셋이 없다: {asset_hash!r}"
            )
        return Response(content=data, media_type=ref.media_type)

    @app.get(
        "/api/extensions",
        response_model=ExtensionsResponse,
        summary="로드된 확장 · 실패한 확장",
        description="M6 까지는 빈 목록이 나간다. 실패한 확장을 숨기지 않는 것이 요점이다.",
        tags=["extensions"],
    )
    async def list_extensions() -> ExtensionsResponse:
        # 확장 로더는 M6 다 (roadmap M6). 실패한 확장을 숨기지 않는다는 계약만
        # 먼저 세워 둔다 — 지금은 로드한 것도 실패한 것도 없다.
        return ExtensionsResponse(loaded=[], failed=[])

    # ------------------------------------------------------------------ WS

    @app.websocket("/ws")
    async def events_socket(socket: WebSocket) -> None:
        """진행률 · 프리뷰 · 캐시 히트 · 큐 상태를 흘려보내는 전역 스트림.

        모든 메시지는 `WsEvent` 유니온의 한 항목이고 `t` 로 판별한다. 모든
        이벤트가 `run_id` 를 실으므로 (`queue` 제외) 클라이언트는 하나의 연결로
        여러 실행을 구분할 수 있다.

        OpenAPI 는 WS 를 다루지 않으므로 이벤트 스키마는
        `tools/export_openapi.py` 가 `components.schemas` 에 주입한다.

        이 클라이언트가 끊겨도 실행은 계속된다 — 구독이 정리될 뿐이다.
        """
        await socket.accept()
        try:
            async for message in hub.stream():
                await socket.send_json(message)
        except WebSocketDisconnect:
            pass
        except Exception:
            _LOGGER.debug("WS 클라이언트가 비정상 종료했다", exc_info=True)
        finally:
            with contextlib.suppress(Exception):
                await socket.close()

    # ------------------------------------------------------------ 응답 조립

    def _summary(record: RunRecord) -> RunSummary:
        return RunSummary(
            run_id=record.run_id,
            status=record.status,
            node_count=record.node_count,
            elapsed_ms=record.elapsed_ms,
            created_at=record.created_at,
            started_at=record.started_at,
            finished_at=record.finished_at,
        )

    def _detail(record: RunRecord) -> RunDetail:
        result = record.result
        outputs = {}
        if result is not None:
            for node_id, values in result.outputs.items():
                node = record.graph.nodes.get(node_id)
                schema = node_registry.schemas().get(node.type) if node is not None else None
                outputs[node_id] = refs_from_values(
                    values,
                    schema,
                    result.references.get(node_id),
                )

        return RunDetail(
            run_id=record.run_id,
            status=record.status,
            outputs=outputs,
            executed=list(result.executed) if result else [],
            cached=list(result.cached) if result else [],
            blocked=list(result.blocked) if result else [],
            elapsed_ms=record.elapsed_ms,
            created_at=record.created_at,
            started_at=record.started_at,
            finished_at=record.finished_at,
            error=record.error,
        )

    return app
