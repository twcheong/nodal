"""실행 검증과 위치가 있는 에러 테스트 (docs/design.md §2, §4.3, §5.1)."""

from __future__ import annotations

from typing import ClassVar

import pytest

from nodal import (
    INT,
    STRING,
    CancelToken,
    DynamicGraph,
    Int,
    IssueCode,
    NodeError,
    NodeExecutionError,
    NodeRegistry,
    NodeResult,
    NullCache,
    RecordingEventSink,
    RunDone,
    Type,
    execute,
    node,
    parse_graph,
    resolve_inputs,
    validate_for_execution,
)


def _validation_registry() -> NodeRegistry:
    @node(id="test.IntSource", category="test")
    class IntSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            return NodeResult(1)

    @node(id="test.StringSource", category="test")
    class StringSource:
        returns: ClassVar[dict[str, Type]] = {"value": STRING}

        def run(self) -> NodeResult:
            return NodeResult("not an int")

    @node(id="test.IntSink", category="test")
    class IntSink:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    registry = NodeRegistry()
    registry.register_all((IntSource, StringSource, IntSink))
    return registry


def test_missing_required_input_points_to_consumer_node_and_socket() -> None:
    """필수 입력 누락은 큐 진입 전에 nodes.<id>.inputs.<socket>을 지목한다 (§2)."""
    graph = parse_graph({"nodes": {"sink": {"type": "test.IntSink"}}, "outputs": ["sink"]})

    issues = validate_for_execution(graph, _validation_registry(), ["sink"])

    issue = next(item for item in issues if item.code == IssueCode.MISSING_REQUIRED_INPUT)
    assert issue.node_id == "sink"
    assert issue.socket == "value"
    assert issue.location == "nodes.sink.inputs.value"


def test_type_mismatch_points_to_consumer_node_and_socket() -> None:
    """타입 불일치는 실행 전에 소비 노드와 입력 소켓에 귀속된다 (§4.3)."""
    graph = parse_graph(
        {
            "nodes": {
                "source": {"type": "test.StringSource"},
                "sink": {
                    "type": "test.IntSink",
                    "inputs": {"value": {"$link": ["source", "value"]}},
                },
            },
            "outputs": ["sink"],
        }
    )

    issues = validate_for_execution(graph, _validation_registry(), ["sink"])

    issue = next(item for item in issues if item.code == IssueCode.TYPE_MISMATCH)
    assert issue.node_id == "sink"
    assert issue.socket == "value"
    assert issue.location == "nodes.sink.inputs.value"
    assert "STRING" in issue.message
    assert "INT" in issue.message


def test_unknown_output_socket_points_to_consumer_input() -> None:
    """없는 출력 소켓 링크도 사용자가 고칠 소비 입력 위치를 지목한다 (§4.1, §2)."""
    graph = parse_graph(
        {
            "nodes": {
                "source": {"type": "test.IntSource"},
                "sink": {
                    "type": "test.IntSink",
                    "inputs": {"value": {"$link": ["source", "missing"]}},
                },
            },
            "outputs": ["sink"],
        }
    )

    issues = validate_for_execution(graph, _validation_registry(), ["sink"])

    issue = next(item for item in issues if item.code == IssueCode.UNKNOWN_OUTPUT_SOCKET)
    assert issue.node_id == "sink"
    assert issue.socket == "value"
    assert issue.location == "nodes.sink.inputs.value"


def test_resolve_inputs_locates_missing_runtime_output_at_consumer_socket() -> None:
    """결과 딕셔너리에 출력이 없으면 익명 KeyError 대신 소비 소켓 에러다 (§5.1)."""
    registry = _validation_registry()
    graph = parse_graph(
        {
            "nodes": {
                "source": {"type": "test.IntSource"},
                "sink": {
                    "type": "test.IntSink",
                    "inputs": {"value": {"$link": ["source", "value"]}},
                },
            }
        }
    )

    with pytest.raises(NodeExecutionError) as excinfo:
        resolve_inputs(
            "sink",
            DynamicGraph(graph),
            registry.get("test.IntSink", node_id="sink"),
            {"source": {}},
        )

    assert excinfo.value.node_id == "sink"
    assert excinfo.value.socket == "value"
    assert "nodes.sink.inputs.value" in str(excinfo.value)


async def test_runtime_failure_points_to_node_and_emits_node_error() -> None:
    """run 예외는 실패 노드 ID를 보존하고 run.done으로 오인하지 않는다 (§5.1, §6)."""

    @node(id="test.Boom", category="test")
    class Boom:
        value: Int = Int(1)
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            raise RuntimeError(f"boom: {value}")

    registry = NodeRegistry()
    registry.register(Boom)
    events = RecordingEventSink()
    graph = parse_graph(
        {
            "nodes": {"boom": {"type": "test.Boom", "inputs": {"value": 7}}},
            "outputs": ["boom"],
        }
    )

    with pytest.raises(NodeExecutionError) as excinfo:
        await execute(
            graph,
            ["boom"],
            registry=registry,
            cache=NullCache(),
            events=events,
            cancel_token=CancelToken(),
            run_id="failing-run",
        )

    assert excinfo.value.node_id == "boom"
    assert excinfo.value.socket is None
    assert isinstance(excinfo.value.cause, RuntimeError)
    assert "nodes.boom" in str(excinfo.value)
    (event,) = events.of_type(NodeError)
    assert event.node_id == "boom"
    assert not events.of_type(RunDone)
