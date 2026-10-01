"""ExecutionBlocker 전파 테스트 (docs/design.md §1.1 ④, §5.1)."""

from __future__ import annotations

from typing import ClassVar

from nodal import (
    INT,
    CancelToken,
    ExecutionBlocker,
    Graph,
    Int,
    LRUCache,
    NodeRegistry,
    NodeResult,
    NullEventSink,
    Type,
    execute,
    node,
    parse_graph,
)


def _blocker_registry(calls: list[str]) -> NodeRegistry:
    @node(id="test.BareBlocker", category="test")
    class BareBlocker:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> ExecutionBlocker:
            calls.append("bare-blocker")
            return ExecutionBlocker("whole node disabled")

    @node(id="test.BlockedStep", category="test")
    class BlockedStep:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append("blocked-step")
            return NodeResult(value + 1)

    @node(id="test.IndependentSibling", category="test")
    class IndependentSibling:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            calls.append("sibling")
            return NodeResult(9)

    @node(id="test.PartialBlocker", category="test")
    class PartialBlocker:
        returns: ClassVar[dict[str, Type]] = {"live": INT, "blocked": INT}

        def run(self) -> NodeResult:
            calls.append("partial-blocker")
            return NodeResult(7, ExecutionBlocker("blocked socket"))

    @node(id="test.BlockedSocketConsumer", category="test")
    class BlockedSocketConsumer:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append("blocked-consumer")
            return NodeResult(value)

    @node(id="test.LiveSocketConsumer", category="test")
    class LiveSocketConsumer:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append("live-consumer")
            return NodeResult(value + 1)

    registry = NodeRegistry()
    registry.register_all(
        (
            BareBlocker,
            BlockedStep,
            IndependentSibling,
            PartialBlocker,
            BlockedSocketConsumer,
            LiveSocketConsumer,
        )
    )
    return registry


def _bare_blocker_graph() -> Graph:
    return parse_graph(
        {
            "nodes": {
                "blocker": {"type": "test.BareBlocker"},
                "blocked_child": {
                    "type": "test.BlockedStep",
                    "inputs": {"value": {"$link": ["blocker", "value"]}},
                },
                "blocked_leaf": {
                    "type": "test.BlockedStep",
                    "inputs": {"value": {"$link": ["blocked_child", "value"]}},
                },
                "sibling": {"type": "test.IndependentSibling"},
            },
            "outputs": ["blocked_leaf", "sibling"],
        }
    )


def _partial_blocker_graph() -> Graph:
    return parse_graph(
        {
            "nodes": {
                "producer": {"type": "test.PartialBlocker"},
                "blocked_consumer": {
                    "type": "test.BlockedSocketConsumer",
                    "inputs": {"value": {"$link": ["producer", "blocked"]}},
                },
                "live_consumer": {
                    "type": "test.LiveSocketConsumer",
                    "inputs": {"value": {"$link": ["producer", "live"]}},
                },
            },
            "outputs": ["blocked_consumer", "live_consumer"],
        }
    )


async def test_bare_blocker_blocks_the_node_and_all_downstream_only() -> None:
    """맨몸 반환은 노드 전체와 하류만 막고 독립 형제는 살린다 (§1.1 ④)."""
    calls: list[str] = []

    result = await execute(
        _bare_blocker_graph(),
        ["blocked_leaf", "sibling"],
        registry=_blocker_registry(calls),
        cache=LRUCache(32),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert set(result.blocked) == {"blocker", "blocked_child", "blocked_leaf"}
    assert set(result.executed) == {"sibling"}
    assert result.cached == ()
    assert result.outputs == {"sibling": {"value": 9}}
    assert set(calls) == {"sibling", "bare-blocker"}
    assert len(calls) == 2
    assert set(result.blocked).isdisjoint(result.executed)
    assert set(result.blocked).isdisjoint(result.cached)


async def test_socket_blocker_only_blocks_consumers_of_that_output() -> None:
    """막힌 출력 소비자는 막고 같은 노드의 정상 출력 소비자는 실행한다 (§1.1 ④)."""
    calls: list[str] = []

    result = await execute(
        _partial_blocker_graph(),
        ["blocked_consumer", "live_consumer"],
        registry=_blocker_registry(calls),
        cache=LRUCache(32),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert result.blocked == ("blocked_consumer",)
    assert set(result.executed) == {"producer", "live_consumer"}
    assert result.cached == ()
    assert result.outputs == {"live_consumer": {"value": 8}}
    assert set(calls) == {"partial-blocker", "live-consumer"}
    assert len(calls) == 2


async def test_cached_partial_blocker_still_blocks_its_socket_consumer() -> None:
    """부분 블로킹 결과의 캐시 히트도 블로커를 값으로 하류에 흘리지 않는다 (§5.3)."""
    calls: list[str] = []
    registry = _blocker_registry(calls)
    graph = _partial_blocker_graph()
    cache = LRUCache(32)

    first = await execute(
        graph,
        ["blocked_consumer", "live_consumer"],
        registry=registry,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
        run_id="partial-first",
    )
    second = await execute(
        graph,
        ["blocked_consumer", "live_consumer"],
        registry=registry,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
        run_id="partial-second",
    )

    assert first.blocked == ("blocked_consumer",)
    assert set(second.blocked) == {"producer", "blocked_consumer"}
    assert set(second.blocked).isdisjoint(second.executed)
    assert set(second.blocked).isdisjoint(second.cached)
    assert second.cached == ("live_consumer",)
    assert second.outputs == {"live_consumer": {"value": 8}}
    assert set(calls) == {"partial-blocker", "live-consumer"}
    assert len(calls) == 2
