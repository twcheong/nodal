"""FastAPI 앱 — 라우트 계약 (docs/design.md §6).

> **계약 파일.** 라우트 시그니처와 응답 모델만 확정한다. 본문은 M2 구현
> 단계에서 채운다 — 지금 호출하면 501 이 나간다.

이 파일이 존재하는 이유는 `schemas/openapi.json` 을 만들기 위해서다. 프론트는
그 산출물에서 타입을 생성하므로, 라우트가 선언되지 않으면 프론트가 시작할 수
없다.

`/ws` 이벤트는 OpenAPI 가 다루지 않는다. `tools/export_openapi.py` 가
`components.schemas` 에 주입하고 `x-nodal-ws-events` 로 표시한다.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import FastAPI, File, Path, Query, UploadFile, WebSocket, status
from fastapi.responses import Response

from .schemas import (
    AssetInfo,
    CancelRunResponse,
    CreateRunRequest,
    CreateRunResponse,
    ErrorResponse,
    ExtensionsResponse,
    ModelsResponse,
    NodesResponse,
    RunDetail,
    RunListResponse,
    ValidateRequest,
    ValidateResponse,
)

__all__ = ["create_app"]

API_VERSION = "1"

#: 모든 엔드포인트가 공유하는 실패 응답. 본문은 언제나 `ErrorResponse` 다.
_ERRORS: dict[int | str, dict[str, object]] = {
    status.HTTP_400_BAD_REQUEST: {"model": ErrorResponse, "description": "요청이 잘못됐다"},
    status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": "대상이 없다"},
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "model": ErrorResponse,
        "description": "그래프 검증 실패. `issues` 가 어느 노드·어느 소켓인지 지목한다",
    },
}


def create_app() -> FastAPI:
    """앱을 만든다. 테스트가 자기 인스턴스를 갖도록 팩토리로 둔다."""
    app = FastAPI(
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

    # ---------------------------------------------------------- 노드 · 검증

    @app.get(
        "/api/nodes",
        response_model=NodesResponse,
        summary="전체 노드 스키마",
        description="프론트 팔레트의 유일한 소스. 등록된 모든 노드의 입출력 소켓을 준다.",
        tags=["nodes"],
    )
    async def list_nodes() -> NodesResponse:
        raise NotImplementedError

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
        raise NotImplementedError

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
        raise NotImplementedError

    @app.get(
        "/api/runs",
        response_model=RunListResponse,
        summary="큐와 히스토리",
        tags=["runs"],
    )
    async def list_runs(
        limit: Annotated[int, Query(ge=1, le=500, description="히스토리 최대 개수")] = 50,
    ) -> RunListResponse:
        raise NotImplementedError

    @app.get(
        "/api/runs/{run_id}",
        response_model=RunDetail,
        responses=_ERRORS,
        summary="상태와 결과",
        tags=["runs"],
    )
    async def get_run(run_id: Annotated[str, Path(description="실행 ID")]) -> RunDetail:
        raise NotImplementedError

    @app.delete(
        "/api/runs/{run_id}",
        response_model=CancelRunResponse,
        responses=_ERRORS,
        summary="취소",
        description=("협조적 취소를 요청한다. 이미 끝난 실행이면 그때의 상태가 그대로 돌아온다."),
        tags=["runs"],
    )
    async def cancel_run(run_id: Annotated[str, Path(description="실행 ID")]) -> CancelRunResponse:
        raise NotImplementedError

    # ------------------------------------------------------ 모델 · 에셋 · 확장

    @app.get(
        "/api/models",
        response_model=ModelsResponse,
        summary="발견된 모델 목록",
        description="M4 까지는 빈 목록이 나간다. 형태만 먼저 고정한다.",
        tags=["models"],
    )
    async def list_models() -> ModelsResponse:
        raise NotImplementedError

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
        raise NotImplementedError

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
        raise NotImplementedError

    @app.get(
        "/api/extensions",
        response_model=ExtensionsResponse,
        summary="로드된 확장 · 실패한 확장",
        description="M6 까지는 빈 목록이 나간다. 실패한 확장을 숨기지 않는 것이 요점이다.",
        tags=["extensions"],
    )
    async def list_extensions() -> ExtensionsResponse:
        raise NotImplementedError

    # ------------------------------------------------------------------ WS

    @app.websocket("/ws")
    async def events_socket(socket: WebSocket) -> None:
        """진행률 · 프리뷰 · 캐시 히트 · 큐 상태를 흘려보내는 전역 스트림.

        모든 메시지는 `WsEvent` 유니온의 한 항목이고 `t` 로 판별한다. 모든
        이벤트가 `run_id` 를 실으므로 (`queue` 제외) 클라이언트는 하나의 연결로
        여러 실행을 구분할 수 있다.

        OpenAPI 는 WS 를 다루지 않으므로 이벤트 스키마는
        `tools/export_openapi.py` 가 `components.schemas` 에 주입한다.
        """
        raise NotImplementedError

    return app
