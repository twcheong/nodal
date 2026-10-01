"""**결과가 실제로 달라지는가.**

M4 백엔드 검증에서 나온 가장 중요한 지적이 이것이다. 기존 테스트는 핸들이
만들어지는지 · 호출이 성공하는지만 봤고, 그래서 다음 두 버그가 전부 통과했다:

- `LoraLoader` 가 공유 파이프라인을 직접 바꿔 **비-LoRA 분기까지 오염**시켰다
- `ControlNetApply` 의 결과가 샘플링에 **아예 들어가지 않았다**
  (`control.model` 을 쓰는 곳이 0 곳이었다)

둘 다 "핸들이 생겼고 호출이 성공했다" 는 성립한다. 결과 픽셀을 보지 않으면
잡히지 않는다.

## 가중치가 랜덤인데 무엇을 검증할 수 있나

tiny 픽스처는 가중치가 랜덤이라 **그림의 의미**는 검증할 수 없다. 하지만
아래 세 가지는 의미와 무관하게 참이어야 한다:

- 같은 입력 → 같은 픽셀 (결정성)
- 디노이저에 실제로 얹힌 것이 바뀌면 → 다른 픽셀
- 얹히지 **않은** 분기는 → 옆 분기가 무엇을 하든 같은 픽셀

이 셋이 배선을 고정한다. 실제 가중치로 그럴듯한 그림이 나오는지는 사람이
NVIDIA 장비에서 본다 (`docs/dev.md`).
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("torch")
pytest.importorskip("diffusers")
pytest.importorskip("peft")

from tiny_fixtures import (
    TINY_SD,
    fetch_pipeline,
    non_lora_branch_graph,
    run_graph,
    txt2img_graph,
    write_hint_png,
    write_tiny_controlnet,
    write_tiny_lora,
)

from nodal_nodes_diffusion import scanner
from nodal_nodes_diffusion.manager import ModelManager

#: 픽셀 차이를 "달라졌다" 로 볼 문턱. float32 0..1 이미지에서 1e-3 이면
#: 8bit 로 내렸을 때 눈에 보이는 차이다. 부동소수점 잡음(1e-7 수준)과 확실히
#: 구분된다.
DIFFERENT = 1e-3


@pytest.fixture(autouse=True)
def _pin_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """정책 없이 만든 `ModelManager` 가 개발자의 하드웨어를 읽지 않게 한다."""
    monkeypatch.setenv("NODAL_DEVICE", "cpu")


@pytest.fixture(scope="session")
def _tiny_sd():
    """픽스처를 미리 받아 둔다. 못 받으면 이 모듈 전체를 건너뛴다."""
    return fetch_pipeline(TINY_SD)


@pytest.fixture
def models_root(tmp_path, monkeypatch):
    """LoRA 가 든 모델 루트. 스캐너가 이 디렉토리를 보게 한다."""
    write_tiny_lora(tmp_path)
    monkeypatch.setattr(scanner, "_root", tmp_path)
    return tmp_path


def _image(result, node: str = "decode") -> np.ndarray:
    image = result.outputs[node]["image"]
    assert isinstance(image, np.ndarray)
    return image


def _max_diff(a: np.ndarray, b: np.ndarray) -> float:
    assert a.shape == b.shape, f"모양이 다르면 픽셀 비교가 의미 없다: {a.shape} vs {b.shape}"
    return float(np.abs(a - b).max())


# -------------------------------------------------------------------- LoRA


async def test_lora_changes_the_image(_tiny_sd, models_root):
    """같은 시드에서 LoRA 를 얹으면 그림이 달라진다.

    이것이 실패하면 LoRA 경로가 **아무 일도 하지 않는 것**이다 — 핸들은 생기고
    노드는 성공하지만 디노이저에는 닿지 않은 상태. 픽셀을 보지 않으면 통과한다.
    """
    plain = await run_graph(txt2img_graph(TINY_SD, seed=99))
    lora = await run_graph(txt2img_graph(TINY_SD, seed=99, lora="tiny.safetensors"))

    assert _max_diff(_image(plain), _image(lora)) > DIFFERENT, (
        "LoRA 를 얹었는데 픽셀이 그대로다 — 어댑터가 디노이저에 적용되지 않았다"
    )


async def test_lora_strength_changes_the_image(_tiny_sd, models_root):
    """`strength` 가 결과에 반영된다.

    이 값은 M4 검증 시점에 **생성만 되고 읽히는 곳이 0 곳**이었다
    (`ModelHandle.lora_scale`). 지금은 `set_adapters(adapter_weights=...)` 로
    간다 — 그것이 사실인지 픽셀로 확인한다.
    """
    weak = await run_graph(
        txt2img_graph(TINY_SD, seed=99, lora="tiny.safetensors", lora_strength=0.1)
    )
    strong = await run_graph(
        txt2img_graph(TINY_SD, seed=99, lora="tiny.safetensors", lora_strength=1.0)
    )

    assert _max_diff(_image(weak), _image(strong)) > DIFFERENT, (
        "strength 를 바꿨는데 픽셀이 그대로다 — 세기가 어디에도 쓰이지 않는다"
    )


async def test_non_lora_branch_is_not_contaminated(_tiny_sd, models_root):
    """**오염 회귀 테스트.** 같은 `LoadCheckpoint` 에서 갈라진 비-LoRA 분기는
    옆 분기가 LoRA 를 얹든 말든 결과가 같아야 한다.

    이전 구현은 `LoraLoader` 가 공유 `checkpoint.pipe` 에 `set_adapters` 를
    걸어서, 실행 순서에 따라 비-LoRA 분기도 LoRA 로 샘플링됐다. 분기는
    독립이어야 한다 — 그것이 데이터흐름 그래프의 의미론이다.

    같은 실행 안에서 두 분기를 함께 돌리는 것이 요점이다. 따로 돌리면 파이프라인
    상태가 실행 사이에 초기화되어 버그가 숨는다.
    """
    baseline = _image(await run_graph(txt2img_graph(TINY_SD, seed=42)))

    both = await run_graph(non_lora_branch_graph(TINY_SD, "tiny.safetensors", seed=42))
    plain = _image(both, "decode")
    lora = _image(both, "decode_lora")

    assert _max_diff(baseline, plain) < DIFFERENT, (
        "옆 분기의 LoRA 가 비-LoRA 분기까지 바꿨다 — 공유 파이프라인이 오염됐다"
    )
    # 오염이 없다는 것을 "둘 다 아무 일도 없었다" 로 만족시키지 않기 위해,
    # LoRA 분기는 확실히 달라야 한다.
    assert _max_diff(plain, lora) > DIFFERENT, (
        "LoRA 분기도 같다 — 이 LoRA 는 효과가 없어서 오염 검사가 무의미하다"
    )


async def test_branch_order_does_not_change_the_result(_tiny_sd, models_root):
    """비-LoRA 분기의 결과가 **실행 순서에 의존하지 않는다.**

    오염 버그의 가장 나쁜 얼굴이 이것이다: 같은 그래프인데 어느 분기가 먼저
    도느냐에 따라 그림이 달라진다. 캐시 키는 그 차이를 모르므로 잘못된 캐시
    히트까지 따라온다.
    """
    graph = non_lora_branch_graph(TINY_SD, "tiny.safetensors", seed=7)

    lora_first = await run_graph(graph, outputs=["decode_lora", "decode"])
    plain_first = await run_graph(graph, outputs=["decode", "decode_lora"])

    assert _max_diff(_image(lora_first), _image(plain_first)) < DIFFERENT, (
        "출력 요청 순서가 비-LoRA 분기의 픽셀을 바꿨다"
    )


# --------------------------------------------------------------- ControlNet


@pytest.fixture
def controlnet_root(tmp_path, monkeypatch):
    """ControlNet 이 든 모델 루트. 스캐너 배치를 그대로 만든다."""
    write_tiny_controlnet(tmp_path)
    monkeypatch.setattr(scanner, "_root", tmp_path)
    return tmp_path


async def test_controlnet_is_scanned(controlnet_root):
    assert "tiny" in scanner.scan("controlnet")


async def test_controlnet_changes_the_image(_tiny_sd, controlnet_root, tmp_path):
    """ControlNet 을 적용하면 그림이 달라진다.

    M4 검증 시점에는 `ControlNetApply` 가 만든 핸들의 `model` 이 샘플링에
    **한 번도 쓰이지 않았다.** 노드는 성공하고 그래프도 돌지만 결과는 ControlNet
    이 없는 것과 완전히 같았다 — 정확히 이 테스트가 잡는 모양이다.
    """
    hint = write_hint_png(tmp_path / "hint.png", size=128)

    plain = await run_graph(txt2img_graph(TINY_SD, seed=5))
    controlled = await run_graph(
        txt2img_graph(TINY_SD, seed=5, control_net="tiny", control_hint=hint)
    )

    assert _max_diff(_image(plain), _image(controlled)) > DIFFERENT, (
        "ControlNet 을 붙였는데 픽셀이 그대로다 — control.model 이 샘플링에 들어가지 않았다"
    )


async def test_controlnet_strength_changes_the_image(_tiny_sd, controlnet_root, tmp_path):
    """`strength` 가 결과에 반영된다. 0 이면 안 붙인 것과 같아야 한다."""
    hint = write_hint_png(tmp_path / "hint.png", size=128)

    off = await run_graph(
        txt2img_graph(TINY_SD, seed=5, control_net="tiny", control_hint=hint, control_strength=0.0)
    )
    on = await run_graph(
        txt2img_graph(TINY_SD, seed=5, control_net="tiny", control_hint=hint, control_strength=1.0)
    )
    plain = await run_graph(txt2img_graph(TINY_SD, seed=5))

    assert _max_diff(_image(off), _image(on)) > DIFFERENT, "세기가 결과에 반영되지 않는다"
    assert _max_diff(_image(off), _image(plain)) < DIFFERENT, (
        "세기 0 인데 안 붙인 것과 다르다 — 붙이는 것 자체가 결과를 흔든다"
    )


async def test_controlnet_reuses_the_checkpoint_weights(_tiny_sd, controlnet_root, tmp_path):
    """ControlNet 을 붙여도 체크포인트가 다시 올라가지 않는다.

    파생 파이프라인(`from_pipe`)이 컴포넌트를 공유한다는 주장이 사실인지 본다.
    공유하지 않으면 ControlNet 을 쓸 때마다 UNet 이 한 벌 더 올라간다.
    """
    hint = write_hint_png(tmp_path / "hint.png", size=128)
    models = ModelManager()

    await run_graph(txt2img_graph(TINY_SD, seed=5), models=models)
    after_plain = models.loaded()

    await run_graph(
        txt2img_graph(TINY_SD, seed=5, control_net="tiny", control_hint=hint), models=models
    )

    # 늘어난 것은 ControlNet 항목 하나뿐이다 — 체크포인트는 그대로.
    added = [key for key in models.loaded() if key not in after_plain]
    assert len(added) == 1, f"체크포인트가 다시 올라갔다: {models.loaded()}"
    assert "controlnet" in added[0]
