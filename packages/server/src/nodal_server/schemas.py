"""REST · WebSocket 계약 (docs/design.md §6).

> **계약 파일.** M2 프론트엔드를 다른 에이전트가 맡는다. 여기서 어긋나면 양쪽이
> 함께 깨진다 — 변경 전 사용자 확인 (AGENTS.md 협업 규칙 7).

`types.json` 이 M1 의 계약이었듯 이 파일 + `schemas/openapi.json` 이 M2 의
계약이다. 프론트는 산출물에서 타입을 생성하고 규칙을 다시 쓰지 않는다.

**세 가지 원칙**

1. 캐논 그래프는 그대로 실려 다닌다. 요청 본문의 `graph` 는 `nodal.Graph` 이고
   서버는 변환하지 않는다 (design.md §1.2 ①).
2. 에러 어휘는 하나다. 모든 실패가 `nodal.GraphIssue` 와 같은 모양의 `issues`
   배열을 싣는다 — 프론트는 `location` 으로 캔버스 소켓을 바로 찾는다.
3. 큰 값은 참조로 나간다. 노드 출력은 `OutputRefModel` 이지 값이 아니다.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from nodal import Graph

__all__ = [
    "AssetInfo",
    "AssetPreviewModel",
    "AssetRefModel",
    "CancelRunResponse",
    "CreateRunRequest",
    "CreateRunResponse",
    "ErrorBody",
    "ErrorResponse",
    "ExtensionInfo",
    "ExtensionsResponse",
    "GraphFromPngResponse",
    "InlinePreviewModel",
    "InputSocketModel",
    "IssueModel",
    "NodeSchemaModel",
    "NodesResponse",
    "OutputRefModel",
    "OutputSocketModel",
    "PreviewModel",
    "RunDetail",
    "RunListResponse",
    "RunStatus",
    "RunSummary",
    "TypeExpr",
    "ValidateRequest",
    "ValidateResponse",
    "WsEvent",
]


class _Model(BaseModel):
    """모든 응답 모델의 기반. 알 수 없는 필드를 거부한다."""

    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------ 에러
#
# design.md §6 에는 에러 형식이 없었다. M2 계약에서 확정한다.


class IssueModel(_Model):
    """`nodal.GraphIssue` 의 전송 형태. 필드 이름을 그대로 유지한다.

    `location` 은 `nodes.<id>.inputs.<socket>` 경로다. 프론트는 이것만으로
    캔버스의 해당 소켓을 찾아 빨갛게 칠할 수 있다. 문제가 서브그래프 정의 안에
    있으면 `definitions.<이름>.` 이 앞에 붙는다 (M5).
    """

    code: str = Field(description="안정적인 기계 판독용 코드 (`type_mismatch` 등)")
    message: str = Field(description="사람이 읽는 설명")
    node_id: str | None = Field(default=None, description="문제가 귀속되는 노드")
    socket: str | None = Field(default=None, description="문제가 귀속되는 소켓")
    definition: str | None = Field(
        default=None,
        description=(
            "문제가 서브그래프 정의 안에 있으면 그 정의 이름. `node_id` 만으로는 "
            "위치가 모호하다 — 정의마다 별개의 이름공간이라 ID 가 겹칠 수 있다"
        ),
    )
    location: str = Field(description="캐논 문서 안의 경로. 그래프 전역이면 `graph`")


class ErrorBody(_Model):
    code: str = Field(description="`graph_invalid` · `run_not_found` · `node_failed` 등")
    message: str
    issues: list[IssueModel] = Field(
        default_factory=list,
        description="문제를 전부 담는다. 첫 번째에서 멈추지 않는다",
    )


class ErrorResponse(_Model):
    """모든 4xx·5xx 응답의 본문. 상태 코드로 분기하고 본문은 항상 이 모양이다."""

    error: ErrorBody


# ------------------------------------------------------------------ 타입 표현식
#
# `types.json` 의 `type_expression` 문법을 그대로 전송한다. 프론트의
# `parseTypeExpr()` 가 이것을 먹고 `isCompatible()` 로 드래그 중 호환 소켓을
# 계산한다 (design.md §7 UX 1).
#
# 사람이 읽는 문자열(`describe()`)을 보내지 않는 이유: 그것은 **렌더링**이라
# 복원할 수 없다. `Tensor[float32, (?, 3)]` 은 `?` 가 라벨이었는지 `None` 이었는지
# 지운다. 표시용 문자열은 프론트가 `describeType()` 으로 직접 만든다 — 렌더러가
# 양쪽에 생기지 않는다.


class ListTypeExpr(_Model):
    list: TypeExpr


class UnionTypeExpr(_Model):
    union: list[TypeExpr]


class OpaqueTypeExpr(_Model):
    opaque: str = Field(description="핸들 이름 (`Model`, `VAE` ...)")
    capabilities: list[str] = Field(default_factory=list, description="능력 태그")


class TensorBodyExpr(_Model):
    dtypes: list[str]
    shape: list[int | str | None] = Field(
        description="정수는 고정 크기, 문자열 라벨과 null 은 임의 크기"
    )


class TensorTypeExpr(_Model):
    tensor: TensorBodyExpr


#: 소켓 타입. 카탈로그 이름이면 문자열, 합성 타입이면 객체다.
TypeExpr = str | ListTypeExpr | UnionTypeExpr | OpaqueTypeExpr | TensorTypeExpr


# ------------------------------------------------------------------ 노드 스키마


class InputSocketModel(_Model):
    """팔레트와 노드 본문이 그리는 입력 소켓 하나."""

    name: str
    type: TypeExpr = Field(description="`types.json` 의 타입 표현식")
    required: bool
    default: JsonValue | None = None
    lazy: bool = False
    doc: str = ""
    widget: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="min·max·step·options 등 위젯 힌트. 백엔드는 검증에만 쓴다",
    )


class OutputSocketModel(_Model):
    name: str
    type: TypeExpr
    doc: str = ""


class NodeSchemaModel(_Model):
    """`nodal.NodeSchema` 의 전송 형태.

    입력·출력을 딕셔너리가 아니라 **리스트**로 보낸다. 선언 순서가 UI 의 소켓
    순서이고, 리스트가 그 순서를 잃지 않는 유일한 표현이다.
    """

    id: str = Field(description="네임스페이스를 포함한 타입 ID. 캐논 그래프의 `node.type`")
    title: str
    category: str
    aliases: list[str] = Field(default_factory=list, description="퍼지 검색용. 한글 포함")
    version: str
    output_node: bool
    cacheable: bool
    doc: str = ""
    inputs: list[InputSocketModel] = Field(default_factory=list)
    outputs: list[OutputSocketModel] = Field(default_factory=list)


class NodesResponse(_Model):
    """`GET /api/nodes` — 프론트 팔레트의 유일한 소스."""

    nodes: list[NodeSchemaModel]
    types_version: str = Field(
        description="`types.json` 의 `types_version`. 프론트가 로드한 타입 규칙과 대조한다"
    )


# ------------------------------------------------------------------ 검증


class ValidateRequest(_Model):
    graph: Graph = Field(description="캐논 그래프 문서 그대로. 서버는 변환하지 않는다")
    outputs: list[str] | None = Field(
        default=None,
        description="검증할 출력 노드. 생략하면 그래프의 `outputs`",
    )


class ValidateResponse(_Model):
    """`POST /api/graph/validate` — 실행 없이 검증만 한다.

    무효한 그래프도 **200** 이다. 검증은 질의이지 명령이 아니므로, "이 그래프는
    무효다"는 성공적인 답이다. 4xx 는 요청 자체가 잘못됐을 때만 나간다.
    """

    valid: bool
    issues: list[IssueModel] = Field(default_factory=list)


# ------------------------------------------------------------------ 실행


class RunStatus(StrEnum):
    """실행 상태. 프론트가 이 값으로 화면을 분기한다."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AssetRefModel(_Model):
    """`nodal.AssetRef` 의 전송 형태 — 저장소에 있는 값에 대한 참조 (M3).

    `width` · `height` 가 참조에 들어 있는 이유는 프론트가 이미지를 **받기 전에**
    자리를 잡아야 하기 때문이다. 해시만 주면 GET 이 끝날 때까지 노드 레이아웃이
    튄다. 이미지가 아닌 에셋에서는 둘 다 `null` 이다.
    """

    hash: str = Field(description="내용 해시. `GET /api/assets/{hash}` 의 키")
    media_type: str = Field(description="`image/png` 처럼")
    size_bytes: int
    width: int | None = Field(default=None, description="픽셀 너비. 이미지가 아니면 null")
    height: int | None = Field(default=None, description="픽셀 높이. 이미지가 아니면 null")


