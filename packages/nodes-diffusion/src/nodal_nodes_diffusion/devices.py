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

## 능력 테이블

백엔드별 차이는 `if` 사슬이 아니라 `BACKENDS` 테이블에 데이터로 둔다. 분기가
코드에 흩어지면 새 백엔드를 붙일 때 어디를 고쳐야 하는지 알 수 없다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, get_args

from nodal.models import CPU, Device, DeviceKind, DevicePlan

__all__ = [
    "BACKENDS",
    "DEVICE_ENV_VAR",
    "Backend",
    "DevicePolicy",
    "detect_kind",
    "empty_cache",
    "free_memory",
    "resolve_plan",
    "to_torch_dtype",
]

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


# ------------------------------------------------------------------ 능력 테이블


@dataclass(frozen=True)
class Backend:
    """백엔드 하나의 능력. **분기가 아니라 데이터다.**

    `if kind == "cuda"` 를 코드에 흩뿌리는 대신 여기 한 테이블에 적는다. 새
    백엔드를 붙일 때 고칠 곳이 이 파일 하나가 되는 것이 요점이다.

    Attributes:
        kind: 백엔드 이름.
        dtype: 기본 dtype (`nodal.models.DTYPES` 의 값).
        supports_offload: `accelerate` 의 CPU 오프로드가 **의미 있는가**.
            통합 메모리인 mps 와 애초에 호스트인 cpu 에서는 오프로드가 이득이
            아니라 순손실이다 — 같은 메모리 안에서 텐서를 옮기기만 한다.
        reports_free_memory: 여유 메모리를 물어볼 수 있는가. 물어볼 수 없는
            백엔드에서 숫자를 지어내면 LRU 언로드가 그 숫자를 믿는다.
    """

    kind: DeviceKind
    dtype: str
    supports_offload: bool
    reports_free_memory: bool


#: 백엔드별 능력. **여기가 유일한 출처다.**
#:
#: cpu 가 `float32` 인 이유: CPU 의 fp16 은 대부분의 커널에서 지원되지 않거나
#: 에뮬레이션이라 오히려 느리다. mps 가 `float16` 인 이유: Apple GPU 에서
#: bf16 지원이 버전에 따라 들쭉날쭉해서 fp16 이 안전한 기본값이다. cuda 는
#: bf16 이 가능하면 그쪽을 쓰지만 그 판정은 런타임이라 `resolve_plan` 에 있다.
BACKENDS: dict[DeviceKind, Backend] = {
    "cuda": Backend("cuda", "float16", supports_offload=True, reports_free_memory=True),
    "mps": Backend("mps", "float16", supports_offload=False, reports_free_memory=False),
    "cpu": Backend("cpu", "float32", supports_offload=False, reports_free_memory=False),
}


def to_torch_dtype(dtype: str) -> Any:
    """`DevicePlan.dtype` 문자열을 torch dtype 으로. 여기서만 변환한다."""
    import torch

    mapping = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    try:
        return mapping[dtype]
    except KeyError:
        raise ValueError(f"알 수 없는 dtype: {dtype!r}. 허용: {', '.join(mapping)}") from None


def free_memory(device: Device) -> int | None:
    """디바이스의 여유 바이트. **물어볼 수 없으면 `None`.**

    `0` 이나 큰 수를 지어내지 않는다 — LRU 언로드가 그 숫자를 믿고 잘못된 결정을
    내린다. `None` 은 "모른다" 이고, 부르는 쪽은 모를 때 무엇을 할지 알아야 한다.
    """
    backend = BACKENDS[device.kind]
    if not backend.reports_free_memory:
        return None

    import torch

    free, _total = torch.cuda.mem_get_info(device.index or 0)
    return int(free)


def empty_cache(device: Device) -> None:
    """언로드 뒤 할당자 캐시를 비운다. cuda 외에는 아무 일도 하지 않는다.

    이것을 부르지 않으면 모델을 지워도 `nvidia-smi` 의 사용량이 줄지 않아
    "언로드가 동작하지 않는다" 로 보인다.
    """
    if device.kind != "cuda":
        return

    import torch

    torch.cuda.empty_cache()


def resolve_plan(policy: DevicePolicy) -> DevicePlan:
    """정책을 실행 계획으로 해석한다. **노드는 이 결과만 본다.**

    `compute` 는 탐지된 백엔드, `offload` 는 오프로드가 의미 있을 때만 `cpu`,
    `dtype` 은 능력 테이블에서 온다. cuda 에서 bf16 이 가능하면 fp16 대신 쓴다 —
    같은 폭이면서 지수 범위가 넓어 오버플로가 덜하다.
    """
    kind = detect_kind(policy)
    backend = BACKENDS[kind]

    index = _default_cuda_index() if kind == "cuda" else None
    compute = Device(kind, index)

    dtype = backend.dtype
    if kind == "cuda" and _supports_bfloat16():
        dtype = "bfloat16"

    offload = CPU if backend.supports_offload else compute
    return DevicePlan(compute=compute, offload=offload, dtype=dtype)


def _default_cuda_index() -> int:
    """현재 선택된 cuda 장치 번호. 멀티 GPU 는 M6 이후이므로 지금은 현재 장치다."""
    import torch

    return int(torch.cuda.current_device())


def _supports_bfloat16() -> bool:
    import torch

    return bool(torch.cuda.is_bf16_supported())
