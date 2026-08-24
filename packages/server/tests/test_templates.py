"""템플릿 카탈로그 규약 (design.md §12.8) + 호출 그래프 계약 (§12.6).

카탈로그가 **조용히 건너뛰지 않는다**는 것이 이 파일의 절반이다. 템플릿이 안
보이는 이유를 사람이 알 수 있어야 하므로, 거부는 언제나 이유와 함께 남는다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nodal.subgraph import flatten
from nodal_server.templates import (
    CALL_NODE_ID,
    Template,
    build_call_graph,
    default_templates_dir,
    load_catalog,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLES = REPO_ROOT / "examples" / "templates"


def write(root: Path, name: str, document: dict[str, Any]) -> Path:
    path = root / name
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


def minimal(definition_name: str = "demo", **params: dict[str, Any]) -> dict[str, Any]:
    """정의 하나짜리 문서. 파라미터는 호출자가 정한다."""
    return {
        "nodal_version": "1",
        "definitions": {
            definition_name: {
                "params": params or {"text": {"type": "STRING", "default": "hi"}},
                "nodes": {"echo": {"type": "text.Print", "inputs": {"text": {"$param": "text"}}}},
                "returns": {"out": {"$link": ["echo", "text"]}},
            }
        },
    }


# ------------------------------------------------------------------ 발견 규약


def test_discovery_directory_is_one_place() -> None:
    assert default_templates_dir() == Path.home() / ".nodal" / "templates"


def test_missing_directory_is_an_empty_catalog_not_an_error(tmp_path: Path) -> None:
    catalog = load_catalog(tmp_path / "nope")
    assert len(catalog) == 0
    assert catalog.rejections == ()


def test_template_id_is_the_file_name(tmp_path: Path) -> None:
    write(tmp_path, "demo.nodal.json", minimal("demo"))
    catalog = load_catalog(tmp_path)
    assert [t.id for t in catalog.templates] == ["demo"]
    assert catalog.templates[0].tool_name == "run_template_demo"


def test_definition_must_match_the_file_name(tmp_path: Path) -> None:
    """이름이 어긋나면 **거부한다.** 정의가 하나뿐이어도 골라주지 않는다."""
    write(tmp_path, "demo.nodal.json", minimal("something_else"))
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert "something_else" in catalog.rejections[0].reason


def test_extra_definitions_are_allowed(tmp_path: Path) -> None:
    """정의가 여럿이어도 된다 — 노출은 파일 이름과 같은 것 하나다."""
    document = minimal("demo")
    document["definitions"]["helper"] = document["definitions"]["demo"]
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert [t.id for t in catalog.templates] == ["demo"]
    assert set(catalog.templates[0].graph.definitions) == {"demo", "helper"}


def test_uppercase_id_is_rejected(tmp_path: Path) -> None:
    """ID 가 곧 파일명이다. 대소문자를 구분하지 않는 파일시스템에서 충돌한다."""
    write(tmp_path, "Demo.nodal.json", minimal("Demo"))
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert "템플릿 ID" in catalog.rejections[0].reason


def test_broken_json_is_rejected_with_a_reason(tmp_path: Path) -> None:
    (tmp_path / "demo.nodal.json").write_text("{ not json", encoding="utf-8")
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert catalog.rejections[0].reason


def test_self_contradicting_document_is_rejected_with_issue_locations(tmp_path: Path) -> None:
    document = minimal("demo")
    # 선언되지 않은 파라미터를 가리킨다 → `unknown_param`.
    document["definitions"]["demo"]["nodes"]["echo"]["inputs"]["text"] = {"$param": "nope"}
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    detail = catalog.rejections[0].details[0]
    assert "unknown_param" in detail.reason
    assert detail.param == "definitions.demo.nodes.echo.inputs.text"


def test_definition_without_returns_is_rejected(tmp_path: Path) -> None:
    document = minimal("demo")
    document["definitions"]["demo"]["returns"] = {}
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert "returns" in catalog.rejections[0].reason


def test_unconvertible_param_rejects_the_template(tmp_path: Path) -> None:
    document = minimal("demo", image={"type": "Image"})
    document["definitions"]["demo"]["nodes"]["echo"]["inputs"]["text"] = {"$param": "image"}
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert catalog.rejections[0].details[0].param == "image"


def test_one_bad_file_does_not_hide_the_good_ones(tmp_path: Path) -> None:
    write(tmp_path, "good.nodal.json", minimal("good"))
    write(tmp_path, "bad.nodal.json", minimal("mismatch"))
    catalog = load_catalog(tmp_path)
    assert [t.id for t in catalog.templates] == ["good"]
    assert len(catalog.rejections) == 1


def test_other_files_are_not_scanned(tmp_path: Path) -> None:
    write(tmp_path, "demo.json", minimal("demo"))
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert catalog.rejections == (), "확장자가 다른 파일은 템플릿 후보가 아니다"


# ------------------------------------------------------------------ 시드 (§12.3)


def test_seed_is_visible_when_declared(tmp_path: Path) -> None:
    document = minimal("demo", seed={"type": "INT", "widget": {"seed": True}})
    document["definitions"]["demo"]["nodes"]["echo"]["inputs"]["text"] = {"$param": "seed"}
    write(tmp_path, "demo.nodal.json", document)
    template = load_catalog(tmp_path).templates[0]
    assert template.seed_params == ("seed",)
    assert "seed" in template.input_schema["required"], "서버가 만들어 넣지 않는다 (§12.3)"
    assert "같은 결과가 나온다" in template.describe()


def test_absent_seed_is_stated_not_hidden(tmp_path: Path) -> None:
    write(tmp_path, "demo.nodal.json", minimal("demo"))
    template = load_catalog(tmp_path).templates[0]
    assert template.seed_params == ()
    assert "시드를 노출하지 않는다" in template.describe()


def test_seed_hint_alone_is_enough(tmp_path: Path) -> None:
    """이름이 달라도 힌트가 있으면 시드다."""
    document = minimal("demo", noise={"type": "INT", "widget": {"seed": True}})
    document["definitions"]["demo"]["nodes"]["echo"]["inputs"]["text"] = {"$param": "noise"}
    write(tmp_path, "demo.nodal.json", document)
    assert load_catalog(tmp_path).templates[0].seed_params == ("noise",)


# ------------------------------------------------------------------ 호출 그래프


@pytest.fixture
def thumbnail() -> Template:
    template = load_catalog(EXAMPLES).get("thumbnail")
    assert template is not None, "examples/templates/thumbnail.nodal.json 이 로드되어야 한다"
    return template


def test_example_template_loads(thumbnail: Template) -> None:
    assert load_catalog(EXAMPLES).rejections == ()
    assert thumbnail.tool_name == "run_template_thumbnail"
    assert thumbnail.returns == ("image",)


def test_example_input_schema(thumbnail: Template) -> None:
    """M6.0 완료 증거. 이 값이 곧 MCP 클라이언트가 보는 것이다."""
    assert thumbnail.input_schema == {
        "type": "object",
        "properties": {
            "source_path": {"type": "string"},
            "size": {
                "type": "integer",
                "minimum": 16,
                "maximum": 2048,
                "multipleOf": 8,
                "default": 256,
            },
            "method": {
                "type": "string",
                "enum": ["nearest", "bilinear", "bicubic", "lanczos"],
                "default": "lanczos",
            },
        },
        "additionalProperties": False,
        "required": ["source_path"],
    }


def test_call_graph_flattens(thumbnail: Template) -> None:
    graph = build_call_graph(thumbnail, {"source_path": "examples/sample.png", "size": 128})
    result = flatten(graph, (CALL_NODE_ID,))
    assert result.issues == ()
    # 평탄화가 끝난 그래프에 `subgraph.*` 는 남지 않는다 (§5.5 ⑤).
    assert all(not node.type.startswith("subgraph.") for node in result.graph.nodes.values())
    assert sorted(result.graph.nodes) == ["call:load", "call:save", "call:shrink:fit"]
    # 요청된 출력은 정의의 `returns` 가 가리키는 안쪽 노드로 옮겨진다.
    assert result.outputs == ("call:save",)


def test_missing_argument_points_at_the_parameter(thumbnail: Template) -> None:
    """§12.3 — 실패하면 **어느 파라미터인지** 지목한다."""
    result = flatten(build_call_graph(thumbnail, {"size": 128}), (CALL_NODE_ID,))
    (issue,) = result.issues
    assert issue.code == "missing_param"
    assert issue.node_id == CALL_NODE_ID
    assert issue.socket == "source_path"


def test_defaults_come_from_the_definition(thumbnail: Template) -> None:
    """인자를 주지 않으면 선언된 기본값이 들어간다 — 서버가 지어내지 않는다."""
    result = flatten(
        build_call_graph(thumbnail, {"source_path": "examples/sample.png"}), (CALL_NODE_ID,)
    )
    assert result.issues == ()
    assert result.graph.nodes["call:shrink:fit"].inputs["width"] == 256
