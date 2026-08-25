"""실행 엔진 — 용해 방식 위상 정렬과 실행 루프 (docs/design.md §5).

> 이 파일의 시그니처가 M1 테스트가 기대는 표면 전체다. 사용자 확인 없이
> 바꾸지 않는다 (AGENTS.md 협업 규칙 7).

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

import asyncio
import inspect
import time
import traceback
import uuid
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .assets import AssetRef, AssetStore, NullAssetStore
from .cache import MISS, Cache, cache_key
from .errors import GraphIssue, GraphValidationError, IssueCode
from .events import (
    Cancelled,
    CancelToken,
    EventSink,
    NodeCached,
    NodeContext,
    NodeDone,
    NodeError,
    NodeStarted,
    OutputRef,
    RunCancelled,
    RunDone,
    RunFailed,
    RunStarted,
)
from .graph import Graph, Link, Node
from .models import ModelStore, NullModelStore
from .preview import AssetPreview, encode_preview
from .registry import NodeRegistry, NodeTypeNotFoundError
from .schema import NodeResult, NodeSchema
from .types import TensorType, is_compatible, to_type_expr

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
        self._reason = reason

    @property
    def reason(self) -> str | None:
        return self._reason

    def __repr__(self) -> str:
        return f"ExecutionBlocker({self._reason!r})" if self._reason else "ExecutionBlocker()"


# --------------------------------------------------------------- 실행 결과
#
# design.md §5.1 의 match 문이 이 타입들을 분기한다. dataclass 라서 위치 패턴
# (`case Expanded(g)`) 이 그대로 동작한다.


@dataclass(frozen=True, slots=True)
class NodeOutcome:
    """노드 한 번 실행의 결과. 아래 다섯 가지 중 하나다."""


@dataclass(frozen=True, slots=True)
class PreparedGraph:
    """`prepare_for_execution` 의 결과 — 평탄화된 그래프와 검증 결과 (§5.5).

    `issues` 가 비어 있지 않으면 `graph` 를 실행하지 않는다. 평탄화가 문제를
    만난 자리를 건너뛰고 나머지를 폈으므로 불완전할 수 있다.
    """

    graph: Graph
    #: 요청된 출력을 평탄화 후 ID 로 옮긴 것. 인스턴스는 안쪽 노드로 바뀐다.
    outputs: tuple[str, ...]
    #: 요청된 서브그래프 출력의 공개 이름을 실제 노드 소켓으로 옮긴 매핑.
    output_sockets: Mapping[str, Mapping[str, tuple[str, str]]]
    issues: tuple[GraphIssue, ...]


@dataclass(frozen=True, slots=True)
class Success(NodeOutcome):
    """정상 종료. `outputs` 는 소켓 이름 → 값.

    `blocked_sockets` 가 비어 있지 않으면 **부분 블로킹**이다 (design.md §1.1 ④):
    노드는 실제로 실행됐고(`executed`) 나머지 출력은 정상 값이지만, 여기 실린
    소켓들은 값 대신 `ExecutionBlocker` 를 냈다.

    블로킹인데도 `Blocked` 가 아니라 `Success` 인 이유: 실행 루프가 캐시 저장 ·
    `node.done` · 참조 생성을 **똑같이** 해야 하기 때문이다. 분기를 나누면 그
    셋이 두 벌이 되고, 한쪽만 고치는 날이 온다.
    """

    outputs: Mapping[str, Any]
    blocked_sockets: Mapping[str, ExecutionBlocker] = field(default_factory=dict)


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
        references: 노드 출력의 WS/REST 전송 참조. 원시 `outputs`와 분리한다.
        output_sockets: 요청된 서브그래프 출력 이름을 실제 노드 소켓으로 옮긴 매핑.

    `executed` 와 `cached` 를 나눠 두는 것이 M1 완료 기준의 증거다 — "입력 하나를
    바꿨더니 그 아래만 재실행됐다"를 로그가 아니라 값으로 증명할 수 있다.
    """

    run_id: str
    outputs: Mapping[str, Mapping[str, Any]]
    output_sockets: Mapping[str, Mapping[str, tuple[str, str]]] = field(default_factory=dict)
    executed: tuple[str, ...] = ()
    cached: tuple[str, ...] = ()
    blocked: tuple[str, ...] = ()
    elapsed_ms: int = 0
    references: Mapping[str, tuple[OutputRef, ...]] = field(default_factory=dict)


# ------------------------------------------------------------ 동적 그래프


