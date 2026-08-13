"""M1 실행 루프 통합 테스트 (docs/design.md §5.1, §5.4)."""

from __future__ import annotations

from typing import ClassVar

from nodal import (
    INT,
    CancelToken,
    Int,
    NodeDone,
    NodeRegistry,
    NodeResult,
    NodeStarted,
    NullCache,
    RecordingEventSink,
    RunDone,
    RunStarted,
    Type,
    execute,
    node,
    parse_graph,
)

EXECUTION_GRAPH = {
    "nodes": {
        "source": {"type": "test.Value", "inputs": {"value": 4}},
        "double": {
            "type": "test.AsyncDouble",
            "inputs": {"value": {"$link": ["source", "value"]}},
        },
        "sum": {
            "type": "test.Add",
            "inputs": {"left": {"$link": ["double", "value"]}, "right": 3},
        },
        "unrelated": {"type": "test.Value", "inputs": {"value": 999}},
    },
    "outputs": ["sum"],
}


def _execution_registry(calls: list[tuple[str, int]]) -> NodeRegistry:
    @node(id="test.Value", category="test")
    class Value:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            calls.append(("sync", value))
            return NodeResult(value)

    @node(id="test.AsyncDouble", category="test")
    class AsyncDouble:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        async def run(self, value: int) -> NodeResult:
            calls.append(("async", value))
            return NodeResult(value * 2)

    @node(id="test.Add", category="test")
    class Add:
        left: Int = Int()
        right: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, left: int, right: int) -> NodeResult:
            calls.append(("sync", left + right))
            return NodeResult(left + right)

    registry = NodeRegistry()
    registry.register_all((Value, AsyncDouble, Add))
    return registry


async def test_execute_runs_sync_and_async_ancestors_and_returns_named_outputs() -> None:
    """동기·비동기 run을 자동 감지하고 요청 출력의 조상만 실행한다 (§5.1, §5.4)."""
    calls: list[tuple[str, int]] = []
    registry = _execution_registry(calls)
    events = RecordingEventSink()
    graph = parse_graph(EXECUTION_GRAPH)
    before = graph.to_dict(compact=False)

    result = await execute(
        graph,
        ["sum"],
        registry=registry,
        cache=NullCache(),
        events=events,
        cancel_token=CancelToken(),
        run_id="run-sync-async",
    )

    assert result.outputs == {"sum": {"value": 11}}
    assert result.executed == ("source", "double", "sum")
    assert result.cached == ()
    assert calls == [("sync", 4), ("async", 4), ("sync", 11)]
    assert "unrelated" not in result.executed
    assert graph.to_dict(compact=False) == before


async def test_execute_emits_run_and_node_lifecycle_in_execution_order() -> None:
    """실행 루프는 run/node 시작·완료 이벤트를 실제 순서로 보고한다 (§5.1, §6)."""
    calls: list[tuple[str, int]] = []
    registry = _execution_registry(calls)
    events = RecordingEventSink()

    await execute(
        parse_graph(EXECUTION_GRAPH),
        ["sum"],
        registry=registry,
        cache=NullCache(),
        events=events,
        cancel_token=CancelToken(),
        run_id="run-events",
    )

    assert isinstance(events.events[0], RunStarted)
    assert events.events[0].run_id == "run-events"
    assert list(events.node_ids(NodeStarted)) == ["source", "double", "sum"]
    assert list(events.node_ids(NodeDone)) == ["source", "double", "sum"]
    assert isinstance(events.events[-1], RunDone)
    assert events.events[-1].run_id == "run-events"


async def test_output_node_is_selected_before_an_independent_ready_node() -> None:
    """준비 노드 중 output_node를 일반 노드보다 먼저 고른다 (§1.1 ②, §5.1)."""
    calls: list[str] = []

    @node(id="test.PlainSource", category="test")
    class PlainSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            calls.append("plain")
            return NodeResult(1)

    @node(id="test.PreviewSource", category="test", output_node=True)
    class PreviewSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            calls.append("preview")
            return NodeResult(2)

    @node(id="test.Join", category="test")
    class Join:
        left: Int = Int()
        right: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, left: int, right: int) -> NodeResult:
            calls.append("join")
            return NodeResult(left + right)

    registry = NodeRegistry()
    registry.register_all((PlainSource, PreviewSource, Join))
    graph = parse_graph(
        {
            "nodes": {
                "plain": {"type": "test.PlainSource"},
                "preview": {"type": "test.PreviewSource"},
                "join": {
                    "type": "test.Join",
                    "inputs": {
                        "left": {"$link": ["plain", "value"]},
                        "right": {"$link": ["preview", "value"]},
                    },
                },
            },
            "outputs": ["join"],
        }
    )

    await execute(
        graph,
        ["join"],
        registry=registry,
        cache=NullCache(),
        events=RecordingEventSink(),
        cancel_token=CancelToken(),
    )

    assert calls == ["preview", "plain", "join"]
