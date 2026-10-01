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

## 공유하는 만큼 **바꾸지 않는다**

핸들은 전부 `frozen=True` 이고 `Checkpoint` 는 여럿이 공유한다. 그래서 어댑터
같은 "적용된 상태" 는 **핸들이 들고 다니고** 파이프라인에는 쓰는 순간에만
얹는다 (`nodes.py` 의 `_adapters_applied`). 공유 객체를 노드가 직접 바꾸면
같은 `LoadCheckpoint` 에서 갈라진 다른 분기까지 따라 바뀐다 — 그것은 그래프의
데이터흐름 의미론이 깨진 것이다 (`decisions.md` 2026-08-18).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from nodal.models import DevicePlan

if TYPE_CHECKING:
    import torch

    Tensor = torch.Tensor
else:
    Tensor = Any

__all__ = [
    "Adapter",
    "Checkpoint",
    "ClipHandle",
    "ConditioningHandle",
    "ControlNetHandle",
    "ModelHandle",
    "VaeHandle",
    "with_adapter",
]


@dataclass(frozen=True)
class Adapter:
    """적용할 LoRA 어댑터 하나와 그 세기.

    **핸들에 붙는다.** 파이프라인에 얹혀 있는 어댑터 목록(`Checkpoint.loaded`)과
    다른 것이다 — 가중치가 올라와 있는 것과 이번 실행에 켜져 있는 것은 별개다.
    """

    name: str
    scale: float


def with_adapter(adapters: tuple[Adapter, ...], name: str, scale: float) -> tuple[Adapter, ...]:
    """어댑터 목록에 하나를 얹는다. 같은 이름이면 세기를 덮어쓴다.

    같은 LoRA 를 두 번 얹었을 때 목록에 두 번 들어가면 `set_adapters` 가
    같은 이름을 중복으로 받는다. 마지막 세기가 이긴다 — 사용자가 나중에 놓은
    노드의 값을 의도로 본다.
    """
    kept = tuple(a for a in adapters if a.name != name)
    return (*kept, Adapter(name, scale))


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

    #: 이 파이프라인에 **가중치가 올라와 있는** LoRA 어댑터 이름들.
    #:
    #: "적용된" 이 아니라 "올라와 있는" 이다. 어댑터는 얹어도 `set_adapters` 로
    #: 켜기 전에는 forward 에 관여하지 않으므로, 이 집합은 순수한 로드 캐시다
    #: (같은 LoRA 를 두 번 읽지 않기 위한 것). **무엇이 켜져 있는가는 핸들이
    #: 정한다** — 그래야 같은 체크포인트에서 갈라진 분기가 서로 독립이다.
    loaded: set[str] = field(default_factory=set)

    #: ControlNet 별 파생 파이프라인. `id(controlnet 모델)` → 파이프라인.
    #:
    #: `from_pipe` 는 컴포넌트를 공유하므로 여기 담긴 것들이 가중치를 더 쓰지
    #: 않는다 — 공유하는 UNet 을 다른 클래스로 감싼 껍데기다 (`nodes.py`).
    control_pipes: dict[int, Any] = field(default_factory=dict, repr=False)

    #: 어댑터 활성화와 파이프라인 호출이 겹치지 않게 한다.
    #:
    #: 활성 어댑터는 파이프라인 **전역** 상태라, 켜는 것과 쓰는 것 사이에 다른
    #: 노드가 끼어들면 엉뚱한 어댑터로 샘플링한다. 지금은 실행 워커가 하나라
    #: 실제로 끼어들지 않지만, 그 사실에 기대는 코드를 남기지 않는다.
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    @property
    def vae(self) -> Any:
        return self.pipe.vae

    @property
    def unet(self) -> Any:
        # SD3 · FLUX 는 `transformer` 라고 부른다. 이름 차이를 여기서 흡수한다.
        return getattr(self.pipe, "unet", None) or self.pipe.transformer

    def __repr__(self) -> str:
        return f"Checkpoint({self.ref!r}, {self.architecture}, {self.plan.compute})"


@dataclass(frozen=True, eq=False)
class _View:
    """체크포인트 하나를 가리키는 뷰. 소켓 타입만 다르다.

    **`eq=False` 로 동일성 비교를 쓴다.** `ModelManager` 가 살아 있는 핸들을
    `WeakSet` 으로 세는데(`manager.py`), 값 비교를 쓰면 필드가 같은 두 핸들이
    집합에서 **하나로 합쳐진다.** 그러면 먼저 만든 쪽이 죽을 때 항목이 사라져
    아직 쓰는 중인 체크포인트가 "사용 안 함" 으로 보이고 언로드 대상이 된다.
    참조 카운팅은 값이 아니라 객체를 세는 것이므로 동일성이 맞는 의미다.
    """

    checkpoint: Checkpoint

    #: 이 핸들에 **적용된** LoRA 어댑터. 파이프라인에 올라와 있는 것과 다르다.
    adapters: tuple[Adapter, ...] = ()

    @property
    def plan(self) -> DevicePlan:
        return self.checkpoint.plan

    def cache_id(self) -> str:
        """캐시 키에 들어갈 안정적인 문자열.

        핸들 객체의 `id()` 를 쓰면 프로세스마다 달라져 캐시가 절대 맞지 않는다.
        `ref` · 로더 · **이 핸들에** 적용된 어댑터가 결과를 결정하므로 그것으로
        만든다. 체크포인트의 상태를 읽으면 옆 분기가 LoRA 를 얹었다는 이유로
        이 핸들의 키가 흔들린다.
        """
        ckpt = self.checkpoint
        adapters = "+".join(f"{a.name}@{a.scale}" for a in self.adapters)
        return f"{type(self).__name__}:{ckpt.loader}:{ckpt.ref}:{adapters}"


@dataclass(frozen=True, eq=False)
class ModelHandle(_View):
    """`Model` 소켓. 디노이저(UNet 또는 transformer)를 가리킨다."""

    @property
    def unet(self) -> Any:
        return self.checkpoint.unet


@dataclass(frozen=True, eq=False)
class ClipHandle(_View):
    """`CLIP` 소켓. 텍스트 인코더를 가리킨다."""

    clip_skip: int | None = None


@dataclass(frozen=True, eq=False)
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


@dataclass(frozen=True, eq=False)
class ControlNetHandle:
    """ControlNet 하나와 그것을 적용할 세기.

    `ControlNetLoader` 가 모델만 든 핸들을 만들고, `ControlNetApply` 가 힌트
    이미지와 세기를 채운 새 핸들을 만든다. 원본을 바꾸지 않는다 — 같은
    ControlNet 을 두 곳에 다른 세기로 쓸 수 있어야 한다.

    `eq=False` 인 이유는 `_View` 와 같다 — `ModelManager` 가 이 핸들도 약한
    참조로 세므로 값이 아니라 객체를 구분해야 한다.
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