class DynamicGraph:
    """런타임 확장 노드를 얹을 수 있는 그래프 뷰 (design.md §5.2).

    원본 캐논 그래프는 바뀌지 않는다. 확장으로 생긴 ephemeral 노드는 이 뷰에만
    존재하며 **부모 ID 를 유지한다** — 진행률과 에러가 사용자가 실제로 캔버스에서
    보는 노드에 귀속되어야 하기 때문이다.
    """

    def __init__(self, graph: Graph) -> None:
        self._base = graph
        self._ephemeral: dict[str, Node] = {}
        self._parents: dict[str, str] = {}
        self._dependents: dict[str, set[str]] | None = None

    @property
    def base(self) -> Graph:
        """원본 캐논 그래프. 변경되지 않는다."""
        return self._base

    def node(self, node_id: str) -> Node:
        """노드를 꺼낸다. ephemeral 노드도 포함한다.

        Raises:
            KeyError: 뷰에 없는 노드 ID 일 때.
        """
        if node_id in self._ephemeral:
            return self._ephemeral[node_id]
        try:
            return self._base.nodes[node_id]
        except KeyError:
            raise KeyError(f"그래프에 없는 노드: {node_id!r}") from None

    def __contains__(self, node_id: object) -> bool:
        return node_id in self._ephemeral or node_id in self._base.nodes

    def __iter__(self) -> Iterator[str]:
        yield from self._base.nodes
        yield from self._ephemeral

    def dependencies(self, node_id: str) -> Mapping[str, tuple[str, str]]:
        """입력 소켓 이름 → (출처 노드 ID, 출처 소켓). 리터럴 입력은 빠진다."""
        return {
            socket: (link.source_node, link.source_socket)
            for socket, link in self.node(node_id).links()
        }

    def dependents(self, node_id: str) -> frozenset[str]:
        """이 노드의 출력을 소비하는 노드들."""
        if self._dependents is None:
            index: dict[str, set[str]] = {}
            for consumer in self:
                for source, _ in self.dependencies(consumer).values():
                    index.setdefault(source, set()).add(consumer)
            self._dependents = index
        return frozenset(self._dependents.get(node_id, ()))

    def splice(self, node_id: str, subgraph: Graph) -> Sequence[str]:
        """확장된 서브그래프를 `node_id` 자리에 삽입한다.

        새로 생긴 노드들은 ephemeral 이며 `parent_of` 가 `node_id` 를 가리킨다.

        Returns:
            삽입된 ephemeral 노드 ID 들.
        """
        prefix = f"{node_id}:{uuid.uuid4().hex[:8]}"
        renamed = {inner: f"{prefix}:{inner}" for inner in subgraph.nodes}

        inserted: list[str] = []
        for inner, node in subgraph.nodes.items():
            inputs: dict[str, Any] = {}
            for socket, value in node.inputs.items():
                if isinstance(value, Link) and value.source_node in renamed:
                    # 서브그래프 안쪽 링크는 새 ID 로 다시 건다.
                    inputs[socket] = Link.to(renamed[value.source_node], value.source_socket)
                else:
                    inputs[socket] = value
            new_id = renamed[inner]
            self._ephemeral[new_id] = Node(type=node.type, inputs=inputs, meta=node.meta)
            self._parents[new_id] = node_id
            inserted.append(new_id)

        self._dependents = None
        return inserted

    def parent_of(self, node_id: str) -> str | None:
        """ephemeral 노드의 부모. 원본 노드면 `None`."""
        return self._parents.get(node_id)

    def visible_id(self, node_id: str) -> str:
        """사용자가 캔버스에서 보는 노드 ID.

        ephemeral 노드면 부모를 따라 올라간다. 이벤트와 에러는 전부 이 ID 로
        보고한다 — "존재하지 않는 노드에서 에러가 발생"을 막는 장치다.
        """
        seen: set[str] = set()
        current = node_id
        while current in self._parents and current not in seen:
            seen.add(current)
            current = self._parents[current]
        return current

    def is_ephemeral(self, node_id: str) -> bool:
        return node_id in self._ephemeral

    def __repr__(self) -> str:
        return (
            f"DynamicGraph({len(self._base.nodes)}개 원본"
            f"{f' + {len(self._ephemeral)}개 확장' if self._ephemeral else ''})"
        )


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
        self._dyn = dyn
        self._pending: set[str] = set()
        self._block_count: dict[str, int] = {}
        self._blocking: dict[str, set[str]] = {}

    def add_node(self, node_id: str) -> None:
        """노드와 **그 조상들만** 실행 대상에 넣는다. 그래프 전체를 넣지 않는다."""
        if node_id in self._pending:
            return
        if node_id not in self._dyn:
            raise GraphValidationError(
                [
                    GraphIssue(
                        code=IssueCode.UNKNOWN_OUTPUT,
                        message="실행을 요청한 노드가 그래프에 없다",
                        node_id=node_id,
                    )
                ]
            )

        self._pending.add(node_id)
        self._block_count.setdefault(node_id, 0)
        self._blocking.setdefault(node_id, set())

        for source, _ in self._dyn.dependencies(node_id).values():
            if source not in self._dyn:
                # 끊어진 링크. 검증에서 이미 잡혔어야 하지만 여기서도 멈춘다.
                raise GraphValidationError(
                    [
                        GraphIssue(
                            code=IssueCode.UNKNOWN_LINK_TARGET,
                            message=f"존재하지 않는 노드를 가리킨다: {source!r}",
                            node_id=node_id,
                        )
                    ]
                )
            TopologicalSort.add_node(self, source)
            self.add_dependency(node_id, source)

    def add_dependency(self, blocked: str, blocker: str) -> None:
        """`blocked` 가 `blocker` 를 기다리게 한다."""
        blocking = self._blocking.setdefault(blocker, set())
        if blocked in blocking:
            return
        blocking.add(blocked)
        self._block_count[blocked] = self._block_count.get(blocked, 0) + 1

    def is_ready(self, node_id: str) -> bool:
        """막는 노드가 하나도 없으면 참."""
        return node_id in self._pending and self._block_count.get(node_id, 0) == 0

    def ready_nodes(self) -> Sequence[str]:
        """지금 실행 가능한 노드들."""
        return [node_id for node_id in self._pending if self._block_count.get(node_id, 0) == 0]

    def pop(self, node_id: str) -> None:
        """완료 처리하고 이 노드가 막고 있던 노드들의 `block_count` 를 줄인다."""
        self._pending.discard(node_id)
        for blocked in self._blocking.pop(node_id, set()):
            self._block_count[blocked] = max(0, self._block_count.get(blocked, 0) - 1)
        self._block_count.pop(node_id, None)

    def is_empty(self) -> bool:
        return not self._pending

    def pending(self) -> frozenset[str]:
        return frozenset(self._pending)

    def detect_cycle(self) -> Sequence[str] | None:
        """사이클에 속한 노드 ID 들, 없으면 `None`.

        준비된 노드가 없는데 pending 이 남았을 때 호출한다. 에러 메시지가 어느
        노드들이 서로를 물고 있는지 지목할 수 있어야 한다.

        역방향 용해: 남은 노드 중 아무도 기다리지 않는 것부터 걷어낸다. 더 걷어낼
        것이 없는데 남아 있으면 그것이 사이클이다.
        """
        remaining = set(self._pending)
        while True:
            removable = {
                node_id
                for node_id in remaining
                if not any(
                    source in remaining for source, _ in self._dyn.dependencies(node_id).values()
                )
            }
            if not removable:
                break
            remaining -= removable
        return sorted(remaining) if remaining else None


