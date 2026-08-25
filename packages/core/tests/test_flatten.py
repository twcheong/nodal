"""서브그래프 평탄화 (docs/design.md §5.5, M5.3).

이 파일이 고정하는 핵심 문장은 하나다 — **"평탄화 결과는 평범한 그래프다."**
`test_flatten_matches_handwritten_graph` 가 그 증거이고, 나머지는 그 문장이
깨지는 방식들이다: 파라미터가 인스턴스 사이로 새거나, 캐시가 낡은 값을 붙들거나,
한계를 넘겨도 조용하거나.
"""

from __future__ import annotations

from typing import Any, ClassVar

import pytest

from nodal import (
    INT,
    CancelToken,
    DynamicGraph,
    ExecutionList,
    Graph,
    Int,
    IssueCode,
    LRUCache,
    NodeRegistry,
    NodeResult,
    NullEventSink,
    RunResult,
    Type,
    execute,
    flatten,
    node,
    parse_graph,
    validate_for_execution,
)
from nodal.subgraph import MAX_DEPTH, MAX_NODES, _Flattener

CALLS: list[str] = []


@node(id="test.Const", category="test")
class Const:
    value: Int = Int(5)
    returns: ClassVar[dict[str, Type]] = {"value": INT}

    def run(self, value: int) -> NodeResult:
        CALLS.append("const")
        return NodeResult(value)


@node(id="test.Mul", category="test")
class Mul:
    a: Int = Int(1)
    b: Int = Int(1)
    returns: ClassVar[dict[str, Type]] = {"product": INT}

    def run(self, a: int, b: int) -> NodeResult:
        CALLS.append(f"mul({a},{b})")
        return NodeResult(a * b)


@node(id="test.Sink", category="test")
class Sink:
    value: Int = Int(0)
    returns: ClassVar[dict[str, Type]] = {"value": INT}

    def run(self, value: int) -> NodeResult:
        CALLS.append(f"sink({value})")
        return NodeResult(value)


def registry() -> NodeRegistry:
    reg = NodeRegistry()
    reg.register_all((Const, Mul, Sink))
    return reg


# `scale` 정의: 밖에서 값을 받아 factor 를 곱해 내보낸다.
SCALE_DEF: dict[str, Any] = {
    "params": {"value": {"type": "INT"}, "factor": {"type": "INT", "default": 2}},
    "nodes": {
        "mul": {
            "type": "test.Mul",
            "inputs": {"a": {"$param": "value"}, "b": {"$param": "factor"}},
        }
    },
    "returns": {"product": {"$link": ["mul", "product"]}},
}


def scaled_graph(factor: int) -> Graph:
    return parse_graph(
        {
            "definitions": {"scale": SCALE_DEF},
            "nodes": {
                "src": {"type": "test.Const", "inputs": {"value": 5}},
                "inst": {
                    "type": "subgraph.scale",
                    "inputs": {"value": {"$link": ["src", "value"]}, "factor": factor},
                },
                "sink": {
                    "type": "test.Sink",
                    "inputs": {"value": {"$link": ["inst", "product"]}},
                },
            },
            "outputs": ["sink"],
        }
    )


async def run(graph: Graph, cache: LRUCache, reg: NodeRegistry) -> RunResult:
    return await execute(
        graph,
        ["sink"],
        registry=reg,
        cache=cache,
        events=NullEventSink(),
        cancel_token=CancelToken(),
    )


def keys(graph: Graph, reg: NodeRegistry) -> set[str]:
    plan = ExecutionList(DynamicGraph(graph), LRUCache(64), reg)
    return {plan.cache_key_for(node_id) for node_id in graph.nodes}


# ------------------------------------------------------------------ T7


