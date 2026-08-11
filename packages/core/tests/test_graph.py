"""캐논 그래프 포맷 테스트 (docs/design.md §4.1).

M0 완료 기준: 빈 그래프를 검증하고 유효/무효를 판정한다.
"""

from __future__ import annotations

import json
from uuid import UUID

import pytest

from nodal import (
    GRAPH_VERSION,
    Graph,
    GraphValidationError,
    IssueCode,
    Link,
    Node,
    check_graph,
    parse_graph,
    validate_graph,
)

# design.md §4.1 에 실린 예제 문서 그대로.
DESIGN_DOC_EXAMPLE = {
    "nodal_version": "1",
    "id": "018f2c00-0000-7000-8000-000000000000",
    "nodes": {
        "n_c3d4": {"type": "image.Load", "inputs": {"path": "cat.png"}},
        "n_a1b2": {
            "type": "image.Resize",
            "inputs": {
                "image": {"$link": ["n_c3d4", "image"]},
                "width": 512,
                "method": "lanczos",
            },
            "meta": {"title": "Resize to 512"},
        },
    },
    "outputs": ["n_a1b2"],
    "ui": {
        "n_a1b2": {"pos": [340, 120], "collapsed": False, "color": "#3a5"},
        "viewport": {"x": 0, "y": 0, "zoom": 1.0},
        "groups": [],
    },
}


# ------------------------------------------------------------------ 빈 그래프


def test_empty_graph_is_valid() -> None:
    graph = parse_graph({"nodal_version": "1", "nodes": {}, "outputs": []})
    assert validate_graph(graph) == []
    check_graph(graph)


def test_graph_defaults_are_usable() -> None:
    """필드를 하나도 안 줘도 유효한 빈 그래프가 나온다."""
    graph = Graph()
    assert graph.nodal_version == GRAPH_VERSION
    assert isinstance(graph.id, UUID)
    assert graph.nodes == {}
    assert validate_graph(graph) == []


# ------------------------------------------------------------------ 파싱


def test_parses_design_doc_example() -> None:
    graph = parse_graph(DESIGN_DOC_EXAMPLE)

    resize = graph.nodes["n_a1b2"]
    assert resize.type == "image.Resize"
    assert resize.meta.title == "Resize to 512"

    # 링크는 Link 로, 리터럴은 그대로.
    assert resize.inputs["image"] == Link.to("n_c3d4", "image")
    assert resize.inputs["width"] == 512
    assert resize.inputs["method"] == "lanczos"

    assert validate_graph(graph) == []


def test_roundtrip_preserves_canonical_shape() -> None:
    """읽고 다시 쓰면 같은 문서가 나온다 — 변환 레이어가 없다는 뜻."""
    graph = parse_graph(DESIGN_DOC_EXAMPLE)
    assert json.loads(graph.to_json()) == DESIGN_DOC_EXAMPLE


def test_ui_field_is_opaque_to_backend() -> None:
    """백엔드는 ui 를 해석하지 않는다. 임의의 JSON 이 통과해야 한다."""
    doc = dict(DESIGN_DOC_EXAMPLE, ui={"whatever": [1, {"nested": None}], "🎨": "ok"})
    graph = parse_graph(doc)
    assert graph.ui["🎨"] == "ok"


def test_graph_without_ui_is_complete() -> None:
    """ui 가 없어도 백엔드는 완전히 동작한다."""
    doc = {k: v for k, v in DESIGN_DOC_EXAMPLE.items() if k != "ui"}
    graph = parse_graph(doc)
    assert graph.ui == {}
    assert validate_graph(graph) == []


def test_link_key_is_reserved() -> None:
    """`$link` 를 가진 딕셔너리는 언제나 링크로 해석된다."""
    graph = parse_graph(
        {
            "nodes": {
                "a": {"type": "core.Sink", "inputs": {"x": {"$link": ["b", "out"]}}},
                "b": {"type": "core.Source"},
            }
        }
    )
    assert isinstance(graph.nodes["a"].inputs["x"], Link)


def test_literal_dict_input_is_preserved() -> None:
    graph = parse_graph(
        {"nodes": {"a": {"type": "core.Sink", "inputs": {"opts": {"k": [1, 2, None]}}}}}
    )
    assert graph.nodes["a"].inputs["opts"] == {"k": [1, 2, None]}


# ------------------------------------------------------------------ 순회


def test_traversal_helpers() -> None:
    graph = parse_graph(DESIGN_DOC_EXAMPLE)
    assert graph.dependencies("n_a1b2") == {"n_c3d4"}
    assert graph.dependencies("n_c3d4") == set()
    assert graph.dependents("n_c3d4") == {"n_a1b2"}
    assert graph.dependents("n_a1b2") == set()
    assert list(graph.iter_links()) == [("n_a1b2", "image", Link.to("n_c3d4", "image"))]