class ExecutionList(TopologicalSort):
    """실행 목록 — 위상 정렬 + 캐시 + UX 선택 휴리스틱.

    `stage()` 로 하나를 꺼내고, `complete()` 나 `unstage()` 로 돌려준다.
    """

    def __init__(self, dyn: DynamicGraph, cache: Cache, registry: NodeRegistry) -> None:
        super().__init__(dyn)
        self._cache = cache
        self._registry = registry
        self._staged: str | None = None
        self._requested: set[str] = set()
        # 키는 (노드, 출력 소켓). 소켓이 None 이면 **노드 전체**가 막힌 것이다
        # (맨몸 `ExecutionBlocker` 반환 또는 상류에서 상속). design.md §1.1 ④.
        self._blocked: dict[tuple[str, str | None], ExecutionBlocker] = {}
        self._key_cache: dict[str, str] = {}

    @property
    def staged(self) -> str | None:
        """현재 꺼내져 있는 노드. 없으면 `None`."""
        return self._staged

    def add_node(self, node_id: str) -> None:
        """실행 대상에 넣는다. 최초로 요청된 노드는 '출력 노드'로 기억해 둔다."""
        first = node_id not in self._pending
        super().add_node(node_id)
        if first and self._staged is None:
            # execute() 가 요청한 출력 노드를 우선순위 계산에 쓴다.
            self._requested.add(node_id)

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
        ready = self.ready_nodes()
        if not ready:
            cycle = self.detect_cycle()
            raise GraphValidationError(
                [
                    GraphIssue(
                        code=IssueCode.CYCLE,
                        message=(
                            f"사이클이라 실행할 수 없다: {' → '.join(cycle)}"
                            if cycle
                            else "실행 가능한 노드가 없다"
                        ),
                        node_id=cycle[0] if cycle else None,
                    )
                ]
            )

        chosen = min(ready, key=lambda node_id: (self._priority(node_id), node_id))
        self._staged = chosen
        return chosen

    def complete(self) -> None:
        """staged 노드를 완료 처리한다."""
        if self._staged is None:
            raise RuntimeError("staged 노드가 없는데 complete() 가 호출됐다")
        self.pop(self._staged)
        self._staged = None

    def unstage(self) -> None:
        """staged 노드를 실행 목록에 되돌린다.

        노드 확장과 lazy 평가가 둘 다 여기에 기댄다 (design.md §5.1).
        """
        self._staged = None

    def add_deps(self, node_id: str, sockets: Sequence[str]) -> None:
        """`node_id` 의 특정 입력 소켓들의 upstream 을 실행 대상에 추가한다.

        lazy 노드가 "지금 나는 A 만 필요하다"고 말했을 때 쓴다.
        """
        dependencies = self._dyn.dependencies(node_id)
        for socket in sockets:
            if socket not in dependencies:
                continue
            source, _ = dependencies[socket]
            self.add_node(source)
            self.add_dependency(node_id, source)

    def mark_blocked(
        self, node_id: str, blocker: ExecutionBlocker, *, socket: str | None = None
    ) -> None:
        """블로커를 표시한다.

        Args:
            socket: 막힌 **출력** 소켓. `None` 이면 노드 전체가 막힌 것이고,
                그 노드의 모든 출력이 막힌 것으로 취급된다.
        """
        self._blocked[(node_id, socket)] = blocker

    def blocker_for(self, node_id: str, socket: str | None = None) -> ExecutionBlocker | None:
        """이 출력에 걸린 블로커. 없으면 `None`.

        노드 전체가 막혀 있으면 어느 소켓을 묻든 그 블로커가 나온다. 반대로
        `socket=None` 으로 물으면 **노드 전체 블로킹만** 답한다 — 소켓 하나가
        막혔다고 노드가 막힌 것은 아니기 때문이다 (그 노드는 `executed` 다).
        """
        whole = self._blocked.get((node_id, None))
        if whole is not None:
            return whole
        if socket is None:
            return None
        return self._blocked.get((node_id, socket))

    def cache_key_for(self, node_id: str) -> str:
        """이 노드의 현재 캐시 키."""
        if node_id in self._key_cache:
            return self._key_cache[node_id]

        node = self._dyn.node(node_id)
        try:
            schema = self._registry.get(node.type, node_id=node_id)
            version = schema.version
        except NodeTypeNotFoundError:
            schema = None
            version = "?"

        resolved: dict[str, Any] = {}
        for socket, value in node.inputs.items():
            if isinstance(value, Link):
                resolved[socket] = self.cache_key_for(value.source_node) + "#" + value.source_socket
            else:
                resolved[socket] = value

        token = self._is_changed_token(node_id, node, schema)
        key = cache_key(node.type, version, resolved, is_changed_token=token)
        self._key_cache[node_id] = key
        return key

    def _is_changed_token(
        self,
        node_id: str,
        node: Node,
        schema: NodeSchema | None,
    ) -> str | None:
        """리터럴 입력만으로 ``is_changed`` 토큰을 한 번 평가한다 (§5.3)."""
        if schema is None or schema.is_changed is None:
            return None

        kwargs: dict[str, Any] = {}
        for name in inspect.signature(schema.is_changed).parameters:
            if name in node.inputs:
                value = node.inputs[name]
                if isinstance(value, Link):
                    linked_cause = ValueError(
                        "`is_changed` 훅은 링크 입력을 받을 수 없다 — 리터럴/위젯 입력만 선언하라"
                    )
                    raise NodeExecutionError(
                        self._dyn.visible_id(node_id),
                        linked_cause,
                        socket=name,
                        ephemeral_id=node_id if self._dyn.is_ephemeral(node_id) else None,
                    )
                kwargs[name] = value
                continue

            spec = schema.inputs[name]
            if spec.required:
                missing_cause = ValueError("`is_changed` 훅에 전달할 필수 리터럴 입력이 없다")
                raise NodeExecutionError(
                    self._dyn.visible_id(node_id),
                    missing_cause,
                    socket=name,
                    ephemeral_id=node_id if self._dyn.is_ephemeral(node_id) else None,
                )
            kwargs[name] = spec.default

        try:
            token = schema.is_changed(**kwargs)
        except Exception as exc:
            hook_cause = RuntimeError(f"`is_changed` 훅 평가 실패: {exc}")
            raise NodeExecutionError(
                self._dyn.visible_id(node_id),
                hook_cause,
                ephemeral_id=node_id if self._dyn.is_ephemeral(node_id) else None,
            ) from exc

        if not isinstance(token, str):
            type_cause = TypeError(
                f"`is_changed` 훅은 str 토큰을 반환해야 한다: {type(token).__name__} 반환"
            )
            raise NodeExecutionError(
                self._dyn.visible_id(node_id),
                type_cause,
                ephemeral_id=node_id if self._dyn.is_ephemeral(node_id) else None,
            )
        return token

    def invalidate_keys(self) -> None:
        """캐시 키 메모를 버린다. 그래프가 확장으로 바뀌었을 때 부른다."""
        self._key_cache.clear()

    def _priority(self, node_id: str) -> int:
        """작을수록 먼저 실행된다. design.md §1.1 ② 의 4단계."""
        schema = self._schema_for(node_id)
        if (schema is not None and (schema.output_node or schema.is_async)) or (
            node_id in self._requested
        ):
            return 0

        blocking = self._blocking.get(node_id, set())
        if blocking & self._requested:
            return 1
        for blocked in blocking:
            if self._blocking.get(blocked, set()) & self._requested:
                return 2
        return 3

    def _schema_for(self, node_id: str) -> NodeSchema | None:
        try:
            return self._registry.get(self._dyn.node(node_id).type, node_id=node_id)
        except (NodeTypeNotFoundError, KeyError):
            return None


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
    assets: AssetStore | None = None,
    models: ModelStore | None = None,
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
        assets: 실행 중인 노드와 출력 직렬화가 공유할 에셋 저장소.

    Returns:
        실행 요약. `executed` 와 `cached` 로 무엇이 재실행됐는지 알 수 있다.

    Raises:
        GraphValidationError: 그래프가 구조·타입 검증을 통과하지 못할 때.
            사이클도 여기에 포함된다.
        NodeTypeNotFoundError: 등록되지 않은 노드 타입을 참조할 때.
        NodeExecutionError: 노드가 실패했을 때. 어느 노드인지 지목한다.
        Cancelled: 실행 중 취소됐을 때.
    """
    prepared = prepare_for_execution(graph, registry, requested_outputs)
    if prepared.issues:
        raise GraphValidationError(list(prepared.issues))

    # 실행되는 것은 **평탄화된** 그래프다. 서브그래프 인스턴스는 여기 없다 (§5.5).
    executable = prepared.graph
    requested_outputs = prepared.outputs

    identifier = run_id or uuid.uuid4().hex
    started_at = time.perf_counter()

    asset_store = assets if assets is not None else NullAssetStore()
    model_store = models if models is not None else NullModelStore()
    dyn = DynamicGraph(executable)
    plan = ExecutionList(dyn, cache, registry)
    for out_id in requested_outputs:
        plan.add_node(out_id)

    results: dict[str, Mapping[str, Any]] = {}
    executed: list[str] = []
    cached: list[str] = []
    blocked: list[str] = []
    references: dict[str, tuple[OutputRef, ...]] = {}

    events.emit(RunStarted(t="run.started", run_id=identifier, node_count=len(plan.pending())))

    def elapsed_ms() -> int:
        return int((time.perf_counter() - started_at) * 1000)

    try:
        while not plan.is_empty():
            cancel_token.raise_if_cancelled()

            node_id = await plan.stage()
            visible = dyn.visible_id(node_id)
            schema = registry.get(dyn.node(node_id).type, node_id=node_id)

            # 상위에서 블로커가 내려왔으면 실행하지 않고 그대로 전파한다.
            inherited = _inherited_blocker(node_id, dyn, plan)
            if inherited is not None:
                plan.mark_blocked(node_id, inherited)
                blocked.append(node_id)
                plan.complete()
                continue

            try:
                key = plan.cache_key_for(node_id)
            except NodeExecutionError as exc:
                events.emit(
                    NodeError(
                        t="node.error",
                        run_id=identifier,
                        node_id=exc.node_id,
                        message=str(exc.cause),
                        traceback=tuple(
                            traceback.format_exception(
                                type(exc.cause), exc.cause, exc.cause.__traceback__
                            )
                        ),
                        socket=exc.socket,
                    )
                )
                raise
            if schema.cacheable:
                hit = cache.get(key)
                if hit is not MISS:
                    # 캐시에 블로커가 실려 있을 수 있다 — 부분 블로킹 노드의
                    # 출력을 그대로 저장하기 때문이다. 여기서 알아보지 않으면
                    # 첫 실행만 맞고 두 번째 실행부터 블로커가 값으로 되살아난다
                    # (design.md §5.3, decisions.md G1).
                    hit_blocked = _blocked_sockets(hit)
                    results[node_id] = _without(hit, hit_blocked)
                    if hit_blocked:
                        blocked.extend(_block_sockets(node_id, plan, hit_blocked, own=True))
                    else:
                        cached.append(node_id)
                        events.emit(NodeCached(t="node.cached", run_id=identifier, node_id=visible))
                    plan.complete()
                    continue

            events.emit(NodeStarted(t="node.started", run_id=identifier, node_id=visible))

            inputs = resolve_inputs(node_id, dyn, schema, results)
            # `ctx` 에는 **원본** 그래프를 준다 (평탄화 전). PNG `iTXt` 에 심기는
            # 워크플로가 사용자가 쓴 문서여야 복원했을 때 정의가 살아 돌아온다
            # — 평탄화 결과를 심으면 템플릿 구조가 사라진 사본이 남는다 (§5.5).
            ctx = NodeContext(
                visible, identifier, events, cancel_token, asset_store, graph, model_store
            )
            outcome = await run_node(node_id, dyn, schema, inputs, ctx)

            match outcome:
                case Success():
                    # 막힌 소켓은 `results` 에 넣지 않는다. 값이 없는 소켓이고,
                    # 하류는 어차피 막혀 읽지 않는다. 혹시 전파에 구멍이 있어도
                    # `resolve_inputs` 가 "출력 소켓이 없다" 고 **노드와 소켓을
                    # 지목해** 실패한다 — 블로커가 인자로 흘러드는 것보다 낫다.
                    visible_outputs = _without(outcome.outputs, outcome.blocked_sockets)
                    results[node_id] = visible_outputs
                    executed.append(node_id)
                    try:
                        refs = _output_refs(visible_outputs, schema, asset_store)
                    except Exception as exc:
                        events.emit(
                            NodeError(
                                t="node.error",
                                run_id=identifier,
                                node_id=visible,
                                message=str(exc),
                                traceback=tuple(
                                    traceback.format_exception(type(exc), exc, exc.__traceback__)
                                ),
                            )
                        )
                        raise NodeExecutionError(visible, exc) from exc
                    if schema.cacheable:
                        # 블로커까지 **그대로** 저장한다. 빼고 저장하면 히트 시
                        # "출력이 없는 정상 결과" 로 보여 하류가 그냥 실행된다.
                        cache.set(key, outcome.outputs)
                    references[node_id] = refs
                    events.emit(
                        NodeDone(
                            t="node.done",
                            run_id=identifier,
                            node_id=visible,
                            outputs=refs,
                        )
                    )
                    if outcome.blocked_sockets:
                        # 노드 자신은 `executed` 다 — 실제로 실행됐고 나머지
                        # 출력은 값이다 (design.md §1.1 ④).
                        blocked.extend(
                            _block_sockets(node_id, plan, outcome.blocked_sockets, own=False)
                        )
                    plan.complete()

                case Expanded():
                    # 봉인 (design.md §5.2, E1). 봉인 전에는 `splice` 뒤에
                    # `unstage()` 를 불렀는데, `unstage` 는 노드를 pending 에
                    # 되돌리기만 해서 같은 노드가 다시 확장하는 **무한 루프**가
                    # 됐다. 열 때 채워야 할 것은 §5.2 "목표" 에 있다.
                    raise NotImplementedError(
                        f"nodes.{visible}: 노드 확장(서브그래프 반환)은 봉인돼 있다 "
                        f"— 노드 타입 {dyn.node(node_id).type!r} 이 Expanded 를 돌려줬다. "
                        "서브그래프는 로드가 아니라 검증 단계에서 평탄화된다 "
                        "(design.md §5.2 · §12.7). 확장이 다시 필요하면 §5.2 의 "
                        "'목표' 세 가지를 함께 구현해야 한다"
                    )

                case NeedsLazy(deps):
                    plan.add_deps(node_id, deps)
                    plan.unstage()

                case Blocked(blocker):
                    plan.mark_blocked(node_id, blocker)
                    blocked.extend(propagate_blocker(node_id, plan, blocker))
                    blocked.append(node_id)
                    plan.complete()

                case Failure(error, socket):
                    events.emit(
                        NodeError(
                            t="node.error",
                            run_id=identifier,
                            node_id=visible,
                            message=str(error),
                            traceback=tuple(
                                traceback.format_exception(type(error), error, error.__traceback__)
                            ),
                            socket=socket,
                        )
                    )
                    raise NodeExecutionError(
                        visible,
                        error,
                        socket=socket,
                        ephemeral_id=node_id if dyn.is_ephemeral(node_id) else None,
                    ) from error

                case _:  # pragma: no cover — NodeOutcome 은 위 다섯 가지가 전부다
                    raise NodeExecutionError(
                        visible, TypeError(f"알 수 없는 실행 결과: {outcome!r}")
                    )

        # 캐시 히트인 요청 출력은 node.done 을 다시 내지 않으므로 여기서 참조만 만든다.
        for out_id in requested_outputs:
            if out_id in results and out_id not in references:
                schema = registry.get(dyn.node(out_id).type, node_id=out_id)
                try:
                    references[out_id] = _output_refs(results[out_id], schema, asset_store)
                except Exception as exc:
                    visible = dyn.visible_id(out_id)
                    events.emit(
                        NodeError(
                            t="node.error",
                            run_id=identifier,
                            node_id=visible,
                            message=str(exc),
                            traceback=tuple(
                                traceback.format_exception(type(exc), exc, exc.__traceback__)
                            ),
                        )
                    )
                    raise NodeExecutionError(visible, exc) from exc

    except Cancelled:
        events.emit(RunCancelled(t="run.cancelled", run_id=identifier, elapsed_ms=elapsed_ms()))
        raise

    except BaseException as exc:
        # 실패에도 run 레벨 종료 이벤트가 나가야 한다. 없으면 프론트의 상태
        # 머신이 종료 신호를 영원히 기다린다 (`node.error` 는 노드 단위이고,
        # 사이클처럼 어느 노드에도 귀속되지 않는 실패도 있다).
        events.emit(
            RunFailed(
                t="run.failed",
                run_id=identifier,
                elapsed_ms=elapsed_ms(),
                code=_failure_code(exc),
                message=str(exc),
            )
        )
        raise

    events.emit(RunDone(t="run.done", run_id=identifier, elapsed_ms=elapsed_ms()))

    return RunResult(
        run_id=identifier,
        outputs={
            out_id: results.get(out_id, {}) for out_id in requested_outputs if out_id in results
        },
        output_sockets=prepared.output_sockets,
        executed=tuple(executed),
        cached=tuple(cached),
        blocked=tuple(dict.fromkeys(blocked)),
        elapsed_ms=elapsed_ms(),
        references=references,
    )


def _failure_code(exc: BaseException) -> str:
    """실패 사유의 안정적인 코드. 서버의 `ErrorBody.code` 와 같은 어휘를 쓴다."""
    if isinstance(exc, NodeExecutionError):
        return "node_failed"
    if isinstance(exc, GraphValidationError):
        return "graph_invalid"
    return "internal_error"


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
    call_kwargs = dict(inputs)
    if schema.wants_ctx:
        call_kwargs["ctx"] = ctx

    instance = schema.node_class()
    try:
        if schema.is_async:
            raw = await instance.run(**call_kwargs)
        else:
            # 동기 노드가 이벤트 루프를 막지 않게 스레드로 보낸다.
            raw = await asyncio.to_thread(instance.run, **call_kwargs)
        # `NodeResult(preview=...)` 는 최종 프리뷰라 실행별 저장소에 남긴다.
        if isinstance(raw, NodeResult) and raw.preview is not None:
            ctx.preview(raw.preview, persistent=True)
        return _classify(raw, schema)
    except Cancelled:
        raise
    except Exception as exc:
        return Failure(exc)


def _output_refs(
    outputs: Mapping[str, Any],
    schema: NodeSchema,
    assets: AssetStore,
) -> tuple[OutputRef, ...]:
    """노드 출력을 WS 로 내보낼 참조로 바꾼다 (design.md §6).

    JSON 으로 표현되는 값은 `inline` 에 싣는다. 그렇지 않은 값은 등록된 인코더가
    처리할 수 있으면 실행별 저장소에 넣고 `asset` 을 채운다. 모델 핸들처럼 인코더가
    모르는 값은 둘 다 비어 있지만 소켓 이름과 타입은 언제나 실린다.
    """
    refs: list[OutputRef] = []
    for socket, value in outputs.items():
        spec = schema.outputs.get(socket)
        inline = value if _is_json_safe(value) else None
        asset = None
        if isinstance(value, AssetRef):
            # 노드가 이미 저장소에 넣고 참조를 돌려줬다 (Save 노드가 그렇다).
            # 다시 인코딩하면 워크플로가 심긴 PNG 대신 맨 PNG 가 하나 더 생긴다.
            asset = value
        elif inline is None:
            preview = encode_preview(
                value,
                assets=assets,
                persistent=True,
                required=spec is not None and isinstance(spec.type, TensorType),
            )
            if isinstance(preview, AssetPreview):
                asset = preview.asset
        refs.append(
            OutputRef(
                socket=socket,
                type=to_type_expr(spec.type) if spec else "Any",
                inline=inline,
                asset=asset,
            )
        )
    return tuple(refs)


def _is_json_safe(value: Any) -> bool:
    """WS 로 그대로 실어 보낼 수 있는 값인지."""
    if isinstance(value, str | int | float | bool | type(None)):
        return True
    if isinstance(value, Mapping):
        return all(isinstance(k, str) and _is_json_safe(v) for k, v in value.items())
    if isinstance(value, list | tuple):
        return all(_is_json_safe(item) for item in value)
    return False


def _classify(raw: Any, schema: NodeSchema) -> NodeOutcome:
    """`run` 의 반환값을 실행 결과 타입으로 분류한다."""
    if isinstance(raw, NodeOutcome):
        # 노드가 직접 Expanded/NeedsLazy 등을 돌려준 경우 (M5).
        return raw
    if isinstance(raw, ExecutionBlocker):
        return Blocked(raw)
    if isinstance(raw, Graph):
        return Expanded(raw)

    result = raw if isinstance(raw, NodeResult) else NodeResult(raw)
    try:
        outputs = result.as_outputs(schema)
    except Exception as exc:
        return Failure(exc)
    # 값 중 하나가 블로커면 **그 소켓만** 막힌다 (design.md §1.1 ④). 이것을 보지
    # 않으면 블로커가 값처럼 하류 노드의 인자로 들어가고, 실패가 블로커를 만든
    # 곳이 아니라 엉뚱한 노드의 타입 에러로 나타난다.
    return Success(outputs, blocked_sockets=_blocked_sockets(outputs))


def _blocked_sockets(outputs: Mapping[str, Any]) -> dict[str, ExecutionBlocker]:
    """출력 중 `ExecutionBlocker` 인 소켓들.

    갓 실행한 결과와 **캐시에서 꺼낸 결과**가 같은 판정을 받아야 하므로 한 곳에
    둔다 (§5.3). 캐시가 블로커를 값으로 되살리면 첫 실행만 맞고 두 번째부터
    틀린다.
    """
    return {
        socket: value for socket, value in outputs.items() if isinstance(value, ExecutionBlocker)
    }


def _without(
    outputs: Mapping[str, Any], blocked: Mapping[str, ExecutionBlocker]
) -> Mapping[str, Any]:
    """막힌 소켓을 뺀 출력. 하나도 안 막혔으면 원본을 그대로 돌려준다."""
    if not blocked:
        return outputs
    return {socket: value for socket, value in outputs.items() if socket not in blocked}


def _block_sockets(
    node_id: str,
    plan: ExecutionList,
    blocked_sockets: Mapping[str, ExecutionBlocker],
    *,
    own: bool,
) -> list[str]:
    """부분 블로킹을 표시하고 하류로 전파한다.

    갓 실행한 결과와 캐시 히트가 **같은 경로**를 타게 하려고 하나로 묶었다
    (decisions.md G1). 둘로 나누면 한쪽만 고치는 날이 온다.

    Args:
        own: 이 노드 자신을 `blocked` 로 보고할지. 갓 실행한 노드는 `executed`
            이므로 `False`, 캐시 히트는 `True` 다 (사용자 결정 G1).

    Returns:
        `blocked` 에 더할 노드 ID 들.
    """
    marked: list[str] = []
    for socket, blocker in blocked_sockets.items():
        plan.mark_blocked(node_id, blocker, socket=socket)
    for socket, blocker in blocked_sockets.items():
        marked.extend(propagate_blocker(node_id, plan, blocker, sockets=frozenset({socket})))
    if own:
        marked.append(node_id)
    return marked


def propagate_blocker(
    node_id: str,
    plan: ExecutionList,
    blocker: ExecutionBlocker,
    *,
    sockets: frozenset[str] | None = None,
) -> Sequence[str]:
    """블로커를 하위 노드로 전파한다 (design.md §1.1 ④).

    Args:
        sockets: 막힌 **출력 소켓** 이름들. `None` 이면 노드 전체가 막힌 것이라
            이 노드를 읽는 모든 소비자가 막힌다. 집합을 주면 **그 소켓을 링크로
            읽는 소비자만** 막히고, 다른 출력을 읽는 소비자는 산다.

    Returns:
        블로커 때문에 실행되지 않게 된 노드 ID 들.

    Note:
        전파된 노드는 **통째로** 막힌다. 입력 하나가 막히면 그 노드는 실행될 수
        없고, 따라서 어떤 출력도 낼 수 없기 때문이다. 소켓 단위 블로킹은 노드가
        스스로 만들어 낼 때만 생긴다.
    """
    dyn = plan._dyn
    marked: list[str] = []
    frontier: list[tuple[str, frozenset[str] | None]] = [(node_id, sockets)]
    seen = {node_id}

    while frontier:
        current, current_sockets = frontier.pop()
        for consumer in _consumers_of(dyn, current, current_sockets):
            if consumer in seen or consumer not in plan.pending():
                continue
            seen.add(consumer)
            plan.mark_blocked(consumer, blocker)
            marked.append(consumer)
            frontier.append((consumer, None))

    return marked


def _consumers_of(
    dyn: DynamicGraph,
    source: str,
    sockets: frozenset[str] | None,
) -> Iterator[str]:
    """`source` 의 (해당 소켓) 출력을 링크로 읽는 노드들.

    `sockets` 가 `None` 이면 소켓을 가리지 않는다. `dyn.dependents` 는 노드
    단위라서 그것만으로는 "같은 노드의 다른 출력을 쓰는 하류" 를 구분할 수 없다
    — 링크가 실제로 어느 소켓을 가리키는지 여기서 다시 본다.
    """
    for consumer in dyn.dependents(source):
        for src, src_socket in dyn.dependencies(consumer).values():
            if src == source and (sockets is None or src_socket in sockets):
                yield consumer
                break


def _inherited_blocker(
    node_id: str,
    dyn: DynamicGraph,
    plan: ExecutionList,
) -> ExecutionBlocker | None:
    """입력 중 하나라도 **막힌 출력 소켓**에서 왔으면 그 블로커를 돌려준다.

    소켓을 보는 것이 요점이다. 상류 노드가 부분 블로킹이어도, 이 노드가 **막히지
    않은 소켓**을 읽고 있으면 정상 실행된다 (design.md §1.1 ④).
    """
    own = plan.blocker_for(node_id)
    if own is not None:
        return own
    for source, source_socket in dyn.dependencies(node_id).values():
        upstream = plan.blocker_for(source, source_socket)
        if upstream is not None:
            return upstream
    return None


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
    visible = dyn.visible_id(node_id)
    node = dyn.node(node_id)
    resolved: dict[str, Any] = {}

    for name, spec in schema.inputs.items():
        value = node.inputs.get(name)

        if isinstance(value, Link):
            upstream = results.get(value.source_node)
            if upstream is None:
                raise NodeExecutionError(
                    visible,
                    RuntimeError(f"출처 노드 {value.source_node!r} 의 결과가 아직 없다"),
                    socket=name,
                )
            if value.source_socket not in upstream:
                available = ", ".join(upstream) or "(출력 없음)"
                raise NodeExecutionError(
                    visible,
                    KeyError(
                        f"출처 노드 {value.source_node!r} 에 출력 소켓 "
                        f"{value.source_socket!r} 이 없다. 있는 것: {available}"
                    ),
                    socket=name,
                )
            resolved[name] = upstream[value.source_socket]
            continue

        if value is not None:
            resolved[name] = value
            continue

        if spec.required:
            raise NodeExecutionError(
                visible,
                ValueError("필수 입력이 비어 있다"),
                socket=name,
            )
        resolved[name] = spec.default

    return resolved


def prepare_for_execution(
    graph: Graph,
    registry: NodeRegistry,
    requested_outputs: Sequence[str] = (),
) -> PreparedGraph:
    """실행 준비 — **① 평탄화 → ② 검증** (design.md §5.5).

    평탄화가 검증의 첫 걸음인 이유는 §5.5 에 있다. 요약하면: 서브그래프가 펴진
    뒤라야 노드 타입 · 소켓 타입 · 필수 입력을 볼 수 있고, 평탄화가 만나는 문제
    (필수 파라미터 누락 등)도 예외가 아니라 같은 `issues` 목록에 실려야 한다.
    MCP 는 실행을 시작하기 **전에** 무엇이 잘못됐는지 들어야 한다 (§12.3).

    **`flatten` 을 부르는 곳은 여기 하나뿐이다.** `execute` 도 이 함수를 지나며,
    그래서 실행되는 그래프와 검증된 그래프가 같다는 것이 구조적으로 보장된다.

    Returns:
        평탄화된 그래프 · 옮겨진 출력 목록과 소켓 매핑 · `GraphIssue` 목록.
    """
    from .graph import validate_graph
    from .subgraph import flatten

    # 문서 자기모순은 평탄화 **전에** 본다. 정의가 자기모순이면 펼 이유가 없고,
    # 사이클을 편 결과는 무한하다 (§5.5 의 검증 표).
    document_issues = list(validate_graph(graph))

    result = flatten(graph, tuple(requested_outputs))
    issues: list[GraphIssue] = document_issues + list(result.issues)
    flat = result.graph
    outputs = result.outputs

    issues.extend(_registry_issues(flat, registry, outputs))
    return PreparedGraph(
        graph=flat,
        outputs=outputs,
        output_sockets=result.output_sockets,
        issues=tuple(issues),
    )


def validate_for_execution(
    graph: Graph,
    registry: NodeRegistry,
    requested_outputs: Sequence[str] = (),
) -> Sequence[Any]:
    """실행 전 전체 검증 — 구조 + 노드 타입 + 소켓 타입 호환성.

    `prepare_for_execution` 에서 이슈만 꺼낸 얇은 껍데기다. 그래프를 돌려받을
    필요가 없는 호출자(`POST /api/graph/validate`)를 위해 남아 있다 — 응답
    형상이 바뀌지 않는 이유가 이것이다.

    Returns:
        `GraphIssue` 목록. 비어 있으면 실행 가능하다. `list` 로 돌려주는 것은
        M1 부터의 모양이다 — 호출자가 `== []` 로 비교하는 곳이 있다.
    """
    return list(prepare_for_execution(graph, registry, requested_outputs).issues)


def _registry_issues(
    graph: Graph,
    registry: NodeRegistry,
    requested_outputs: Sequence[str],
) -> list[GraphIssue]:
    """레지스트리를 알아야만 할 수 있는 검사들.

    알 수 없는 노드 타입, 없는 입력·출력 소켓, 필수 입력 누락, 타입 불일치
    (`nodal.types.is_compatible`), 그리고 `is_changed` 훅의 링크 입력.

    **평탄화된 그래프 위에서 돈다.** 서브그래프 인스턴스는 이미 사라졌으므로
    여기서 `subgraph.*` 를 만날 일이 없다.
    """
    issues: list[GraphIssue] = []

    schemas: dict[str, NodeSchema] = {}
    for node_id, node in graph.nodes.items():
        try:
            schemas[node_id] = registry.get(node.type, node_id=node_id)
        except NodeTypeNotFoundError:
            issues.append(
                GraphIssue(
                    code=IssueCode.UNKNOWN_NODE_TYPE,
                    message=f"등록되지 않은 노드 타입: {node.type!r}",
                    node_id=node_id,
                )
            )

    for out_id in requested_outputs:
        if out_id not in graph.nodes:
            issues.append(
                GraphIssue(
                    code=IssueCode.UNKNOWN_OUTPUT,
                    message="실행을 요청한 노드가 그래프에 없다",
                    node_id=out_id,
                )
            )

    for node_id, schema in schemas.items():
        node = graph.nodes[node_id]

        for socket, value in node.inputs.items():
            if socket not in schema.inputs:
                known = ", ".join(schema.inputs) or "(입력 없음)"
                issues.append(
                    GraphIssue(
                        code=IssueCode.UNKNOWN_INPUT_SOCKET,
                        message=f"{schema.id} 에 없는 입력 소켓이다. 있는 것: {known}",
                        node_id=node_id,
                        socket=socket,
                    )
                )
                continue

            if not isinstance(value, Link):
                continue

            source_schema = schemas.get(value.source_node)
            if source_schema is None:
                continue

            if value.source_socket not in source_schema.outputs:
                known = ", ".join(source_schema.outputs) or "(출력 없음)"
                issues.append(
                    GraphIssue(
                        code=IssueCode.UNKNOWN_OUTPUT_SOCKET,
                        message=(
                            f"{source_schema.id} 에 출력 소켓 {value.source_socket!r} 이 "
                            f"없다. 있는 것: {known}"
                        ),
                        node_id=node_id,
                        socket=socket,
                    )
                )
                continue

            source_type = source_schema.outputs[value.source_socket].type
            target_type = schema.inputs[socket].type
            if not is_compatible(source_type, target_type):
                issues.append(
                    GraphIssue(
                        code=IssueCode.TYPE_MISMATCH,
                        message=(
                            f"{value.source_node}.{value.source_socket} "
                            f"({source_type.describe()}) 를 이 소켓"
                            f"({target_type.describe()})에 연결할 수 없다"
                        ),
                        node_id=node_id,
                        socket=socket,
                    )
                )

        for name, spec in schema.inputs.items():
            if spec.required and name not in node.inputs:
                issues.append(
                    GraphIssue(
                        code=IssueCode.MISSING_REQUIRED_INPUT,
                        message="필수 입력이 비어 있다",
                        node_id=node_id,
                        socket=name,
                    )
                )

        issues.extend(_is_changed_issues(node_id, node, schema))

    return issues


def _is_changed_issues(node_id: str, node: Node, schema: NodeSchema) -> list[GraphIssue]:
    """`is_changed` 훅이 링크로 채워진 입력을 요구하는가 (design.md §5.3).

    훅은 캐시를 **조회하기 전에** 평가되는데 링크 값은 상류를 실행한 뒤에야
    존재한다. 그래서 훅은 리터럴/위젯 입력만 받는다.

    **평탄화 뒤에 판정해야 한다.** 정의 안에서 `{"$param": "path"}` 였던 입력이
    인스턴스에서 링크로 채워질 수 있고, 그때 비로소 훅이 링크 입력을 받게 된다
    — 평탄화 전에는 알 수 없다.

    실행 시점 방어(`ExecutionList._is_changed_token`)는 그대로 둔다. 검증을
    건너뛰고 `execute` 를 직접 부르는 경로가 있다 (§2 원칙 2 는 큐 진입 전
    검증을 요구하지만, 라이브러리로 쓰는 호출자까지 강제하지는 못한다).
    """
    if schema.is_changed is None:
        return []
    issues: list[GraphIssue] = []
    for name in inspect.signature(schema.is_changed).parameters:
        if isinstance(node.inputs.get(name), Link):
            issues.append(
                GraphIssue(
                    code=IssueCode.IS_CHANGED_LINKED_INPUT,
                    message=(
                        f"{schema.id} 의 `is_changed` 훅이 이 입력을 읽는데 링크로 "
                        "채워져 있다 — 훅은 캐시 조회 전에 평가되므로 리터럴/위젯 "
                        "입력만 받을 수 있다"
                    ),
                    node_id=node_id,
                    socket=name,
                )
            )
    return issues
