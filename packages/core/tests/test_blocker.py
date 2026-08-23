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
    @node(id="test.BlockerSource", category="test")
    class BlockerSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            calls.append("blocker")
            return NodeResult(ExecutionBlocker("disabled branch"))

    @node(id="test.BlockedStep", category="test")
    class BlockedStep:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append("blocked-step")
            return NodeResult(value + 1)

    @node(id="test.BlockerSibling", category="test")
    class BlockerSibling:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append("sibling")
            return NodeResult(value)

    registry = NodeRegistry()
    registry.register_all((BlockerSource, BlockedStep, BlockerSibling))
    return registry


def _blocker_graph() -> Graph:
    return parse_graph(
        {
            "nodes": {
                "blocker": {"type": "test.BlockerSource"},
                "blocked_child": {
                    "type": "test.BlockedStep",
                    "inputs": {"value": {"$link": ["blocker", "value"]}},
                },
                "blocked_leaf": {
                    "type": "test.BlockedStep",
                    "inputs": {"value": {"$link": ["blocked_child", "value"]}},
                },
                "sibling": {
                    "type": "test.BlockerSibling",
                    "inputs": {"value": 9},
                },
            },
            "outputs": ["blocked_leaf", "sibling"],
        }
    )


async def test_blocker_propagates_to_all_downstream_nodes() -> None:
    """블로커를 받은 노드와 그 하류가 모두 blocked에 기록된다 (§1.1 ④)."""
    calls: list[str] = []

    result = await execute(
        _blocker_graph(),
        ["blocked_leaf", "sibling"],
        registry=_blocker_registry(calls),
        cache=LRUCache(32),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert set(result.blocked) == {"blocked_child", "blocked_leaf"}
    assert "blocked-step" not in calls


async def test_blocker_does_not_stop_an_independent_sibling_branch() -> None:
    """블로커와 의존 관계가 없는 형제 출력은 정상 실행된다 (§1.1 ④)."""
    calls: list[str] = []

    result = await execute(
        _blocker_graph(),
        ["blocked_leaf", "sibling"],
        registry=_blocker_registry(calls),
        cache=LRUCache(32),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert result.outputs["sibling"] == {"value": 9}
    assert "sibling" in result.executed
    assert "sibling" not in result.blocked
    assert calls == ["blocker", "sibling"]


async def test_blocked_nodes_are_neither_executed_nor_cached() -> None:
    """전파로 막힌 노드는 실행 및 캐시 히트 집합에서 제외된다 (§5.1)."""
    calls: list[str] = []

    result = await execute(
        _blocker_graph(),
        ["blocked_leaf", "sibling"],
        registry=_blocker_registry(calls),
        cache=LRUCache(32),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    blocked = set(result.blocked)
    assert blocked
    assert blocked.isdisjoint(result.executed)
    assert blocked.isdisjoint(result.cached)
