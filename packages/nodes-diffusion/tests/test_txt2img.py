"""txt2img 전 경로를 tiny 체크포인트로 CPU 에서 돌린다 (roadmap M4 검증).

**노드를 하나씩 부르지 않고 그래프를 실행한다.** 이 마일스톤의 위험은 노드
하나가 틀리는 것이 아니라 **다섯 노드를 이었을 때 배선이 어긋나는 것**이다 —
캐시 키 · 취소 · 프리뷰가 겹치는 자리이기도 하다 (AGENTS.md 테스트 원칙).
"""

from __future__ import annotations

import numpy as np
import pytest

from nodal import (
    CancelToken,
    LRUCache,
    NodeCached,
    NodePreview,
    NodeProgress,
    NodeRegistry,
    NullCache,
    RecordingEventSink,
    execute,
    parse_graph,
)

pytest.importorskip("torch")
pytest.importorskip("diffusers")

# 프리뷰 인코더를 등록하기 위해 import 한다. 실제 배포에서도 두 팩이 함께
# 올라간다 (`DEFAULT_OPTIONAL_PACKS`). 이것이 없으면 스텝 프리뷰는 **조용히
# 생략되고** 생성은 정상적으로 끝난다 (design.md §9.5).
import nodal_nodes_image  # noqa: F401
from nodal_nodes_diffusion import registry
from nodal_nodes_diffusion.manager import ModelManager

#: tiny 픽스처 (design.md §9.7). 채널 수만 32/64 로 줄인 **진짜**
#: `UNet2DConditionModel` + `AutoencoderKL` 이라 스케줄러 루프 · cross-attention ·
#: `scaling_factor` 가 실제로 돈다. 가중치는 랜덤이라 **출력의 의미는 검증하지
#: 못한다** — 잡히는 것은 배선 · shape · 캐시 · 취소 · 프리뷰 경로다.
TINY_SD = "hf-internal-testing/tiny-sd-pipe"
TINY_SDXL = "hf-internal-testing/tiny-sdxl-pipe"


def _fetch(repo: str) -> object:
    """픽스처를 미리 받아 둔다. 못 받으면 건너뛴다 (오프라인 CI 를 빨갛게 하지 않는다)."""
    import torch
    from diffusers import DiffusionPipeline

    try:
        pipe = DiffusionPipeline.from_pretrained(repo, torch_dtype=torch.float32)
    except Exception as exc:
        pytest.skip(f"{repo} 를 받을 수 없다 (네트워크?): {exc}")
    pipe.set_progress_bar_config(disable=True)
    return pipe


@pytest.fixture(scope="session")
def tiny_sd() -> object:
    return _fetch(TINY_SD)


@pytest.fixture(scope="session")
def tiny_sdxl() -> object:
    return _fetch(TINY_SDXL)


@pytest.fixture(autouse=True)
def _pin_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """이 모듈의 `ModelManager()` 는 정책 없이 만들어져 환경변수를 읽는다.

    맥에서 개발하고 GPU 는 별도 장비인 환경에서, 테스트가 개발자의 하드웨어에
    따라 다르게 도는 것이 가장 나쁘다. CI 의 diffusion 잡도 같은 값을 쓴다.

    이것을 `conftest.py` 에 두지 않는 이유: 이 디렉토리에 `__init__.py` 가
    없어서(core 의 `tests` 패키지와 이름이 충돌한다) `conftest` 라는 모듈
    이름이 `packages/server/tests/conftest.py` 와 sys.path 에서 부딪힌다.
    실제로 서버 테스트 수집이 깨지는 것을 확인하고 여기로 옮겼다.
    """
    monkeypatch.setenv("NODAL_DEVICE", "cpu")


