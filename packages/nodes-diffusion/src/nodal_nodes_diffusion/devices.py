"""디바이스 탐지 — **`torch.cuda` · `torch.backends.mps` 가 등장하는 유일한 파일.**

이 규칙은 관습이 아니라 강제된다. 루트 `pyproject.toml` 의 ruff `banned-api` 가
`torch.cuda` · `torch.backends.mps` · `torch.mps` 를 금지하고, `per-file-ignores`
가 **이 파일 하나만** 면제한다. 다른 곳에서 백엔드를 물어보면 CI 가 막는다.

왜 이렇게까지 하는가: 백엔드 분기는 한 번 흩어지면 되돌릴 수 없다. `if
torch.cuda.is_available()` 이 노드마다 박히면 mps 를 고칠 때 스무 군데를 찾아야
하고, 그 중 하나를 빠뜨린 것은 그 하드웨어를 가진 사람만 발견한다. 저자가 맥에서
개발하고 GPU 는 별도 리눅스 장비인 이 프로젝트에서는 특히 그렇다.

**노드는 이 모듈을 부르지 않는다.** 노드가 보는 것은 `ctx.models.plan` 이 주는
이미 해석된 `DevicePlan` 뿐이다 (`nodal.models`).

## 아직 없는 것

`DevicePolicy` → `DevicePlan` 해석(백엔드별 dtype · 오프로드 가능 여부 · 여유
메모리 질의)은 **다음 커밋**이다. 그것은 계약이 아니라 구현이고, 값이 바뀌어도
`nodal.models` 의 표면은 그대로다. 지금 이 파일에 있는 것은 경계와 탐지뿐이다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import get_args

from nodal.models import DeviceKind

__all__ = ["DEVICE_ENV_VAR", "DevicePolicy", "detect_kind"]

#: 정책을 환경변수로 덮어쓰는 이름. CI 는 여기에 `cpu` 를 박는다.
DEVICE_ENV_VAR = "NODAL_DEVICE"

#: `auto` 가 훑는 순서. 빠른 것부터.
_PROBE_ORDER: tuple[DeviceKind, ...] = ("cuda", "mps", "cpu")


@dataclass(frozen=True)
class DevicePolicy:
    """무엇을 쓰고 싶은가. **하드웨어가 아니라 의도**다.

    정책이 값으로 주입되는 것이 요점이다 — 전역 탐지에 의존하면 "mps 에서 어떻게
    되는가" 를 맥에서만, "cuda 에서 어떻게 되는가" 를 GPU 장비에서만 테스트할 수
    있게 된다. 정책을 주입할 수 있으면 두 경우 다 어디서나 단위 테스트가 된다.

    Attributes:
        preferred: `"auto"` 면 `_PROBE_ORDER` 순으로 탐지한다. 백엔드 이름을
            직접 주면 **그것이 없을 때 조용히 cpu 로 떨어지지 않고 실패**한다 —
            cuda 를 지정했는데 cpu 로 도는 것은 거의 언제나 사고다.
    """

    preferred: str = "auto"

    def __post_init__(self) -> None:
        allowed = ("auto", *get_args(DeviceKind))
        if self.preferred not in allowed:
            raise ValueError(
                f"알 수 없는 디바이스 정책: {self.preferred!r}. 허용: {', '.join(allowed)}"
            )

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> DevicePolicy:
        """`NODAL_DEVICE` 를 읽는다. 없으면 `auto`."""
        source = os.environ if env is None else env
        return cls(preferred=source.get(DEVICE_ENV_VAR, "auto"))


def detect_kind(policy: DevicePolicy) -> DeviceKind:
    """정책을 실제 백엔드 하나로 해석한다.

    torch 는 **함수 안에서** import 한다. 이 패키지는 `uv sync --group diffusion`
    없이도 import 될 수 있어야 하고 (`nodal.models` 의 타입만 쓰는 코드가 있다),
    그때 모듈 최상단의 `import torch` 는 ImportError 로 전체를 무너뜨린다.

    Raises:
        RuntimeError: 명시적으로 지정한 백엔드를 쓸 수 없을 때. 조용히 cpu 로
            떨어지지 않는다.
    """
    import torch

    available: dict[DeviceKind, bool] = {
        "cuda": torch.cuda.is_available(),
        "mps": torch.backends.mps.is_available(),
        "cpu": True,
    }

    if policy.preferred != "auto":
        kind: DeviceKind = policy.preferred  # type: ignore[assignment]
        if not available[kind]:
            raise RuntimeError(
                f"{kind} 를 요청했지만 이 머신에서 쓸 수 없다. "
                f"쓸 수 있는 것: {', '.join(k for k, ok in available.items() if ok)}. "
                f"자동 선택을 원하면 {DEVICE_ENV_VAR}=auto."
            )
        return kind

    return next(kind for kind in _PROBE_ORDER if available[kind])
