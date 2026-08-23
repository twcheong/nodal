"""서브그래프 계약 — 표현과 검증 (docs/design.md §5.5).

M5.0 은 **계약만** 이다. 평탄화(M5.3)도 실행(M5.2)도 여기 없다. 이 파일이 고정하는
것은 "문서가 무엇을 말할 수 있고, 무엇을 말하면 거부되는가" 하나다.

거부 케이스가 많은 이유: 서브그래프는 이름공간을 하나 더 만든다. 정의 안의 `n1`
과 최상위의 `n1` 은 다른 노드이고, 그 경계를 넘는 실수는 **조용히 통과하면
평탄화 시점에야 터진다.**
"""

from __future__ import annotations

from typing import Any

import pytest

from nodal import (
    Graph,
    GraphValidationError,
    IssueCode,
    Link,
    Param,
    ParamDef,
    SubgraphDef,
    parse_graph,
    subgraph_name,
    validate_graph,
)

# docs/design.md §5.5 의 예제 문서 그대로.
DESIGN_DOC_SUBGRAPH: dict[str, Any] = {
    "nodal_version": "1",
    "definitions": {
        "thumbnail": {
            "params": {
                "source": {"type": "Image"},
                "size": {"type": "INT", "default": 256, "widget": {"min": 16, "max": 2048}},
            },
            "nodes": {
                "fit": {
                    "type": "image.Resize",
                    "inputs": {
                        "image": {"$param": "source"},
                        "width": {"$param": "size"},
                        "height": {"$param": "size"},
                    },
                }
            },
            "outputs": {"image": {"$link": ["fit", "image"]}},
        }
    },
    "nodes": {
        "load": {"type": "image.Load", "inputs": {"path": "cat.png"}},
        "thumb": {
            "type": "subgraph.thumbnail",
            "inputs": {"source": {"$link": ["load", "image"]}, "size": 128},
        },
        "save": {"type": "image.Save", "inputs": {"image": {"$link": ["thumb", "image"]}}},
    },
    "outputs": ["save"],
}


def codes(graph: Graph) -> list[IssueCode]:
    return [issue.code for issue in validate_graph(graph)]


# ------------------------------------------------------------------ 표현


def test_design_doc_example_is_valid() -> None:
    graph = parse_graph(DESIGN_DOC_SUBGRAPH)
    assert validate_graph(graph) == []


def test_definitions_survive_a_round_trip() -> None:
    """정의가 문서 안에 산다는 것이 D1 의 전부다. 저장했다 읽으면 그대로여야 한다."""
    graph = parse_graph(DESIGN_DOC_SUBGRAPH)
    again = parse_graph(graph.to_json())
    assert again.definitions == graph.definitions
    assert again.to_dict() == graph.to_dict()


def test_param_is_a_reserved_key_not_a_literal() -> None:
    """`{"$param": ...}` 가 리터럴 딕셔너리로 새면 그 값이 노드까지 흘러간다."""
    graph = parse_graph(DESIGN_DOC_SUBGRAPH)
    fit = graph.definitions["thumbnail"].nodes["fit"]
    assert fit.inputs["image"] == Param.of("source")
    assert dict(fit.params()) == {
        "image": Param.of("source"),
        "width": Param.of("size"),
        "height": Param.of("size"),
    }
    assert dict(fit.links()) == {}


def test_literal_dict_without_reserved_keys_stays_literal() -> None:
    graph = parse_graph(
        {"nodal_version": "1", "nodes": {"a": {"type": "core.Sink", "inputs": {"opts": {"k": 1}}}}}
    )
    assert graph.nodes["a"].inputs["opts"] == {"k": 1}


def test_default_absent_means_required() -> None:
    """`default` 가 없는 것과 `null` 인 것은 같다 — 빈 값을 두 가지로 만들지 않는다."""
    declared = ParamDef.model_validate({"type": "Image"})
    explicit_null = ParamDef.model_validate({"type": "Image", "default": None})
    assert declared.required and explicit_null.required
    assert not ParamDef.model_validate({"type": "INT", "default": 0}).required


