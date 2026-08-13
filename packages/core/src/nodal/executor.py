"""실행 엔진 — 용해 방식 위상 정렬과 실행 루프 (docs/design.md §5).

> **계약 파일.** 본문은 M1 에서 채운다. 이 파일의 시그니처가 M1 테스트가
> 기대는 표면 전체다 (AGENTS.md 협업 규칙 7).

실행 전에 전체 순서를 확정하지 않는다. 매 스텝마다 "지금 실행 가능한 노드
집합"을 계산하고 하나를 고른다 — 노드가 실행 도중 그래프를 확장해도 대응된다.

핵심은 `unstage()` 다. 노드가 "아직 못 하겠다, 이것들이 먼저 필요하다"고 말하면
실행 목록에 되돌려 놓는다. **이 한 가지 메커니즘이 노드 확장과 lazy 평가를 둘
다 지탱한다.**

노드를 정의해서 실행하기까지의 전체 경로::

    from nodal import Int, NodeResult, NodeRegistry, node, parse_graph
    from nodal import CancelToken, LRUCache, RecordingEventSink, execute

    @node(id="math.Add", category="math")
    class Add:
        a: Int = Int(0)
        b: Int = Int(0)
        returns = {"sum": Int}

        def run(self, a, b) -> NodeResult:      # ctx 를 안 받으므로 순수 함수다
            return NodeResult(a + b)

    registry = NodeRegistry()
    registry.register(Add)

    graph = parse_graph({
        "nodal_version": "1",
        "nodes": {
            "n1": {"type": "math.Add", "inputs": {"a": 1, "b": 2}},
            "n2": {"type": "math.Add",
                   "inputs": {"a": {"$link": ["n1", "sum"]}, "b": 10}},
        },
        "outputs": ["n2"],
    })

    events = RecordingEventSink()
    result = await execute(
        graph,
        graph.outputs,
        registry=registry,
        cache=LRUCache(64),
        events=events,
        cancel_token=CancelToken(),
    )

    result.outputs["n2"]["sum"] == 13
    result.executed == ("n1", "n2")

같은 그래프를 같은 캐시로 다시 실행하면 `result.cached == ("n1", "n2")` 이고
`executed` 는 비어 있다. `n2` 의 `b` 만 바꾸면 `n1` 은 캐시, `n2` 만 재실행된다
— 이것이 M1 완료 기준이다.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .cache import Cache
from .events import CancelToken, EventSink, NodeContext
from .graph import Graph, Node
from .registry import NodeRegistry
from .schema import NodeSchema

__all__ = [
    "Blocked",
    "DynamicGraph",
    "ExecutionBlocker",
    "ExecutionList",
    "Expanded",
    "Failure",
    "NeedsLazy",
    "NodeExecutionError",
    "NodeOutcome",
    "RunResult",
    "Success",
    "TopologicalSort",
    "execute",
    "propagate_blocker",
    "run_node",
]


class NodeExecutionError(Exception):
    """노드 실행이 실패했다. 언제나 **어느 노드**인지 지목한다.

    입력 하나가 원인이면 `socket` 도 채운다. 익명 에러 금지 (AGENTS.md 코딩 컨벤션).

    Attributes:
        node_id: 사용자가 캔버스에서 보는 노드. 확장으로 생긴 ephemeral 노드에서
            났더라도 여기에는 **부모 ID** 가 들어간다 (design.md §5.2). 존재하지
            않는 노드에서 에러가 났다고 말하지 않기 위해서다.
    """

    def __init__(
        self,
        node_id: str,
        cause: BaseException,
        *,
        socket: str | None = None,
        ephemeral_id: str | None = None,
    ) -> None:
        self.node_id = node_id
        self.cause = cause
        self.socket = socket
        self.ephemeral_id = ephemeral_id
        where = f"nodes.{node_id}" + (f".inputs.{socket}" if socket else "")
        super().__init__(f"{where}: {cause}")


class ExecutionBlocker:
    """조건 분기 센티넬 (design.md §1.1 ④).

    노드가 실제 값 대신 이것을 돌려주면, 그 값을 받은 하위 노드는 실행되지 않고
    블로커를 그대로 전파한다. 데이터 흐름 그래프에 if 를 얹는 가장 저렴한 방법이다.

    별도 제어 흐름 그래프를 만들지 않는다는 점이 요점이다.
    """

    def __init__(self, reason: str | None = None) -> None:
        raise NotImplementedError

    @property
    def reason(self) -> str | None:
        raise NotImplementedError


# --------------------------------------------------------------- 실행 결과
#
# design.md §5.1 의 match 문이 이 타입들을 분기한다. dataclass 라서 위치 패턴
# (`case Expanded(g)`) 이 그대로 동작한다.


@dataclass(frozen=True, slots=True)
class NodeOutcome:
    """노드 한 번 실행의 결과. 아래 다섯 가지 중 하나다."""


@dataclass(frozen=True, slots=True)
class Success(NodeOutcome):
    """정상 종료. `outputs` 는 소켓 이름 → 값."""

    outputs: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class Expanded(NodeOutcome):
    """노드가 값 대신 서브그래프를 돌려줬다 (design.md §5.2, M5).

    엔진은 이것을 `DynamicGraph.splice` 로 삽입하고 노드를 `unstage` 한다.
    """

    subgraph: Graph


@dataclass(frozen=True, slots=True)
class NeedsLazy(NodeOutcome):
    """노드가 "이 입력들이 먼저 필요하다"고 말했다 (design.md §1.1 ⑤, M5).

    `deps` 는 지금 평가해야 할 **입력 소켓 이름들**이다. 엔진은 그 upstream 을
    실행 목록에 넣고 노드를 `unstage` 한다.
    """

    deps: Sequence[str]


@dataclass(frozen=True, slots=True)
class Blocked(NodeOutcome):
    """블로커가 도달했거나 노드가 블로커를 돌려줬다. 하위로 전파된다."""

    blocker: ExecutionBlocker


@dataclass(frozen=True, slots=True)
class Failure(NodeOutcome):
    """노드가 예외를 던졌다."""

    error: BaseException
    socket: str | None = None


@dataclass(frozen=True, slots=True)
class RunResult:
    """실행 한 번의 요약.

    Attributes:
        outputs: 요청한 출력 노드 ID → 그 노드의 출력 딕셔너리.
        executed: 실제로 실행된 노드 ID (실행 순서대로).
        cached: 캐시 히트로 건너뛴 노드 ID.
        blocked: 블로커 때문에 실행되지 않은 노드 ID.
        elapsed_ms: 총 소요 시간.

    `executed` 와 `cached` 를 나눠 두는 것이 M1 완료 기준의 증거다 — "입력 하나를
    바꿨더니 그 아래만 재실행됐다"를 로그가 아니라 값으로 증명할 수 있다.
    """

    run_id: str
    outputs: Mapping[str, Mapping[str, Any]]
    executed: tuple[str, ...] = ()
    cached: tuple[str, ...] = ()
    blocked: tuple[str, ...] = ()
    elapsed_ms: int = 0


# ------------------------------------------------------------ 동적 그래프


class DynamicGraph:
    """런타임 확장 노드를 얹을 수 있는 그래프 뷰 (design.md §5.2).

    원본 캐논 그래프는 바뀌지 않는다. 확장으로 생긴 ephemeral 노드는 이 뷰에만
    존재하며 **부모 ID 를 유지한다** — 진행률과 에러가 사용자가 실제로 캔버스에서
    보는 노드에 귀속되어야 하기 때문이다.
    """

    def __init__(self, graph: Graph) -> None:
        raise NotImplementedError

    @property
    def base(self) -> Graph:
        """원본 캐논 그래프. 변경되지 않는다."""
        raise NotImplementedError

    def node(self, node_id: str) -> Node:
        """노드를 꺼낸다. ephemeral 노드도 포함한다.

        Raises:
            KeyError: 뷰에 없는 노드 ID 일 때.
        """
        raise NotImplementedError

    def __contains__(self, node_id: object) -> bool:
        raise NotImplementedError

    def __iter__(self) -> Iterator[str]:
        raise NotImplementedError

    def dependencies(self, node_id: str) -> Mapping[str, tuple[str, str]]:
        """입력 소켓 이름 → (출처 노드 ID, 출처 소켓). 리터럴 입력은 빠진다."""
        raise NotImplementedError

    def dependents(self, node_id: str) -> frozenset[str]:
        """이 노드의 출력을 소비하는 노드들."""
        raise NotImplementedError

    def splice(self, node_id: str, subgraph: Graph) -> Sequence[str]:
        """확장된 서브그래프를 `node_id` 자리에 삽입한다.

        새로 생긴 노드들은 ephemeral 이며 `parent_of` 가 `node_id` 를 가리킨다.

        Returns:
            삽입된 ephemeral 노드 ID 들.
        """
        raise NotImplementedError

    def parent_of(self, node_id: str) -> str | None:
        """ephemeral 노드의 부모. 원본 노드면 `None`."""
        raise NotImplementedError

    def visible_id(self, node_id: str) -> str:
        """사용자가 캔버스에서 보는 노드 ID.

        ephemeral 노드면 부모를 따라 올라간다. 이벤트와 에러는 전부 이 ID 로
        보고한다 — "존재하지 않는 노드에서 에러가 발생"을 막는 장치다.
        """
        raise NotImplementedError

    def is_ephemeral(self, node_id: str) -> bool:
        raise NotImplementedError


# ------------------------------------------------------------ 위상 정렬


class TopologicalSort:
    """점진적 위상 "용해" (design.md §1.1 ①).

    전체 정렬을 만들지 않는다. 유지하는 상태는 셋뿐이다:

    - `pending`: 아직 실행 안 된 노드
    - `block_count[node]`: 이 노드를 막고 있는 노드 수
    - `blocking[node]`: 이 노드가 막고 있는 노드들

    사이클 탐지는 역방향 용해로 한다 — 아무것도 실행 가능하지 않은데 pending 이
    남아 있으면 남은 것이 사이클이다.
    """

    def __init__(self, dyn: DynamicGraph) -> None:
        raise NotImplementedError

    def add_node(self, node_id: str) -> None:
        """노드와 **그 조상들만** 실행 대상에 넣는다. 그래프 전체를 넣지 않는다."""
        raise NotImplementedError

    def add_dependency(self, blocked: str, blocker: str) -> None:
        """`blocked` 가 `blocker` 를 기다리게 한다."""
        raise NotImplementedError

    def is_ready(self, node_id: str) -> bool:
        """막는 노드가 하나도 없으면 참."""
        raise NotImplementedError

    def ready_nodes(self) -> Sequence[str]:
        """지금 실행 가능한 노드들."""
        raise NotImplementedError

    def pop(self, node_id: str) -> None:
        """완료 처리하고 이 노드가 막고 있던 노드들의 `block_count` 를 줄인다."""
        raise NotImplementedError

    def is_empty(self) -> bool:
        raise NotImplementedError

    def pending(self) -> frozenset[str]:
        raise NotImplementedError

    def detect_cycle(self) -> Sequence[str] | None:
        """사이클에 속한 노드 ID 들, 없으면 `None`.

        준비된 노드가 없는데 pending 이 남았을 때 호출한다. 에러 메시지가 어느
        노드들이 서로를 물고 있는지 지목할 수 있어야 한다.
        """
        raise NotImplementedError


class ExecutionList(TopologicalSort):
    """실행 목록 — 위상 정렬 + 캐시 + UX 선택 휴리스틱.

    `stage()` 로 하나를 꺼내고, `complete()` 나 `unstage()` 로 돌려준다.
    """

    def __init__(self, dyn: DynamicGraph, cache: Cache, registry: NodeRegistry) -> None:
        raise NotImplementedError

    @property
    def staged(self) -> str | None:
        """현재 꺼내져 있는 노드. 없으면 `None`."""
        raise NotImplementedError

    async def stage(self) -> str:
        """준비된 노드 중 하나를 골라 꺼낸다.

        선택 우선순위 (design.md §1.1 ②) — 총 실행 시간은 같지만 프리뷰가 먼저
        뜨면 체감 속도가 완전히 달라진다:

        1. 출력 노드 또는 async 노드
        2. 출력 노드를 막고 있는 노드
        3. 그 위 단계 (2-hop)
        4. 아무거나

        Raises:
            GraphValidationError: 준비된 노드가 없는데 pending 이 남았을 때
                (사이클). 어느 노드들이 사이클을 이루는지 지목한다.
        """
        raise NotImplementedError

    def complete(self) -> None:
        """staged 노드를 완료 처리한다."""
        raise NotImplementedError

    def unstage(self) -> None:
        """staged 노드를 실행 목록에 되돌린다.

        노드 확장과 lazy 평가가 둘 다 여기에 기댄다 (design.md §5.1).
        """
        raise NotImplementedError

    def add_deps(self, node_id: str, sockets: Sequence[str]) -> None:
        """`node_id` 의 특정 입력 소켓들의 upstream 을 실행 대상에 추가한다.

        lazy 노드가 "지금 나는 A 만 필요하다"고 말했을 때 쓴다.
        """
        raise NotImplementedError

    def mark_blocked(self, node_id: str, blocker: ExecutionBlocker) -> None:
        """이 노드를 블로커 상태로 표시한다. 하위 노드도 따라 막힌다."""
        raise NotImplementedError

    def cache_key_for(self, node_id: str) -> str:
        """이 노드의 현재 캐시 키."""
        raise NotImplementedError


# ---------------------------------------------------------------- 실행 루프


async def execute(
    graph: Graph,
    requested_outputs: Sequence[str],
    *,
    registry: NodeRegistry,
    cache: Cache,
    events: EventSink,
    cancel_token: CancelToken,
    run_id: str | None = None,
) -> RunResult:
    """그래프를 실행한다 (design.md §5.1).

    요청한 출력 노드의 **조상만** 실행된다. 그래프에 있어도 출력에 기여하지
    않는 노드는 건드리지 않는다.

    실행 전에 그래프를 검증한다 — 타입 호환성까지 포함해서, 첫 노드를 돌리기
    전에 실패시킨다 (design.md §2 원칙 2).

    Args:
        graph: 캐논 그래프. 이 함수는 그래프를 변경하지 않는다.
        requested_outputs: 실행을 요청할 노드 ID 들. 보통 `graph.outputs`.
        registry: 노드 타입 조회처.
        cache: 입력 시그니처 캐시. 캐시를 끄려면 `NullCache()`.
        events: 진행률·프리뷰·캐시 히트 이벤트를 받을 싱크.
        cancel_token: 협조적 취소 토큰.
        run_id: 이벤트에 붙는 실행 ID. 없으면 새로 만든다.

    Returns:
        실행 요약. `executed` 와 `cached` 로 무엇이 재실행됐는지 알 수 있다.

    Raises:
        GraphValidationError: 그래프가 구조·타입 검증을 통과하지 못할 때.
            사이클도 여기에 포함된다.
        NodeTypeNotFoundError: 등록되지 않은 노드 타입을 참조할 때.
        NodeExecutionError: 노드가 실패했을 때. 어느 노드인지 지목한다.
        Cancelled: 실행 중 취소됐을 때.
    """
    raise NotImplementedError


async def run_node(
    node_id: str,
    dyn: DynamicGraph,
    schema: NodeSchema,
    inputs: Mapping[str, Any],
    ctx: NodeContext,
) -> NodeOutcome:
    """노드 하나를 실행하고 결과를 분류한다.

    동기 `run` 은 스레드풀로 격리해서 이벤트 루프를 막지 않게 한다
    (design.md §5.4). 코루틴 여부는 `schema.is_async` 로 이미 알고 있다.
    `schema.wants_ctx` 가 참일 때만 `ctx` 를 넘긴다.

    예외를 밖으로 던지지 않고 `Failure` 로 감싸 돌려준다 — 실행 루프가 어느
    노드였는지 붙여서 `NodeExecutionError` 를 만든다.
    """
    raise NotImplementedError


def propagate_blocker(
    node_id: str,
    plan: ExecutionList,
    blocker: ExecutionBlocker,
) -> Sequence[str]:
    """블로커를 하위 노드로 전파한다 (design.md §1.1 ④).

    Returns:
        블로커 때문에 실행되지 않게 된 노드 ID 들.
    """
    raise NotImplementedError


def resolve_inputs(
    node_id: str,
    dyn: DynamicGraph,
    schema: NodeSchema,
    results: Mapping[str, Mapping[str, Any]],
) -> Mapping[str, Any]:
    """노드의 입력을 실제 값으로 푼다.

    링크는 `results` 에서 출처 노드의 출력 소켓 값을 꺼내고, 리터럴은 그대로,
    빠진 입력은 스키마의 기본값으로 채운다.

    Raises:
        NodeExecutionError: 필수 입력이 비어 있거나, 링크가 존재하지 않는 출력
            소켓을 가리킬 때. 어느 소켓인지 지목한다.
    """
    raise NotImplementedError


def validate_for_execution(
    graph: Graph,
    registry: NodeRegistry,
    requested_outputs: Sequence[str] = (),
) -> Sequence[Any]:
    """실행 전 전체 검증 — 구조 + 노드 타입 + 소켓 타입 호환성.

    `nodal.graph.validate_graph` 의 구조 검사에 더해, 레지스트리를 알아야만 할
    수 있는 것들을 본다: 알 수 없는 노드 타입, 없는 입력·출력 소켓, 필수 입력
    누락, 타입 불일치 (`nodal.types.is_compatible`).

    큐 진입 전에 이것을 통과해야 실행이 시작된다 (design.md §4.3).
    `POST /api/graph/validate` 가 실행 없이 이것만 돌린다.

    Returns:
        `GraphIssue` 목록. 비어 있으면 실행 가능하다.
    """
    raise NotImplementedError