def test_flatten_matches_handwritten_graph() -> None:
    """평탄화 결과가 손으로 쓴 동등 그래프와 **같은 캐시 키**를 낸다.

    "평탄화 결과는 평범한 그래프다"(§5.5)의 증거가 이것이다. 캐시 키는 노드 ID
    가 아니라 타입 + 해석된 입력의 재귀 해시라서(§5.3), 키가 같다는 것은 두
    그래프가 실행 엔진에게 **구별되지 않는다**는 뜻이다.
    """
    reg = registry()
    flat = flatten(scaled_graph(3)).graph

    handwritten = parse_graph(
        {
            "nodes": {
                "src": {"type": "test.Const", "inputs": {"value": 5}},
                "inst:mul": {
                    "type": "test.Mul",
                    "inputs": {"a": {"$link": ["src", "value"]}, "b": 3},
                },
                "sink": {
                    "type": "test.Sink",
                    "inputs": {"value": {"$link": ["inst:mul", "product"]}},
                },
            },
            "outputs": ["sink"],
        }
    )

    assert flat.nodes.keys() == handwritten.nodes.keys()
    assert keys(flat, reg) == keys(handwritten, reg)


def test_flattened_graph_has_no_subgraph_types() -> None:
    """§5.5 ⑤ — 평탄화가 끝난 그래프에 `subgraph.*` 는 남지 않는다."""
    flat = flatten(scaled_graph(3)).graph
    assert not flat.definitions
    assert all(node.subgraph() is None for node in flat.nodes.values())


def test_graph_without_definitions_is_returned_untouched() -> None:
    """대부분의 그래프가 이 경우다. 평탄화가 비용이 되어서는 안 된다."""
    graph = parse_graph({"nodes": {"a": {"type": "test.Const"}}, "outputs": ["a"]})
    assert flatten(graph).graph is graph


# ------------------------------------------------------------------ T2 · T3
#
# 둘은 한 쌍이다. 하나만 있으면 §5.3 의 한쪽 방향만 막힌다 — T2 만 있으면
# "아무것도 재실행 안 함" 이 통과하고, T3 만 있으면 "매번 전체 재실행" 이 통과한다.


async def test_param_change_reruns_only_downstream() -> None:
    """인스턴스 파라미터 하나만 바꾸면 그 하류만 다시 돈다 (과대 무효화 방어)."""
    reg = registry()
    cache = LRUCache(64)

    CALLS.clear()
    first = await run(scaled_graph(2), cache, reg)
    assert set(first.executed) == {"src", "inst:mul", "sink"}

    CALLS.clear()
    second = await run(scaled_graph(3), cache, reg)

    assert second.cached == ("src",)
    assert set(second.executed) == {"inst:mul", "sink"}
    assert CALLS == ["mul(5,3)", "sink(15)"]  # src 는 다시 돌지 않았다


async def test_param_change_actually_changes_output() -> None:
    """바뀐 파라미터가 결과에 실제로 반영된다 (과소 무효화 방어).

    캐시 히트로 낡은 값이 나오면 AI 클라이언트는 그것을 새 결과로 믿는다 (§5.3).
    """
    reg = registry()
    cache = LRUCache(64)

    first = await run(scaled_graph(2), cache, reg)
    second = await run(scaled_graph(3), cache, reg)

    assert first.outputs["sink"] == {"value": 10}
    assert second.outputs["sink"] == {"value": 15}


async def test_identical_rerun_is_fully_cached() -> None:
    """같은 문서를 두 번 — 아무것도 다시 돌지 않는다."""
    reg = registry()
    cache = LRUCache(64)

    await run(scaled_graph(2), cache, reg)
    CALLS.clear()
    again = await run(scaled_graph(2), cache, reg)

    assert set(again.cached) == {"src", "inst:mul", "sink"}
    assert again.executed == ()
    assert CALLS == []


# ------------------------------------------------------------------ 격리 · 중첩


def test_two_instances_of_one_definition_do_not_leak_params() -> None:
    """§5.5 ① — 정의를 공유해도 노드는 각자의 사본이다."""
    graph = parse_graph(
        {
            "definitions": {"scale": SCALE_DEF},
            "nodes": {
                "src": {"type": "test.Const", "inputs": {"value": 5}},
                "twice": {
                    "type": "subgraph.scale",
                    "inputs": {"value": {"$link": ["src", "value"]}, "factor": 2},
                },
                "thrice": {
                    "type": "subgraph.scale",
                    "inputs": {"value": {"$link": ["src", "value"]}, "factor": 3},
                },
            },
            "outputs": ["twice", "thrice"],
        }
    )
    flat = flatten(graph).graph

    assert flat.nodes["twice:mul"].inputs["b"] == 2
    assert flat.nodes["thrice:mul"].inputs["b"] == 3
    # 출력 요청도 안쪽 노드로 옮겨진다.
    assert flat.outputs == ["twice:mul", "thrice:mul"]


