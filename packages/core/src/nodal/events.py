"""진행률 이벤트와 협조적 취소 (docs/design.md §5.4, §6).

이벤트 타입은 `design.md` §6 의 WebSocket 이벤트와 **일대일 대응**한다. 서버는
번역하지 않고 그대로 직렬화한다 — 변환 레이어를 만들지 않는 것이 nodal 의
설계 원칙이다.

`node.cached` 를 명시적 이벤트로 두는 것이 포인트다. 어느 노드가 재실행됐고
어느 노드가 캐시로 스킵됐는지 보이면, 캐시가 마법이 아니라 이해 가능한 도구가
된다.

**모든 이벤트가 `run_id` 를 갖는다.** `/ws` 는 전역 스트림이고 프론트는 히스토리와
여러 탭을 동시에 본다 — 어느 실행의 이벤트인지 봉투 없이 알 수 있어야 한다.
(§6 의 TS 정의는 일부 이벤트에만 `run_id` 가 있었다. M2 계약에서 통일했다.)
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from .assets import AssetRef, AssetStore, NullAssetStore
from .preview import Preview, encode_preview

__all__ = [
    "AssetRef",
    "CancelToken",
    "Cancelled",
    "Event",
    "EventSink",
    "NodeCached",
    "NodeContext",
    "NodeDone",
    "NodeError",
    "NodePreview",
    "NodeProgress",
    "NodeStarted",
    "NullEventSink",
    "OutputRef",
    "QueueStatus",
    "RecordingEventSink",
    "RunCancelled",
    "RunDone",
    "RunFailed",
    "RunStarted",
]


class Cancelled(Exception):
    """취소된 실행에서 던져진다. 실패가 아니므로 에러로 보고하지 않는다."""


class CancelToken:
    """협조적 취소 토큰 (design.md §5.4).

    강제 종료가 아니다. 장기 루프(샘플링 스텝)가 매 스텝 확인해 주어야 멈춘다.
    """

    def __init__(self) -> None:
        self._cancelled = False
        self._reason: str | None = None

    def cancel(self, reason: str | None = None) -> None:
        """취소를 요청한다. 여러 번 불러도 안전하다."""
        if not self._cancelled:
            self._cancelled = True
            self._reason = reason

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def reason(self) -> str | None:
        return self._reason

    def raise_if_cancelled(self) -> None:
        """취소됐으면 `Cancelled` 를 던진다. 실행 루프가 매 스텝 호출한다."""
        if self._cancelled:
            raise Cancelled(self._reason or "실행이 취소됐다")

    def __repr__(self) -> str:
        state = f"cancelled({self._reason!r})" if self._cancelled else "active"
        return f"CancelToken({state})"


# ----------------------------------------------------------------- 이벤트
#
# `t` 판별자는 design.md §6 의 WebSocket 이벤트 이름과 정확히 같다.
# 서버는 번역하지 않고 그대로 직렬화한다.


@dataclass(frozen=True, slots=True)
class OutputRef:
    """노드 출력 하나에 대한 **참조**. 값 자체가 아니다 (design.md §6).

    이미지나 텐서를 WS 로 그대로 흘리면 메가바이트가 소켓을 타고 나간다. 그래서
    작은 값만 `inline` 에 싣고 큰 값은 content-addressed 해시로 가리킨다.

    Attributes:
        socket: 출력 소켓 이름. 캐논 그래프의 링크가 이 이름으로 참조한다.
        type: `types.json` 카탈로그의 타입 이름 (`INT`, `Image` ...).
        inline: JSON 으로 표현되는 작은 값. 아니면 `None`.
        asset: 저장소에 있는 값의 참조 (M3). 아직 없으면 `None`.

    Note:
        `asset` 은 M2 까지 해시 **문자열**이었다. M3 계약에서 `AssetRef` 로 바꿨다 —
        프론트가 노드 안에 프리뷰를 그리려면 이미지를 받기 **전에** 크기를 알아야
        레이아웃이 튀지 않는데, 해시만으로는 알 수 없었다.

        둘 다 비어 있으면 그 값은 전송 수단이 없다는 뜻이다 (JSON 도 아니고
        저장소에도 넣지 않은 값).
    """

    socket: str
    type: Any
    inline: Any = None
    asset: AssetRef | None = None


@dataclass(frozen=True, slots=True)
class RunStarted:
    t: Literal["run.started"]
    run_id: str
    node_count: int


@dataclass(frozen=True, slots=True)
class NodeStarted:
    t: Literal["node.started"]
    run_id: str
    node_id: str


@dataclass(frozen=True, slots=True)
class NodeProgress:
    t: Literal["node.progress"]
    run_id: str
    node_id: str
    step: int
    total: int


@dataclass(frozen=True, slots=True)
class NodePreview:
    """노드가 보여주는 프리뷰 이미지.

    M2 까지는 `image: str` 하나였고 주석이 "base64 or asset ref" 라고만 적혀
    있었다. 받는 쪽이 둘 중 무엇인지 **구분할 방법이 없었다.** M3 계약에서
    판별 가능한 `Preview` 로 바꿨다 (`preview.py`).
    """

    t: Literal["node.preview"]
    run_id: str
    node_id: str
    preview: Preview


@dataclass(frozen=True, slots=True)
class NodeCached:
    """캐시 히트로 실행을 건너뛴 노드. UI 가 색으로 표시한다."""

    t: Literal["node.cached"]
    run_id: str
    node_id: str


@dataclass(frozen=True, slots=True)
class NodeDone:
    t: Literal["node.done"]
    run_id: str
    node_id: str
    outputs: tuple[OutputRef, ...] = ()


@dataclass(frozen=True, slots=True)
class NodeError:
    """실패한 노드. `socket` 은 원인이 특정 입력이면 채워진다.

    익명 에러 금지 — 이 이벤트는 언제나 `node_id` 를 갖는다.
    """

    t: Literal["node.error"]
    run_id: str
    node_id: str
    message: str
    traceback: tuple[str, ...] = ()
    socket: str | None = None


@dataclass(frozen=True, slots=True)
class RunDone:
    t: Literal["run.done"]
    run_id: str
    elapsed_ms: int


@dataclass(frozen=True, slots=True)
class RunFailed:
    """실행이 실패했다. `run.done` 과 대칭인 종료 이벤트다.

    `node.error` 만으로는 부족하다 — 실행 도중 발견된 사이클처럼 **어느 노드에도
    귀속되지 않는 실패**가 있고, 그때 프론트가 사유를 아는 유일한 통로가 여기다.
    종료 이벤트 셋이 `RunStatus` 의 종료 상태 셋과 짝을 이룬다:
    `run.done`→succeeded, `run.failed`→failed, `run.cancelled`→cancelled.
    """

    t: Literal["run.failed"]
    run_id: str
    elapsed_ms: int
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class RunCancelled:
    t: Literal["run.cancelled"]
    run_id: str
    elapsed_ms: int


@dataclass(frozen=True, slots=True)
class QueueStatus:
    """큐 상태. 특정 실행에 속하지 않으므로 `run_id` 가 없다."""

    t: Literal["queue"]
    pending: int
    running: str | None


Event = (
    RunStarted
    | NodeStarted
    | NodeProgress
    | NodePreview
    | NodeCached
    | NodeDone
    | NodeError
    | RunDone
    | RunFailed
    | RunCancelled
    | QueueStatus
)


@runtime_checkable
class EventSink(Protocol):
    """이벤트를 받는 쪽. 서버는 WS 로 브로드캐스트하고, 테스트는 모아둔다."""

    def emit(self, event: Event) -> None: ...


class NullEventSink:
    """아무것도 하지 않는 싱크. 이벤트에 관심 없는 실행의 기본값."""

    def emit(self, event: Event) -> None:
        return None


@dataclass
class RecordingEventSink:
    """받은 이벤트를 순서대로 모아두는 싱크.

    테스트가 "입력 하나를 바꿨더니 그 아래만 재실행됐다"를 증명하는 도구다
    (M1 완료 기준). `node.cached` 와 `node.started` 를 세면 그대로 증거가 된다.
    """

    events: list[Event] = field(default_factory=list)

    def emit(self, event: Event) -> None:
        self.events.append(event)

    def of_type(self, event_type: type) -> Sequence[Event]:
        """특정 종류의 이벤트만 순서대로."""
        return [event for event in self.events if isinstance(event, event_type)]

    def node_ids(self, event_type: type) -> Sequence[str]:
        """특정 종류의 이벤트가 가리킨 노드 ID 들. 순서를 유지한다."""
        return [
            event.node_id
            for event in self.events
            if isinstance(event, event_type) and hasattr(event, "node_id")
        ]

    def clear(self) -> None:
        self.events.clear()


# ------------------------------------------------------------ 실행 컨텍스트


class NodeContext:
    """`run` 이 `ctx` 파라미터를 선언했을 때 주입되는 객체 (design.md §5.4).

    노드가 엔진에 말을 거는 유일한 통로다. 이것을 안 받는 노드는 엔진 없이
    그냥 호출할 수 있는 순수 함수다.
    """

    def __init__(
        self,
        node_id: str,
        run_id: str,
        events: EventSink,
        cancel_token: CancelToken,
        assets: AssetStore | None = None,
    ) -> None:
        self._node_id = node_id
        self._run_id = run_id
        self._events = events
        self._cancel_token = cancel_token
        self._assets: AssetStore = assets if assets is not None else NullAssetStore()

    @property
    def node_id(self) -> str:
        """실행 중인 노드 ID. 확장 노드면 사용자가 캔버스에서 보는 부모 ID 다."""
        return self._node_id

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def cancel_token(self) -> CancelToken:
        return self._cancel_token

    @property
    def assets(self) -> AssetStore:
        """에셋 저장소 (M3). 저장소 없이 실행 중이면 `put` 이 명시적으로 실패한다.

        노드 팩이 `core` 만 의존하면서도 저장소에 닿는 유일한 통로다.
        """
        return self._assets

    def progress(self, step: int, total: int, *, preview: Any = None) -> None:
        """진행률을 보고한다. 서버가 WS 로 중계한다."""
        self._events.emit(
            NodeProgress(
                t="node.progress",
                run_id=self._run_id,
                node_id=self._node_id,
                step=step,
                total=total,
            )
        )
        if preview is not None:
            self.preview(preview)

    def preview(self, value: Any, *, persistent: bool = False) -> None:
        """프리뷰를 보낸다 (M3).

        `value` 는 런타임 값(ndarray 등)이거나 이미 만들어진 `Preview` 다.
        등록된 인코더가 처리하지 못하면 **이벤트를 보내지 않는다** — 빈 프리뷰를
        보내는 것보다 낫다 (`preview.py`).

        `ctx.progress(preview=...)` 와 `NodeResult(preview=...)` 가 전부 이 한
        지점으로 모인다. 프리뷰가 여러 군데서 다르게 만들어지면 프론트가 여러
        모양을 다뤄야 한다.
        """
        encoded = encode_preview(value, assets=self._assets, persistent=persistent)
        if encoded is None:
            return
        self._events.emit(
            NodePreview(
                t="node.preview",
                run_id=self._run_id,
                node_id=self._node_id,
                preview=encoded,
            )
        )

    def raise_if_cancelled(self) -> None:
        """`cancel_token.raise_if_cancelled()` 의 축약. 장기 루프가 매 스텝 호출한다."""
        self._cancel_token.raise_if_cancelled()

    def log(self, message: str) -> None:
        """노드에 귀속되는 로그 한 줄."""
        _LOGGER.info("[%s] %s", self._node_id, message)

    def __repr__(self) -> str:
        return f"NodeContext(node_id={self._node_id!r}, run_id={self._run_id!r})"


_LOGGER = logging.getLogger("nodal.node")
