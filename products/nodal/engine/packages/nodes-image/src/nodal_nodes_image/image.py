"""Image 런타임 표현과 변환 (docs/design.md §4.4).

계약은 하나다 — 소켓을 흐르는 이미지는 **`float32`, 값 범위 0.0..1.0,
축 순서 `(B, H, W, C)`** 인 numpy 배열이다. `uint8` 은 파일 입출력 경계에서만
나타나고 소켓으로 흐르지 않는다.

배치 축을 언제나 두는 이유는 배치가 특별 케이스가 되지 않게 하기 위해서다.
"한 장일 때만 다른 shape" 는 M4 의 샘플러가 배치를 돌려주는 순간 전부 분기가 된다.

**범위 밖 값 처리** — 계약대로 클립한다. 연산 결과가 0..1 을 벗어나는 것은
정상이지만(밝기 합성, 곱셈), 소켓으로 나갈 때는 언제나 0..1 이다. 클립하지 않으면
다음 노드가 uint8 로 바꾸는 순간 래핑되어 검은 점으로 나타난다 — 원인을 찾기
어려운 종류의 버그다.
"""

from __future__ import annotations

from typing import Any, TypeAlias

import numpy as np
from PIL import Image as PILImage

__all__ = [
    "CHANNELS",
    "ImageArray",
    "MaskArray",
    "clip01",
    "ensure_batch",
    "from_pil",
    "to_float32",
    "to_pil",
    "to_uint8",
]

#: 소켓을 흐르는 이미지의 **실제** 파이썬 타입.
#:
#: `nodal.Image.T` 는 core 쪽 표기이고 언제나 `Any` 다 — core 는 numpy 를 모른다
#: (design.md §4.4). 노드 팩 안에서는 이 별칭을 쓴다. dtype 이 타입에 박혀 있어서
#: `a / 255.0` 처럼 **float64 로 승격되는 실수를 mypy 가 잡는다** — 0..1 정규화에서
#: 가장 흔한 버그다.
#:
#: 랭크(4)와 shape 은 타입으로 표현되지 않는다. numpy 의 타입 시스템이 아직 shape 을
#: 검사하지 못하기 때문이다. 그쪽은 `ensure_batch` · `to_float32` 의 런타임 검증이
#: 담당한다 — 둘은 대체재가 아니라 분담이다.
ImageArray: TypeAlias = np.ndarray[Any, np.dtype[np.float32]]

#: 마스크. `(B, H, W)` 로 채널 축이 없다 (design.md §4.4).
MaskArray: TypeAlias = np.ndarray[Any, np.dtype[np.float32]]

#: 허용 채널 수 — L(1) · RGB(3) · RGBA(4).
CHANNELS = (1, 3, 4)

#: 소켓을 흐르는 이미지의 dtype. 계약이다.
_DTYPE = np.float32


def clip01(array: np.ndarray[Any, Any]) -> ImageArray:
    """0.0..1.0 으로 클립한다. 소켓으로 내보내기 직전에 부른다."""
    clipped: ImageArray = np.clip(array, 0.0, 1.0, dtype=_DTYPE, casting="unsafe")
    return clipped


def ensure_batch(array: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    """`(H, W, C)` 를 `(1, H, W, C)` 로 만든다. 이미 4D 면 그대로.

    Raises:
        ValueError: 랭크가 3도 4도 아닐 때.
    """
    if array.ndim == 4:
        return array
    if array.ndim == 3:
        return array[np.newaxis, ...]
    raise ValueError(f"이미지는 (B, H, W, C) 또는 (H, W, C) 여야 한다. 받은 shape: {array.shape}")


def to_float32(array: np.ndarray[Any, Any]) -> ImageArray:
    """어떤 이미지 배열이든 계약 형태(`float32` 0..1, `(B,H,W,C)`)로 만든다.

    `uint8` 은 255 로 나눠 정규화한다. 이미 실수형이면 값 범위만 맞춘다.

    Raises:
        ValueError: 채널 수가 1·3·4 가 아닐 때.
    """
    batched = ensure_batch(array)
    normalized: ImageArray = (
        (batched / np.float32(255.0)).astype(_DTYPE)
        if batched.dtype == np.uint8
        else batched.astype(_DTYPE, copy=False)
    )
    channels = normalized.shape[-1]
    if channels not in CHANNELS:
        raise ValueError(f"채널 수는 {CHANNELS} 중 하나여야 한다. 받은 값: {channels}")
    return clip01(normalized)


def to_uint8(array: np.ndarray[Any, Any]) -> np.ndarray[Any, np.dtype[np.uint8]]:
    """계약 형태 → `uint8` 0..255. 파일로 나갈 때만 쓴다.

    반올림 후 클립한다. 0.5 를 그냥 자르면 흰색이 254 가 되어 왕복이 어긋난다.
    """
    scaled = clip01(to_float32(array)) * 255.0
    rounded: np.ndarray[Any, np.dtype[np.uint8]] = np.rint(scaled).astype(np.uint8)
    return rounded


def from_pil(image: PILImage.Image) -> ImageArray:
    """PIL 이미지를 계약 형태로. **Load 노드 경계에서만 쓴다.**

    팔레트·1비트 같은 모드는 RGB(A) 로 펼친다. 알파가 있으면 RGBA 를 유지한다 —
    합성 노드가 쓸 정보를 여기서 버리지 않는다.
    """
    mode = image.mode
    if mode not in ("L", "RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in mode or mode == "P" else "RGB")
    array = np.asarray(image)
    if array.ndim == 2:  # L 은 채널 축이 없다
        array = array[..., np.newaxis]
    return to_float32(array)


def to_pil(array: ImageArray, index: int = 0) -> PILImage.Image:
    """계약 형태의 배치에서 한 장을 PIL 로. **Save/인코딩 경계에서만 쓴다.**

    Args:
        array: `(B, H, W, C)` float32.
        index: 배치에서 꺼낼 장 번호.
    """
    frame = to_uint8(array)[index]
    channels = frame.shape[-1]
    if channels == 1:
        return PILImage.fromarray(frame[..., 0], mode="L")
    return PILImage.fromarray(frame, mode="RGB" if channels == 3 else "RGBA")
