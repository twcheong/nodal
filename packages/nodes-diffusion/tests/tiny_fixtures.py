"""여러 테스트 모듈이 함께 쓰는 tiny 픽스처와 그래프 조립기.

`conftest.py` 가 아니라 평범한 모듈인 이유는 이 디렉토리에 `__init__.py` 가
없어서다 (core 의 `tests` 패키지와 이름이 충돌한다) — `packages/nodes-image/tests`
의 `preview_encoder_fixture.py` 와 같은 방식이다. `testpaths` 에 이 디렉토리가
있으므로 이름 그대로 import 된다.

## LoRA 픽스처가 **실제로 효과가 있어야** 한다

`init_lora_weights="gaussian"` 은 `lora_A` 만 랜덤이고 `lora_B` 는 **0** 이다.
LoRA 의 델타가 `B @ A` 이므로 그대로 저장하면 **아무 효과가 없는 LoRA** 가
나온다. 그것으로는 "LoRA 를 얹었더니 그림이 달라졌다" 를 검증할 수 없고,
오히려 오염 버그가 있어도 통과한다 — 두 분기가 똑같이 아무 일도 없기 때문이다.

그래서 `lora_B` 를 직접 채운다. 이것이 이 파일이 존재하는 가장 큰 이유다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

#: tiny 픽스처 (design.md §9.7). 채널 수만 줄인 **진짜** UNet + VAE 라
#: 스케줄러 루프 · cross-attention · `scaling_factor` 가 실제로 돈다.
#: 가중치가 랜덤이라 출력의 **의미**는 검증하지 못하지만, "같은 입력이면 같은
#: 픽셀 · 다른 입력이면 다른 픽셀" 은 의미와 무관하게 참이어야 한다.
TINY_SD = "hf-internal-testing/tiny-sd-pipe"
TINY_SDXL = "hf-internal-testing/tiny-sdxl-pipe"

#: LoRA 어댑터가 붙는 어텐션 프로젝션. tiny UNet 에도 전부 있다.
_LORA_TARGETS = ["to_q", "to_k", "to_v", "to_out.0"]


def fetch_pipeline(repo: str) -> Any:
    """픽스처를 미리 받아 둔다. 못 받으면 건너뛴다 (오프라인 CI 를 빨갛게 하지 않는다)."""
    import torch
    from diffusers import DiffusionPipeline

    try:
        pipe = DiffusionPipeline.from_pretrained(repo, torch_dtype=torch.float32)
    except Exception as exc:
        pytest.skip(f"{repo} 를 받을 수 없다 (네트워크?): {exc}")
    pipe.set_progress_bar_config(disable=True)
    return pipe


#: ControlNet 의 "제로 컨볼루션" — 학습 전에는 0 으로 초기화되어 있어서 잔차가
#: 정확히 0 이다. 픽스처를 만들 때 여기만 채운다.
_ZERO_CONV_PREFIXES = (
    "controlnet_cond_embedding.conv_out",
    "controlnet_down_blocks",
    "controlnet_mid_block",
)


def write_tiny_controlnet(models_root: Path, *, name: str = "tiny", seed: int = 0) -> Path:
    """`models_root/controlnet/<name>` 에 **효과가 있는** tiny ControlNet 을 쓴다.

    `hf-internal-testing/tiny-controlnet` 을 쓰지 않는 이유가 있다. 그 픽스처는
    제로 컨볼루션이 **전부 0** 이라 (확인함) 잔차가 정확히 0 이고, 따라서
    "적용해도 결과가 같다" 가 **버그가 없어도 참**이다 — ControlNet 배선을
    검증하려는 테스트를 조용히 무의미하게 만든다.

    그래서 체크포인트의 UNet 에서 직접 만들고(`from_unet` — 아키텍처가 반드시
    맞는다) 제로 컨볼루션만 채운다. LoRA 픽스처와 같은 이유·같은 방식이다.
    """
    import torch
    from diffusers import ControlNetModel

    pipe = fetch_pipeline(TINY_SD)
    control = ControlNetModel.from_unet(pipe.unet)

    generator = torch.Generator("cpu").manual_seed(seed)
    with torch.no_grad():
        for param_name, param in control.named_parameters():
            if param_name.startswith(_ZERO_CONV_PREFIXES):
                param.copy_(torch.randn(param.shape, generator=generator) * 0.1)

    target = models_root / "controlnet" / name
    control.save_pretrained(str(target))
    return target


def write_tiny_lora(models_root: Path, *, name: str = "tiny.safetensors", seed: int = 0) -> Path:
    """`models_root/loras/<name>` 에 **효과가 있는** tiny LoRA 를 쓴다.

    `hf-internal-testing` 에 tiny LoRA 가 없고 그 조직은 목록 API 가 막혀 있어
    이름을 알아낼 방법이 없다. 그래서 테스트가 직접 만든다 — 네트워크에
    의존하지 않고 upstream 이 픽스처를 바꿔도 흔들리지 않는다.

    Returns:
        쓴 파일 경로.
    """
    import torch
    from diffusers import StableDiffusionPipeline
    from diffusers.utils import convert_state_dict_to_diffusers
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict

    pipe = fetch_pipeline(TINY_SD)
    pipe.unet.add_adapter(
        LoraConfig(
            r=2,
            lora_alpha=2,
            init_lora_weights="gaussian",
            target_modules=_LORA_TARGETS,
        )
    )

    # `lora_B` 가 0 이면 델타(B @ A)도 0 이다 — 모듈 최상단 참고.
    generator = torch.Generator("cpu").manual_seed(seed)
    with torch.no_grad():
        for param_name, param in pipe.unet.named_parameters():
            if "lora_B" in param_name:
                param.copy_(torch.randn(param.shape, generator=generator) * 0.5)

    state = convert_state_dict_to_diffusers(get_peft_model_state_dict(pipe.unet))
    loras = models_root / "loras"
    loras.mkdir(parents=True, exist_ok=True)
    StableDiffusionPipeline.save_lora_weights(save_directory=str(loras), unet_lora_layers=state)

    written = loras / name
    written.write_bytes((loras / "pytorch_lora_weights.safetensors").read_bytes())
    return written


def unet_probe(pipe: Any) -> Any:
    """고정 입력으로 UNet 을 한 번 돌린 결과.

    "어댑터가 켜져 있나" 를 **동작으로** 묻는 방법이다. `get_active_adapters()`
    는 켜짐 여부와 무관하게 이름을 계속 돌려주므로 (`disable_lora()` 후에도
    그대로다 — 확인함) 그것으로는 판별할 수 없다. 실제로 중요한 것은 forward 가
    달라지는가이고, 그것만이 사용자가 보는 결과와 이어진다.
    """
    import torch

    unet = pipe.unet
    generator = torch.Generator("cpu").manual_seed(0)
    sample = torch.randn(1, unet.config.in_channels, 16, 16, generator=generator)
    hidden = torch.randn(1, 77, unet.config.cross_attention_dim, generator=generator)
    with torch.no_grad():
        return unet(sample, torch.tensor([10]), encoder_hidden_states=hidden).sample


def write_hint_png(path: Path, *, size: int = 128) -> Path:
    """ControlNet 힌트로 쓸 PNG 를 만든다.

    내용은 대각선 격자다. 균일한 색이면 ControlNet 이 거의 아무 신호도 주지
    않아 "적용/미적용이 다르다" 가 약해진다 — 눈에 보이는 구조가 있어야 한다.
    """
    import numpy as np
    from PIL import Image as PILImage

    grid = np.indices((size, size)).sum(axis=0) % 32 < 16
    pixels = np.repeat((grid * 255).astype(np.uint8)[:, :, None], 3, axis=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.fromarray(pixels).save(path)
    return path


# ------------------------------------------------------------------ 그래프


def txt2img_graph(
    repo: str,
    *,
    steps: int = 3,
    size: int = 128,
    seed: int = 7,
    lora: str | None = None,
    lora_strength: float = 1.0,
    control_net: str | None = None,
    control_hint: Path | None = None,
    control_strength: float = 1.0,
) -> dict[str, Any]:
    """txt2img 그래프 하나. LoRA · ControlNet 은 옵션이다.

    같은 조립기로 "있음/없음" 두 그래프를 만드는 것이 요점이다 — 시드 · 크기 ·
    스텝이 손으로 맞춰지지 않고 **같을 수밖에 없어야** 픽셀 비교가 의미를 갖는다.
    """
    nodes: dict[str, Any] = {
        "ckpt": {"type": "diffusion.LoadCheckpoint", "inputs": {"ckpt": repo}},
        "empty": {
            "type": "diffusion.EmptyLatent",
            "inputs": {"width": size, "height": size, "batch_size": 1},
        },
    }

    model_src: list[Any] = ["ckpt", "model"]
    clip_src: list[Any] = ["ckpt", "clip"]
    if lora is not None:
        nodes["lora"] = {
            "type": "diffusion.LoraLoader",
            "inputs": {
                "model": {"$link": ["ckpt", "model"]},
                "clip": {"$link": ["ckpt", "clip"]},
                "lora_name": lora,
                "strength": lora_strength,
            },
        }
        model_src, clip_src = ["lora", "model"], ["lora", "clip"]

    nodes["pos"] = {
        "type": "diffusion.CLIPTextEncode",
        "inputs": {"clip": {"$link": clip_src}, "text": "a photo of a cat"},
    }
    nodes["neg"] = {
        "type": "diffusion.CLIPTextEncode",
        "inputs": {"clip": {"$link": clip_src}, "text": "blurry"},
    }

    positive: list[Any] = ["pos", "conditioning"]
    if control_net is not None:
        if control_hint is None:
            raise ValueError("control_net 을 주면 control_hint 도 줘야 한다")
        nodes["hint"] = {"type": "image.Load", "inputs": {"path": str(control_hint)}}
        nodes["cnet"] = {
            "type": "diffusion.ControlNetLoader",
            "inputs": {"control_net_name": control_net},
        }
        nodes["apply"] = {
            "type": "diffusion.ControlNetApply",
            "inputs": {
                "conditioning": {"$link": ["pos", "conditioning"]},
                "control_net": {"$link": ["cnet", "control_net"]},
                "image": {"$link": ["hint", "image"]},
                "strength": control_strength,
                "start_percent": 0.0,
                "end_percent": 1.0,
            },
        }
        positive = ["apply", "conditioning"]

    nodes["sample"] = {
        "type": "diffusion.KSampler",
        "inputs": {
            "model": {"$link": model_src},
            "positive": {"$link": positive},
            "negative": {"$link": ["neg", "conditioning"]},
            "latent": {"$link": ["empty", "latent"]},
            "seed": seed,
            "steps": steps,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    nodes["decode"] = {
        "type": "diffusion.VAEDecode",
        "inputs": {
            "vae": {"$link": ["ckpt", "vae"]},
            "latent": {"$link": ["sample", "latent"]},
        },
    }
    return {"nodal_version": "1", "nodes": nodes, "outputs": ["decode"]}


def non_lora_branch_graph(repo: str, lora: str, *, steps: int = 3, size: int = 128, seed: int = 7):
    """**한 `LoadCheckpoint` 에서 LoRA 분기와 비-LoRA 분기가 함께 나가는** 그래프.

    오염 회귀 테스트의 핵심 모양이다. `decode` 는 비-LoRA 쪽만 내보내지만
    LoRA 분기도 같은 실행에서 돌아야 하므로, 두 번째 출력(`decode_lora`)을
    함께 요청해 실행을 강제한다.
    """
    graph = txt2img_graph(repo, steps=steps, size=size, seed=seed)
    nodes = graph["nodes"]

    nodes["lora"] = {
        "type": "diffusion.LoraLoader",
        "inputs": {
            "model": {"$link": ["ckpt", "model"]},
            "clip": {"$link": ["ckpt", "clip"]},
            "lora_name": lora,
            "strength": 1.0,
        },
    }
    nodes["pos_lora"] = {
        "type": "diffusion.CLIPTextEncode",
        "inputs": {"clip": {"$link": ["lora", "clip"]}, "text": "a photo of a cat"},
    }
    nodes["neg_lora"] = {
        "type": "diffusion.CLIPTextEncode",
        "inputs": {"clip": {"$link": ["lora", "clip"]}, "text": "blurry"},
    }
    nodes["sample_lora"] = {
        "type": "diffusion.KSampler",
        "inputs": {
            **nodes["sample"]["inputs"],
            "model": {"$link": ["lora", "model"]},
            "positive": {"$link": ["pos_lora", "conditioning"]},
            "negative": {"$link": ["neg_lora", "conditioning"]},
        },
    }
    nodes["decode_lora"] = {
        "type": "diffusion.VAEDecode",
        "inputs": {
            "vae": {"$link": ["ckpt", "vae"]},
            "latent": {"$link": ["sample_lora", "latent"]},
        },
    }
    graph["outputs"] = ["decode", "decode_lora"]
    return graph


async def run_graph(
    graph: dict[str, Any],
    *,
    outputs: list[str] | None = None,
    cache: Any = None,
    events: Any = None,
    models: Any = None,
    token: Any = None,
    assets: Any = None,
) -> Any:
    """그래프를 실행한다.

    `assets` 가 필요한 이유: core 는 텐서 타입 출력에 프리뷰를 요구하고(M3),
    그 프리뷰는 실행별 저장소에 들어간다.
    """
    from nodal import CancelToken, NullCache, RecordingEventSink, execute, parse_graph
    from nodal_nodes_diffusion.manager import ModelManager
    from nodal_server.assets import AssetStore

    parsed = parse_graph(graph)
    return await execute(
        parsed,
        outputs if outputs is not None else list(parsed.outputs),
        registry=_registry(),
        cache=cache if cache is not None else NullCache(),
        events=events if events is not None else RecordingEventSink(),
        cancel_token=token if token is not None else CancelToken(),
        models=models if models is not None else ModelManager(),
        assets=assets if assets is not None else AssetStore(),
    )


def _registry() -> Any:
    """diffusion + image 노드가 함께 든 레지스트리.

    ControlNet 힌트 이미지를 만들려면 image 팩의 노드가 필요하다. 배포에서도
    두 팩이 함께 올라간다 (`DEFAULT_OPTIONAL_PACKS`).
    """
    from nodal import NodeRegistry
    from nodal_nodes_diffusion import registry as diffusion_registry
    from nodal_nodes_image import registry as image_registry

    return diffusion_registry(image_registry(NodeRegistry()))
