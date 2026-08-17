"""모델 저장소 인터페이스와 디바이스 계획 (docs/design.md §9, M4 계약).

**여기 있는 것은 인터페이스뿐이고 구현은 없다.** `assets.py` 와 같은 이유다 —
체크포인트를 로드하는 노드가 저장소에 닿아야 하는데, 노드 팩은 `core` 만
의존한다 (AGENTS.md 아키텍처 절). 구현까지 core 에 넣으면 도메인 중립 그래프
엔진이 torch 를 알게 된다.

**이 모듈은 torch 를 import 하지 않는다.** `Device` 는 `torch.device` 가 아니라
값 타입이고, `dtype` 은 `torch.dtype` 이 아니라 `types.json` 과 같은 어휘의
문자열이다. 핸들은 불투명하다 — core 는 `load()` 가 무엇을 돌려주는지 모른다.
실제 타입은 그 표현을 소유한 노드 팩이 `ModelHandle` 로 노출한다
(`decisions.md` 2026-08-15, `<Type>Handle` 명명 규칙).

노드는 `ctx.models` 로 접근한다. `ctx` 를 선언하지 않은 노드는 저장소를 모르며,
그것이 정상이다.

## 왜 노드가 디바이스를 고르지 않는가

`if device == "cuda"` 를 노드가 쓸 수 있게 두면 백엔드 분기가 노드마다 흩어진다.
그래서 노드가 보는 것은 **이미 해석이 끝난** `DevicePlan` 하나뿐이고, 무엇을
어디에 올릴지는 저장소 구현이 정한다. `torch.cuda` · `torch.backends.mps` 는
`packages/nodes-diffusion` 의 `devices.py` **한 파일에만** 등장하며 ruff 의
`banned-api` 가 그것을 강제한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

__all__ = [
    "CPU",
    "DTYPES",
    "Device",
    "DeviceKind",
    "DevicePlan",
    "ModelLoadError",
    "ModelStore",
    "NullModelStore",
]

#: 디바이스 백엔드. 이 셋이 전부다 — 새 백엔드는 `devices.py` 와 함께 추가한다.
DeviceKind = Literal["cuda", "mps", "cpu"]

#: 허용되는 dtype 이름. `types.json` 의 `Latent.dtypes` 와 같은 어휘를 쓴다 —
#: 텐서 서술자와 실행 계획이 다른 말로 같은 것을 가리키면 반드시 어긋난다.
DTYPES: tuple[str, ...] = ("float16", "bfloat16", "float32")


@dataclass(frozen=True)
class Device:
    """디바이스 하나. `torch.device` 가 아니라 **값 타입**이다.

    `str(device)` 가 torch 가 받는 문자열(`"cuda:0"` · `"mps"` · `"cpu"`)과 같은
    모양이라 노드 팩에서 변환이 한 줄로 끝난다. 그렇다고 core 가 torch 를 아는
    것은 아니다 — 이것은 우연이 아니라 **선택된 표기**이고, torch 가 표기를
    바꾸면 바꿔야 하는 쪽은 노드 팩이다.

    Attributes:
        kind: 백엔드.
        index: 같은 백엔드가 여럿일 때의 번호. `cuda:1` 의 1. 없으면 `None`.
            `mps` · `cpu` 에서는 언제나 `None` 이다.
    """

    kind: DeviceKind
    index: int | None = None

    def __post_init__(self) -> None:
        if self.kind != "cuda" and self.index is not None:
            raise ValueError(f"{self.kind} 디바이스에는 인덱스가 없다 (index={self.index})")
        if self.index is not None and self.index < 0:
            raise ValueError(f"디바이스 인덱스는 음수가 될 수 없다: {self.index}")

    def __str__(self) -> str:
        return self.kind if self.index is None else f"{self.kind}:{self.index}"


#: `cpu` 는 유일하게 언제나 존재하는 디바이스라 상수로 둔다.
CPU = Device("cpu")


@dataclass(frozen=True)
class DevicePlan:
    """해석이 끝난 실행 계획. **노드가 보는 유일한 디바이스 정보**다.

    "어느 백엔드인가" 가 아니라 "무엇을 어디에 두는가" 로 표현한다. 노드가
    백엔드 이름으로 분기하지 못하게 하는 것이 요점이다.

    Attributes:
        compute: forward 가 도는 곳.
        offload: 안 쓰는 가중치가 앉아 있는 곳. 보통 `cpu` 이고, 오프로드를
            하지 않으면 `compute` 와 같다.
        dtype: 가중치·활성의 dtype. `DTYPES` 중 하나.

    `offload == compute` 이면 오프로드가 꺼진 것이다. 별도 불리언을 두지 않는
    이유는 그 둘이 어긋날 수 있기 때문이다 — 상태는 한 곳에만 있어야 한다.
    """

    compute: Device
    offload: Device = CPU
    dtype: str = "float32"

    def __post_init__(self) -> None:
        if self.dtype not in DTYPES:
            allowed = ", ".join(DTYPES)
            raise ValueError(f"알 수 없는 dtype: {self.dtype!r}. 허용: {allowed}")

    @property
    def offloading(self) -> bool:
        """가중치가 `compute` 밖에 앉아 있는가."""
        return self.offload != self.compute


class ModelLoadError(Exception):
    """체크포인트를 로드하지 못했다. **무엇을 추론하려 했는지 말한다.**

    이 에러가 따로 있는 이유는 하나다 — `diffusers.single_file` 로더는 파일
    안의 텐서 키를 보고 아키텍처를 **추론**하는데, 실사용에서 가장 자주 깨지는
    지점이 바로 그 추론이다. "체크포인트 로드 실패" 라고만 하면 사용자는 파일이
    깨진 것인지, 지원하지 않는 아키텍처인지, 컴포넌트가 빠진 것인지 알 수 없다.

    그래서 **네 가지를 반드시 싣는다**: 무엇을 읽었는지(`ref`), 어느 로더로
    읽었는지(`loader`), 무엇으로 추론했는지(`inferred` — 실패했으면 `None`),
    무엇을 기대했는지(`expected`). 증거(`evidence`)는 있으면 싣는다 — 파일에서
    실제로 본 텐서 키 접두사 같은 것으로, 사용자가 "아 이건 그 모델이 아니구나"
    를 스스로 판단할 수 있게 하는 유일한 재료다.

    노드 ID 는 여기서 붙이지 않는다. 실행 루프가 `NodeExecutionError` 로 감싸며
    붙인다 (`executor.py`) — 저장소는 자기를 누가 불렀는지 모른다.

    Attributes:
        ref: 로드하려던 대상. 파일 경로이거나 diffusers 저장소 ID.
        loader: 시도한 로더 이름 (`"diffusers.single_file"` 등).
        reason: 사람이 읽는 실패 사유 한 줄.
        inferred: 추론된 아키텍처 이름. **추론 자체가 실패했으면 `None`** 이고,
            그것이 `None` 과 문자열을 구분하는 이유다.
        expected: 이 로더가 인식할 수 있는 아키텍처들.
        evidence: 추론의 근거. 파일에서 실제로 관찰한 것들.
    """

    def __init__(
        self,
        ref: str,
        *,
        loader: str,
        reason: str,
        inferred: str | None = None,
        expected: tuple[str, ...] = (),
        evidence: tuple[str, ...] = (),
    ) -> None:
        self.ref = ref
        self.loader = loader
        self.reason = reason
        self.inferred = inferred
        self.expected = expected
        self.evidence = evidence
        super().__init__(self._message())

    def _message(self) -> str:
        lines = [f"{self.ref!r} 를 {self.loader!r} 로 로드하지 못했다: {self.reason}"]
        if self.inferred is None:
            lines.append("  추론된 아키텍처: 없음 — 알려진 어느 것과도 맞지 않았다")
        else:
            lines.append(f"  추론된 아키텍처: {self.inferred}")
        if self.expected:
            lines.append(f"  이 로더가 아는 것: {', '.join(self.expected)}")
        if self.evidence:
            lines.append(f"  파일에서 관찰한 것: {', '.join(self.evidence)}")
        return "\n".join(lines)


@runtime_checkable
class ModelStore(Protocol):
    """모델 로딩 · 캐시 · 오프로딩 (design.md §9).

    **표면을 최소로 유지한다 — 노드가 실제로 부르는 것만 둔다.** 참조 카운팅 ·
    LRU 언로드 · mmap 은 구현의 책임이고 노드가 부르지 않으므로 여기에 없다.
    Protocol 은 메서드 추가가 비파괴적이므로 필요해지면 그때 넓힌다. 반대로
    한번 넓힌 것을 좁히는 것은 노드 팩을 깨뜨린다.

    구현은 `packages/nodes-diffusion` 에 있다.
    """

    @property
    def plan(self) -> DevicePlan:
        """이 실행의 디바이스 계획. 실행 중에 바뀌지 않는다."""
        ...

    def load(self, ref: str, *, loader: str) -> Any:
        """모델을 로드하고 **불투명 핸들**을 돌려준다.

        같은 `(ref, loader)` 를 두 번 부르면 같은 핸들이 나온다 — 여러 노드가
        한 체크포인트를 공유해도 한 번만 로드된다.

        Args:
            ref: 파일 경로(단일 파일 체크포인트) 또는 diffusers 저장소 ID·폴더.
            loader: 로더 이름. `"diffusers.single_file"` 은 단일 `.safetensors`
                에서 아키텍처를 **추론**하고, `"diffusers.pretrained"` 는
                `model_index.json` 이 있는 폴더를 읽는다. 둘은 다른 경로다.

        Returns:
            노드 팩이 아는 핸들. core 는 그 모양을 모른다.

        Raises:
            ModelLoadError: 언제나 이것으로 실패한다. 아키텍처 추론이 깨졌으면
                무엇을 추론하려 했는지 에러가 말한다.
        """
        ...


class NullModelStore:
    """아무것도 로드하지 않는 저장소.

    저장소 없이 실행할 때의 기본값이다 (CLI, 단위 테스트). `load` 가 조용히
    `None` 을 돌려주는 대신 **명시적으로 실패한다** — `NullAssetStore` 와 같은
    이유다. 모델을 로드했다고 믿었는데 `None` 이 흘러가면 훨씬 뒤에서 터진다.

    `plan` 은 CPU 계획을 돌려준다. 여기서도 터지게 하면 "디바이스가 무엇인지
    묻는 것" 만으로 실패하게 되는데, 그것은 물어볼 수 있어야 하는 질문이다.
    """

    @property
    def plan(self) -> DevicePlan:
        return DevicePlan(compute=CPU, offload=CPU, dtype="float32")

    def load(self, ref: str, *, loader: str) -> Any:
        raise ModelLoadError(
            ref,
            loader=loader,
            reason=(
                "이 실행에는 모델 저장소가 없다. "
                "서버로 실행하거나 ctx.models 를 주입하라 "
                "(uv sync --group diffusion 으로 diffusion 노드 팩을 설치한다)"
            ),
        )
