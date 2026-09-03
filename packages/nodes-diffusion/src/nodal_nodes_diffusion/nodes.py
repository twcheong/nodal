"""diffusion 노드 (roadmap M4).

## 모듈 최상단에서 torch 를 import 하지 않는다

이 팩은 **언제나 설치되고**(스키마 노출) torch 는 옵트인이다. 최상단에서
import 하면 `uv sync` 만 한 사람의 서버가 이 팩을 못 읽어 팔레트에서 노드가
통째로 사라진다.

그래서 `run` 안에서 늦게 import 하고, 없으면 **무엇을 해야 하는지 말하는**
에러를 낸다. `devices.py` 가 같은 규칙을 따른다.

## 샘플링은 diffusers 파이프라인에 위임한다

디노이징 루프를 직접 쓰지 않는다. 파이프라인이 `prompt_embeds` · `latents` ·
`generator` · `callback_on_step_end` · `output_type="latent"` 를 전부 받으므로,
우리가 할 일은 **소켓을 그 인자에 붙이는 것**뿐이다 (`design.md` §0 전략).

SD1.5 와 SDXL 의 차이는 `encode_prompt` 의 반환 개수(2 vs 4)로 드러난다.
파이프라인 클래스 이름으로 분기하지 않는다 — 새 아키텍처가 오면 이름이 늘지만
반환 개수 규칙은 그대로다.

## 로더 노드는 캐시하지 않는다 (`cacheable=False`)

`LoadCheckpoint` · `LoraLoader` · `ControlNetLoader` 의 출력은 수 GB 짜리 모델
핸들이다. M1 의 실행 캐시(`LRUCache`)는 값싼 결과를 담을 생각으로 만들었고
핸들을 **강하게** 붙든다 — 그러면 `ModelManager` 의 약한 참조 계산이 영영 0 이
되지 않아 `capacity` 가 무의미해지고, 실제 GPU 에서는 그것이 OOM 경로다.

로더를 캐시에서 빼도 느려지지 않는다. 재실행은 `ModelManager` 의 딕셔너리
조회 한 번이고, 실제 로딩 캐시는 거기 있다. 하위 노드(`KSampler` 등)의 캐시
키는 그래프 구조에서 계산되므로 로더가 캐시되든 말든 그대로 맞는다.

## 파이프라인 전역 상태는 **쓰는 순간에만** 얹는다

LoRA 어댑터는 파이프라인 하나에 붙는 전역 상태다. `LoraLoader` 가 그것을 켜
버리면 같은 `LoadCheckpoint` 에서 갈라진 **비-LoRA 분기까지** LoRA 가 적용된다.
그래서 어댑터는 핸들이 들고 다니고(`handles.py`), 파이프라인을 실제로 부르는
노드가 `_adapters_applied` 안에서 그 순간에만 활성화한다.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from nodal import (
    CLIP,
    VAE,
    Combo,
    Conditioning,
    Float,
    Image,
    Int,
    Latent,
    Model,
    NodeContext,
    NodeResult,
    Seed,
    Str,
    node,
)

from .handles import (
    Adapter,
    Checkpoint,
    ClipHandle,
    ConditioningHandle,
    ControlNetHandle,
    ModelHandle,
    VaeHandle,
    with_adapter,
)
from .latent import (
    LATENT_CHANNELS,
    VAE_SCALE_FACTOR,
    LatentTensor,
    latent_preview,
    latent_size,
)

__all__ = [
    "NODES",
    "SAMPLERS",
    "SCHEDULERS",
    "CLIPTextEncode",
    "ControlNetApply",
    "ControlNetLoader",
    "EmptyLatent",
    "KSampler",
    "LoadCheckpoint",
    "LoraLoader",
    "VAEDecode",
]

#: 샘플러 이름 → `diffusers` 스케줄러 클래스.
#:
#: 목록은 늘어날 수 있다 — **위젯 종류가 바뀌는 것이 아니라 옵션이 늘 뿐**이라
#: 프론트는 이 값을 하드코딩하지 말고 스키마에서 읽어야 한다.
_SAMPLER_CLASSES: dict[str, str] = {
    "euler": "EulerDiscreteScheduler",
    "euler_ancestral": "EulerAncestralDiscreteScheduler",
    "heun": "HeunDiscreteScheduler",
    "dpmpp_2m": "DPMSolverMultistepScheduler",
    "dpmpp_2m_sde": "DPMSolverMultistepScheduler",
    "ddim": "DDIMScheduler",
}

SAMPLERS = tuple(_SAMPLER_CLASSES)

#: 타임스텝 스케줄. 같은 이유로 늘어날 수 있다.
SCHEDULERS = ("normal", "karras", "exponential", "simple")

#: 프리뷰를 몇 번 보낼 것인가. 스텝마다 VAE 를 돌리면 SDXL 에서 생성보다
#: 프리뷰가 더 오래 걸린다 — 사람이 진행을 느끼는 데 8 장이면 충분하다.
PREVIEW_COUNT = 8


def _require_torch() -> Any:
    """torch 를 늦게 import 한다. 없으면 **무엇을 하면 되는지** 말한다."""
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - 설치된 환경에서는 안 걸린다
        raise RuntimeError(
            "이 노드는 torch 가 필요하지만 설치되어 있지 않다. "
            "diffusion 런타임은 옵트인이다 — `uv sync --group diffusion` (CPU) 또는 "
            "`uv sync --extra cuda` (NVIDIA 장비) 를 돌려라. "
            "노드 스키마는 torch 없이도 보이지만 실행에는 필요하다 (docs/dev.md)."
        ) from exc
    return torch


def _store(ctx: NodeContext) -> Any:
    """`ctx.models` 를 꺼낸다. 저장소가 없으면 `load` 가 명시적으로 실패한다."""
    return ctx.models


# ------------------------------------------------------------------- 로더


@node(
    id="diffusion.LoadCheckpoint",
    title="Load Checkpoint",
    category="diffusion/loaders",
    aliases=["체크포인트", "모델 불러오기", "ckpt"],
    cacheable=False,
)
class LoadCheckpoint:
    """체크포인트에서 `Model` · `CLIP` · `VAE` 를 낸다.

    셋은 **같은 파이프라인을 가리키는 뷰**다. 따로 로드하면 같은 가중치가 세 벌
    올라간다 (`handles.py`).

    단일 파일(`.safetensors`)이면 아키텍처를 **추론**하고, `model_index.json` 이
    있는 폴더면 파일이 명시한 것을 읽는다. 추론이 깨지면 무엇을 추론하려 했는지
    말하는 에러가 난다 (`design.md` §9.2).

    **`cacheable=False`** — 로딩 캐시는 `ModelManager` 에 있다 (모듈 최상단).
    """

    ckpt: Combo = Combo.from_provider("checkpoints", doc="models/checkpoints 에서 스캔한다.")

    returns = (Model, CLIP, VAE)

    def run(self, ckpt: str, ctx: NodeContext) -> NodeResult:
        from .manager import ModelManager

        store = _store(ctx)
        loader = _loader_for(ckpt)

        if isinstance(store, ModelManager):
            return NodeResult(
                store.load(ckpt, loader=loader),
                store.clip(ckpt, loader=loader),
                store.vae(ckpt, loader=loader),
            )

        # 저장소가 ModelManager 가 아니면(테스트 더블 등) Protocol 표면만 쓴다.
        handle = store.load(ckpt, loader=loader)
        checkpoint = getattr(handle, "checkpoint", handle)
        return NodeResult(handle, ClipHandle(checkpoint), VaeHandle(checkpoint))


@node(
    id="diffusion.LoraLoader",
    title="Load LoRA",
    category="diffusion/loaders",
    aliases=["로라", "lora", "어댑터"],
    cacheable=False,
)
class LoraLoader:
    """LoRA 어댑터를 모델과 텍스트 인코더에 얹는다.

    **새 핸들을 돌려주고 원본을 바꾸지 않는다.** 같은 체크포인트를 LoRA 있는
    쪽과 없는 쪽에 동시에 쓸 수 있어야 한다 — 그래프는 DAG 라 한 노드의 출력이
    여러 곳으로 간다.

    가중치는 파이프라인 하나에 붙으므로 어댑터 이름으로 구분한다. 이 노드가
    하는 일은 **가중치를 올려 두는 것까지**이고, 그것을 켜는 것은 파이프라인을
    실제로 부르는 노드다 (`_adapters_applied`). 여기서 `set_adapters` 를 부르면
    같은 체크포인트의 다른 분기까지 LoRA 가 적용된다 — 실제로 그랬고, 그것이
    이 노드의 약속("원본을 바꾸지 않는다")과 정면으로 어긋났다.
    """

    model: Model
    clip: CLIP
    lora_name: Combo = Combo.from_provider("loras", doc="models/loras 에서 스캔한다.")
    strength: Float = Float(1.0, min=-4.0, max=4.0, step=0.05, doc="어댑터 세기.")

    returns = (Model, CLIP)

    def run(
        self,
        model: ModelHandle,
        clip: ClipHandle,
        lora_name: str,
        strength: float,
        ctx: NodeContext,
    ) -> NodeResult:
        _require_torch()
        from .scanner import resolve

        checkpoint = model.checkpoint
        path = resolve("loras", lora_name)
        target = str(path) if path is not None else lora_name
        adapter = _adapter_name(lora_name)

        with checkpoint.lock:
            if adapter not in checkpoint.loaded:
                try:
                    checkpoint.pipe.load_lora_weights(target, adapter_name=adapter)
                except Exception as exc:
                    raise RuntimeError(
                        f"LoRA 를 얹지 못했다: {lora_name!r} ({target}). "
                        f"체크포인트 아키텍처는 {checkpoint.architecture} 다 — "
                        f"LoRA 가 같은 계열용인지 확인하라. 원인: {exc}"
                    ) from exc
                checkpoint.loaded.add(adapter)
                # `load_lora_weights` 는 방금 얹은 어댑터를 켜 둔 채로 돌아온다.
                # 그대로 두면 이 노드를 거치지 않은 분기도 LoRA 를 쓰게 된다.
                _deactivate(checkpoint)

        adapters = with_adapter(model.adapters, adapter, strength)
        return NodeResult(
            ModelHandle(checkpoint, adapters=adapters),
            ClipHandle(checkpoint, adapters=adapters, clip_skip=clip.clip_skip),
        )


@node(
    id="diffusion.ControlNetLoader",
    title="Load ControlNet",
    category="diffusion/loaders",
    aliases=["컨트롤넷", "controlnet"],
    cacheable=False,
)
class ControlNetLoader:
    """ControlNet 하나를 로드한다. 적용은 `ControlNetApply` 가 한다.

    **`cacheable=False`** — 체크포인트와 같은 이유다 (모듈 최상단). 로딩 캐시는
    `ModelManager` 에 있고 상한도 거기서 함께 센다.
    """

    control_net_name: Combo = Combo.from_provider(
        "controlnet", doc="models/controlnet 에서 스캔한다."
    )

    returns = {"control_net": Model}

    def run(self, control_net_name: str, ctx: NodeContext) -> NodeResult:
        _require_torch()
        from .manager import ModelManager
        from .scanner import resolve

        store = _store(ctx)
        if not isinstance(store, ModelManager):
            raise RuntimeError(
                "ControlNet 로딩에는 ModelManager 가 필요하다. "
                "이 실행의 ctx.models 는 "
                f"{type(store).__name__} 다 — 서버로 실행하거나 ModelManager 를 주입하라."
            )

        path = resolve("controlnet", control_net_name)
        target = str(path) if path is not None else control_net_name
        return NodeResult(store.controlnet(control_net_name, target=target))


@node(
    id="diffusion.ControlNetApply",
    title="Apply ControlNet",
    category="diffusion/conditioning",
    aliases=["컨트롤넷 적용", "control"],
    cacheable=True,
)
class ControlNetApply:
    """조건에 ControlNet 을 붙인다. 결과는 `KSampler` 의 조건 입력으로 간다.

    **원본 조건을 바꾸지 않는다.** 같은 프롬프트를 ControlNet 있는 쪽과 없는
    쪽에 나눠 쓸 수 있어야 한다.
    """

    conditioning: Conditioning
    control_net: Model
    image: Image
    strength: Float = Float(1.0, min=0.0, max=10.0, step=0.05)
    start_percent: Float = Float(0.0, min=0.0, max=1.0, step=0.01)
    end_percent: Float = Float(1.0, min=0.0, max=1.0, step=0.01)

    returns = {"conditioning": Conditioning}

    def run(
        self,
        conditioning: ConditioningHandle,
        control_net: ControlNetHandle,
        image: Any,
        strength: float,
        start_percent: float,
        end_percent: float,
    ) -> NodeResult:
        torch = _require_torch()

        if start_percent > end_percent:
            raise ValueError(
                f"start_percent({start_percent}) 가 end_percent({end_percent}) 보다 크다. "
                "적용 구간이 비어 있으면 ControlNet 이 조용히 아무 일도 하지 않는다."
            )

        # 이미지 계약은 (B, H, W, C) float32 0..1 (design.md §4.4).
        # torch 쪽은 (B, C, H, W) 라 여기서 축을 옮긴다.
        hint = torch.from_numpy(image).permute(0, 3, 1, 2).contiguous()
        hint = hint.to(str(control_net.plan.compute))

        applied = ControlNetHandle(
            model=control_net.model,
            ref=control_net.ref,
            plan=control_net.plan,
            hint=hint,
            strength=strength,
            window=(start_percent, end_percent),
            conditioning=conditioning,
        )
        # Conditioning 소켓으로 나가지만 ControlNet 을 달고 간다. KSampler 가
        # 둘 다 이해한다 — 소켓을 하나 더 만들면 그래프가 복잡해지기만 한다.
        return NodeResult(applied)


# ------------------------------------------------------------------- 조건


@node(
    id="diffusion.CLIPTextEncode",
    title="CLIP Text Encode",
    category="diffusion/conditioning",
    aliases=["프롬프트", "prompt", "텍스트"],
    cacheable=True,
)
class CLIPTextEncode:
    """프롬프트를 조건 임베딩으로 인코딩한다.

    SD1.5 는 임베딩 하나, SDXL 은 pooled 임베딩도 낸다. 그 차이는
    `encode_prompt` 의 반환 개수로 드러나므로 파이프라인 클래스로 분기하지 않는다.
    """

    clip: CLIP
    text: Str = Str("", multiline=True, placeholder="a photo of ...")

    returns = {"conditioning": Conditioning}

    def run(self, clip: ClipHandle, text: str) -> NodeResult:
        _require_torch()
        checkpoint = clip.checkpoint
        # 텍스트 인코더에도 LoRA 가 붙으므로 인코딩도 어댑터 안에서 한다.
        # 그래서 `source` 에 어댑터가 실린다 — 같은 문장이라도 어댑터가 다르면
        # 다른 임베딩이고, 캐시가 그 둘을 구분해야 한다.
        with _adapters_applied(checkpoint, clip.adapters):
            embeds, pooled = _encode(checkpoint, text)
        return NodeResult(
            ConditioningHandle(
                embeds=embeds,
                pooled=pooled,
                text=text,
                source=f"{checkpoint.ref}:{checkpoint.architecture}:{_adapter_tag(clip.adapters)}",
            )
        )


# -------------------------------------------------------------------- 잠재


@node(
    id="diffusion.EmptyLatent",
    title="Empty Latent",
    category="diffusion/latent",
    aliases=["빈 잠재", "캔버스", "empty", "latent"],
    cacheable=True,
)
class EmptyLatent:
    """빈 잠재 텐서를 만든다. txt2img 그래프의 시작점이다.

    크기는 **픽셀 단위로** 받는다. 사용자가 생각하는 단위가 픽셀이고, 잠재
    크기(÷8)는 구현 세부사항이기 때문이다.
    """

    width: Int = Int(1024, min=64, max=16384, step=8, doc="픽셀 너비. 8 의 배수.")
    height: Int = Int(1024, min=64, max=16384, step=8, doc="픽셀 높이. 8 의 배수.")
    batch_size: Int = Int(1, min=1, max=64, doc="한 번에 만들 장수.")

    returns = {"latent": Latent}

    def run(self, width: int, height: int, batch_size: int) -> NodeResult:
        torch = _require_torch()
        rows, cols = latent_size(width, height)
        empty = torch.zeros(
            (batch_size, LATENT_CHANNELS, rows, cols),
            dtype=torch.float32,
        )
        return NodeResult(empty)


@node(
    id="diffusion.KSampler",
    title="KSampler",
    category="diffusion/sampling",
    aliases=["샘플러", "sampler", "denoise", "생성"],
    cacheable=True,
)
class KSampler:
    """잠재 텐서를 디노이즈한다. txt2img 의 핵심 노드.

    **`seed` 는 평범한 정수 소켓이고 위젯만 다르다** (design.md §9.4). 값을
    굴리는 것은 프론트이고 서버는 넘어온 값을 그대로 쓴다 — 서버가 굴리면
    캐시 키가 매번 달라지고 `.nodal.json` 이 재현 가능한 레시피가 아니게 된다.

    시드는 **언제나 cpu 제너레이터**에서 만든다. `torch.Generator` 의 device
    처리가 백엔드마다 달라서, 그러지 않으면 "같은 시드 → 같은 결과" 가 백엔드를
    건널 때 깨진다.
    """

    model: Model
    positive: Conditioning
    negative: Conditioning
    latent: Latent

    seed: Seed = Seed(0, doc="같은 시드 · 같은 입력이면 같은 결과가 나온다.")
    steps: Int = Int(20, min=1, max=1000, doc="디노이즈 스텝 수.")
    cfg: Float = Float(7.0, min=0.0, max=100.0, step=0.1, doc="조건 강도 (CFG).")
    sampler_name: Combo = Combo("euler", options=SAMPLERS)
    scheduler: Combo = Combo("normal", options=SCHEDULERS)
    denoise: Float = Float(
        1.0,
        min=0.0,
        max=1.0,
        step=0.01,
        doc="1.0 이면 처음부터, 낮추면 입력 잠재를 남긴다 (img2img).",
    )

    returns = {"latent": Latent}

    def run(
        self,
        model: ModelHandle,
        positive: ConditioningHandle | ControlNetHandle,
        negative: ConditioningHandle | ControlNetHandle,
        latent: LatentTensor,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        ctx: NodeContext,
    ) -> NodeResult:
        torch = _require_torch()

        checkpoint = model.checkpoint
        plan = checkpoint.plan

        pos, control = _split_control(positive)
        neg, _ = _split_control(negative)

        # ControlNet 이 붙었으면 **부를 파이프라인 자체가 달라진다.** 컴포넌트를
        # 공유하는 파생 파이프라인이라 가중치가 두 벌 올라가지 않는다.
        pipe = checkpoint.pipe if control is None else _control_pipe(checkpoint, control)

        # 스케줄러는 실제로 부를 파이프라인에 얹는다. 원본에만 얹으면 파생
        # 파이프라인이 만들어진 시점의 옛 스케줄러로 돈다.
        _apply_sampler(pipe, sampler_name, scheduler)

        # 시드는 언제나 cpu 에서 만든다 (design.md §9.4). 백엔드마다 제너레이터의
        # device 처리가 달라서, 그러지 않으면 재현성이 백엔드를 건널 때 깨진다.
        generator = torch.Generator("cpu").manual_seed(int(seed))

        start = _denoise_start(steps, denoise)
        latents = latent.to(device=str(plan.compute), dtype=_pipe_dtype(pipe, torch))
        latents = (
            _initial_noise(pipe, latents, generator)
            if start == 0
            else _add_noise(pipe, latents, generator, steps, start)
        )

        every = max(1, steps // PREVIEW_COUNT)
        total = steps - start

        def on_step(
            _pipe: Any, index: int, _timestep: Any, kwargs: dict[str, Any]
        ) -> dict[str, Any]:
            ctx.raise_if_cancelled()
            done = index + 1
            preview = None
            if done % every == 0 or done == total:
                preview = latent_preview(kwargs["latents"], checkpoint.vae)
            ctx.progress(done, total, preview=preview)
            return kwargs

        call_kwargs: dict[str, Any] = {
            "num_images_per_prompt": _images_per_prompt(latents, pos, neg),
            "num_inference_steps": steps,
            "guidance_scale": cfg,
            "latents": latents,
            "generator": generator,
            "output_type": "latent",
            "callback_on_step_end": on_step,
            "prompt_embeds": pos.embeds,
            "negative_prompt_embeds": neg.embeds,
        }
        if pos.pooled is not None:
            call_kwargs["pooled_prompt_embeds"] = pos.pooled
            call_kwargs["negative_pooled_prompt_embeds"] = neg.pooled
        if start > 0:
            call_kwargs["timesteps"] = _tail_timesteps(pipe, steps, start)
        if control is not None:
            call_kwargs.update(_control_kwargs(control, latents))

        # 어댑터는 이 호출 동안에만 켜져 있다 (`_adapters_applied`).
        with _adapters_applied(checkpoint, model.adapters):
            result = pipe(**call_kwargs)
        return NodeResult(result.images)


@node(
    id="diffusion.VAEDecode",
    title="VAE Decode",
    category="diffusion/latent",
    aliases=["디코드", "decode", "이미지로"],
    cacheable=True,
)
class VAEDecode:
    """잠재 텐서를 이미지로 디코드한다.

    출력은 §4.4 의 이미지 계약이다 — `(B, H, W, C)` float32 0..1. 그래서
    `nodes-image` 의 Save · Resize 가 그대로 받는다.
    """

    vae: VAE
    latent: Latent

    returns = Image

    def run(self, vae: VaeHandle, latent: LatentTensor, ctx: NodeContext) -> NodeResult:
        torch = _require_torch()
        import numpy as np

        module = vae.vae
        # `module.device` 는 accelerate cpu-offload 아래서 쉬는 자리(cpu)를
        # 가리킨다 — forward 시점에 훅이 GPU 로 옮기므로 그걸로 입력을 배치하면
        # 어긋난다. `plan.compute` 가 diffusers 파이프라인의 `_execution_device`
        # 와 같은 역할이다 (`_encode` 가 이미 쓰는 패턴, §9.3).
        device = torch.device(str(vae.plan.compute))
        scaling = float(getattr(module.config, "scaling_factor", 1.0))
        shift = float(getattr(module.config, "shift_factor", 0.0) or 0.0)

        with torch.no_grad():
            scaled = latent.to(device=device, dtype=module.dtype) / scaling + shift
            decoded = module.decode(scaled).sample

        # (B, C, H, W) -1..1 → (B, H, W, C) 0..1
        image = (decoded / 2 + 0.5).clamp(0, 1)
        array = image.permute(0, 2, 3, 1).float().cpu().numpy().astype(np.float32)
        return NodeResult(array, preview=array)


# ---------------------------------------------------------------------- 헬퍼


def _images_per_prompt(
    latents: Any, positive: ConditioningHandle, negative: ConditioningHandle
) -> int:
    """Expand prompt embeddings to the requested latent batch in diffusers."""
    batch = int(latents.shape[0])
    prompts = int(positive.embeds.shape[0])
    if prompts < 1 or batch < 1 or batch % prompts:
        raise ValueError(f"잠재 배치({batch})는 프롬프트 배치({prompts})의 배수여야 한다.")
    if negative.embeds.shape[0] != prompts:
        raise ValueError("positive와 negative의 프롬프트 배치 크기가 다르다.")
    return batch // prompts


def _loader_for(ref: str) -> str:
    """참조 모양으로 로더를 고른다. 단일 파일 확장자면 추론 경로다."""
    return (
        "diffusers.single_file"
        if ref.endswith((".safetensors", ".ckpt"))
        else "diffusers.pretrained"
    )


def _adapter_name(lora_name: str) -> str:
    """어댑터 이름. `diffusers` 가 식별자로 쓰므로 경로 문자를 뺀다."""
    return "".join(c if c.isalnum() else "_" for c in lora_name)


def _adapter_tag(adapters: tuple[Adapter, ...]) -> str:
    """어댑터 목록의 캐시용 표기. 없으면 빈 문자열이다."""
    return "+".join(f"{a.name}@{a.scale}" for a in adapters)


def _deactivate(checkpoint: Checkpoint) -> None:
    """올라와 있는 어댑터를 전부 끈다. 락을 쥔 채로 부른다."""
    disable = getattr(checkpoint.pipe, "disable_lora", None)
    if disable is not None:
        disable()


@contextmanager
def _adapters_applied(checkpoint: Checkpoint, adapters: tuple[Adapter, ...]) -> Iterator[None]:
    """이 블록 동안만 어댑터를 켠다.

    활성 어댑터는 파이프라인 **전역** 상태다. 그래서 "켜 두고 쓴다" 가 아니라
    "쓸 때 켠다" 로 뒤집었다 — 그러지 않으면 같은 체크포인트에서 갈라진 다른
    분기가 옆 분기의 LoRA 를 쓰게 된다.

    나갈 때 반드시 끈다. 다음 사용자가 켜 줄 것이라는 가정에 기대면, 어댑터를
    쓰지 않는 노드 하나만 그 규약을 잊어도 조용히 잘못된 그림이 나온다.
    """
    with checkpoint.lock:
        if adapters:
            checkpoint.pipe.set_adapters(
                [a.name for a in adapters],
                adapter_weights=[a.scale for a in adapters],
            )
            enable = getattr(checkpoint.pipe, "enable_lora", None)
            if enable is not None:
                enable()
        try:
            yield
        finally:
            if checkpoint.loaded:
                _deactivate(checkpoint)


def _control_pipe(checkpoint: Checkpoint, control: ControlNetHandle) -> Any:
    """이 체크포인트 + 이 ControlNet 으로 부를 파이프라인.

    `from_pipe` 는 **컴포넌트를 공유한다** — UNet · VAE · 텍스트 인코더가 같은
    객체라 가중치가 다시 올라가지 않는다. 그래서 LoRA 활성화도 원본 파이프라인
    기준으로 하면 파생 쪽에 그대로 반영된다.

    `AutoPipelineForText2Image` 를 쓰는 이유는 SD 와 SDXL 의 ControlNet
    파이프라인 클래스가 다르기 때문이다. 클래스 이름으로 분기하면 새 아키텍처
    마다 여기를 고쳐야 하고, 그것은 이 모듈이 피하기로 한 방식이다 (모듈 최상단).

    파생 파이프라인은 체크포인트에 캐시한다. 스텝마다가 아니라 실행마다 한
    번이지만, 매번 만들면 스케줄러 설정이 새로 복사되어 `_apply_sampler` 가
    무엇에 얹혔는지 추적하기 어려워진다.
    """
    from diffusers import AutoPipelineForText2Image

    key = id(control.model)
    with checkpoint.lock:
        cached = checkpoint.control_pipes.get(key)
        if cached is not None:
            return cached
        try:
            pipe = AutoPipelineForText2Image.from_pipe(checkpoint.pipe, controlnet=control.model)
        except Exception as exc:
            raise RuntimeError(
                f"ControlNet {control.ref!r} 을 이 체크포인트에 붙이지 못했다 "
                f"({checkpoint.architecture}). ControlNet 이 같은 계열용인지 "
                f"확인하라 — SD1.5 용을 SDXL 에 붙이면 여기서 걸린다. 원인: {exc}"
            ) from exc
        pipe.set_progress_bar_config(disable=True)
        checkpoint.control_pipes[key] = pipe
        return pipe


def _encode(checkpoint: Checkpoint, text: str) -> tuple[Any, Any | None]:
    """프롬프트를 인코딩한다. SDXL 이면 pooled 도 돌려준다.

    `encode_prompt` 의 반환 개수로 아키텍처를 구분한다 — 2 면 SD 계열, 4 면
    SDXL 계열이다. 클래스 이름으로 분기하면 새 아키텍처마다 여기를 고쳐야 한다.
    """
    import inspect

    import torch

    pipe = checkpoint.pipe
    encode = getattr(pipe, "encode_prompt", None)
    if encode is None:
        raise RuntimeError(
            f"{checkpoint.architecture} 는 encode_prompt 가 없다 — "
            "이 팩이 아직 지원하지 않는 아키텍처다."
        )

    kwargs: dict[str, Any] = {"prompt": text, "num_images_per_prompt": 1}
    params = inspect.signature(encode).parameters
    if "device" in params:
        kwargs["device"] = torch.device(str(checkpoint.plan.compute))
    if "do_classifier_free_guidance" in params:
        # 음수 프롬프트는 따로 인코딩하므로 여기서는 끈다.
        kwargs["do_classifier_free_guidance"] = False

    out = encode(**kwargs)
    if not isinstance(out, tuple):
        return out, None
    if len(out) >= 3:
        # (prompt, negative, pooled, negative_pooled) — SDXL 계열
        return out[0], out[2]
    return out[0], None


def _split_control(
    conditioning: ConditioningHandle | ControlNetHandle,
) -> tuple[ConditioningHandle, ControlNetHandle | None]:
    """조건에서 ControlNet 을 분리한다. 안 붙어 있으면 `None`."""
    if isinstance(conditioning, ControlNetHandle):
        if conditioning.conditioning is None:
            raise ValueError(
                "ControlNet 이 조건 없이 왔다. ControlNetApply 를 거치지 않고 "
                "ControlNetLoader 출력을 KSampler 에 바로 연결했나?"
            )
        return conditioning.conditioning, conditioning
    return conditioning, None


def _control_kwargs(control: ControlNetHandle, latents: Any) -> dict[str, Any]:
    """ControlNet 을 파이프라인 인자로 바꾼다.

    힌트는 `ControlNetApply` 가 이미 `(B, C, H, W)` 로 만들어 뒀다. 여기서는
    배치와 dtype 만 잠재에 맞춘다 — 조건 이미지 한 장으로 여러 장을 뽑는 것이
    흔한 사용이라 배치가 어긋나기 쉽다.

    **`height` · `width` 를 반드시 함께 넘긴다.** 안 넘기면 파이프라인이
    `unet.config.sample_size` 에서 기본 크기를 만들어 힌트를 그 크기로 리사이즈
    하는데, 우리는 잠재를 직접 넘기므로 그 기본값이 잠재와 맞을 이유가 없다.
    어긋나면 ControlNet 잔차와 UNet 활성의 shape 이 달라 샘플링이 터진다.

    크기는 **잠재에서 되계산한다.** 잠재가 이 실행의 유일한 진실이고,
    ControlNet 의 조건 임베딩은 힌트를 `VAE_SCALE_FACTOR` 만큼 줄여 잠재 격자에
    맞춘다 (SD1.5 · SDXL 모두 8). `pipe.vae_scale_factor` 를 쓰지 않는 이유는
    그것이 **VAE** 의 성질이라 조건 임베딩의 축소 비율과 다를 수 있어서다 —
    tiny 픽스처에서 실제로 갈라진다 (VAE 는 2, 조건 임베딩은 8).
    """
    hint = control.hint
    if hint is None:  # pragma: no cover - `_split_control` 이 먼저 잡는다
        raise ValueError(f"ControlNet {control.ref!r} 에 힌트 이미지가 없다")

    hint = hint.to(device=latents.device, dtype=latents.dtype)
    batch = latents.shape[0]
    if hint.shape[0] == 1 and batch > 1:
        hint = hint.expand(batch, *hint.shape[1:]).contiguous()
    elif hint.shape[0] != batch:
        raise ValueError(
            f"ControlNet 힌트의 배치({hint.shape[0]})가 잠재의 배치({batch})와 다르다. "
            "한 장이면 자동으로 늘리지만 그 외에는 맞춰서 넣어야 한다."
        )

    return {
        "image": hint,
        "height": int(latents.shape[2]) * VAE_SCALE_FACTOR,
        "width": int(latents.shape[3]) * VAE_SCALE_FACTOR,
        "controlnet_conditioning_scale": control.strength,
        "control_guidance_start": control.window[0],
        "control_guidance_end": control.window[1],
    }


def _apply_sampler(pipe: Any, sampler_name: str, scheduler: str) -> None:
    """샘플러와 타임스텝 스케줄을 파이프라인에 적용한다.

    스케줄러 교체는 `from_config` 로 한다 — 파이프라인의 기존 설정(예측 타입,
    베타 스케줄)을 유지한 채 알고리즘만 바꾸는 것이 요점이다.
    """
    import diffusers

    class_name = _SAMPLER_CLASSES.get(sampler_name)
    if class_name is None:
        raise ValueError(f"알 수 없는 샘플러: {sampler_name!r}. 허용: {', '.join(SAMPLERS)}")
    if scheduler not in SCHEDULERS:
        raise ValueError(f"알 수 없는 스케줄: {scheduler!r}. 허용: {', '.join(SCHEDULERS)}")

    cls = getattr(diffusers, class_name)
    extra: dict[str, Any] = {}
    if scheduler == "karras":
        extra["use_karras_sigmas"] = True
    elif scheduler == "exponential":
        extra["use_exponential_sigmas"] = True
    if sampler_name == "dpmpp_2m_sde":
        extra["algorithm_type"] = "sde-dpmsolver++"

    try:
        pipe.scheduler = cls.from_config(pipe.scheduler.config, **extra)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{sampler_name!r} + {scheduler!r} 조합을 이 체크포인트의 스케줄러가 "
            f"받지 않는다 ({class_name}). 원인: {exc}"
        ) from exc


def _pipe_dtype(pipe: Any, torch: Any) -> Any:
    """파이프라인이 도는 dtype. 잠재를 여기에 맞춰야 matmul 이 터지지 않는다."""
    unet = getattr(pipe, "unet", None) or getattr(pipe, "transformer", None)
    return unet.dtype if unet is not None else torch.float32


def _denoise_start(steps: int, denoise: float) -> int:
    """`denoise` 를 건너뛸 스텝 수로 바꾼다. 1.0 이면 0 이다."""
    if denoise >= 1.0:
        return 0
    if denoise <= 0.0:
        raise ValueError("denoise 가 0 이면 아무것도 하지 않는다. 노드를 빼라.")
    return max(0, steps - round(steps * denoise))


def _tail_timesteps(pipe: Any, steps: int, start: int) -> list[int]:
    """스케줄의 뒷부분만. img2img 처럼 중간부터 디노이즈할 때 쓴다."""
    pipe.scheduler.set_timesteps(steps)
    # `.tolist()` — 텐서를 순회하며 int() 로 감싸면 ruff 가 이미 정수라고 오해한다.
    return list(pipe.scheduler.timesteps[start:].tolist())


def _initial_noise(pipe: Any, latents: Any, generator: Any) -> Any:
    """`denoise=1.0` 의 출발점 — **시드에서 뽑은 노이즈**.

    `EmptyLatent` 는 0 으로 채운 텐서를 준다. 그것을 그대로 파이프라인에 넘기면
    출발점이 0 이라 **시드가 결과에 아무 영향을 주지 않는다** — 실제로 그렇게
    구현했다가 "다른 시드가 같은 이미지를 낸다" 로 테스트가 잡았다.

    `denoise=1.0` 은 "처음부터 만든다" 는 뜻이므로 들어온 잠재의 **shape 만**
    쓰고 내용은 노이즈로 대체한다.

    **여기서 `init_noise_sigma` 를 곱하지 않는다.** `pipe.prepare_latents()`
    가 `latents` 인자를 받았는지와 무관하게 항상 `* scheduler.init_noise_sigma`
    를 한 번 더 적용한다 (diffusers 의 `StableDiffusionPipeline`·
    `StableDiffusionXLPipeline` 공통 구현). 여기서도 곱하면 이중 스케일링이 되어
    잠재가 `sigma²` 배로 터진다 — 실제로 Euler(sigma≈14.6)에서 latent std 가 190 대로
    나가 디코드가 전부 노이즈였다. `denoise<1.0` 분기(`_add_noise`)는 이 함수를
    타지 않으므로 영향 없다.

    노이즈는 cpu 에서 뽑는다 (design.md §9.4) — 제너레이터의 device 처리가
    백엔드마다 달라서, 그러지 않으면 같은 시드가 cuda 와 cpu 에서 다른 그림을 낸다.
    """
    import torch

    noise = torch.randn(latents.shape, generator=generator, dtype=torch.float32)
    return noise.to(device=latents.device, dtype=latents.dtype)


def _add_noise(pipe: Any, latents: Any, generator: Any, steps: int, start: int) -> Any:
    """중간부터 시작하기 위해 입력 잠재에 그만큼의 노이즈를 얹는다."""
    import torch

    pipe.scheduler.set_timesteps(steps)
    timestep = pipe.scheduler.timesteps[start : start + 1]
    noise = torch.randn(latents.shape, generator=generator, dtype=latents.dtype).to(latents.device)
    return pipe.scheduler.add_noise(latents, noise, timestep)


#: 이 팩이 등록하는 노드들.
NODES = (
    LoadCheckpoint,
    LoraLoader,
    ControlNetLoader,
    ControlNetApply,
    CLIPTextEncode,
    EmptyLatent,
    KSampler,
    VAEDecode,
)
