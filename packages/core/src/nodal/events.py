"""진행률 이벤트와 협조적 취소 (docs/design.md §5.4, §6).

> **계약 파일.** 본문은 M1 에서 채운다.

이벤트 타입은 `design.md` §6 의 WebSocket 이벤트와 **일대일 대응**한다. 서버는
번역하지 않고 그대로 직렬화한다 — 변환 레이어를 만들지 않는 것이 nodal 의
설계 원칙이다.

`node.cached` 를 명시적 이벤트로 두는 것이 포인트다. 어느 노드가 재실행됐고
어느 노드가 캐시로 스킵됐는지 보이면, 캐시가 마법이 아니라 이해 가능한 도구가
된다.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

__all__ = [
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
    "QueueStatus",
    "RecordingEventSink",
    "RunCancelled",
    "RunDone",
    "RunStarted",
]


class Cancelled(Exception):
    """취소된 실행에서 던져진다. 실패가 아니므로 에러로 보고하지 않는다."""


class CancelToken:
    """협조적 취소 토큰 (design.md §5.4).

    강제 종료가 아니다. 장기 루프(샘플링 스텝)가 매 스텝 확인해 주어야 멈춘다.
    """

    def cancel(self, reason: str | None = None) -> None:
        """취소를 요청한다. 여러 번 불러도 안전하다."""
        raise NotImplementedError

    @property
    def cancelled(self) -> bool:
        raise NotImplementedError

    @property
    def reason(self) -> str | None:
        raise NotImplementedError

    def raise_if_cancelled(self) -> None:
        """취소됐으면 `Cancelled` 를 던진다. 실행 루프가 매 스텝 호출한다."""
        raise NotImplementedError


# ----------------------------------------------------------------- 이벤트
#
# `t` 판별자는 design.md §6 의 WebSocket 이벤트 이름과 정확히 같다.


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
    node_id: str
    step: int
    total: int


@dataclass(frozen=True, slots=True)
class NodePreview:
    """`image` 는 base64 이거나 에셋 참조다. core 는 어느 쪽인지 해석하지 않는다."""

    t: Literal["node.preview"]
    node_id: str
    image: str


@dataclass(frozen=True, slots=True)
class NodeCached:
    """캐시 히트로 실행을 건너뛴 노드. UI 가 색으로 표시한다."""

    t: Literal["node.cached"]
    node_id: str


@dataclass(frozen=True, slots=True)
class NodeDone:
    t: Literal["node.done"]
    node_id: str
    outputs: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class NodeError:
    """실패한 노드. `socket` 은 원인이 특정 입력이면 채워진다.

    익명 에러 금지 — 이 이벤트는 언제나 `node_id` 를 갖는다.
    """

    t: Literal["node.error"]
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
class RunCancelled:
    t: Literal["run.cancelled"]
    run_id: str
    elapsed_ms: int


@dataclass(frozen=True, slots=True)
class QueueStatus:
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
        raise NotImplementedError


@dataclass
class RecordingEventSink:
    """받은 이벤트를 순서대로 모아두는 싱크.

    테스트가 "입력 하나를 바꿨더니 그 아래만 재실행됐다"를 증명하는 도구다
    (M1 완료 기준). `node.cached` 와 `node.started` 를 세면 그대로 증거가 된다.
    """

    events: list[Event] = field(default_factory=list)

    def emit(self, event: Event) -> None:
        raise NotImplementedError

    def of_type(self, event_type: type) -> Sequence[Event]:
        """특정 종류의 이벤트만 순서대로."""
        raise NotImplementedError

    def node_ids(self, event_type: type) -> Sequence[str]:
        """특정 종류의 이벤트가 가리킨 노드 ID 들. 순서를 유지한다."""
        raise NotImplementedError

    def clear(self) -> None:
        raise NotImplementedError


# ------------------------------------------------------------ 실행 컨텍스트


class NodeContext:
    """`run` 이 `ctx` 파라미터를 선언했을 때 주입되는 객체 (design.md §5.4).

    노드가 엔진에 말을 거는 유일한 통로다. 이것을 안 받는 노드는 엔진 없이
    그냥 호출할 수 있는 순수 함수다.
    """

    @property
    def node_id(self) -> str:
        """실행 중인 노드 ID. 확장 노드면 사용자가 캔버스에서 보는 부모 ID 다."""
        raise NotImplementedError

    @property
    def run_id(self) -> str:
        raise NotImplementedError

    @property
    def cancel_token(self) -> CancelToken:
        raise NotImplementedError

    def progress(self, step: int, total: int, *, preview: Any = None) -> None:
        """진행률을 보고한다. 서버가 WS 로 중계한다."""
        raise NotImplementedError

    def raise_if_cancelled(self) -> None:
        """`cancel_token.raise_if_cancelled()` 의 축약. 장기 루프가 매 스텝 호출한다."""
        raise NotImplementedError

    def log(self, message: str) -> None:
        """노드에 귀속되는 로그 한 줄."""
        raise NotImplementedError
