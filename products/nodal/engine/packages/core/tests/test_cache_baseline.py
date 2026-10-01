"""M5.2 ``IS_CHANGED`` 배선 전 그래프 캐시 키 베이스라인.

아래 키는 현재 구현 결과를 **의도적으로 리터럴 문자열로 하드코딩**한다. 이 테스트가
깨졌을 때 새 출력으로 값을 갱신하면 기존 저장 캐시를 전부 무효화하는 회귀를 정답으로
고정하게 된다. 값 변경은 캐시 키 정의를 의도적으로 바꾸는 경우에만 허용하며, 그
커밋에는 변경 이유를 기록한 ``docs/decisions.md`` 항목이 반드시 함께 있어야 한다.
"""

from __future__ import annotations

from nodal import NodeSchema, graph_cache_keys, parse_graph


def _schema(type_id: str, *, version: str) -> NodeSchema:
    return NodeSchema(
        id=type_id,
        title=type_id,
        category="baseline",
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


SCHEMAS = {
    "baseline.Literal": _schema(
        "baseline.Literal",
        version="baseline-literal-v1",
    ),
    "baseline.Offset": _schema(
        "baseline.Offset",
        version="baseline-offset-v1",
    ),
    "baseline.Add": _schema(
        "baseline.Add",
        version="baseline-add-v1",
    ),
}


def test_literal_only_graph_cache_key_baseline() -> None:
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

    assert graph_cache_keys(graph, SCHEMAS) == {"literal": "e9d96a74fc8ed9f580150e3a4456c479"}


def test_linked_input_graph_cache_key_baseline() -> None:
    graph = parse_graph(
        {
            "nodes": {
                "source": {
                    "type": "baseline.Literal",
                    "inputs": {"value": 3},
                },
                "offset": {
                    "type": "baseline.Offset",
                    "inputs": {
                        "value": {"$link": ["source", "value"]},
                        "amount": 5,
                    },
                },
            }
        }
    )

    assert graph_cache_keys(graph, SCHEMAS) == {
        "source": "9a767d84f973280d7d36f1c79a3f008f",
        "offset": "262169d62fd6f2c9764c17d66fe3846a",
    }


def test_diamond_dependency_graph_cache_key_baseline() -> None:
    graph = parse_graph(
        {
            "nodes": {
                "a": {"type": "baseline.Literal", "inputs": {"value": 2}},
                "b": {
                    "type": "baseline.Offset",
                    "inputs": {
                        "value": {"$link": ["a", "value"]},
                        "amount": 1,
                    },
                },
                "c": {
                    "type": "baseline.Offset",
                    "inputs": {
                        "value": {"$link": ["a", "value"]},
                        "amount": 10,
                    },
                },
                "d": {
                    "type": "baseline.Add",
                    "inputs": {
                        "left": {"$link": ["b", "value"]},
                        "right": {"$link": ["c", "value"]},
                    },
                },
            }
        }
    )

    assert graph_cache_keys(graph, SCHEMAS) == {
        "a": "bbd6bb99858016883c0c366ff677b207",
        "b": "fb4e0d0473e56516413b2842ba076215",
        "c": "32e720d7834ae36c03d3a3662942c604",
        "d": "9240b50c7a14c6a9cdfe4c52d1eaff0a",
    }
