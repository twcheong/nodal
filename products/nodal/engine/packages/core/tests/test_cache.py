"""입력 시그니처 캐시 테스트 (docs/design.md §5.3)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, ClassVar

from nodal import (
    INT,
    MISS,
    CancelToken,
    Int,
    LRUCache,
    NodeRegistry,
    NodeResult,
    NodeSchema,
    NullCache,
    NullEventSink,
    Type,
    cache_key,
    execute,
    graph_cache_keys,
    node,
    parse_graph,
)

BASE_DIAMOND = {
    "nodes": {
        "a": {"type": "test.Value", "inputs": {"value": 2}},
        "b": {
            "type": "test.Offset",
            "inputs": {"value": {"$link": ["a", "value"]}, "amount": 1},
        },
        "c": {
            "type": "test.Offset",
            "inputs": {"value": {"$link": ["a", "value"]}, "amount": 10},
        },
        "d": {
            "type": "test.Add",
            "inputs": {
                "left": {"$link": ["b", "value"]},
                "right": {"$link": ["c", "value"]},
            },
        },
    },
    "outputs": ["d"],
}


def _schema(type_id: str, *, version: str = "1") -> NodeSchema:
    return NodeSchema(
        id=type_id,
        title=type_id,
        category="test",
        aliases=(),
        version=version,
        output_node=False,
        cacheable=True,
        inputs={},
        outputs={},
        node_class=object,
        is_async=False,
        wants_ctx=False,
    )


def _registry_with_arithmetic_nodes(calls: list[str]) -> NodeRegistry:
    @node(id="test.Value", category="test")
    class Value:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append("value")
            return NodeResult(value)

    @node(id="test.Offset", category="test")
    class Offset:
        value: Int = Int()
        amount: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int, amount: int) -> NodeResult:
            calls.append("offset")
            return NodeResult(value + amount)

    @node(id="test.Add", category="test")
    class Add:
        left: Int = Int()
        right: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, left: int, right: int) -> NodeResult:
            calls.append("add")
            return NodeResult(left + right)

    registry = NodeRegistry()
    registry.register_all((Value, Offset, Add))
    return registry


def test_cache_key_is_deterministic_and_mapping_order_independent() -> None:
    """동일한 재귀 입력 내용은 딕셔너리 순서와 무관하게 같은 키다 (§5.3)."""
    left = cache_key(
        "test.Node",
        "1",
        {"a": {"x": 1, "y": [2, 3]}, "b": True},
    )
    right = cache_key(
        "test.Node",
        "1",
        {"b": True, "a": {"y": [2, 3], "x": 1}},
    )

    assert left == right
    assert left
    int(left, 16)


def test_cache_key_changes_for_every_declared_signature_component() -> None:
    """타입·스키마 버전·입력값·IS_CHANGED 토큰이 모두 키에 참여한다 (§5.3)."""
    baseline = cache_key("test.Node", "1", {"value": 1})

    assert cache_key("test.Other", "1", {"value": 1}) != baseline
    assert cache_key("test.Node", "2", {"value": 1}) != baseline
    assert cache_key("test.Node", "1", {"value": 2}) != baseline
    assert cache_key("test.Node", "1", {"other": 1}) != baseline
    assert cache_key("test.Node", "1", {"value": [1, 2]}) != cache_key(
        "test.Node", "1", {"value": [2, 1]}
    )
    assert cache_key("test.Node", "1", {"value": 1}, is_changed_token="new") != baseline


def test_graph_cache_key_ignores_node_id_and_ui_metadata() -> None:
    """키는 노드 ID가 아니라 노드 타입과 해석된 입력 내용으로 정한다 (§5.3)."""
    graph = parse_graph(
        {
            "nodes": {
                "first": {
                    "type": "test.Value",
                    "inputs": {"value": 7},
                    "meta": {"title": "첫 노드"},
                },
                "copy": {
                    "type": "test.Value",
                    "inputs": {"value": 7},
                    "meta": {"title": "복사본"},
                },
            },
            "ui": {"first": {"pos": [0, 0]}, "copy": {"pos": [100, 0]}},
        }
    )

    keys = graph_cache_keys(graph, {"test.Value": _schema("test.Value")})

    assert keys["first"] == keys["copy"]


async def test_changed_input_invalidates_only_that_node_and_descendants() -> None:
    """B 입력 변경 시 A·C는 캐시되고 B·D만 재실행된다 (§2 원칙 4, §5.3)."""
    calls: list[str] = []
    registry = _registry_with_arithmetic_nodes(calls)
    cache = LRUCache(32)

    first = await execute(
        parse_graph(BASE_DIAMOND),
        ["d"],
        registry=registry,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
        run_id="first",
    )
    changed = {
        **BASE_DIAMOND,
        "nodes": {
            **BASE_DIAMOND["nodes"],
            "b": {
                "type": "test.Offset",
                "inputs": {"value": {"$link": ["a", "value"]}, "amount": 3},
            },
        },
    }
    second = await execute(
        parse_graph(changed),
        ["d"],
        registry=registry,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
        run_id="second",
    )

    assert set(first.executed) == {"a", "b", "c", "d"}
    assert len(first.executed) == 4
    assert first.cached == ()
    assert set(second.executed) == {"b", "d"}
    assert len(second.executed) == 2
    assert set(second.cached) == {"a", "c"}
    assert second.outputs["d"]["value"] == 17


def test_lru_cache_refreshes_hits_and_evicts_the_oldest_key() -> None:
    """M1 인메모리 LRU는 조회된 항목을 최신으로 옮겨 용량을 지킨다 (§5.3)."""
    cache = LRUCache(2)
    cache.set("a", {"value": 1})
    cache.set("b", {"value": 2})

    assert cache.get("a") == {"value": 1}
    cache.set("c", {"value": 3})

    assert cache.get("b") is MISS
    assert list(cache) == ["a", "c"]
    assert len(cache) == 2


def test_null_cache_never_retains_results() -> None:
    """NONE 정책은 None 같은 유효 값과 미스를 센티넬로 구분한다 (§5.3)."""
    cache = NullCache()
    value: Mapping[str, Any] = {"value": None}
    cache.set("key", value)

    assert cache.get("key") is MISS
    assert "key" not in cache
    assert len(cache) == 0