def _graph(repo: str, *, steps: int = 3, size: int = 128, seed: int = 7) -> dict:
    """txt2img 그래프 하나. 다섯 노드가 전부 들어간다."""
    return {
        "nodal_version": "1",
        "nodes": {
            "ckpt": {"type": "diffusion.LoadCheckpoint", "inputs": {"ckpt": repo}},
            "pos": {
                "type": "diffusion.CLIPTextEncode",
                "inputs": {
                    "clip": {"$link": ["ckpt", "clip"]},
                    "text": "a photo of a cat",
                },
            },
            "neg": {
                "type": "diffusion.CLIPTextEncode",
                "inputs": {"clip": {"$link": ["ckpt", "clip"]}, "text": "blurry"},
            },
            "empty": {
                "type": "diffusion.EmptyLatent",
                "inputs": {"width": size, "height": size, "batch_size": 1},
            },
            "sample": {
                "type": "diffusion.KSampler",
                "inputs": {
                    "model": {"$link": ["ckpt", "model"]},
                    "positive": {"$link": ["pos", "conditioning"]},
                    "negative": {"$link": ["neg", "conditioning"]},
                    "latent": {"$link": ["empty", "latent"]},
                    "seed": seed,
                    "steps": steps,
                    "cfg": 7.0,
                    "sampler_name": "euler",
                    "scheduler": "normal",
                    "denoise": 1.0,
                },
            },
            "decode": {
                "type": "diffusion.VAEDecode",
                "inputs": {
                    "vae": {"$link": ["ckpt", "vae"]},
                    "latent": {"$link": ["sample", "latent"]},
                },
            },
        },
        "outputs": ["decode"],
    }


async def _run(graph: dict, *, cache=None, events=None, models=None, token=None, assets=None):
    """그래프를 실행한다.

    `assets` 가 필요한 이유: core 는 텐서 타입 출력에 프리뷰를 요구하고(M3),
    그 프리뷰는 실행별 저장소에 들어간다. 저장소가 없으면 `NullAssetStore` 가
    **명시적으로 실패한다** — 조용히 사라지는 것보다 낫다는 M3 의 결정이다.
    """
    from nodal_server.assets import AssetStore

    return await execute(
        parse_graph(graph),
        ["decode"],
        registry=registry(NodeRegistry()),
        cache=cache if cache is not None else NullCache(),
        events=events if events is not None else RecordingEventSink(),
        cancel_token=token if token is not None else CancelToken(),
        models=models if models is not None else ModelManager(),
        assets=assets if assets is not None else AssetStore(),
    )


# ------------------------------------------------------------------ 전 경로


@pytest.mark.parametrize("repo", [TINY_SD, TINY_SDXL])
async def test_txt2img_runs_end_to_end(repo, tiny_sd, tiny_sdxl):
    # 픽스처는 받아두기 위한 것 — 파이프라인 자체는 ModelManager 가 다시 연다.
    result = await _run(_graph(repo))

    image = result.outputs["decode"]["image"]
    assert isinstance(image, np.ndarray)
    # §4.4 이미지 계약: (B, H, W, C) float32 0..1
    assert image.ndim == 4
    assert image.shape[0] == 1
    assert image.shape[3] in (3, 4)
    assert image.dtype == np.float32
    assert float(image.min()) >= 0.0 and float(image.max()) <= 1.0

    assert set(result.executed) == {"ckpt", "pos", "neg", "empty", "sample", "decode"}


async def test_same_seed_gives_the_same_image(tiny_sd):
    """시드가 재현성을 준다 — 이것이 깨지면 시드 위젯이 의미를 잃는다."""
    first = await _run(_graph(TINY_SD, seed=1234))
    second = await _run(_graph(TINY_SD, seed=1234))
    np.testing.assert_allclose(
        first.outputs["decode"]["image"], second.outputs["decode"]["image"], atol=1e-5
    )


async def test_different_seed_gives_a_different_image(tiny_sd):
    first = await _run(_graph(TINY_SD, seed=1))
    second = await _run(_graph(TINY_SD, seed=2))
    assert not np.allclose(
        first.outputs["decode"]["image"], second.outputs["decode"]["image"], atol=1e-4
    )


# -------------------------------------------------------------------- 캐시