def test_omitted_param_falls_back_to_the_declared_default() -> None:
    graph = parse_graph(
        {
            "definitions": {"scale": SCALE_DEF},
            "nodes": {
                "src": {"type": "test.Const"},
                "inst": {
                    "type": "subgraph.scale",
                    "inputs": {"value": {"$link": ["src", "value"]}},
                },
            },
            "outputs": ["inst"],
        }
    )
    assert flatten(graph).graph.nodes["inst:mul"].inputs["b"] == 2


def test_nested_prefixes_stack() -> None:
    """§5.5 ② — 중첩되면 접두가 겹쳐 쌓인다 (`outer:inner:leaf`)."""
    graph = parse_graph(
        {
            "definitions": {
                "outer": {
                    "params": {"v": {"type": "INT"}},
                    "nodes": {
                        "inner": {
                            "type": "subgraph.leaf",
                            "inputs": {"v": {"$param": "v"}},
                        }
                    },
                    "returns": {"out": {"$link": ["inner", "out"]}},
                },
                "leaf": {
                    "params": {"v": {"type": "INT"}},
                    "nodes": {
                        "fit": {"type": "test.Mul", "inputs": {"a": {"$param": "v"}, "b": 2}}
                    },
                    "returns": {"out": {"$link": ["fit", "product"]}},
                },
            },
            "nodes": {
                "o": {"type": "subgraph.outer", "inputs": {"v": 7}},
                "sink": {"type": "test.Sink", "inputs": {"value": {"$link": ["o", "out"]}}},
            },
            "outputs": ["sink"],
        }
    )
    flat = flatten(graph).graph

    assert set(flat.nodes) == {"o:inner:fit", "sink"}
    assert flat.nodes["o:inner:fit"].inputs["a"] == 7
    # 별칭 사슬(o.out → o:inner.out → o:inner:fit.product)이 끝까지 풀린다.
    assert flat.nodes["sink"].inputs["value"].ref == ("o:inner:fit", "product")


def test_output_socket_mapping_follows_nested_returns_to_the_leaf() -> None:
    """중첩 returns 도 서버가 다시 해석할 필요 없이 실제 소켓까지 풀린다."""
    graph = parse_graph(
        {
            "definitions": {
                "outer": {
                    "nodes": {"inner": {"type": "subgraph.leaf"}},
                    "returns": {"image": {"$link": ["inner", "asset"]}},
                },
                "leaf": {
                    "nodes": {"save": {"type": "test.Const"}},
                    "returns": {"asset": {"$link": ["save", "asset"]}},
                },
            },
            "nodes": {"call": {"type": "subgraph.outer"}},
            "outputs": ["call"],
        }
    )

    result = flatten(graph, ("call",))

    assert result.output_sockets == {"call": {"image": ("call:inner:save", "asset")}}


def test_output_socket_mapping_keeps_two_sockets_on_the_same_node() -> None:
    """`map_outputs` 의 노드 중복 제거가 공개 소켓 둘을 합치면 안 된다."""
    graph = parse_graph(
        {
            "definitions": {
                "pair": {
                    "nodes": {"n": {"type": "test.Const"}},
                    "returns": {
                        "a": {"$link": ["n", "x"]},
                        "b": {"$link": ["n", "y"]},
                    },
                }
            },
            "nodes": {"inst": {"type": "subgraph.pair"}},
            "outputs": ["inst"],
        }
    )

    result = flatten(graph, ("inst",))

    assert result.outputs == ("inst:n",)
    assert list(result.output_sockets["inst"]) == ["a", "b"]
    assert result.output_sockets["inst"] == {
        "a": ("inst:n", "x"),
        "b": ("inst:n", "y"),
    }


def test_plain_requested_output_has_no_output_socket_mapping_entry() -> None:
    graph = parse_graph(
        {
            "definitions": {"scale": SCALE_DEF},
            "nodes": {
                "plain": {"type": "test.Const"},
                "inst": {"type": "subgraph.scale", "inputs": {"value": 1}},
            },
            "outputs": ["plain"],
        }
    )

    result = flatten(graph, ("plain",))

    assert "plain" not in result.output_sockets
    assert result.output_sockets == {}


