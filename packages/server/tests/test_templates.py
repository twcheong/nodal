"""템플릿 카탈로그 규약 (design.md §12.8) + 호출 그래프 계약 (§12.6).

카탈로그가 **조용히 건너뛰지 않는다**는 것이 이 파일의 절반이다. 템플릿이 안
보이는 이유를 사람이 알 수 있어야 하므로, 거부는 언제나 이유와 함께 남는다.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from PIL import Image as PILImage

import nodal_nodes_image
from nodal import (
    CancelToken,
    LRUCache,
    NullEventSink,
    RunResult,
    execute,
    register_preview_encoder,
)
from nodal.preview import _ENCODERS
from nodal.subgraph import flatten
from nodal_server.assets import AssetStore
from nodal_server.queue import RunRecord
from nodal_server.templates import (
    CALL_NODE_ID,
    AssetReferenceNotSupportedError,
    Template,
    build_call_graph,
    collect_results,
    default_templates_dir,
    load_catalog,
)
from nodal_server.toolschema import IMAGE_VALUE_DOC

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
                "doc": "테스트용 정의.",
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


def test_definition_without_doc_is_rejected(tmp_path: Path) -> None:
    """카탈로그에 노출되려면 doc 이 필수다 (§12.8) — 서버가 지어낼 수 없다."""
    document = minimal("demo")
    del document["definitions"]["demo"]["doc"]
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert "doc" in catalog.rejections[0].reason


def test_blank_doc_is_not_a_doc(tmp_path: Path) -> None:
    document = minimal("demo")
    document["definitions"]["demo"]["doc"] = "   "
    write(tmp_path, "demo.nodal.json", document)
    assert len(load_catalog(tmp_path)) == 0


def test_nested_definition_needs_no_doc(tmp_path: Path) -> None:
    """필수는 **노출 지점**에서만이다. 서브그래프 일반에서는 선택이다."""
    document = minimal("demo")
    document["definitions"]["helper"] = dict(document["definitions"]["demo"])
    del document["definitions"]["helper"]["doc"]
    write(tmp_path, "demo.nodal.json", document)
    assert [t.id for t in load_catalog(tmp_path).templates] == ["demo"]


def test_doc_is_the_first_line_of_the_tool_description(tmp_path: Path) -> None:
    document = minimal("demo")
    document["definitions"]["demo"]["doc"] = "제품 사진을 광고용으로 다듬는다."
    write(tmp_path, "demo.nodal.json", document)
    template = load_catalog(tmp_path).templates[0]
    assert template.describe().splitlines()[0] == "제품 사진을 광고용으로 다듬는다."


def test_definition_without_returns_is_rejected(tmp_path: Path) -> None:
    document = minimal("demo")
    document["definitions"]["demo"]["returns"] = {}
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert "returns" in catalog.rejections[0].reason


def test_unconvertible_param_rejects_the_template(tmp_path: Path) -> None:
    document = minimal("demo", mask={"type": "Mask"})
    document["definitions"]["demo"]["nodes"]["echo"]["inputs"]["text"] = {"$param": "mask"}
    write(tmp_path, "demo.nodal.json", document)
    catalog = load_catalog(tmp_path)
    assert len(catalog) == 0
    assert catalog.rejections[0].details[0].param == "mask"


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


@pytest.fixture
def image_preview_encoder() -> Iterator[None]:
    """core 테스트가 비운 전역 등록을 복구하되 이 테스트가 남기지는 않는다."""
    encoder = nodal_nodes_image.encode_ndarray_preview
    was_registered = encoder in _ENCODERS
    if not was_registered:
        register_preview_encoder(encoder)
    try:
        yield
    finally:
        if not was_registered and encoder in _ENCODERS:
            _ENCODERS.remove(encoder)


def test_example_template_loads(thumbnail: Template) -> None:
    assert load_catalog(EXAMPLES).rejections == ()
    assert thumbnail.tool_name == "run_template_thumbnail"
    assert thumbnail.returns == ("image",)


def test_example_input_schema(thumbnail: Template) -> None:
    """M6.0 완료 증거. 이 값이 곧 MCP 클라이언트가 보는 것이다."""
    assert thumbnail.input_schema == {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": f"줄일 원본 이미지. {IMAGE_VALUE_DOC}",
            },
            "size": {
                "type": "integer",
                "minimum": 16,
                "maximum": 2048,
                "multipleOf": 8,
                "description": "결과 한 변의 픽셀 크기. 가로세로가 같아진다.",
                "default": 256,
            },
            # `method` 에는 doc 이 없다 — 없으면 description 도 없다는 것을
            # 예제가 함께 보인다 (§12.3).
            "method": {
                "type": "string",
                "enum": ["nearest", "bilinear", "bicubic", "lanczos"],
                "default": "lanczos",
            },
        },
        "additionalProperties": False,
        "required": ["source"],
    }


def test_call_graph_flattens(thumbnail: Template) -> None:
    graph = build_call_graph(thumbnail, {"source": "examples/sample.png", "size": 128})
    result = flatten(graph, (CALL_NODE_ID,))
    assert result.issues == ()
    # 평탄화가 끝난 그래프에 `subgraph.*` 는 남지 않는다 (§5.5 ⑤).
    assert all(not node.type.startswith("subgraph.") for node in result.graph.nodes.values())
    assert sorted(result.graph.nodes) == ["call:load", "call:save", "call:shrink:fit"]
    # 요청된 출력은 정의의 `returns` 가 가리키는 안쪽 노드로 옮겨진다.
    assert result.outputs == ("call:save",)


async def test_example_template_executes_and_collects_a_128_png(
    thumbnail: Template, image_preview_encoder: None
) -> None:
    """예제를 실제 1st-party 이미지 노드로 끝까지 실행하는 M6.1a 증거."""
    graph = build_call_graph(thumbnail, {"source": "examples/sample.png", "size": 128})
    assets = AssetStore()
    result = await execute(
        graph,
        graph.outputs,
        registry=nodal_nodes_image.registry(),
        cache=LRUCache(64),
        events=NullEventSink(),
        cancel_token=CancelToken(),
        assets=assets,
    )
    record = RunRecord(
        run_id=result.run_id,
        graph=graph,
        outputs=tuple(graph.outputs),
        use_cache=True,
        priority=0,
        node_count=len(graph.nodes),
    )
    record.result = result

    results = collect_results(thumbnail, record)

    assert list(results) == ["image"]
    assert results["image"].asset is not None
    digest = results["image"].asset.hash
    data = assets.get(digest)
    assert data is not None
    with PILImage.open(io.BytesIO(data)) as image:
        assert image.format == "PNG"
        assert image.size == (128, 128)


def test_collect_results_omits_and_logs_a_missing_reference(
    thumbnail: Template, caplog: pytest.LogCaptureFixture
) -> None:
    graph = build_call_graph(thumbnail, {"source": "examples/sample.png"})
    record = RunRecord(
        run_id="missing-ref",
        graph=graph,
        outputs=tuple(graph.outputs),
        use_cache=False,
        priority=0,
        node_count=len(graph.nodes),
    )
    record.result = RunResult(
        run_id=record.run_id,
        outputs={},
        output_sockets={"call": {"image": ("call:save", "asset")}},
    )

    with caplog.at_level(logging.WARNING):
        results = collect_results(thumbnail, record)

    assert results == {}
    assert "call:save.asset 참조가 없어 생략했다" in caplog.text


def test_missing_argument_points_at_the_parameter(thumbnail: Template) -> None:
    """§12.3 — 실패하면 **어느 파라미터인지** 지목한다."""
    result = flatten(build_call_graph(thumbnail, {"size": 128}), (CALL_NODE_ID,))
    (issue,) = result.issues
    assert issue.code == "missing_param"
    assert issue.node_id == CALL_NODE_ID
    assert issue.socket == "source"


def test_defaults_come_from_the_definition(thumbnail: Template) -> None:
    """인자를 주지 않으면 선언된 기본값이 들어간다 — 서버가 지어내지 않는다."""
    result = flatten(
        build_call_graph(thumbnail, {"source": "examples/sample.png"}), (CALL_NODE_ID,)
    )
    assert result.issues == ()
    assert result.graph.nodes["call:shrink:fit"].inputs["width"] == 256


def test_asset_reference_is_an_explicit_not_implemented_error(thumbnail: Template) -> None:
    """§12.3 H2 — 조용히 경로로 취급하지 않는다."""
    with pytest.raises(AssetReferenceNotSupportedError) as excinfo:
        build_call_graph(thumbnail, {"source": "asset:ab12cd34"})
    message = str(excinfo.value)
    assert "source" in message, "어느 파라미터인지 지목한다"
    assert "asset:ab12cd34" in message


def test_asset_prefix_is_reserved_on_every_parameter(thumbnail: Template) -> None:
    """예약 접두는 타입과 무관하다 — STRING 파라미터에 들어와도 걸린다."""
    with pytest.raises(AssetReferenceNotSupportedError):
        build_call_graph(thumbnail, {"source": "a.png", "method": "asset:ab12"})


def test_asset_reference_inside_a_list_is_caught(thumbnail: Template) -> None:
    with pytest.raises(AssetReferenceNotSupportedError):
        build_call_graph(thumbnail, {"source": ["a.png", "asset:ab12"]})


def test_ordinary_paths_are_untouched(thumbnail: Template) -> None:
    graph = build_call_graph(thumbnail, {"source": "assets/cat.png"})
    assert graph.nodes[CALL_NODE_ID].inputs["source"] == "assets/cat.png"
