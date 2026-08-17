"""잠재 텐서의 런타임 표현과 프리뷰 변환 (M4).

`Latent` 카탈로그 타입은 `types.json` 이 `Tensor[float16|float32, (B, C, H, W)]`
로 서술한다. **런타임 표현은 `torch.Tensor`** 이고, 그것을 소유하는 것은 이
팩이다 (`decisions.md` 2026-08-15 의 `<Type>Tensor` 명명 규칙).

## `ImageArray` 와 다른 점

`nodal_nodes_image` 의 `ImageArray` 는 진짜 런타임 별칭이다 — numpy 가 그
패키지의 하드 의존성이라 언제나 있다. 여기서는 torch 가 **옵트인**이라
(`uv sync --group diffusion`) 모듈 최상단에서 import 할 수 없다. 그래서
`LatentTensor` 는 타입 검사 때만 진짜 타입이고 런타임에는 `Any` 다.

거짓말처럼 보이지만 아니다. mypy 는 diffusion 잡에서 torch 가 설치된 채로
돌므로 **타입 검사는 진짜로 이루어진다**. 런타임의 `Any` 는 "이 환경에는 torch
가 없고, 없으면 어차피 이 값이 만들어지지 않는다" 는 뜻이다.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import torch

    #: 잠재 텐서. `(B, C, H, W)`, `float16` 또는 `float32`.
    LatentTensor = torch.Tensor
else:
    LatentTensor = Any

__all__ = ["LATENT_CHANNELS", "VAE_SCALE_FACTOR", "LatentTensor", "latent_size"]

#: VAE 가 공간 해상도를 줄이는 비율. SD1.5 · SDXL · SD3 전부 8 이다.
#: 픽셀 1024 → 잠재 128.
VAE_SCALE_FACTOR = 8

#: 잠재 채널 수. SD1.5 · SDXL 은 4, SD3 · FLUX 는 16 이다.
#:
#: **여기 상수로 둔 것은 임시다.** 올바른 값은 체크포인트가 정하므로 M4 구현에서
#: `ctx.models` 가 로드한 핸들에서 읽어야 한다. 지금 4 로 두는 이유는 이 커밋의
#: 목적이 스키마 노출이고, 값이 바뀌어도 **소켓 타입은 그대로**이기 때문이다 —
#: 프론트가 다시 그릴 일이 없다.
LATENT_CHANNELS = 4


def latent_size(width: int, height: int) -> tuple[int, int]:
    """픽셀 크기 → 잠재 크기. 나누어떨어지지 않으면 그 자리에서 실패한다.

    조용히 반올림하면 사용자가 1000x1000 을 넣고 1024x1024 결과를 받는다.
    어느 쪽이든 놀라게 되므로 **입력한 값과 다른 크기가 나온 이유**를 말하는 편이
    낫다 (AGENTS.md 코딩 컨벤션 — 익명 에러 금지).
    """
    for label, value in (("width", width), ("height", height)):
        if value <= 0:
            raise ValueError(f"{label} 는 양수여야 한다: {value}")
        if value % VAE_SCALE_FACTOR:
            raise ValueError(
                f"{label}={value} 는 {VAE_SCALE_FACTOR} 의 배수가 아니다. "
                f"VAE 가 공간 해상도를 정확히 {VAE_SCALE_FACTOR} 배로 줄이므로 "
                f"나누어떨어져야 한다. 가까운 값: "
                f"{value // VAE_SCALE_FACTOR * VAE_SCALE_FACTOR}"
            )
    return height // VAE_SCALE_FACTOR, width // VAE_SCALE_FACTOR