# ------------------------------------------------------------------ 무효 판정


def test_dangling_link_points_at_node_and_socket() -> None:
    graph = parse_graph(
        {"nodes": {"a": {"type": "image.Resize", "inputs": {"image": {"$link": ["ghost", "out"]}}}}}
    )
    (issue,) = validate_graph(graph)
    assert issue.code == IssueCode.UNKNOWN_LINK_TARGET
    assert issue.node_id == "a"
    assert issue.socket == "image"
    assert issue.location == "nodes.a.inputs.image"


def test_self_link_is_rejected() -> None:
    graph = parse_graph(
        {"nodes": {"a": {"type": "core.Loop", "inputs": {"x": {"$link": ["a", "out"]}}}}}
    )
    (issue,) = validate_graph(graph)
    assert issue.code == IssueCode.SELF_LINK
    assert issue.location == "nodes.a.inputs.x"


def test_unknown_output_is_rejected() -> None:
    graph = parse_graph({"nodes": {}, "outputs": ["ghost"]})
    (issue,) = validate_graph(graph)
    assert issue.code == IssueCode.UNKNOWN_OUTPUT
    assert issue.node_id == "ghost"


def test_duplicate_output_is_rejected() -> None:
    graph = parse_graph({"nodes": {"a": {"type": "core.Sink"}}, "outputs": ["a", "a"]})
    (issue,) = validate_graph(graph)
    assert issue.code == IssueCode.DUPLICATE_OUTPUT


def test_all_issues_are_reported_at_once() -> None:
    """첫 번째 문제에서 멈추지 않는다."""
    graph = parse_graph(
        {
            "nodes": {
                "a": {"type": "core.Sink", "inputs": {"x": {"$link": ["ghost", "out"]}}},
                "b": {"type": "core.Sink", "inputs": {"y": {"$link": ["nobody", "out"]}}},
            },
            "outputs": ["missing"],
        }
    )
    assert len(validate_graph(graph)) == 3


def test_check_graph_raises_with_located_message() -> None:
    graph = parse_graph(
        {"nodes": {"a": {"type": "core.Sink", "inputs": {"x": {"$link": ["ghost", "out"]}}}}}
    )
    with pytest.raises(GraphValidationError) as excinfo:
        check_graph(graph)
    assert "nodes.a.inputs.x" in str(excinfo.value)
    assert excinfo.value.issues[0].code == IssueCode.UNKNOWN_LINK_TARGET


# ------------------------------------------------------------------ 포맷 위반


@pytest.mark.parametrize(
    ("doc", "reason"),
    [
        ({"nodal_version": "2", "nodes": {}}, "미래 버전 거부"),
        ({"nodes": {"a": {"type": "Resize"}}}, "네임스페이스 없는 타입"),
        ({"nodes": {"a": {"type": "image.Resize", "extra": 1}}}, "알 수 없는 노드 필드"),
        ({"nodes": {"a b": {"type": "image.Resize"}}}, "공백 있는 노드 ID"),
        (
            {
                "nodes": {"a": {"type": "image.Resize", "inputs": {"1bad": 1}}},
            },
            "잘못된 소켓 이름",
        ),
        (
            {"nodes": {"a": {"type": "image.Resize", "inputs": {"x": {"$link": ["b"]}}}}},
            "링크 튜플 길이",
        ),
        ({"unknown_top_level": 1}, "알 수 없는 최상위 필드"),
    ],
)
def test_malformed_documents_are_rejected(doc: dict[str, object], reason: str) -> None:
    with pytest.raises(GraphValidationError) as excinfo:
        parse_graph(doc)
    assert all(i.code == IssueCode.SCHEMA for i in excinfo.value.issues), reason


def test_schema_error_locates_the_node() -> None:
    with pytest.raises(GraphValidationError) as excinfo:
        parse_graph({"nodes": {"n_a1b2": {"type": "not a type id"}}})
    assert excinfo.value.issues[0].node_id == "n_a1b2"


def test_invalid_json_text_is_a_graph_error() -> None:
    with pytest.raises(GraphValidationError):
        parse_graph("{ not json")


# ------------------------------------------------------------------ 조립 API


def test_graph_can_be_built_in_python() -> None:
    graph = Graph(
        nodes={
            "src": Node(type="core.Int", inputs={"value": 7}),
            "dst": Node(type="core.Add", inputs={"a": Link.to("src", "value"), "b": 1}),
        },
        outputs=["dst"],
    )
    check_graph(graph)
    assert json.loads(graph.to_json())["nodes"]["dst"]["inputs"]["a"] == {"$link": ["src", "value"]}
