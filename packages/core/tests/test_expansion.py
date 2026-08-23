"""런타임 노드 확장 테스트 (docs/design.md §5.1~§5.3)."""

from __future__ import annotations

import asyncio
from typing import ClassVar

import pytest

from nodal import (
    INT,
    CancelToken,
    Expanded,
    Int,
    LRUCache,
    NodeContext,
    NodeError,
    NodeExecutionError,
    NodeProgress,
    NodeRegistry,
    NodeResult,
    NodeStarted,
    NullCache,
    RecordingEventSink,
    Type,
    execute,
    node,
    parse_graph,
)


def _register(registry: NodeRegistry, *node_classes: type[object]) -> NodeRegistry:
    registry.register_all(node_classes)
    return registry


async def test_returned_subgraph_executes_and_feeds_downstream() -> None:
    """Expanded의 출력은 부모 출력처럼 하류 입력으로 흐른다 (§5.1, §5.2)."""

    @node(id="test.ExpansionValue", category="test")
    class ExpansionValue:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    @node(id="test.ExpansionOffset", category="test")
    class ExpansionOffset:
        value: Int = Int()
        amount: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int, amount: int) -> NodeResult:
            return NodeResult(value + amount)

    @node(id="test.Expand", category="test")
    class Expand:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> Expanded:
            return Expanded(
                parse_graph(
                    {
                        "nodes": {
                            "source": {
                                "type": "test.ExpansionValue",
                                "inputs": {"value": 4},
                            },
                            "offset": {
                                "type": "test.ExpansionOffset",
                                "inputs": {
                                    "value": {"$link": ["source", "value"]},
                                    "amount": 3,
                                },
                            },
                        },
                        "outputs": ["offset"],
                    }
                )
            )

    @node(id="test.ExpansionDouble", category="test")
    class ExpansionDouble:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value * 2)

    registry = _register(NodeRegistry(), ExpansionValue, ExpansionOffset, Expand, ExpansionDouble)
    graph = parse_graph(
        {
            "nodes": {
                "expand": {"type": "test.Expand"},
                "downstream": {
                    "type": "test.ExpansionDouble",
                    "inputs": {"value": {"$link": ["expand", "value"]}},
                },
            },
            "outputs": ["downstream"],
        }
    )

    result = await asyncio.wait_for(
        execute(
            graph,
            ["downstream"],
            registry=registry,
            cache=NullCache(),
            events=RecordingEventSink(),
            cancel_token=CancelToken(),
        ),
        timeout=2,
    )

    assert result.outputs == {"downstream": {"value": 14}}


async def test_ephemeral_progress_is_reported_as_the_parent_node() -> None:
    """서브그래프 노드의 진행률과 생명주기에는 부모 ID만 노출된다 (§5.2)."""

    @node(id="test.ExpansionProgress", category="test")
    class ExpansionProgress:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, ctx: NodeContext) -> NodeResult:
            ctx.progress(1, 2)
            return NodeResult(7)

    @node(id="test.ProgressExpander", category="test")
    class ProgressExpander:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> Expanded:
            return Expanded(
                parse_graph(
                    {
                        "nodes": {"inner": {"type": "test.ExpansionProgress"}},
                        "outputs": ["inner"],
                    }
                )
            )

    registry = _register(NodeRegistry(), ExpansionProgress, ProgressExpander)
    events = RecordingEventSink()

    result = await asyncio.wait_for(
        execute(
            parse_graph(
                {
                    "nodes": {"expand": {"type": "test.ProgressExpander"}},
                    "outputs": ["expand"],
                }
            ),
            ["expand"],
            registry=registry,
            cache=NullCache(),
            events=events,
            cancel_token=CancelToken(),
        ),
        timeout=2,
    )

    assert result.outputs == {"expand": {"value": 7}}
    assert list(events.node_ids(NodeProgress)) == ["expand"]
    assert set(events.node_ids(NodeStarted)) == {"expand"}
    assert all(":" not in node_id for node_id in events.node_ids(NodeStarted))


