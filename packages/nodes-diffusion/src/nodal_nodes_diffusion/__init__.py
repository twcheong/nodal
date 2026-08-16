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

from .devices import DEVICE_ENV_VAR, DevicePolicy, detect_kind

__all__ = ["DEVICE_ENV_VAR", "DevicePolicy", "detect_kind"]
