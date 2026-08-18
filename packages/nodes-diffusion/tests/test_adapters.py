"""LoRA 와 ControlNet — 핸들과 노드 수준의 성질.

결과 픽셀까지 보는 검증은 `test_output_differs.py` 에 있다. 여기는 그 아래
층이다: 핸들이 무엇을 들고 나가는지, 공유 파이프라인이 어떤 상태로 남는지.

## LoRA 픽스처를 왜 만들어 쓰는가

`hf-internal-testing` 에 tiny LoRA 가 있을 법한 이름을 여럿 찔러봤지만 없었고,
그 조직은 목록 API 가 막혀 있어 이름을 알아낼 방법이 없다. 그래서 **테스트가
직접 만든다** (`tiny_fixtures.write_tiny_lora`) — 네트워크에 의존하지 않고,
upstream 이 픽스처를 바꿔도 흔들리지 않는다. 그 함수는 `lora_B` 까지 채우므로
**효과가 실제로 있는** LoRA 다. 그것이 아래 forward 비교의 전제다.
"""

from __future__ import annotations

import pytest

pytest.importorskip("torch")
pytest.importorskip("diffusers")
pytest.importorskip("peft")

from tiny_fixtures import unet_probe, write_tiny_lora

from nodal import NodeRegistry
from nodal_nodes_diffusion import registry, scanner
from nodal_nodes_diffusion.devices import DevicePolicy
from nodal_nodes_diffusion.handles import Adapter, ConditioningHandle, ControlNetHandle
from nodal_nodes_diffusion.manager import ModelManager
from nodal_nodes_diffusion.nodes import ControlNetApply, LoraLoader

TINY_SD = "hf-internal-testing/tiny-sd-pipe"


@pytest.fixture
def lora_dir(tmp_path, monkeypatch):
    """효과가 있는 tiny LoRA 를 `models/loras/` 배치에 놓는다."""
    write_tiny_lora(tmp_path)
    monkeypatch.setattr(scanner, "_root", tmp_path)
    return tmp_path


class _Ctx:
    """`ctx` 최소 더블. 노드가 쓰는 것은 `models` 뿐이다."""

    def __init__(self, models: ModelManager) -> None:
        self.models = models


# -------------------------------------------------------------------- LoRA


def test_lora_is_scanned(lora_dir):
    assert "tiny.safetensors" in scanner.scan("loras")


def test_lora_loader_returns_new_handles(lora_dir):
    """**원본을 바꾸지 않고** 새 핸들을 준다.

    그래프는 DAG 라 한 체크포인트가 LoRA 있는 쪽과 없는 쪽으로 동시에 간다.
    """
    manager = ModelManager(policy=DevicePolicy("cpu"))
    ctx = _Ctx(manager)
    model = manager.load(TINY_SD)
    clip = manager.clip(TINY_SD)

    result = LoraLoader().run(
        model=model, clip=clip, lora_name="tiny.safetensors", strength=0.8, ctx=ctx
    )
    new_model, new_clip = result.values

    assert new_model is not model
    assert new_clip is not clip
    # 세기는 **핸들에** 실린다. 파이프라인에 얹는 것은 쓰는 순간이다.
    assert new_model.adapters == (Adapter("tiny_safetensors", 0.8),)
    assert new_clip.adapters == new_model.adapters
    # 원본 핸들은 그대로다 — 같은 체크포인트에서 갈라진 비-LoRA 분기의 근거.
    assert model.adapters == ()
    # 같은 체크포인트를 가리킨다 — 가중치를 두 벌 올리지 않는다.
    assert new_model.checkpoint is model.checkpoint


def test_lora_does_not_activate_on_the_shared_pipeline(lora_dir):
    """**얹는 것과 켜는 것을 분리했다** (M4 검증에서 나온 P1).

    `LoraLoader` 가 `set_adapters` 까지 해 버리면 같은 `LoadCheckpoint` 에서
    갈라진 비-LoRA 분기도 LoRA 로 샘플링한다. 노드가 끝난 뒤 파이프라인에는
    가중치만 올라와 있고 활성 어댑터는 없어야 한다.
    """
    import torch

    manager = ModelManager(policy=DevicePolicy("cpu"))
    ctx = _Ctx(manager)
    model = manager.load(TINY_SD)
    pipe = model.checkpoint.pipe
    before = unet_probe(pipe)

    LoraLoader().run(
        model=model,
        clip=manager.clip(TINY_SD),
        lora_name="tiny.safetensors",
        strength=1.0,
        ctx=ctx,
    )

    assert model.checkpoint.loaded == {"tiny_safetensors"}, "가중치는 올라와 있어야 한다"
    # 켜짐 여부는 **forward 로** 묻는다. `get_active_adapters()` 는
    # `disable_lora()` 뒤에도 이름을 계속 돌려주므로 판별에 쓸 수 없다.
    assert torch.allclose(before, unet_probe(pipe), atol=1e-6), (
        "LoraLoader 가 공유 파이프라인의 forward 를 바꿨다 — 비-LoRA 분기가 오염된다"
    )