class OutputRefModel(_Model):
    """`nodal.OutputRef` 의 전송 형태 — 값이 아니라 **참조**다 (design.md §6).

    이미지나 텐서를 그대로 실으면 메가바이트가 나간다. 작은 값만 `inline` 에
    싣고 큰 값은 `asset` 참조로 가리킨다.
    """

    socket: str
    type: TypeExpr
    inline: JsonValue | None = Field(default=None, description="JSON 으로 표현되는 작은 값")
    asset: AssetRefModel | None = Field(
        default=None,
        description="저장소에 있는 값의 참조 (M3). M2 까지는 해시 문자열이었다",
    )


class CreateRunRequest(_Model):
    graph: Graph
    outputs: list[str] | None = Field(
        default=None, description="실행할 출력 노드. 생략하면 그래프의 `outputs`"
    )
    use_cache: bool = Field(
        default=True,
        description="거짓이면 캐시를 무시하고 전부 재실행한다 (Ctrl+Shift+Enter)",
    )
    priority: int = Field(default=0, description="클수록 먼저. 같으면 등록 순서")


class CreateRunResponse(_Model):
    """`POST /api/runs` — 큐에 넣고 즉시 돌아온다. 진행은 `/ws` 로 본다."""

    run_id: str
    status: RunStatus


