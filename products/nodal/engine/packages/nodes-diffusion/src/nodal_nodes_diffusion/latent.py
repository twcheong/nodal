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

__all__ = [
    "LATENT_CHANNELS",
    "VAE_SCALE_FACTOR",
    "LatentTensor",
    "encode_latent_preview",
    "latent_preview",
    "latent_size",
]

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


def latent_preview(latent: LatentTensor, vae: Any, *, max_edge: int = 256) -> Any:
    """스텝 프리뷰용 이미지. **새 전송 형식을 만들지 않는다** (design.md §9.5).

    잠재를 VAE 로 디코드해 §4.4 의 이미지 계약(`(B, H, W, C)` float32 0..1)을
    만족하는 ndarray 로 만든다. 그러면 M3 에서 `nodal_nodes_image` 가 등록한
    프리뷰 인코더가 **아무 변경 없이** 받아 PNG 로 만든다.

    ## 왜 계수 표를 쓰지 않는가

    잠재를 선형 사상으로 근사하면 VAE 없이도 대략의 색을 만들 수 있고, 그것이
    흔한 방법이다. 하지만 **계수 표를 가져오는 것은 코드 복사다** — 숫자 몇
    개라 자각 없이 옮기게 되는 자리이고, `AGENTS.md` 절대 규칙 1 이 정확히
    이것을 경고한다.

    우리는 그럴 필요가 없다. `LoadCheckpoint` 가 낸 세 핸들이 같은 파이프라인을
    가리키므로 (`handles.py`) `KSampler` 가 VAE 에 닿을 수 있다. 진짜 디코더를
    쓰면 색도 정확하다.

    비용은 스텝마다가 아니라 `PREVIEW_COUNT` 번만 치른다. 첫 배치 한 장만
    디코드하는 것도 같은 이유다 — 프리뷰는 진행 상황이지 결과물이 아니다.

    실패하면 `None` 이다. 프리뷰 때문에 생성이 죽는 것은 앞뒤가 바뀐 것이다.
    """
    try:
        import numpy as np
        import torch

        first = latent[:1]
        scaling = float(getattr(vae.config, "scaling_factor", 1.0))
        shift = float(getattr(vae.config, "shift_factor", 0.0) or 0.0)

        with torch.no_grad():
            scaled = first.to(device=vae.device, dtype=vae.dtype) / scaling + shift
            decoded = vae.decode(scaled).sample

        image = (decoded / 2 + 0.5).clamp(0, 1)
        image = _shrink(image, max_edge)
        return image.permute(0, 2, 3, 1).float().cpu().numpy().astype(np.float32)
    except Exception:
        # 프리뷰 실패는 생성 실패가 아니다. 어떤 예외든 삼키고 진행률만 보낸다.
        # 인코더가 없을 때 core 가 이벤트를 안 보내는 것과 같은 방침 (§4.6).
        return None


def _shrink(image: Any, max_edge: int) -> Any:
    """긴 변이 `max_edge` 를 넘으면 줄인다. WS 로 나가는 data URI 를 작게 유지한다."""
    import torch.nn.functional as functional

    height, width = int(image.shape[-2]), int(image.shape[-1])
    longest = max(height, width)
    if longest <= max_edge:
        return image
    scale = max_edge / longest
    size = (max(1, int(height * scale)), max(1, int(width * scale)))
    return functional.interpolate(image, size=size, mode="bilinear", align_corners=False)


def encode_latent_preview(value: Any) -> Any:
    """`Latent` 소켓의 썸네일. **구조는 보이지만 색은 최종 결과와 다르다.**

    core 는 텐서 타입 출력에 프리뷰를 **요구한다** (M3, `executor._output_refs`).
    그 규칙은 "노드 팩이 인코더 등록을 잊었다" 를 잡으려고 있고, `Image` 에는
    맞다. 그런데 `Latent` 는 **VAE 없이는 그릴 수 없다** — 잠재 텐서 하나만으로는
    무엇을 그려야 할지 정해지지 않는다.

    그래서 여기서는 색을 맞추려 하지 않고 **텐서를 있는 그대로 보여준다**:
    앞 세 채널을 각각 0..1 로 정규화해 RGB 로 놓는다. 구도가 잡히는 것은 보이고,
    색이 최종 이미지와 다르다는 것은 문서와 UI 문구가 말한다.

    **계수 표를 쓰지 않는 이유**: 잠재를 선형 사상으로 근사하면 대략의 색을 낼 수
    있고 그것이 흔한 방법이지만, 계수를 가져오는 것은 코드 복사다 — 숫자 몇 개라
    자각 없이 옮기게 되는 자리이고 `AGENTS.md` 절대 규칙 1 이 정확히 이것을
    경고한다.

    색이 정확한 프리뷰는 **샘플링 중**에 나간다. 그때는 `KSampler` 가 VAE 에
    닿을 수 있어서 진짜로 디코드한다 (`latent_preview`, design.md §9.5).

    처리할 수 없는 값이면 `None` 이다 — 다른 인코더가 볼 차례를 준다.
    """
    tensor = _as_latent(value)
    if tensor is None:
        return None

    import numpy as np

    array = tensor[0].detach().float().cpu().numpy()  # (C, H, W)
    channels = [_normalize(array[i]) for i in range(min(3, array.shape[0]))]
    while len(channels) < 3:
        channels.append(channels[0])
    rgb = np.stack(channels, axis=-1)  # (H, W, 3)
    return _png_preview((rgb * 255).round().astype(np.uint8))


def _as_latent(value: Any) -> Any:
    """`(B, C, H, W)` torch 텐서면 그대로, 아니면 `None`.

    torch 를 늦게 import 한다 — 이 팩은 런타임 없이도 import 되어야 한다.
    """
    try:
        import torch
    except ImportError:  # pragma: no cover - 런타임 미설치
        return None
    if not isinstance(value, torch.Tensor) or value.ndim != 4:
        return None
    return value


def _normalize(plane: Any) -> Any:
    """한 채널을 0..1 로. 전부 같은 값이면 가운데 회색으로 둔다."""
    import numpy as np

    low, high = float(plane.min()), float(plane.max())
    if high - low < 1e-8:
        return np.full_like(plane, 0.5, dtype=np.float32)
    return ((plane - low) / (high - low)).astype(np.float32)


def _png_preview(rgb: Any) -> Any:
    """`(H, W, 3)` uint8 → PNG `EncodedPreview`.

    `nodal_nodes_image` 에도 비슷한 코드가 있지만 부르지 않는다 — 노드 팩끼리는
    서로를 몰라야 한다 (AGENTS.md 아키텍처 절). 열 줄을 중복하는 편이 팩 사이
    의존성을 만드는 것보다 싸다.
    """
    import io

    from PIL import Image as PILImage

    from nodal import EncodedPreview

    height, width = int(rgb.shape[0]), int(rgb.shape[1])
    buffer = io.BytesIO()
    PILImage.fromarray(rgb, mode="RGB").save(buffer, format="PNG")
    return EncodedPreview(
        data=buffer.getvalue(), media_type="image/png", width=width, height=height
    )