def test_subgraph_name_helper() -> None:
    assert subgraph_name("subgraph.thumbnail") == "thumbnail"
    assert subgraph_name("image.Resize") is None


def test_instances_are_listed_by_scope() -> None:
    graph = parse_graph(DESIGN_DOC_SUBGRAPH)
    assert list(graph.instances()) == [("thumb", "thumbnail")]
    assert list(graph.definitions["thumbnail"].instances()) == []


@pytest.mark.parametrize(
    "doc",
    [
        pytest.param({"definitions": {"a b": {}}}, id="정의 이름에 공백"),
        pytest.param({"definitions": {"d": {"nodes": {"n": {}}}}}, id="노드에 타입 없음"),
        pytest.param({"definitions": {"d": {"unknown": 1}}}, id="정의에 모르는 필드"),
        pytest.param(
            {"definitions": {"d": {"params": {"p": {"type": "INT", "x": 1}}}}},
            id="파라미터 선언에 모르는 필드",
        ),
        pytest.param(
            {"nodes": {"a": {"type": "core.Sink", "inputs": {"x": {"$param": "a b"}}}}},
            id="파라미터 이름이 소켓 규칙 위반",
        ),
    ],
)
def test_malformed_documents_are_rejected_at_parse(doc: dict[str, Any]) -> None:
    with pytest.raises(GraphValidationError):
        parse_graph({"nodal_version": "1", **doc})


def test_schema_issue_inside_a_definition_names_the_definition() -> None:
    """정의 안의 파싱 실패도 위치를 잃지 않는다."""
    with pytest.raises(GraphValidationError) as caught:
        parse_graph(
            {
                "nodal_version": "1",
                "definitions": {"d": {"nodes": {"n": {"type": "core.A", "extra": 1}}}},
            }
        )
    issue = caught.value.issues[0]
    assert issue.definition == "d"
    assert issue.location.startswith("definitions.d.nodes.n")


# ------------------------------------------------------------------ 검증


def test_instance_without_a_definition() -> None:
    graph = parse_graph({"nodal_version": "1", "nodes": {"i": {"type": "subgraph.nope"}}})
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.UNKNOWN_SUBGRAPH
    assert issue.node_id == "i"
    assert "nope" in issue.message


def test_param_outside_a_definition_is_rejected() -> None:
    """최상위에는 파라미터를 채울 사람이 없다."""
    graph = parse_graph(
        {
            "nodal_version": "1",
            "nodes": {"a": {"type": "core.Sink", "inputs": {"x": {"$param": "p"}}}},
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.PARAM_OUTSIDE_DEFINITION
    assert issue.location == "nodes.a.inputs.x"


def test_undeclared_param_reference() -> None:
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "d": {
                    "params": {"ok": {"type": "INT"}},
                    "nodes": {"n": {"type": "core.Sink", "inputs": {"x": {"$param": "typo"}}}},
                }
            },
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.UNKNOWN_PARAM
    assert issue.location == "definitions.d.nodes.n.inputs.x"
    # 선언된 것을 함께 보여준다 — 오타는 목록을 봐야 고칠 수 있다.
    assert "'ok'" in issue.message


def test_link_out_of_a_definition_is_rejected_even_when_the_target_exists() -> None:
    """가장 잡기 어려운 실수. 대상이 실재하므로 참조 검사만으로는 통과한다."""
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "d": {
                    "nodes": {"n": {"type": "core.Sink", "inputs": {"x": {"$link": ["out", "v"]}}}}
                }
            },
            "nodes": {"out": {"type": "core.Source"}},
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.SUBGRAPH_EXTERNAL_LINK
    assert issue.definition == "d"
    assert "$param" in issue.message  # 무엇을 대신 써야 하는지 말한다


def test_link_to_a_nonexistent_node_inside_a_definition() -> None:
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "d": {
                    "nodes": {
                        "n": {"type": "core.Sink", "inputs": {"x": {"$link": ["ghost", "v"]}}}
                    }
                }
            },
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.UNKNOWN_LINK_TARGET
    assert issue.definition == "d"