class RunSummary(_Model):
    """큐·히스토리 목록용 경량 표현. 출력값을 담지 않는다."""

    run_id: str
    status: RunStatus
    node_count: int
    elapsed_ms: int | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class RunDetail(_Model):
    """`GET /api/runs/{id}` — 상태와 결과.

    `executed` 와 `cached` 를 나눠 두는 것이 요점이다. WS 를 놓친 클라이언트도
    무엇이 재실행되고 무엇이 캐시였는지 알 수 있다 (design.md §6).
    """

    run_id: str
    status: RunStatus
    outputs: dict[str, list[OutputRefModel]] = Field(
        default_factory=dict, description="출력 노드 ID → 그 노드의 출력 참조들"
    )
    executed: list[str] = Field(default_factory=list, description="실제로 실행된 노드")
    cached: list[str] = Field(default_factory=list, description="캐시 히트로 건너뛴 노드")
    blocked: list[str] = Field(default_factory=list, description="블로커로 막힌 노드 (M5)")
    elapsed_ms: int | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: ErrorBody | None = Field(
        default=None, description="`status` 가 `failed` 일 때만 채워진다"
    )


class CancelRunResponse(_Model):
    """`DELETE /api/runs/{id}` — 협조적 취소를 요청한다.

    이미 끝난 실행이면 `cancelled` 가 아니라 그때의 상태가 그대로 돌아온다.
    """

    run_id: str
    status: RunStatus


class RunListResponse(_Model):
    """`GET /api/runs` — 큐와 히스토리."""

    running: RunSummary | None = None
    queued: list[RunSummary] = Field(default_factory=list)
    history: list[RunSummary] = Field(default_factory=list, description="최근 완료분. 최신이 먼저")
    limit: int = Field(description="히스토리 보관 상한")


# ------------------------------------------------------------------ 모델 · 에셋 · 확장


class AssetInfo(_Model):
    """`POST /api/assets` 의 응답. content-addressed 이므로 같은 파일은 같은 해시다."""

    hash: str = Field(description="내용 해시. `GET /api/assets/{hash}` 의 키")
    size_bytes: int
    media_type: str
    filename: str | None = None
    width: int | None = Field(default=None, description="픽셀 너비. 이미지가 아니면 null")
    height: int | None = Field(default=None, description="픽셀 높이. 이미지가 아니면 null")


class GraphFromPngResponse(_Model):
    """`POST /api/graph/from-png` 의 응답 (M3).

    PNG 의 `nodal_workflow` iTXt 청크에서 캐논 그래프를 꺼낸 결과다.
    파싱을 서버 한 곳에만 두는 이유는 iTXt 파서가 Python·TS 양쪽에 생기면
    그것이 곧 "규칙을 두 번 쓰지 않는다" 위반이기 때문이다.

    청크가 없거나 JSON 이 깨졌으면 이 응답이 아니라 `ErrorResponse` 가 나간다.
    """

    graph: Graph = Field(description="복원된 캐논 그래프")
    nodal_version: str | None = Field(
        default=None,
        description="PNG 에 함께 박힌 `nodal_version` iTXt. 없으면 null",
    )