def test_lora_changes_the_cache_id(lora_dir):
    """어댑터가 붙으면 캐시 키가 달라져야 한다.

    안 그러면 LoRA 를 얹어도 이전 결과가 캐시에서 나온다 — 사용자에게는
    "LoRA 가 동작하지 않는다" 로 보인다.
    """
    manager = ModelManager(policy=DevicePolicy("cpu"))
    ctx = _Ctx(manager)
    model = manager.load(TINY_SD)
    before = model.cache_id()

    result = LoraLoader().run(
        model=model,
        clip=manager.clip(TINY_SD),
        lora_name="tiny.safetensors",
        strength=1.0,
        ctx=ctx,
    )
    assert result.values[0].cache_id() != before


def test_missing_lora_names_the_architecture(lora_dir):
    """실패는 **어느 계열 체크포인트인지** 말한다. LoRA 불일치가 가장 흔한 원인이다."""
    manager = ModelManager(policy=DevicePolicy("cpu"))
    ctx = _Ctx(manager)

    with pytest.raises(RuntimeError) as caught:
        LoraLoader().run(
            model=manager.load(TINY_SD),
            clip=manager.clip(TINY_SD),
            lora_name="does-not-exist.safetensors",
            strength=1.0,
            ctx=ctx,
        )
    message = str(caught.value)
    assert "does-not-exist.safetensors" in message
    assert "StableDiffusionPipeline" in message


# --------------------------------------------------------------- ControlNet


def _conditioning() -> ConditioningHandle:
    import torch

    return ConditioningHandle(embeds=torch.zeros(1, 4, 8), text="x", source="test")


def _control(plan) -> ControlNetHandle:
    return ControlNetHandle(model=object(), ref="tiny-controlnet", plan=plan)


def test_control_apply_does_not_mutate_the_input():
    """같은 프롬프트를 ControlNet 있는 쪽과 없는 쪽에 나눠 쓸 수 있어야 한다."""
    import numpy as np

    manager = ModelManager(policy=DevicePolicy("cpu"))
    conditioning = _conditioning()
    control = _control(manager.plan)
    image = np.zeros((1, 8, 8, 3), dtype=np.float32)

    applied = (
        ControlNetApply()
        .run(
            conditioning=conditioning,
            control_net=control,
            image=image,
            strength=0.5,
            start_percent=0.0,
            end_percent=0.8,
        )
        .values[0]
    )

    assert applied is not control
    assert control.hint is None, "원본 ControlNet 핸들이 바뀌었다"
    assert applied.strength == 0.5
    assert applied.window == (0.0, 0.8)
    assert applied.conditioning is conditioning
    # 이미지 계약 (B,H,W,C) → torch 의 (B,C,H,W)
    assert tuple(applied.hint.shape) == (1, 3, 8, 8)


def test_empty_window_fails_instead_of_doing_nothing():
    import numpy as np

    manager = ModelManager(policy=DevicePolicy("cpu"))
    with pytest.raises(ValueError, match="적용 구간이 비어 있으면"):
        ControlNetApply().run(
            conditioning=_conditioning(),
            control_net=_control(manager.plan),
            image=np.zeros((1, 8, 8, 3), dtype=np.float32),
            strength=1.0,
            start_percent=0.9,
            end_percent=0.1,
        )


def test_controlnet_straight_into_ksampler_is_caught():
    """`ControlNetApply` 를 거치지 않고 로더 출력을 바로 꽂으면 그렇게 말한다."""
    from nodal_nodes_diffusion.nodes import _split_control

    manager = ModelManager(policy=DevicePolicy("cpu"))
    with pytest.raises(ValueError, match="ControlNetApply 를 거치지 않고"):
        _split_control(_control(manager.plan))


def test_adapter_nodes_are_registered():
    ids = {s.id for s in registry(NodeRegistry())}
    assert {
        "diffusion.LoraLoader",
        "diffusion.ControlNetLoader",
        "diffusion.ControlNetApply",
    } <= ids
