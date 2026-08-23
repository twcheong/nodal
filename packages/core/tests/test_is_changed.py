"""IS_CHANGED 스키마와 실행 배선 테스트 (docs/design.md §5.3)."""

from __future__ import annotations

from typing import ClassVar

import pytest

from nodal import (
    INT,
    CancelToken,
    DynamicGraph,
    ExecutionList,
    Image,
    Int,
    LRUCache,
    NodeError,
    NodeExecutionError,
    NodeRegistry,
    NodeResult,
    NodeSchema,
    NullCache,
    NullEventSink,
    RecordingEventSink,
    SchemaError,
    Type,
    execute,
    node,
    parse_graph,
)


def test_is_changed_absent_matches_today() -> None:
    """훅 없는 실행 경로의 키는 IS_CHANGED 배선 전 값과 바이트 단위로 같다 (T1)."""
    schema = NodeSchema(
        id="baseline.Literal",
        title="baseline.Literal",
        category="baseline",
        aliases=(),
        version="baseline-literal-v1",
        output_node=False,
        cacheable=True,
        inputs={},
        outputs={},
        node_class=object,
        is_async=False,
        wants_ctx=False,
    )
    graph = parse_graph(
        {
            "nodes": {
                "literal": {
                    "type": "baseline.Literal",
                    "inputs": {
                        "integer": 7,
                        "label": "fixed",
                        "flags": [True, False],
                        "config": {"alpha": 1, "beta": None},
                    },
                }
            }
        }
    )
    plan = ExecutionList(DynamicGraph(graph), NullCache(), NodeRegistry((schema,)))

    assert schema.is_changed is None
    assert plan.cache_key_for("literal") == "e9d96a74fc8ed9f580150e3a4456c479"


