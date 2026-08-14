"""엔진을 통과하는 통합 검증 (roadmap M3 완료 기준).

브라우저 없이 확인하는 네 가지:

1. Load → Resize → Save 가 실제로 돈다
2. 저장된 PNG 에서 워크플로가 복원된다 (`iTXt` 왕복)
3. 같은 그래프를 다시 돌리면 `node.cached` 가 나온다
4. 프리뷰가 `node.preview` 로 실제로 나간다 (M2 까지 버려지던 경로)
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from PIL import Image as PILImage
from preview_encoder_fixture import ensure_preview_encoder_registered  # noqa: F401

import nodal_nodes_image
from nodal import (
    AssetRef,
    CancelToken,
    LRUCache,
    NodeCached,
    NodePreview,
    NodeStarted,
    NullCache,
    RecordingEventSink,
    execute,
    parse_graph,
)
from nodal_nodes_image import WORKFLOW_KEY
from nodal_server.assets import FileAssetStore
from nodal_server.png import read_text_chunks

GRAPH_ID = "018f2c00-0000-7000-8000-00000000c0de"


@pytest.fixture
def registry():
    return nodal_nodes_image.registry()


@pytest.fixture
def source_png(tmp_path: Path) -> Path:
    path = tmp_path / "source.png"
    PILImage.new("RGB", (8, 6), (200, 100, 50)).save(path)
    return path


def pipeline_graph(source: Path, *, width: int = 4, height: int = 3) -> dict:
    """Load → Resize → Save."""
    return {
        "nodal_version": "1",
        "id": GRAPH_ID,
        "nodes": {
            "load": {"type": "image.Load", "inputs": {"path": str(source)}},
            "resize": {
                "type": "image.Resize",
                "inputs": {
                    "image": {"$link": ["load", "image"]},
                    "width": width,
                    "height": height,
                    "method": "bilinear",
                },
            },
            "save": {
                "type": "image.Save",
                "inputs": {"image": {"$link": ["resize", "image"]}, "embed_workflow": True},
            },
        },
    }


def run_graph(graph: dict, registry, assets, *, cache=None, events=None):
    sink = events if events is not None else RecordingEventSink()
    result = asyncio.run(
        execute(
            parse_graph(graph),
            ["save"],
            registry=registry,
            cache=cache if cache is not None else NullCache(),
            events=sink,
            cancel_token=CancelToken(),
            assets=assets,
        )
    )
    return result, sink


# ---------------------------------------------- 1. 파이프라인이 실제로 돈다


def test_load_resize_save_produces_a_stored_png(tmp_path, registry, source_png) -> None:
    assets = FileAssetStore(tmp_path / "assets")

    result, _ = run_graph(pipeline_graph(source_png), registry, assets)

    ref = result.outputs["save"]["asset"]
    assert isinstance(ref, AssetRef)
    assert ref.media_type == "image/png"
    assert (ref.width, ref.height) == (4, 3)

    data = assets.get(ref.hash)
    assert data is not None
    with PILImage.open(__import__("io").BytesIO(data)) as saved:
        assert saved.size == (4, 3)  # Resize 가 실제로 적용됐다


def test_stored_asset_survives_a_new_store_instance(tmp_path, registry, source_png) -> None:
    """파일시스템 저장소이므로 인스턴스를 새로 만들어도 남아 있어야 한다."""
    root = tmp_path / "assets"
    result, _ = run_graph(pipeline_graph(source_png), registry, FileAssetStore(root))
    digest = result.outputs["save"]["asset"].hash

    assert FileAssetStore(root).get(digest) is not None


# ------------------------------------------ 2. PNG 에서 워크플로가 복원된다


def test_saved_png_embeds_the_canonical_graph(tmp_path, registry, source_png) -> None:
    assets = FileAssetStore(tmp_path / "assets")
    graph = pipeline_graph(source_png)

    result, _ = run_graph(graph, registry, assets)

    data = assets.get(result.outputs["save"]["asset"].hash)
    chunks = read_text_chunks(data)
    assert WORKFLOW_KEY in chunks

    restored = parse_graph(chunks[WORKFLOW_KEY])
    assert str(restored.id) == GRAPH_ID
    assert set(restored.nodes) == {"load", "resize", "save"}
    # 링크까지 살아 있어야 재현 가능한 레시피다.
    assert tuple(restored.nodes["resize"].inputs["image"].ref) == ("load", "image")


def test_embedded_workflow_survives_non_ascii(tmp_path, registry, source_png) -> None:
    """`iTXt` 를 쓰는 이유 그 자체 — `tEXt` 였으면 여기서 깨진다."""
    assets = FileAssetStore(tmp_path / "assets")
    graph = pipeline_graph(source_png)
    graph["nodes"]["load"]["meta"] = {"title": "원본 불러오기", "notes": "한글 제목 ✓"}

    result, _ = run_graph(graph, registry, assets)

    chunks = read_text_chunks(assets.get(result.outputs["save"]["asset"].hash))
    assert json.loads(chunks[WORKFLOW_KEY])["nodes"]["load"]["meta"]["title"] == "원본 불러오기"


def test_embedding_can_be_turned_off(tmp_path, registry, source_png) -> None:
    assets = FileAssetStore(tmp_path / "assets")
    graph = pipeline_graph(source_png)
    graph["nodes"]["save"]["inputs"]["embed_workflow"] = False

    result, _ = run_graph(graph, registry, assets)

    chunks = read_text_chunks(assets.get(result.outputs["save"]["asset"].hash))
    assert WORKFLOW_KEY not in chunks


# -------------------------------------------------- 3. 캐시가 실제로 걸린다


def test_second_run_reports_cached_nodes(tmp_path, registry, source_png) -> None:
    """같은 그래프를 다시 돌리면 Load·Resize 는 `node.cached` 다.

    Save 는 `cacheable=False` 라 언제나 다시 돈다 — 저장은 부수효과다.
    """
    assets = FileAssetStore(tmp_path / "assets")
    cache = LRUCache()
    graph = pipeline_graph(source_png)

    _, first = run_graph(graph, registry, assets, cache=cache)
    _, second = run_graph(graph, registry, assets, cache=cache)

    assert first.node_ids(NodeCached) == []
    assert set(second.node_ids(NodeCached)) == {"load", "resize"}
    assert second.node_ids(NodeStarted) == ["save"]


def test_changing_an_input_reruns_only_downstream(tmp_path, registry, source_png) -> None:
    assets = FileAssetStore(tmp_path / "assets")
    cache = LRUCache()

    run_graph(pipeline_graph(source_png), registry, assets, cache=cache)
    _, second = run_graph(
        pipeline_graph(source_png, width=2, height=2), registry, assets, cache=cache
    )

    assert second.node_ids(NodeCached) == ["load"]  # Load 는 그대로
    assert set(second.node_ids(NodeStarted)) == {"resize", "save"}


# ------------------------------------------- 4. 프리뷰가 실제로 나간다


def test_preview_events_are_emitted_for_image_nodes(tmp_path, registry, source_png) -> None:
    """`NodeResult(preview=...)` → `node.preview`. M2 까지 여기서 버려졌다."""
    assets = FileAssetStore(tmp_path / "assets")

    _, sink = run_graph(pipeline_graph(source_png), registry, assets)

    previews = sink.of_type(NodePreview)
    assert {event.node_id for event in previews} == {"load", "resize", "save"}
    for event in previews:
        assert event.preview.kind in ("inline", "asset")


def test_preview_carries_pixel_dimensions(tmp_path, registry, source_png) -> None:
    """프론트가 이미지를 받기 전에 자리를 잡으려면 크기가 실려야 한다."""
    assets = FileAssetStore(tmp_path / "assets")

    _, sink = run_graph(pipeline_graph(source_png), registry, assets)

    by_node = {event.node_id: event.preview for event in sink.of_type(NodePreview)}
    resize_preview = by_node["resize"]
    width = resize_preview.width if resize_preview.kind == "inline" else resize_preview.asset.width
    assert width == 4


def test_output_reference_reuses_the_saved_asset(tmp_path, registry, source_png) -> None:
    """Save 가 넣은 에셋과 전송 참조가 같아야 한다 — PNG 를 두 번 만들지 않는다."""
    assets = FileAssetStore(tmp_path / "assets")

    result, _ = run_graph(pipeline_graph(source_png), registry, assets)

    ref = result.outputs["save"]["asset"]
    transported = result.references["save"][0]
    assert transported.asset is not None
    assert transported.asset.hash == ref.hash
    # 워크플로가 심긴 그 PNG 여야 한다.
    assert WORKFLOW_KEY in read_text_chunks(assets.get(transported.asset.hash))
