"""nodal — diffusion 노드 팩 (M4).

**상태: 스켈레톤.** 이 커밋(`contract: M4 diffusion surface`)이 정한 것은 경계와
표면이고, `ModelManager` · 노드들(LoadCheckpoint · CLIPTextEncode · EmptyLatent ·
KSampler · VAEDecode) · 능력 테이블은 다음 커밋이다.

## 이 패키지만 torch 를 안다

`packages/core` 는 도메인 중립 그래프 엔진이라 torch 를 import 하지 않고,
`packages/server` 도 마찬가지다 (AGENTS.md 아키텍처 절). ruff 의 `banned-api` 가
`torch` 를 전역 금지하고 `per-file-ignores` 가 이 패키지만 면제한다.

그 안에서 한 겹 더 좁힌다 — **`torch.cuda` · `torch.backends.mps` 는 `devices.py`
한 파일에만** 등장한다. 이유는 그 파일 문서에 있다.

## 설치

torch 는 이 패키지의 의존성이 아니다. CPU 빌드와 CUDA 빌드가 같은 이름으로 다른
인덱스에 있어서, 어느 쪽을 받을지는 루트 워크스페이스가 정한다:

```bash
uv sync --group diffusion   # CPU (맥 개발 · CI)
uv sync --extra cuda        # CUDA (NVIDIA 장비)
```

근거는 `packages/nodes-diffusion/pyproject.toml` 의 주석과 `docs/dev.md`.
"""

from __future__ import annotations

from nodal import NodeRegistry, register_preview_encoder

from .devices import BACKENDS, DEVICE_ENV_VAR, Backend, DevicePolicy, detect_kind, resolve_plan
from .h3 import MiniMaxH3
from .handles import (
    Checkpoint,
    ClipHandle,
    ConditioningHandle,
    ControlNetHandle,
    ModelHandle,
    VaeHandle,
)
from .latent import (
    LATENT_CHANNELS,
    VAE_SCALE_FACTOR,
    LatentTensor,
    encode_latent_preview,
    latent_preview,
    latent_size,
)
from .manager import ModelManager
from .nodes import NODES as IMAGE_NODES
from .nodes import (
    SAMPLERS,
    SCHEDULERS,
    CLIPTextEncode,
    ControlNetApply,
    ControlNetLoader,
    EmptyLatent,
    KSampler,
    LoadCheckpoint,
    LoraLoader,
    VAEDecode,
)
from .scanner import MODELS_ENV_VAR, models_root, register_providers, scan, set_models_root

NODES = (*IMAGE_NODES, MiniMaxH3)

__all__ = [
    "BACKENDS",
    "DEVICE_ENV_VAR",
    "LATENT_CHANNELS",
    "MODELS_ENV_VAR",
    "NODES",
    "SAMPLERS",
    "SCHEDULERS",
    "VAE_SCALE_FACTOR",
    "Backend",
    "CLIPTextEncode",
    "Checkpoint",
    "ClipHandle",
    "ConditioningHandle",
    "ControlNetApply",
    "ControlNetHandle",
    "ControlNetLoader",
    "DevicePolicy",
    "EmptyLatent",
    "KSampler",
    "LatentTensor",
    "LoadCheckpoint",
    "LoraLoader",
    "MiniMaxH3",
    "ModelHandle",
    "ModelManager",
    "VAEDecode",
    "VaeHandle",
    "detect_kind",
    "encode_latent_preview",
    "latent_preview",
    "latent_size",
    "models_root",
    "register_providers",
    "registry",
    "resolve_plan",
    "scan",
    "set_models_root",
]

# import 하는 것만으로 Combo 공급자와 프리뷰 인코더가 등록된다 —
# `nodal_nodes_image` 와 같은 패턴이다 (design.md §4.6).
register_providers()
register_preview_encoder(encode_latent_preview)


def registry(into: NodeRegistry | None = None) -> NodeRegistry:
    """이 팩의 노드를 담은 레지스트리를 돌려준다.

    `nodal_nodes_image.registry` 와 같은 모양이다 — CLI 가 이 이름을 찾는다.

    **torch 없이도 동작한다.** 스키마는 `nodal` 의 타입만으로 만들어지므로
    등록에 런타임이 필요 없다. 실행할 때만 `run` 이 torch 를 요구한다.

    Args:
        into: 채울 레지스트리. 없으면 새로 만든다. 여러 팩을 합칠 때 넘긴다.
    """
    target = into if into is not None else NodeRegistry()
    for node_class in NODES:
        target.register(node_class)
    return target
