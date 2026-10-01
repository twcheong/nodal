"""M6.2 템플릿 3종 (roadmap.md M6 — "제품 광고 수준의 실제 워크플로").

세 템플릿은 세 축(이미지 입력 · diffusion · 중첩 서브그래프)에서 서로 갈린다
(claude/nodal-m6-2-kickoff.md). 이 파일은 그 갈림이 실제로 구조에 반영됐는지와,
완료 기준의 두 성질 — **재현**(같은 인자 → 같은 에셋 해시)과 **부분
재실행**(파라미터 하나만 바꾸면 바뀐 노드 하류만 재실행) — 을 검증한다.

`ad_backdrop` 과 `product_card` 는 CPU 로 끝까지 실행해 두 성질을 직접 증명한다.
`product_ad_scene` 은 구조(카탈로그·스키마·평탄화)만 이 파일에서 증명한다 —
`hf-internal-testing/tiny-sd-pipe` 의 VAE 는 `VAE_SCALE_FACTOR=8` 을 따르지 않는
tiny 픽스처라(`nodal_nodes_diffusion.nodes` 의 `_control_kwargs` 문서와 같은 한계),
diffusion 배경과 리사이즈된 제품의 크기가 여기서만 어긋난다. 실제 SDXL 은 8배
스케일을 지키므로 이 문제가 없다 — 그 확인은 M6.2b(원격 GPU)의 몫이다.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from PIL import Image as PILImage

import nodal_nodes_image
from nodal import (
    CancelToken,
    LRUCache,
    NodeCached,
    NodeRegistry,
    NullEventSink,
    RecordingEventSink,
    register_preview_encoder,
)
from nodal.preview import _ENCODERS
from nodal.subgraph import flatten
from nodal_server.assets import AssetStore
from nodal_server.queue import RunRecord
from nodal_server.templates import (
    CALL_NODE_ID,
    Template,
    build_call_graph,
    collect_results,
    load_catalog,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLES = REPO_ROOT / "examples" / "templates"
PRODUCT_CUTOUT = str(REPO_ROOT / "examples" / "sample_cutout.png")
BACKGROUND = str(REPO_ROOT / "examples" / "sample.png")

TINY_SD = "hf-internal-testing/tiny-sd-pipe"


@pytest.fixture
def catalog() -> Any:
    result = load_catalog(EXAMPLES)
    assert result.rejections == (), format(result.rejections)
    return result


@pytest.fixture
def image_preview_encoders() -> Iterator[None]:
    """core 테스트가 비운 전역 등록을 복구하되 이 테스트가 남기지는 않는다."""
    encoders = (nodal_nodes_image.encode_ndarray_preview, nodal_nodes_image.encode_mask_preview)
    added = [e for e in encoders if e not in _ENCODERS]
    for encoder in added:
        register_preview_encoder(encoder)
    try:
        yield
    finally:
        for encoder in added:
            if encoder in _ENCODERS:
                _ENCODERS.remove(encoder)


# --------------------------------------------------------------- 카탈로그 규약


def test_all_three_are_in_the_catalog(catalog: Any) -> None:
    ids = {t.id for t in catalog.templates}
    assert {"ad_backdrop", "product_card", "product_ad_scene"} <= ids


# ---------------------------------------------------------- ad_backdrop (평면)


@pytest.fixture
def ad_backdrop(catalog: Any) -> Template:
    template = catalog.get("ad_backdrop")
    assert template is not None
    return template


def test_ad_backdrop_has_no_image_input(ad_backdrop: Template) -> None:
    """축: 이미지 입력 없음. `Image` 타입 파라미터가 하나도 없어야 한다."""
    assert "product" not in ad_backdrop.input_schema["properties"]
    assert all(
        "image" not in (prop.get("description") or "").lower() or name != "product"
        for name, prop in ad_backdrop.input_schema["properties"].items()
    )


def test_ad_backdrop_flattens_flat(ad_backdrop: Template) -> None:
    """축: 중첩 없음. `call:<노드>` 한 단계뿐이고 더 깊은 접두가 없다."""
    graph = build_call_graph(ad_backdrop, {"prompt": "x", "ckpt": "tiny"})
    result = flatten(graph, (CALL_NODE_ID,))
    assert result.issues == ()
    assert all(not n.type.startswith("subgraph.") for n in result.graph.nodes.values())
    assert sorted(result.graph.nodes) == [
        "call:canvas",
        "call:decode",
        "call:load",
        "call:negative",
        "call:positive",
        "call:sample",
        "call:save",
    ]


# -------------------------------------------------------- product_card (재사용)


@pytest.fixture
def product_card(catalog: Any) -> Template:
    template = catalog.get("product_card")
    assert template is not None
    return template


def test_product_card_has_no_diffusion_and_no_seed(product_card: Template) -> None:
    """축: diffusion 없음. 시드도 없다 — 순수 이미지 파이프라인이라 노출할 것이 없다."""
    assert product_card.seed_params == ()
    assert "시드를 노출하지 않는다" in product_card.describe()


def test_product_card_flattens_with_reused_subgraph_instances(product_card: Template) -> None:
    """축: 중첩 있음, **재사용**. 같은 `fit_layer` 정의가 `bg` · `fg` 두 인스턴스로
    갈라져 서로 다른 ID 를 받는다 — thumbnail 의 단일 인스턴스 중첩과 다른 경로다."""
    graph = build_call_graph(
        product_card,
        {"product": PRODUCT_CUTOUT, "background": BACKGROUND, "width": 300, "height": 200},
    )
    result = flatten(graph, (CALL_NODE_ID,))
    assert result.issues == ()
    assert all(not n.type.startswith("subgraph.") for n in result.graph.nodes.values())
    nodes = set(result.graph.nodes)
    assert {"input:background", "call:bg:fit", "input:product", "call:fg:fit"} <= nodes
    # 같은 정의에서 나왔어도 인자는 각자 것이다.
    assert result.graph.nodes["input:background"].inputs["path"] == BACKGROUND
    assert result.graph.nodes["input:product"].inputs["path"] == PRODUCT_CUTOUT


async def _execute_product_card(
    product_card: Template,
    arguments: dict[str, Any],
    *,
    assets: AssetStore,
    cache: LRUCache,
    events: Any = None,
) -> tuple[str, bytes, set[str]]:
    from nodal import execute

    graph = build_call_graph(product_card, arguments)
    result = await execute(
        graph,
        graph.outputs,
        registry=nodal_nodes_image.registry(),
        cache=cache,
        events=events if events is not None else NullEventSink(),
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
    reference = collect_results(product_card, record)["image"]
    assert reference.asset is not None
    data = assets.get(reference.asset.hash)
    assert data is not None
    return reference.asset.hash, data, set(result.executed)


async def test_product_card_executes_end_to_end(
    product_card: Template, image_preview_encoders: None
) -> None:
    """M6.2a 증거 — diffusion·GPU 없이, 새 노드 조합(Mask + Composite)이 실행 엔진을
    통과한다. 이 조합이 실행 엔진을 지나간 첫 사례라 `image.Mask` 프리뷰 인코더
    누락이 여기서 처음 드러났다 (`nodal_nodes_image` 수정으로 닫았다)."""
    _, data, _ = await _execute_product_card(
        product_card,
        {"product": PRODUCT_CUTOUT, "background": BACKGROUND, "width": 300, "height": 200},
        assets=AssetStore(),
        cache=LRUCache(64),
    )
    with PILImage.open(io.BytesIO(data)) as image:
        assert image.format == "PNG"
        assert image.size == (300, 200)


async def test_product_card_same_arguments_reproduce(
    product_card: Template, image_preview_encoders: None
) -> None:
    """완료 기준 ① — 같은 인자로 다시 부르면 같은 그림(같은 에셋 해시)."""
    assets = AssetStore()
    cache = LRUCache(64)
    arguments = {"product": PRODUCT_CUTOUT, "background": BACKGROUND, "width": 200, "height": 200}

    first_hash, first_png, _ = await _execute_product_card(
        product_card, arguments, assets=assets, cache=cache
    )
    second_hash, second_png, _ = await _execute_product_card(
        product_card, arguments, assets=assets, cache=cache
    )

    assert second_hash == first_hash
    assert second_png == first_png


async def test_product_card_changing_background_reruns_only_that_branch(
    product_card: Template, image_preview_encoders: None, tmp_path: Path
) -> None:
    """완료 기준 ② — 파라미터 하나(`background`)만 바꾸면 그 하류만 재실행된다.

    `fg`(제품) 레이어는 `background` 를 참조하지 않으므로 두 번째 실행에서
    캐시 히트여야 한다 — `product_card` 가 같은 `fit_layer` 를 두 번 인스턴스화한
    것이 서로 독립적으로 캐시된다는 증거다.

    캐시 키는 노드 ID 가 아니라 **입력 시그니처** 기반이다(AGENTS.md 핵심 설계
    결정 5) — 그래서 새 배경은 그래프 어디에도 없던 값이어야 한다. 이미
    `product` 로 쓰인 `PRODUCT_CUTOUT` 을 배경으로도 쓰면 입력 래퍼의
    `image.Load{path: 같은 값}` 시그니처가 이미 캐시에 있어 `bg` 쪽도 조용히 캐시 히트가 되고,
    그것은 이 테스트가 증명하려는 것과 다른 이야기다.
    """
    new_background = tmp_path / "other_background.png"
    PILImage.new("RGB", (64, 64), (10, 20, 30)).save(new_background)

    assets = AssetStore()
    cache = LRUCache(64)
    base = {"product": PRODUCT_CUTOUT, "background": BACKGROUND, "width": 200, "height": 200}

    await _execute_product_card(product_card, base, assets=assets, cache=cache)

    events = RecordingEventSink()
    changed = dict(base, background=str(new_background))
    _, _, executed = await _execute_product_card(
        product_card, changed, assets=assets, cache=cache, events=events
    )

    cached = {e.node_id for e in events.events if isinstance(e, NodeCached)}
    assert {"input:product", "call:fg:fit"} <= cached
    assert "input:background" in executed
    assert "call:bg:fit" in executed
    assert "input:product" not in executed
    assert "call:fg:fit" not in executed


# ---------------------------------------------------- product_ad_scene (플래그십)


@pytest.fixture
def product_ad_scene(catalog: Any) -> Template:
    template = catalog.get("product_ad_scene")
    assert template is not None
    return template


def test_product_ad_scene_has_image_input_and_seed(product_ad_scene: Template) -> None:
    assert product_ad_scene.input_schema["properties"]["product"]["type"] == "string"
    assert product_ad_scene.seed_params == ("seed",)


def test_product_ad_scene_flattens_with_nested_diffusion_pipeline(
    product_ad_scene: Template,
) -> None:
    """축: 이미지 입력 + diffusion + 중첩(단일 인스턴스, diffusion 파이프라인 전체를 감싼다)."""
    graph = build_call_graph(
        product_ad_scene, {"product": PRODUCT_CUTOUT, "prompt": "x", "ckpt": "tiny"}
    )
    result = flatten(graph, (CALL_NODE_ID,))
    assert result.issues == ()
    assert all(not n.type.startswith("subgraph.") for n in result.graph.nodes.values())
    nodes = set(result.graph.nodes)
    assert {
        "call:backdrop:load",
        "call:backdrop:positive",
        "call:backdrop:negative",
        "call:backdrop:canvas",
        "call:backdrop:sample",
        "call:backdrop:decode",
        "input:product",
        "call:fit_product",
        "call:product_mask",
        "call:composite",
        "call:save",
    } == nodes


def test_product_ad_scene_backdrop_and_product_share_the_same_canvas_size(
    product_ad_scene: Template,
) -> None:
    """실제 SDXL(VAE_SCALE_FACTOR=8)에서 배경과 제품이 같은 크기로 합성된다는 것을
    구조로 증명한다 — `width`·`height` 가 diffusion 캔버스와 제품 리사이즈에 같은
    값으로 흘러간다. 픽셀 단위 실행 확인은 tiny 픽스처의 VAE 스케일이 8 이 아니라
    (`nodal_nodes_diffusion.nodes` 의 `_control_kwargs` 문서와 같은 한계) 여기서
    막힌다 — M6.2b(실제 SDXL)의 몫이다.
    """
    graph = build_call_graph(
        product_ad_scene,
        {"product": PRODUCT_CUTOUT, "prompt": "x", "ckpt": "tiny", "width": 768, "height": 640},
    )
    result = flatten(graph, (CALL_NODE_ID,))
    assert result.issues == ()
    assert result.graph.nodes["call:backdrop:canvas"].inputs["width"] == 768
    assert result.graph.nodes["call:backdrop:canvas"].inputs["height"] == 640
    assert result.graph.nodes["call:fit_product"].inputs["width"] == 768
    assert result.graph.nodes["call:fit_product"].inputs["height"] == 640


# --------------------------------------------------- diffusion 축 (ad_backdrop)


@pytest.fixture(scope="module")
def tiny_sd() -> object:
    """픽스처를 미리 받아 둔다. 못 받으면 이 축을 건너뛴다 (오프라인에서 빨갛게 하지 않는다).

    `import torch` 를 쓰지 않는다 — `packages/server` 는 torch import 가 금지다
    (`pyproject.toml` 의 banned-api, `packages/nodes-diffusion` 만 면제). torch 객체는
    fixture 안에서 `pytest.importorskip("torch")` 로 얻는다.
    """
    torch = pytest.importorskip("torch")
    diffusers = pytest.importorskip("diffusers")

    try:
        pipe = diffusers.DiffusionPipeline.from_pretrained(TINY_SD, torch_dtype=torch.float32)
    except Exception as exc:
        pytest.skip(f"{TINY_SD} 를 받을 수 없다 (네트워크?): {exc}")
    pipe.set_progress_bar_config(disable=True)
    return pipe


@pytest.fixture(autouse=True)
def _pin_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """`test_txt2img.py` 와 같은 이유 — 개발자의 하드웨어에 따라 결과가 갈리면 안 된다."""
    monkeypatch.setenv("NODAL_DEVICE", "cpu")


def _diffusion_registry() -> NodeRegistry:
    import nodal_nodes_diffusion

    registry = NodeRegistry()
    nodal_nodes_image.registry(into=registry)
    nodal_nodes_diffusion.registry(into=registry)
    return registry


async def _execute_ad_backdrop(
    ad_backdrop: Template,
    arguments: dict[str, Any],
    *,
    assets: AssetStore,
    cache: LRUCache,
    events: Any = None,
) -> tuple[str, set[str]]:
    from nodal import execute
    from nodal_nodes_diffusion.manager import ModelManager

    graph = build_call_graph(ad_backdrop, arguments)
    result = await execute(
        graph,
        graph.outputs,
        registry=_diffusion_registry(),
        cache=cache,
        events=events if events is not None else NullEventSink(),
        cancel_token=CancelToken(),
        assets=assets,
        models=ModelManager(),
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
    reference = collect_results(ad_backdrop, record)["image"]
    assert reference.asset is not None
    return reference.asset.hash, set(result.executed)


@pytest.mark.diffusion
async def test_ad_backdrop_executes_end_to_end(ad_backdrop: Template, tiny_sd: object) -> None:
    """M6.2a 증거 — MCP 표면(카탈로그 → 호출 그래프 → 실행)을 diffusion 으로 통과한다.
    가중치는 랜덤이라 그림의 의미는 검증하지 못한다 — 잡히는 것은 배선이다
    (`test_txt2img.py` 와 같은 한계)."""
    _, executed = await _execute_ad_backdrop(
        ad_backdrop,
        {"prompt": "a tiny test backdrop", "ckpt": TINY_SD, "width": 64, "height": 64, "steps": 2},
        assets=AssetStore(),
        cache=LRUCache(64),
    )
    assert {
        "call:load",
        "call:positive",
        "call:negative",
        "call:canvas",
        "call:sample",
        "call:decode",
        "call:save",
    } == executed


@pytest.mark.diffusion
async def test_ad_backdrop_same_seed_reproduces(ad_backdrop: Template, tiny_sd: object) -> None:
    """완료 기준 ① — diffusion 축에서도 같은 시드·같은 입력이면 같은 에셋 해시."""
    assets = AssetStore()
    cache = LRUCache(64)
    arguments = {
        "prompt": "a tiny test backdrop",
        "ckpt": TINY_SD,
        "width": 64,
        "height": 64,
        "steps": 2,
        "seed": 1234,
    }

    first_hash, _ = await _execute_ad_backdrop(ad_backdrop, arguments, assets=assets, cache=cache)
    second_hash, _ = await _execute_ad_backdrop(ad_backdrop, arguments, assets=assets, cache=cache)

    assert second_hash == first_hash


@pytest.mark.diffusion
async def test_ad_backdrop_changing_seed_reruns_only_downstream(
    ad_backdrop: Template, tiny_sd: object
) -> None:
    """완료 기준 ② — `test_changing_seed_reruns_only_downstream` 을 템플릿 계층에서
    다시 확인한다. `positive`·`negative`·`canvas` 는 시드를 안 쓰므로 캐시다.
    `load`(체크포인트)는 `cacheable=False` 라 실행 캐시 대상이 아니다 — 매번
    노드로는 다시 돌지만 `ModelManager` 의 로딩 캐시가 실제 재로드를 막는다
    (`nodes.py` 모듈 docstring, `test_txt2img.py` 와 같은 계약). `save` 도
    부수효과라 캐시하지 않는다."""
    assets = AssetStore()
    cache = LRUCache(64)
    base = {
        "prompt": "a tiny test backdrop",
        "ckpt": TINY_SD,
        "width": 64,
        "height": 64,
        "steps": 2,
        "seed": 1,
    }

    await _execute_ad_backdrop(ad_backdrop, base, assets=assets, cache=cache)

    events = RecordingEventSink()
    changed = dict(base, seed=2)
    _, executed = await _execute_ad_backdrop(
        ad_backdrop, changed, assets=assets, cache=cache, events=events
    )

    cached = {e.node_id for e in events.events if isinstance(e, NodeCached)}
    assert {"call:positive", "call:negative", "call:canvas"} <= cached
    assert executed == {"call:load", "call:sample", "call:decode", "call:save"}
