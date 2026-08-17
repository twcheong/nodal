"""불투명 소켓의 런타임 표현 (`Model` · `CLIP` · `VAE` · `Conditioning`).

core 는 이것들을 모른다 — `types.json` 이 `opaque` 로 선언한 이름만 안다.
실제 타입은 그 표현을 소유한 이 팩이 준다 (`decisions.md` 2026-08-15 의
`<Type>Handle` 명명 규칙).

## 셋이 파이프라인 하나를 공유한다

`LoadCheckpoint` 는 체크포인트 하나에서 `Model` · `CLIP` · `VAE` 를 낸다. 셋을
따로 로드하면 같은 가중치가 세 벌 올라간다. 그래서 세 핸들이 **같은
`Checkpoint` 를 가리키는 뷰**이고, 소켓 타입만 다르다.

이 구조가 스텝 프리뷰를 가능하게 한다 — `KSampler` 는 `Model` 만 받지만
`model.checkpoint.vae` 로 VAE 에 닿을 수 있다. 그렇지 않았다면 소켓을 하나 더
만들거나 계수 표를 들고 와야 했다 (`design.md` §9.5).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from nodal.models import DevicePlan

if TYPE_CHECKING:
    import torch

    Tensor = torch.Tensor
else:
    Tensor = Any

__all__ = [
    "Checkpoint",
    "ClipHandle",
    "ConditioningHandle",
    "ControlNetHandle",
    "ModelHandle",
    "VaeHandle",
]


@dataclass(eq=False)
class Checkpoint:
    """로드된 파이프라인 하나. `ModelManager` 가 캐시하는 단위다.

    **`eq=False` 는 의도적이다.** 두 체크포인트는 같은 객체일 때만 같다 —
    필드 비교는 의미가 없고(파이프라인끼리 `==` 하면 텐서 비교가 터진다), 무엇보다
    `eq=True` 면 dataclass 가 `__hash__` 를 지워 이 객체를 **해시할 수 없게**
    만든다. 그러면 핸들을 담는 `WeakSet` 이 동작하지 않아 참조 카운팅이
    통째로 깨진다 (`manager.py`).

    Attributes:
        ref: 로드에 쓴 참조 (파일 경로 또는 저장소 ID). 캐시 키의 일부.
        loader: `diffusers.single_file` 또는 `diffusers.pretrained`.
        pipe: `diffusers` 파이프라인. 컴포넌트는 여기서 꺼낸다.
        plan: 이 체크포인트가 올라간 디바이스 계획.
        architecture: 파이프라인 클래스 이름 (`StableDiffusionXLPipeline`).
            에러 메시지와 `ModelLoadError.inferred` 가 쓴다.
    """

    ref: str
    loader: str
    pipe: Any
    plan: DevicePlan
    architecture: str

    #: 적용된 LoRA 어댑터 이름들. 캐시 키에 들어가야 해서 핸들이 들고 다닌다.
    adapters: tuple[str, ...] = ()

    @property
    def vae(self) -> Any:
        return self.pipe.vae

    @property
    def unet(self) -> Any:
        # SD3 · FLUX 는 `transformer` 라고 부른다. 이름 차이를 여기서 흡수한다.
        return getattr(self.pipe, "unet", None) or self.pipe.transformer

    def __repr__(self) -> str:
        return f"Checkpoint({self.ref!r}, {self.architecture}, {self.plan.compute})"


@dataclass(frozen=True)
class _View:
    """체크포인트 하나를 가리키는 뷰. 소켓 타입만 다르다."""

    checkpoint: Checkpoint

    @property
    def plan(self) -> DevicePlan:
        return self.checkpoint.plan

    def cache_id(self) -> str:
        """캐시 키에 들어갈 안정적인 문자열.

        핸들 객체의 `id()` 를 쓰면 프로세스마다 달라져 캐시가 절대 맞지 않는다.
        `ref` · 로더 · 적용된 어댑터가 결과를 결정하므로 그것으로 만든다.
        """
        ckpt = self.checkpoint
        adapters = "+".join(ckpt.adapters)
        return f"{type(self).__name__}:{ckpt.loader}:{ckpt.ref}:{adapters}"


@dataclass(frozen=True)
class ModelHandle(_View):
    """`Model` 소켓. 디노이저(UNet 또는 transformer)를 가리킨다."""

    #: LoRA 스케일. `LoraLoader` 가 새 핸들을 만들며 채운다.
    lora_scale: float = 1.0

    @property
    def unet(self) -> Any:
        return self.checkpoint.unet


@dataclass(frozen=True)
class ClipHandle(_View):
    """`CLIP` 소켓. 텍스트 인코더를 가리킨다."""

    clip_skip: int | None = None


@dataclass(frozen=True)
class VaeHandle(_View):
    """`VAE` 소켓."""

    @property
    def vae(self) -> Any:
        return self.checkpoint.vae


@dataclass(frozen=True)
class ConditioningHandle:
    """`Conditioning` 소켓 — `CLIPTextEncode` 의 출력.

    SD1.5 계열은 `embeds` 만, SDXL 은 `pooled` 도 필요하다. `pooled` 가 `None`
    인지로 구분하며, `KSampler` 는 파이프라인이 받는 경우에만 넘긴다.

    Attributes:
        embeds: `(B, 토큰, 차원)` 텍스트 임베딩.
        pooled: SDXL 의 pooled 임베딩. SD1.5 에서는 `None`.
        text: 원본 프롬프트. **캐시 키와 에러 메시지에만 쓴다** — 텐서는
            해시하기 비싸고, 같은 텍스트·같은 인코더면 같은 임베딩이다.
    """

    embeds: Tensor
    pooled: Tensor | None = None
    text: str = ""
    #: 어느 인코더가 만들었나. 텍스트가 같아도 인코더가 다르면 다른 임베딩이다.
    source: str = ""

    def cache_id(self) -> str:
        return f"Conditioning:{self.source}:{self.text}"


@dataclass(frozen=True)
class ControlNetHandle:
    """ControlNet 하나와 그것을 적용할 세기.

    `ControlNetLoader` 가 모델만 든 핸들을 만들고, `ControlNetApply` 가 힌트
    이미지와 세기를 채운 새 핸들을 만든다. 원본을 바꾸지 않는다 — 같은
    ControlNet 을 두 곳에 다른 세기로 쓸 수 있어야 한다.
    """

    model: Any
    ref: str
    plan: DevicePlan
    hint: Tensor | None = None
    strength: float = 1.0
    #: 전체 스텝 중 적용 구간. `(시작, 끝)` 비율.
    window: tuple[float, float] = (0.0, 1.0)
    conditioning: ConditioningHandle | None = field(default=None, repr=False)

    def cache_id(self) -> str:
        return f"ControlNet:{self.ref}:{self.strength}:{self.window}"
