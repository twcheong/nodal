"""`ModelManager` — 참조 카운팅 · LRU 언로드 · 에러 품질 (design.md §9.6).

로딩 자체보다 **메모리 관리의 판단**을 검사한다. "체크포인트가 두 벌 올라간다"
나 "쓰는 중인 모델을 내렸다" 는 GPU 에서만 드러나는 종류의 버그라, CPU 에서
관측 가능한 성질로 고정해 둔다.
"""

from __future__ import annotations

import pytest

from nodal.models import ModelLoadError

pytest.importorskip("torch")
pytest.importorskip("diffusers")

from nodal_nodes_diffusion.devices import DevicePolicy
from nodal_nodes_diffusion.manager import LOADERS, ModelManager

TINY_SD = "hf-internal-testing/tiny-sd-pipe"


@pytest.fixture
def manager() -> ModelManager:
    return ModelManager(policy=DevicePolicy("cpu"), capacity=1)


# ------------------------------------------------------------------ 공유 로딩


def test_three_views_share_one_pipeline(manager: ModelManager):
    """`LoadCheckpoint` 가 내는 세 핸들이 같은 체크포인트를 가리킨다.

    따로 로드하면 같은 가중치가 세 벌 올라간다 — tiny 에서는 안 보이지만
    SDXL 에서는 20 GB 다.
    """
    model = manager.load(TINY_SD)
    clip = manager.clip(TINY_SD)
    vae = manager.vae(TINY_SD)

    assert model.checkpoint is clip.checkpoint is vae.checkpoint
    assert len(manager.loaded()) == 1


def test_second_load_reuses_the_first(manager: ModelManager):
    first = manager.load(TINY_SD)
    second = manager.load(TINY_SD)
    assert first.checkpoint is second.checkpoint
    assert len(manager.loaded()) == 1


# --------------------------------------------------------------- 참조 카운팅


def test_in_use_while_a_handle_is_alive(manager: ModelManager):
    handle = manager.load(TINY_SD)
    assert manager.in_use() == manager.loaded()
    assert handle is not None  # 핸들을 살려 둔다


def test_release_unused_preserves_live_handles(manager: ModelManager):
    handle = manager.load(TINY_SD)
    manager.release_unused()
    assert len(manager.loaded()) == 1
    del handle
    manager.release_unused()
    assert manager.loaded() == ()


def test_not_in_use_after_handles_are_dropped(manager: ModelManager):
    import gc

    handle = manager.load(TINY_SD)
    del handle
    gc.collect()
    assert manager.in_use() == ()
    assert len(manager.loaded()) == 1  # 아직 캐시에는 있다


def test_eviction_skips_checkpoints_still_in_use(manager: ModelManager):
    """쓰는 중인 체크포인트를 내리지 않는다.

    상한이 1 인데 둘이 동시에 사용 중이면 **상한을 넘긴 채로 둔다**. 실행
    중인 그래프의 모델을 내리면 그 그래프가 깨지는데, 그것이 메모리를 아끼는
    것보다 나쁘다.
    """
    held = manager.load(TINY_SD)
    also_held = manager.load(TINY_SDXL_REF)

    assert len(manager.loaded()) == 2, "사용 중인데도 내렸다"
    assert also_held.checkpoint.ref == TINY_SDXL_REF
    assert held.checkpoint.ref == TINY_SD


def test_eviction_drops_the_unused_one(manager: ModelManager):
    import gc

    manager.load(TINY_SD)  # 핸들을 안 붙든다
    gc.collect()
    kept = manager.load(TINY_SDXL_REF)

    assert manager.loaded() == (f"diffusers.pretrained\x1f{TINY_SDXL_REF}",)
    assert kept.checkpoint.ref == TINY_SDXL_REF


TINY_SDXL_REF = "hf-internal-testing/tiny-sdxl-pipe"


# -------------------------------------------------------------------- 에러


def test_unknown_loader_says_what_it_knows(manager: ModelManager):
    with pytest.raises(ModelLoadError) as caught:
        manager.load(TINY_SD, loader="magic")
    assert caught.value.expected == LOADERS
    assert "magic" in str(caught.value)


def test_missing_folder_error_names_model_index(manager: ModelManager, tmp_path):
    """폴더 로더 실패는 **model_index.json 이 없다**고 말한다.

    "로드 실패" 라고만 하면 사용자는 경로가 틀린 것인지 포맷이 틀린 것인지
    구분할 수 없다 (design.md §9.2).
    """
    folder = tmp_path / "not-a-pipeline"
    folder.mkdir()
    (folder / "random.txt").write_text("x", encoding="utf-8")

    with pytest.raises(ModelLoadError) as caught:
        manager.load(str(folder))

    text = str(caught.value)
    assert "model_index.json" in text
    assert "single_file" in text  # 무엇을 대신 써야 하는지도 말한다


def test_single_file_error_reports_observed_tensor_keys(manager: ModelManager, tmp_path):
    """추론 실패는 **파일에서 실제로 본 것**을 싣는다.

    이것이 사용자가 "아 이건 그 모델이 아니구나" 를 판단할 유일한 재료다.
    """
    import torch
    from safetensors.torch import save_file

    path = tmp_path / "mystery.safetensors"
    save_file(
        {
            "wrong_prefix.layer0.weight": torch.zeros(2, 2),
            "wrong_prefix.layer1.weight": torch.zeros(2, 2),
            "other.thing": torch.zeros(1),
        },
        str(path),
    )

    with pytest.raises(ModelLoadError) as caught:
        manager.load(str(path), loader="diffusers.single_file")

    error = caught.value
    assert error.inferred is None, "추론에 실패했으면 None 이어야 한다"
    assert "추론된 아키텍처: 없음" in str(error)
    assert any("wrong_prefix" in e for e in error.evidence)
    assert any("텐서 3개" in e for e in error.evidence)


# ------------------------------------------------------------------- 계획


def test_plan_is_resolved_once_and_frozen(manager: ModelManager):
    first = manager.plan
    assert manager.plan is first
    assert first.compute.kind == "cpu"
    assert first.dtype == "float32"  # 능력 테이블의 cpu 기본값


def test_free_bytes_is_none_on_cpu(manager: ModelManager):
    # 물어볼 수 없는 백엔드에서 숫자를 지어내면 LRU 가 그것을 믿는다.
    assert manager.free_bytes() is None