def test_definition_output_must_point_inside() -> None:
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "d": {
                    "nodes": {"n": {"type": "core.A"}},
                    "outputs": {"image": {"$link": ["x", "v"]}},
                }
            },
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.UNKNOWN_LINK_TARGET
    assert issue.location == "definitions.d.outputs.image"


def test_consuming_an_undeclared_instance_output() -> None:
    """정의가 내보내지 않는 소켓을 밖에서 읽으면 평탄화가 재배선할 대상이 없다."""
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "d": {
                    "nodes": {"n": {"type": "core.A"}},
                    "outputs": {"image": {"$link": ["n", "out"]}},
                }
            },
            "nodes": {
                "i": {"type": "subgraph.d"},
                "s": {"type": "core.Sink", "inputs": {"v": {"$link": ["i", "mask"]}}},
            },
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.UNKNOWN_OUTPUT_SOCKET
    assert "'image'" in issue.message


def test_self_link_inside_a_definition_keeps_its_own_code() -> None:
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "d": {"nodes": {"n": {"type": "core.A", "inputs": {"x": {"$link": ["n", "v"]}}}}}
            },
        }
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.SELF_LINK
    assert issue.definition == "d"


# ------------------------------------------------------------------ 순환


def test_direct_definition_cycle() -> None:
    graph = parse_graph(
        {"nodal_version": "1", "definitions": {"a": {"nodes": {"i": {"type": "subgraph.a"}}}}}
    )
    (issue,) = validate_graph(graph)
    assert issue.code is IssueCode.SUBGRAPH_CYCLE
    assert issue.message.endswith("a → a")


def test_indirect_definition_cycle_names_the_path() -> None:
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "a": {"nodes": {"i": {"type": "subgraph.b"}}},
                "b": {"nodes": {"i": {"type": "subgraph.c"}}},
                "c": {"nodes": {"i": {"type": "subgraph.a"}}},
            },
        }
    )
    issues = validate_graph(graph)
    assert {issue.definition for issue in issues} == {"a", "b", "c"}
    assert all(issue.code is IssueCode.SUBGRAPH_CYCLE for issue in issues)
    # 경로가 결정적이다 — 같은 문서는 언제나 같은 메시지를 낸다.
    assert next(issue.message for issue in issues).endswith("a → b → c → a")


def test_nesting_without_a_cycle_is_fine() -> None:
    """중첩 자체는 허용된다. 금지되는 것은 순환뿐이다."""
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "outer": {"nodes": {"i": {"type": "subgraph.inner"}}},
                "inner": {"nodes": {"n": {"type": "core.A"}}},
            },
        }
    )
    assert codes(graph) == []


def test_a_definition_pointing_into_a_cycle_is_not_itself_reported() -> None:
    """`d` 는 순환에 닿지만 자기가 순환하지는 않는다. 지목은 정확해야 한다."""
    graph = parse_graph(
        {
            "nodal_version": "1",
            "definitions": {
                "a": {"nodes": {"i": {"type": "subgraph.b"}}},
                "b": {"nodes": {"i": {"type": "subgraph.a"}}},
                "d": {"nodes": {"i": {"type": "subgraph.a"}}},
            },
        }
    )
    assert {issue.definition for issue in validate_graph(graph)} == {"a", "b"}


# ------------------------------------------------------------------ 조립 API


def test_models_can_be_built_in_python() -> None:
    """테스트와 도구가 JSON 을 손으로 쓰지 않아도 되게 한다."""
    graph = Graph(
        definitions={
            "d": SubgraphDef(
                params={"n": ParamDef(type="INT", default=1)},
                nodes={"a": {"type": "core.Add", "inputs": {"x": Param.of("n")}}},  # type: ignore[dict-item]
                outputs={"sum": Link.to("a", "sum")},
            )
        },
    )
    assert validate_graph(graph) == []
    assert graph.definitions["d"].outputs["sum"].source_node == "a"