async def test_expansion_recomputes_cache_keys_after_splicing() -> None:
    """확장 전 부모 키가 서브그래프 결과의 캐시 키로 남지 않는다 (§5.2, §5.3)."""
    calls: list[tuple[str, int]] = []
    payload = {"value": 10}

    @node(id="test.DynamicExpansionValue", category="test")
    class DynamicExpansionValue:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append(("inner", value))
            return NodeResult(value)

    @node(id="test.DynamicExpander", category="test")
    class DynamicExpander:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> Expanded:
            value = payload["value"]
            calls.append(("expand", value))
            return Expanded(
                parse_graph(
                    {
                        "nodes": {
                            "value": {
                                "type": "test.DynamicExpansionValue",
                                "inputs": {"value": value},
                            }
                        },
                        "outputs": ["value"],
                    }
                )
            )

    @node(id="test.DynamicExpansionSink", category="test")
    class DynamicExpansionSink:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append(("sink", value))
            return NodeResult(value)

    registry = _register(
        NodeRegistry(), DynamicExpansionValue, DynamicExpander, DynamicExpansionSink
    )
    graph = parse_graph(
        {
            "nodes": {
                "expand": {"type": "test.DynamicExpander"},
                "sink": {
                    "type": "test.DynamicExpansionSink",
                    "inputs": {"value": {"$link": ["expand", "value"]}},
                },
            },
            "outputs": ["sink"],
        }
    )
    cache = LRUCache(32)

    first = await asyncio.wait_for(
        execute(
            graph,
            ["sink"],
            registry=registry,
            cache=cache,
            events=RecordingEventSink(),
            cancel_token=CancelToken(),
        ),
        timeout=2,
    )
    payload["value"] = 20
    second = await asyncio.wait_for(
        execute(
            graph,
            ["sink"],
            registry=registry,
            cache=cache,
            events=RecordingEventSink(),
            cancel_token=CancelToken(),
        ),
        timeout=2,
    )

    assert first.outputs == {"sink": {"value": 10}}
    assert second.outputs == {"sink": {"value": 20}}
    assert calls == [
        ("expand", 10),
        ("inner", 10),
        ("sink", 10),
        ("expand", 20),
        ("inner", 20),
        ("sink", 20),
    ]
    assert second.cached == ()


async def test_expanded_subgraph_error_names_parent_and_input_socket() -> None:
    """서브그래프 입력 해석 실패는 부모 노드와 소비 소켓을 지목한다 (§5.2)."""

    @node(id="test.ExpansionBrokenSource", category="test")
    class ExpansionBrokenSource:
        returns: ClassVar[dict[str, Type]] = {"actual": INT}

        def run(self) -> NodeResult:
            return NodeResult(1)

    @node(id="test.ExpansionConsumer", category="test")
    class ExpansionConsumer:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    @node(id="test.BrokenExpander", category="test")
    class BrokenExpander:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> Expanded:
            return Expanded(
                parse_graph(
                    {
                        "nodes": {
                            "source": {"type": "test.ExpansionBrokenSource"},
                            "consumer": {
                                "type": "test.ExpansionConsumer",
                                "inputs": {"value": {"$link": ["source", "missing"]}},
                            },
                        },
                        "outputs": ["consumer"],
                    }
                )
            )

    registry = _register(NodeRegistry(), ExpansionBrokenSource, ExpansionConsumer, BrokenExpander)
    events = RecordingEventSink()

    with pytest.raises(NodeExecutionError) as excinfo:
        await asyncio.wait_for(
            execute(
                parse_graph(
                    {
                        "nodes": {"expand": {"type": "test.BrokenExpander"}},
                        "outputs": ["expand"],
                    }
                ),
                ["expand"],
                registry=registry,
                cache=NullCache(),
                events=events,
                cancel_token=CancelToken(),
            ),
            timeout=2,
        )

    assert excinfo.value.node_id == "expand"
    assert excinfo.value.socket == "value"
    assert excinfo.value.ephemeral_id is not None
    assert "consumer" in excinfo.value.ephemeral_id
    errors = events.of_type(NodeError)
    assert len(errors) == 1
    error = errors[0]
    assert isinstance(error, NodeError)
    assert error.node_id == "expand"
    assert error.socket == "value"