async def test_stable_is_changed_keeps_cache() -> None:
    """외부 토큰이 안정적이면 두 번째 실행은 캐시되고 훅은 run당 한 번만 돈다 (T4)."""
    hook_calls: list[int] = []
    run_calls: list[int] = []

    @node(id="test.StableChanged", category="test")
    class StableChanged:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        @staticmethod
        def is_changed(value: int) -> str:
            hook_calls.append(value)
            return "stable-token"

        def run(self, value: int) -> NodeResult:
            run_calls.append(value)
            return NodeResult(value)

    @node(id="test.StableChangedSink", category="test")
    class StableChangedSink:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    registry = NodeRegistry()
    schema = registry.register(StableChanged)
    registry.register(StableChangedSink)
    graph = parse_graph(
        {
            "nodes": {
                "stable": {"type": "test.StableChanged", "inputs": {"value": 5}},
                "left": {
                    "type": "test.StableChangedSink",
                    "inputs": {"value": {"$link": ["stable", "value"]}},
                },
                "right": {
                    "type": "test.StableChangedSink",
                    "inputs": {"value": {"$link": ["stable", "value"]}},
                },
            },
            "outputs": ["left", "right"],
        }
    )
    cache = LRUCache(8)

    first = await execute(
        graph,
        ["left", "right"],
        registry=registry,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )
    second = await execute(
        graph,
        ["left", "right"],
        registry=registry,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert schema.is_changed is StableChanged.is_changed
    assert set(first.executed) | set(first.cached) == {"stable", "left", "right"}
    assert "stable" in first.executed
    assert len(first.cached) == 1
    assert set(second.cached) == {"stable", "left", "right"}
    assert hook_calls == [5, 5]
    assert run_calls == [5]


def test_is_changed_requires_staticmethod() -> None:
    with pytest.raises(SchemaError, match="@staticmethod"):

        @node(id="test.InstanceChanged", category="test")
        class InstanceChanged:
            value: Int = Int()
            returns: ClassVar[dict[str, Type]] = {"value": INT}

            def is_changed(self, value: int) -> str:
                return str(value)

            def run(self, value: int) -> NodeResult:
                return NodeResult(value)


def test_is_changed_parameter_must_name_an_input() -> None:
    with pytest.raises(SchemaError) as excinfo:

        @node(id="test.UnknownChangedInput", category="test")
        class UnknownChangedInput:
            value: Int = Int()
            returns: ClassVar[dict[str, Type]] = {"value": INT}

            @staticmethod
            def is_changed(missing: int) -> str:
                return str(missing)

            def run(self, value: int) -> NodeResult:
                return NodeResult(value)

    assert excinfo.value.node_id == "test.UnknownChangedInput"
    assert excinfo.value.socket == "missing"
    assert "is_changed" in str(excinfo.value)


def test_is_changed_rejects_link_only_socket_at_registration() -> None:
    with pytest.raises(SchemaError) as excinfo:

        @node(id="test.LinkedChangedInput", category="test")
        class LinkedChangedInput:
            image: Image
            returns: ClassVar[dict[str, Type]] = {"value": INT}

            @staticmethod
            def is_changed(image: object) -> str:
                return str(id(image))

            def run(self, image: object) -> NodeResult:
                return NodeResult(1)

    assert excinfo.value.node_id == "test.LinkedChangedInput"
    assert excinfo.value.socket == "image"
    assert "링크 전용 Socket" in str(excinfo.value)


def test_is_changed_rejects_non_string_return_annotation() -> None:
    with pytest.raises(SchemaError, match="str"):

        @node(id="test.AnnotatedChangedReturn", category="test")
        class AnnotatedChangedReturn:
            value: Int = Int()
            returns: ClassVar[dict[str, Type]] = {"value": INT}

            @staticmethod
            def is_changed(value: int) -> int:
                return value

            def run(self, value: int) -> NodeResult:
                return NodeResult(value)


async def test_is_changed_runtime_return_must_be_string() -> None:
    @node(id="test.RuntimeChangedReturn", category="test")
    class RuntimeChangedReturn:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        @staticmethod
        def is_changed(value: int):  # type: ignore[no-untyped-def]
            return value

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    registry = NodeRegistry()
    registry.register(RuntimeChangedReturn)

    with pytest.raises(NodeExecutionError) as excinfo:
        await execute(
            parse_graph(
                {
                    "nodes": {
                        "wrong_token": {
                            "type": "test.RuntimeChangedReturn",
                            "inputs": {"value": 3},
                        }
                    },
                    "outputs": ["wrong_token"],
                }
            ),
            ["wrong_token"],
            registry=registry,
            cache=LRUCache(8),
            events=NullEventSink(),
            cancel_token=CancelToken(),
        )

    assert excinfo.value.node_id == "wrong_token"
    assert isinstance(excinfo.value.cause, TypeError)
    assert "is_changed" in str(excinfo.value)
    assert "str" in str(excinfo.value)


async def test_is_changed_does_not_receive_a_linked_widget_input() -> None:
    hook_calls: list[int] = []

    @node(id="test.ChangedLinkSource", category="test")
    class ChangedLinkSource:
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        def run(self) -> NodeResult:
            return NodeResult(3)

    @node(id="test.ChangedLinkConsumer", category="test")
    class ChangedLinkConsumer:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        @staticmethod
        def is_changed(value: int) -> str:
            hook_calls.append(value)
            return str(value)

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    registry = NodeRegistry()
    registry.register_all((ChangedLinkSource, ChangedLinkConsumer))

    with pytest.raises(NodeExecutionError) as excinfo:
        await execute(
            parse_graph(
                {
                    "nodes": {
                        "source": {"type": "test.ChangedLinkSource"},
                        "linked_hook": {
                            "type": "test.ChangedLinkConsumer",
                            "inputs": {"value": {"$link": ["source", "value"]}},
                        },
                    },
                    "outputs": ["linked_hook"],
                }
            ),
            ["linked_hook"],
            registry=registry,
            cache=LRUCache(8),
            events=NullEventSink(),
            cancel_token=CancelToken(),
        )

    assert excinfo.value.node_id == "linked_hook"
    assert excinfo.value.socket == "value"
    assert "링크 입력" in str(excinfo.value)
    assert hook_calls == []


async def test_is_changed_exception_is_attributed_to_its_node() -> None:
    @node(id="test.ExplodingChanged", category="test")
    class ExplodingChanged:
        value: Int = Int()
        returns: ClassVar[dict[str, Type]] = {"value": INT}

        @staticmethod
        def is_changed(value: int) -> str:
            raise RuntimeError(f"token exploded: {value}")

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)

    registry = NodeRegistry()
    registry.register(ExplodingChanged)
    events = RecordingEventSink()

    with pytest.raises(NodeExecutionError) as excinfo:
        await execute(
            parse_graph(
                {
                    "nodes": {
                        "exploding": {
                            "type": "test.ExplodingChanged",
                            "inputs": {"value": 4},
                        }
                    },
                    "outputs": ["exploding"],
                }
            ),
            ["exploding"],
            registry=registry,
            cache=LRUCache(8),
            events=events,
            cancel_token=CancelToken(),
        )

    assert excinfo.value.node_id == "exploding"
    assert "is_changed" in str(excinfo.value)
    assert "token exploded: 4" in str(excinfo.value)
    errors = events.of_type(NodeError)
    assert len(errors) == 1
    error = errors[0]
    assert isinstance(error, NodeError)
    assert error.node_id == "exploding"
    assert "is_changed" in error.message