async def test_changing_seed_reruns_only_downstream(tiny_sd):
    """M1 완료 기준을 diffusion 그래프에서 다시 확인한다.

    시드만 바꾸면 `ckpt` · `pos` · `neg` · `empty` 는 캐시고 `sample` · `decode`
    만 다시 돈다. 이 성질이 깨지면 슬라이더 하나 움직일 때마다 체크포인트가
    다시 로드된다.
    """
    cache = LRUCache(64)
    models = ModelManager()

    await _run(_graph(TINY_SD, seed=1), cache=cache, models=models)

    events = RecordingEventSink()
    second = await _run(_graph(TINY_SD, seed=2), cache=cache, events=events, models=models)

    cached = {e.node_id for e in events.events if isinstance(e, NodeCached)}
    assert {"ckpt", "pos", "neg", "empty"} <= cached
    assert set(second.executed) == {"sample", "decode"}


async def test_identical_graph_is_fully_cached(tiny_sd):
    cache = LRUCache(64)
    models = ModelManager()
    await _run(_graph(TINY_SD), cache=cache, models=models)
    second = await _run(_graph(TINY_SD), cache=cache, models=models)
    assert second.executed == ()
    assert len(second.cached) == 6


# ------------------------------------------------------------------ 프리뷰


async def test_step_preview_streams_on_the_m3_path(tiny_sd):
    """스텝 프리뷰가 `node.preview` 로 나간다 — 새 전송 형식 없이 (design.md §9.5).

    페이로드는 M3 의 `kind: "inline"` 그대로여야 한다. 프론트가 스텝 프리뷰를
    위해 새로 다룰 형식이 없다는 것이 이 커밋의 약속이다.
    """
    events = RecordingEventSink()
    await _run(_graph(TINY_SD, steps=4), events=events)

    progress = [e for e in events.events if isinstance(e, NodeProgress)]
    previews = [e for e in events.events if isinstance(e, NodePreview)]

    assert [e.node_id for e in progress].count("sample") == 4
    sampler_previews = [e for e in previews if e.node_id == "sample"]
    assert sampler_previews, "샘플러가 프리뷰를 하나도 내지 않았다"
    assert sampler_previews[0].preview.kind == "inline"
    assert sampler_previews[0].preview.data_uri.startswith("data:image/")


async def test_preview_failure_does_not_kill_the_run(tiny_sd, monkeypatch):
    """프리뷰가 터져도 생성은 끝난다. 앞뒤가 바뀌면 안 된다."""
    from nodal_nodes_diffusion import latent as latent_module

    def boom(*_args, **_kwargs):
        raise RuntimeError("프리뷰 인코더가 터졌다")

    monkeypatch.setattr(latent_module, "_shrink", boom)
    result = await _run(_graph(TINY_SD, steps=2))
    assert result.outputs["decode"]["image"] is not None


# -------------------------------------------------------------------- 취소


async def test_cancel_stops_mid_sampling(tiny_sd):
    """취소가 **실행 중인 샘플러 안까지** 닿는다.

    스텝 콜백이 `ctx.raise_if_cancelled()` 를 부르지 않으면, 취소해도 20 스텝을
    다 돌고 나서야 멈춘다 — 사용자에게는 취소가 동작하지 않는 것으로 보인다.
    """
    token = CancelToken()
    events = RecordingEventSink()

    class CancelAfterFirstStep(RecordingEventSink):
        def emit(self, event) -> None:
            super().emit(event)
            if isinstance(event, NodeProgress) and event.node_id == "sample":
                token.cancel()

    sink = CancelAfterFirstStep()
    from nodal import Cancelled

    with pytest.raises(Cancelled):
        await _run(_graph(TINY_SD, steps=20), events=sink, token=token)

    steps = [e for e in sink.events if isinstance(e, NodeProgress) and e.node_id == "sample"]
    assert len(steps) < 20, "취소가 스텝 루프 안까지 닿지 않았다"
    assert events.events == []