# ------------------------------------------------------------------ 이슈들


def test_missing_required_param_names_the_instance_and_the_param() -> None:
    """§12.3 — MCP 는 실행 전에 **무엇을** 채워야 하는지 들어야 한다."""
    graph = parse_graph(
        {
            "definitions": {
                "needs": {
                    "params": {"a": {"type": "INT"}, "b": {"type": "INT"}},
                    "nodes": {
                        "m": {
                            "type": "test.Mul",
                            "inputs": {"a": {"$param": "a"}, "b": {"$param": "b"}},
                        }
                    },
                    "returns": {"product": {"$link": ["m", "product"]}},
                }
            },
            "nodes": {"inst": {"type": "subgraph.needs"}},
            "outputs": ["inst"],
        }
    )
    issues = flatten(graph).issues

    # 첫 문제에서 멈추지 않는다 — 둘 다 보고한다.
    missing = [i for i in issues if i.code is IssueCode.MISSING_PARAM]
    assert {i.socket for i in missing} == {"a", "b"}
    assert all(i.node_id == "inst" for i in missing)
    assert all("needs" in i.message for i in missing)


def test_unknown_param_on_an_instance_is_reported() -> None:
    graph = parse_graph(
        {
            "definitions": {"scale": SCALE_DEF},
            "nodes": {
                "src": {"type": "test.Const"},
                "inst": {
                    "type": "subgraph.scale",
                    "inputs": {"value": {"$link": ["src", "value"]}, "typo": 1},
                },
            },
            "outputs": ["inst"],
        }
    )
    (issue,) = [i for i in flatten(graph).issues if i.code is IssueCode.UNKNOWN_INPUT_SOCKET]
    assert issue.node_id == "inst"
    assert issue.socket == "typo"


def test_invalid_param_type_expression_is_reported() -> None:
    """§5.5 — 타입 카탈로그를 아는 층이 여기다."""
    graph = parse_graph(
        {
            "definitions": {
                "bad": {
                    "params": {"x": {"type": "NotAType"}},
                    "nodes": {"m": {"type": "test.Mul", "inputs": {"a": {"$param": "x"}}}},
                    "returns": {"product": {"$link": ["m", "product"]}},
                }
            },
            "nodes": {"inst": {"type": "subgraph.bad", "inputs": {"x": 1}}},
            "outputs": ["inst"],
        }
    )
    (issue,) = [i for i in flatten(graph).issues if i.code is IssueCode.INVALID_PARAM_TYPE]
    assert issue.definition == "bad"
    assert issue.socket == "x"


# ------------------------------------------------------------------ 한계


def test_documented_limits_are_what_the_spec_says() -> None:
    """값이 조용히 바뀌면 §5.5 · decisions.md 가 거짓이 된다."""
    assert (MAX_DEPTH, MAX_NODES) == (8, 10_000)


def _chain(depth: int) -> dict[str, Any]:
    """`d0 → d1 → … → d{depth-1}` 로 이어지는 정의 사슬."""
    definitions: dict[str, Any] = {}
    for i in range(depth):
        inner = (
            {"n": {"type": f"subgraph.d{i + 1}"}}
            if i + 1 < depth
            else {"n": {"type": "test.Const"}}
        )
        definitions[f"d{i}"] = {"nodes": inner, "returns": {"out": {"$link": ["n", "value"]}}}
    return definitions


def test_depth_limit_names_the_depth_limit() -> None:
    graph = parse_graph(
        {"definitions": _chain(6), "nodes": {"top": {"type": "subgraph.d0"}}, "outputs": ["top"]}
    )
    issues = flatten(graph, max_depth=3).issues
    (issue,) = [i for i in issues if i.code is IssueCode.SUBGRAPH_TOO_DEEP]
    assert "깊이" in issue.message and "3" in issue.message
    assert issue.node_id is not None  # 어느 인스턴스에서 넘었는지 지목한다


