"""점진적 위상 용해 테스트 (docs/design.md §1.1 ①, §5.1)."""

from __future__ import annotations

import pytest

from nodal import (
    DynamicGraph,
    ExecutionList,
    GraphValidationError,
    IssueCode,
    NodeRegistry,
    NodeSchema,
    NullCache,
    TopologicalSort,
    parse_graph,
)

DIAMOND_GRAPH = {
    "nodes": {
        "a": {"type": "test.Source"},
        "b": {"type": "test.Step", "inputs": {"value": {"$link": ["a", "value"]}}},
        "c": {"type": "test.Step", "inputs": {"value": {"$link": ["a", "value"]}}},
        "d": {
            "type": "test.Join",
            "inputs": {
                "left": {"$link": ["b", "value"]},
                "right": {"$link": ["c", "value"]},
            },
        },
        "unrelated": {"type": "test.Source"},
    },
    "outputs": ["d"],
}

CYCLE_GRAPH = {
    "nodes": {
        "a": {"type": "test.Step", "inputs": {"value": {"$link": ["c", "value"]}}},
        "b": {"type": "test.Step", "inputs": {"value": {"$link": ["a", "value"]}}},
        "c": {"type": "test.Step", "inputs": {"value": {"$link": ["b", "value"]}}},
    },
    "outputs": ["c"],
}


def _step_schema() -> NodeSchema:
    return NodeSchema(
        id="test.Step",
        title="Step",
        category="test",
        aliases=(),
        version="1",
        output_node=False,
        cacheable=True,
        inputs={},
        outputs={},
        node_class=object,
        is_async=False,
        wants_ctx=False,
    )


def test_add_node_collects_only_requested_output_ancestors() -> None:
    """요청 출력에서 역방향으로 필요한 조상만 수집한다 (§5.1)."""
    sort = TopologicalSort(DynamicGraph(parse_graph(DIAMOND_GRAPH)))

    sort.add_node("d")

    assert sort.pending() == frozenset({"a", "b", "c", "d"})
    assert "unrelated" not in sort.pending()


def test_diamond_dependency_runs_shared_ancestor_once() -> None:
    """A→B·C→D 다이아몬드에서 A와 D를 중복 없이 한 번씩 용해한다 (§5.1)."""
    sort = TopologicalSort(DynamicGraph(parse_graph(DIAMOND_GRAPH)))
    sort.add_node("d")

    assert set(sort.ready_nodes()) == {"a"}
    sort.pop("a")
    assert set(sort.ready_nodes()) == {"b", "c"}

    sort.pop("b")
    assert set(sort.ready_nodes()) == {"c"}
    sort.pop("c")
    assert set(sort.ready_nodes()) == {"d"}
    sort.pop("d")

    assert sort.is_empty()
    assert sort.pending() == frozenset()


def test_cycle_is_reported_when_pending_nodes_cannot_dissolve() -> None:
    """준비 노드 없이 pending만 남으면 사이클 구성 노드를 지목한다 (§5.1)."""
    sort = TopologicalSort(DynamicGraph(parse_graph(CYCLE_GRAPH)))
    sort.add_node("c")

    assert not sort.ready_nodes()
    assert set(sort.detect_cycle() or ()) == {"a", "b", "c"}
    assert not sort.is_empty()


async def test_execution_list_raises_located_cycle_issues() -> None:
    """stage할 노드가 없으면 CYCLE 이슈가 각 잔여 노드를 지목한다 (§5.1)."""
    dyn = DynamicGraph(parse_graph(CYCLE_GRAPH))
    plan = ExecutionList(dyn, NullCache(), NodeRegistry((_step_schema(),)))
    plan.add_node("c")

    with pytest.raises(GraphValidationError) as excinfo:
        await plan.stage()

    cycle_issues = [issue for issue in excinfo.value.issues if issue.code == IssueCode.CYCLE]
    assert cycle_issues
    assert all(node_id in str(excinfo.value) for node_id in ("a", "b", "c"))
    assert all(issue.socket is None for issue in cycle_issues)