class ExtensionInfo(_Model):
    """로드된, 또는 로드에 실패한 확장 하나 (design.md §8, M7.2)."""

    id: str
    name: str
    version: str
    nodal_api: str = Field(description="확장이 선언한 API 버전 범위")
    loaded: bool
    node_count: int = 0
    web_entry_url: str | None = Field(
        default=None,
        description=(
            "확장의 `web/index.js` 를 낼 URL(`/api/` 아래). 프론트는 이 값을 "
            "그대로 `import()` 한다 — id 로 조립하지 않는다. `web/index.js` 가 "
            "없거나 확장이 로드되지 않았으면 null"
        ),
    )
    error: str | None = Field(default=None, description="로드 실패 사유")


class ExtensionsResponse(_Model):
    """`GET /api/extensions` — 실패한 확장도 함께 보고한다.

    확장 하나가 예외를 던져도 나머지는 로드된다. 실패는 숨기지 않고 UI 배너로
    올라간다 (design.md §8).
    """

    loaded: list[ExtensionInfo] = Field(default_factory=list)
    failed: list[ExtensionInfo] = Field(default_factory=list)


# ------------------------------------------------ WebSocket 이벤트 (`/ws`)
#
# `nodal.events` 의 dataclass 와 **필드가 정확히 같다**. 서버는 번역하지 않고
# 직렬화만 한다. 이 pydantic 미러가 존재하는 이유는 하나뿐이다 — OpenAPI 산출물에
# 실려 프론트가 타입을 생성할 수 있게 하기 위해서다.
#
# 계약이 어긋나지 않는지는 `packages/server/tests/test_openapi_export.py` 가
# 두 정의의 필드를 대조해 검사한다.


class WsRunStarted(_Model):
    t: Literal["run.started"]
    run_id: str
    node_count: int


class WsNodeStarted(_Model):
    t: Literal["node.started"]
    run_id: str
    node_id: str


class WsNodeProgress(_Model):
    t: Literal["node.progress"]
    run_id: str
    node_id: str
    step: int
    total: int


class InlinePreviewModel(_Model):
    """버려질 프리뷰를 data URI 로 그대로 싣는다 (샘플링 중간 프리뷰)."""

    kind: Literal["inline"]
    data_uri: str
    width: int | None = None
    height: int | None = None


class AssetPreviewModel(_Model):
    """저장소에 있는 프리뷰를 참조로 가리킨다 (노드의 최종 출력 이미지)."""

    kind: Literal["asset"]
    asset: AssetRefModel


#: `kind` 로 판별한다. M2 까지는 `image: str` 하나였고 받는 쪽이 base64 인지
#: 해시인지 **구분할 방법이 없었다**.
PreviewModel = Annotated[
    InlinePreviewModel | AssetPreviewModel,
    Field(discriminator="kind"),
]


class WsNodePreview(_Model):
    t: Literal["node.preview"]
    run_id: str
    node_id: str
    preview: PreviewModel


class WsNodeCached(_Model):
    t: Literal["node.cached"]
    run_id: str
    node_id: str


class WsNodeDone(_Model):
    t: Literal["node.done"]
    run_id: str
    node_id: str
    outputs: list[OutputRefModel] = Field(default_factory=list)


class WsNodeError(_Model):
    t: Literal["node.error"]
    run_id: str
    node_id: str
    message: str
    traceback: list[str] = Field(default_factory=list)
    socket: str | None = None


class WsRunDone(_Model):
    t: Literal["run.done"]
    run_id: str
    elapsed_ms: int


class WsRunFailed(_Model):
    """실행이 실패했다. `run.done`·`run.cancelled` 와 대칭인 종료 이벤트다.

    `node.error` 만으로는 부족하다 — 사이클처럼 어느 노드에도 귀속되지 않는
    실패가 있고, 그때 사유를 아는 통로가 여기뿐이다.
    """

    t: Literal["run.failed"]
    run_id: str
    elapsed_ms: int
    code: str = Field(description="`node_failed` · `graph_invalid` · `internal_error`")
    message: str


class WsRunCancelled(_Model):
    t: Literal["run.cancelled"]
    run_id: str
    elapsed_ms: int


class WsQueueStatus(_Model):
    t: Literal["queue"]
    pending: int
    running: str | None = None


#: `/ws` 로 나가는 모든 메시지. `t` 로 판별한다.
WsEvent = Annotated[
    WsRunStarted
    | WsNodeStarted
    | WsNodeProgress
    | WsNodePreview
    | WsNodeCached
    | WsNodeDone
    | WsNodeError
    | WsRunDone
    | WsRunFailed
    | WsRunCancelled
    | WsQueueStatus,
    Field(discriminator="t"),
]