def test_size_limit_names_the_size_limit() -> None:
    """깊이는 상한 안인데 결과만 큰 경우 — 깊이 검사로는 못 잡는다."""
    wide = {f"n{i}": {"type": "test.Const"} for i in range(10)}
    graph = parse_graph(
        {
            "definitions": {"wide": {"nodes": wide, "returns": {}}},
            "nodes": {f"i{j}": {"type": "subgraph.wide"} for j in range(5)},
            "outputs": [],
        }
    )
    issues = flatten(graph, max_nodes=12).issues
    (issue,) = [i for i in issues if i.code is IssueCode.SUBGRAPH_TOO_LARGE]
    assert "노드 수" in issue.message and "12" in issue.message


def test_the_two_limits_are_reported_distinctly() -> None:
    """ "너무 큽니다" 는 익명 에러다 — 사용자가 할 일이 다르다."""
    deep = parse_graph(
        {"definitions": _chain(6), "nodes": {"top": {"type": "subgraph.d0"}}, "outputs": ["top"]}
    )
    codes = {i.code for i in flatten(deep, max_depth=2).issues}
    assert IssueCode.SUBGRAPH_TOO_DEEP in codes
    assert IssueCode.SUBGRAPH_TOO_LARGE not in codes


def test_cyclic_definitions_terminate_and_are_reported() -> None:
    """사이클은 `validate_graph` 가 잡지만, 평탄화도 **멈춰야** 한다.

    검증을 건너뛰고 `flatten` 을 직접 부르는 호출자에게 무한 루프를 주지 않는다.
    """
    graph = parse_graph(
        {
            "definitions": {
                "a": {"nodes": {"i": {"type": "subgraph.b"}}},
                "b": {"nodes": {"i": {"type": "subgraph.a"}}},
            },
            "nodes": {"top": {"type": "subgraph.a"}},
            "outputs": [],
        }
    )
    result = flatten(graph)  # 멈춘다는 것 자체가 검사다
    assert any(i.code is IssueCode.SUBGRAPH_TOO_DEEP for i in result.issues)

    issues = validate_for_execution(graph, registry())
    assert any(i.code is IssueCode.SUBGRAPH_CYCLE for i in issues)


def test_follow_safety_cap_returns_the_position_after_the_breaking_hop() -> None:
    """검증을 우회해 별칭 사이클이 생겨도 `_follow` 의 실제 반환을 고정한다.

    max_depth=1 이면 여유 상한은 2이고, 세 번째 별칭을 따라간 직후 멈춘다.
    """
    state = _Flattener(parse_graph({"nodes": {}}), max_depth=1, max_nodes=MAX_NODES)
    state._alias.update(
        {
            ("a", "out"): ("b", "out"),
            ("b", "out"): ("c", "out"),
            ("c", "out"): ("a", "out"),
        }
    )

    assert state._follow("a", "out") == ("a", "out")


# ------------------------------------------------------------------ 검증 배치


def test_validate_for_execution_sees_through_the_subgraph() -> None:
    """§5.5 — 평탄화가 검증의 첫 걸음이라 안쪽 노드까지 타입 검사가 닿는다."""
    assert validate_for_execution(scaled_graph(2), registry(), ["sink"]) == []


def test_type_errors_inside_a_definition_are_reported_after_flattening() -> None:
    graph = parse_graph(
        {
            "definitions": {
                "oops": {
                    "nodes": {"m": {"type": "test.Nope"}},
                    "returns": {"out": {"$link": ["m", "x"]}},
                }
            },
            "nodes": {"inst": {"type": "subgraph.oops"}},
            "outputs": [],
        }
    )
    issues = validate_for_execution(graph, registry())
    unknown = [i for i in issues if i.code is IssueCode.UNKNOWN_NODE_TYPE]
    # 평탄화 전에는 `subgraph.oops` 가, 후에는 안쪽 `test.Nope` 가 걸린다.
    assert [i.node_id for i in unknown] == ["inst:m"]


@pytest.mark.parametrize("factor", [2, 3])
def test_flatten_is_deterministic(factor: int) -> None:
    """같은 문서는 언제나 같은 그래프로 편다 — 캐시 키가 그것에 기댄다."""
    first = flatten(scaled_graph(factor)).graph
    second = flatten(scaled_graph(factor)).graph
    # `id` 는 파싱할 때마다 새로 생기므로 비교 대상이 아니다 (문서에 없다).
    assert first.to_dict()["nodes"] == second.to_dict()["nodes"]
    assert first.outputs == second.outputs
