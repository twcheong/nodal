"""M5.4 Switch 블로킹과 배치·리스트 노드 통합 테스트."""

from __future__ import annotations

from nodal import CancelToken, LRUCache, NodeRegistry, NullEventSink, execute, parse_graph
from nodal_nodes_core import BatchRange, GetListItem, ListCount, RepeatBatch, Switch, register_all


def registry() -> NodeRegistry:
    result = NodeRegistry()
    register_all(result)
    return result


async def test_blocked_branch_not_executed() -> None:
    """T5 — Switch가 닫은 출구의 하류만 실행 로그에서 빠진다."""
    graph = parse_graph(
        {
            "nodes": {
                "source": {"type": "math.Const", "inputs": {"value": 7}},
                "switch": {
                    "type": "flow.Switch",
                    "inputs": {
                        "value": {"$link": ["source", "value"]},
                        "condition": True,
                    },
                },
                "open": {
                    "type": "math.Add",
                    "inputs": {"a": {"$link": ["switch", "true"]}, "b": 1},
                },
                "closed": {
                    "type": "math.Add",
                    "inputs": {"a": {"$link": ["switch", "false"]}, "b": 100},
                },
            },
            "outputs": ["open", "closed"],
        }
    )

    result = await execute(
        graph,
        graph.outputs,
        registry=registry(),
        cache=LRUCache(16),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert set(result.executed) == {"source", "switch", "open"}
    assert result.blocked == ("closed",)
    assert "closed" not in result.executed
    assert result.outputs == {"open": {"sum": 8}}


async def test_switch_open_and_closed_sockets_are_independent_after_flattening() -> None:
    """서브그래프 경계 재배선 뒤에도 블로커는 닫힌 소켓 소비자만 막는다."""
    graph = parse_graph(
        {
            "definitions": {
                "choice": {
                    "params": {
                        "value": {"type": "Any"},
                        "condition": {"type": "BOOL"},
                    },
                    "nodes": {
                        "switch": {
                            "type": "flow.Switch",
                            "inputs": {
                                "value": {"$param": "value"},
                                "condition": {"$param": "condition"},
                            },
                        }
                    },
                    "returns": {
                        "true": {"$link": ["switch", "true"]},
                        "false": {"$link": ["switch", "false"]},
                    },
                }
            },
            "nodes": {
                "source": {"type": "math.Const", "inputs": {"value": 4}},
                "choice": {
                    "type": "subgraph.choice",
                    "inputs": {
                        "value": {"$link": ["source", "value"]},
                        "condition": False,
                    },
                },
                "closed": {
                    "type": "math.Add",
                    "inputs": {"a": {"$link": ["choice", "true"]}, "b": 10},
                },
                "open": {
                    "type": "math.Add",
                    "inputs": {"a": {"$link": ["choice", "false"]}, "b": 2},
                },
            },
            "outputs": ["closed", "open"],
        }
    )

    result = await execute(
        graph,
        graph.outputs,
        registry=registry(),
        cache=LRUCache(16),
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert set(result.executed) == {"source", "choice:switch", "open"}
    assert result.blocked == ("closed",)
    assert result.outputs == {"open": {"sum": 6}}


async def test_batch_size_change_reruns_only_the_batch_and_its_downstream() -> None:
    """N개를 처리하고 N 변경 시 안정된 상류는 캐시에서 산다."""

    def graph(count: int):  # type: ignore[no-untyped-def]
        return parse_graph(
            {
                "nodes": {
                    "start": {"type": "math.Const", "inputs": {"value": 10}},
                    "batch": {
                        "type": "batch.Range",
                        "inputs": {
                            "start": {"$link": ["start", "value"]},
                            "count": count,
                            "step": 2,
                        },
                    },
                    "count": {
                        "type": "list.Count",
                        "inputs": {"items": {"$link": ["batch", "items"]}},
                    },
                },
                "outputs": ["batch", "count"],
            }
        )

    cache = LRUCache(16)
    reg = registry()
    first = await execute(
        graph(3),
        ["batch", "count"],
        registry=reg,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )
    second = await execute(
        graph(4),
        ["batch", "count"],
        registry=reg,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )

    assert first.outputs == {
        "batch": {"items": [10, 12, 14]},
        "count": {"count": 3},
    }
    assert second.cached == ("start",)
    assert set(second.executed) == {"batch", "count"}
    assert second.outputs == {
        "batch": {"items": [10, 12, 14, 16]},
        "count": {"count": 4},
    }


def test_flow_and_list_nodes_are_plain_unit_testable_functions() -> None:
    """노드 run은 엔진 객체 없이 평범한 함수로 호출할 수 있다."""
    true, false = Switch().run("kept", True).values
    assert true == "kept"
    assert repr(false).startswith("ExecutionBlocker(")
    assert BatchRange().run(1, 3, 2).values == ([1, 3, 5],)
    assert RepeatBatch().run("x", 3).values == (["x", "x", "x"],)
    assert GetListItem().run(["a", "b"], 1).values == ("b",)
    assert ListCount().run(["a", "b"]).values == (2,)
