"""diffusion 노드 (M4).

**현재 상태: 스키마는 완성, 실행은 최소.** 이 모듈의 목적은 `/api/nodes` 에
정확한 소켓·위젯을 흘려보내 프론트가 시드 위젯을 만들 수 있게 하는 것이다.
샘플링 루프 자체는 `ModelManager` 와 함께 다음 커밋에 온다.

## 모듈 최상단에서 torch 를 import 하지 않는다

이 팩은 **언제나 설치되고**(스키마 노출) torch 는 옵트인이다. 최상단에서
import 하면 `uv sync` 만 한 사람의 서버가 이 팩을 못 읽어 팔레트에서 노드가
통째로 사라진다 — 그러면 이 파일이 존재하는 이유가 없어진다.

그래서 `run` 안에서 늦게 import 하고, 없으면 **무엇을 해야 하는지 말하는**
에러를 낸다. `devices.py` 가 같은 규칙을 따른다.
"""

from __future__ import annotations

from typing import Any

from nodal import (
    Combo,
    Conditioning,
    Float,
    Int,
    Latent,
    Model,
    NodeContext,
    NodeResult,
    Seed,
    node,
)

from .latent import LATENT_CHANNELS, LatentTensor, latent_size

__all__ = ["NODES", "SAMPLERS", "SCHEDULERS", "EmptyLatent", "KSampler"]

#: 샘플러 이름. `diffusers` 의 스케줄러 클래스에 대응하며 M4 구현에서 매핑된다.
#: 목록은 늘어날 수 있다 — **위젯 종류가 바뀌는 것이 아니라 옵션이 늘 뿐**이라
#: 프론트는 이 값을 하드코딩하지 말고 스키마에서 읽어야 한다.
SAMPLERS = ("euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "ddim")

#: 타임스텝 스케줄. 같은 이유로 늘어날 수 있다.
SCHEDULERS = ("normal", "karras", "exponential", "simple")


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
        model: Any,
        positive: Any,
        negative: Any,
        latent: LatentTensor,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        ctx: NodeContext,
    ) -> NodeResult:
        _require_torch()
        raise NotImplementedError(
            "KSampler 의 샘플링 루프는 ModelManager 와 함께 온다 (roadmap M4). "
            "이 커밋은 스키마만 노출한다 — /api/nodes 에서 시드 위젯을 확인할 수 있다."
        )


#: 이 팩이 등록하는 노드들.
NODES = (EmptyLatent, KSampler)
