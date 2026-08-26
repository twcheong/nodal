"""nodal 이미지 노드 팩 (roadmap M3).

**import 하는 것만으로 프리뷰 인코더가 등록된다.** core 는 numpy 를 모르므로
`ndarray → PNG` 를 할 수 없고, `server` 도 `core` 만 의존하므로 마찬가지다.
그래서 노드 팩이 인코더를 넣고 core 는 부르기만 한다 (design.md §4.6) —
`register_combo_provider()` 와 같은 패턴이다.

    import nodal_nodes_image          # 인코더 등록됨
    reg = nodal_nodes_image.registry()  # 노드 7종이 든 레지스트리
"""

from __future__ import annotations

from typing import Any

import numpy as np

from nodal import EncodedPreview, NodeRegistry, register_preview_encoder

from .image import CHANNELS, ImageArray, MaskArray, from_pil, to_float32, to_pil
from .nodes import (
    NODES,
    BlendImages,
    CompositeImages,
    CropImage,
    LoadImage,
    MaskFromImage,
    ResizeImage,
    SaveImage,
)
from .png import VERSION_KEY, WORKFLOW_KEY, encode_png

__all__ = [
    "NODES",
    "VERSION_KEY",
    "WORKFLOW_KEY",
    "BlendImages",
    "CompositeImages",
    "CropImage",
    "ImageArray",
    "LoadImage",
    "MaskArray",
    "MaskFromImage",
    "ResizeImage",
    "SaveImage",
    "encode_mask_preview",
    "encode_ndarray_preview",
    "encode_png",
    "registry",
]

#: 프리뷰를 이 변보다 크게 만들지 않는다. 노드 안에 그리는 그림이라 원본 해상도가
#: 필요 없고, WS 로 나가는 data URI 가 작을수록 좋다.
PREVIEW_MAX_EDGE = 512


def _resize_preview(array: ImageArray) -> ImageArray:
    """첫 프레임을 프리뷰 크기로 줄이고 `(B,H,W,C)` 계약을 복원한다."""
    height, width = int(array.shape[1]), int(array.shape[2])
    longest = max(height, width)
    if longest <= PREVIEW_MAX_EDGE:
        return array

    scale = PREVIEW_MAX_EDGE / longest
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    from PIL import Image as PILImage

    thumb = to_pil(array).resize(target, PILImage.Resampling.BILINEAR)
    return from_pil(thumb)


@register_preview_encoder
def encode_ndarray_preview(value: Any) -> EncodedPreview | None:
    """`ndarray` → PNG 프리뷰. 처리할 수 없는 값이면 `None` 을 돌려준다.

    `None` 을 돌려주는 것이 중요하다 — 모델 핸들처럼 이미지가 아닌 값이 왔을 때
    다음 인코더에 기회를 넘겨야 한다 (`preview.py`).
    """
    if not isinstance(value, np.ndarray):
        return None
    if value.ndim not in (3, 4):
        return None
    try:
        array = to_float32(value)
    except ValueError:
        return None

    array = _resize_preview(array)
    height, width = int(array.shape[1]), int(array.shape[2])

    return EncodedPreview(
        data=encode_png(array),
        media_type="image/png",
        width=width,
        height=height,
    )


@register_preview_encoder
def encode_mask_preview(value: Any) -> EncodedPreview | None:
    """`(B, H, W)` 마스크(채널 축 없음) → 그레이스케일 PNG 프리뷰.

    `encode_ndarray_preview` 는 마지막 축을 채널로 본다. 마스크는 채널 축이
    없어 그 자리에 폭(W)이 오고, 폭이 1·3·4 가 아니면 `to_float32` 가 "채널 수가
    이상하다" 며 거부해 `None` 을 돌려준다 — 그러면 처리할 인코더가 하나도
    남지 않는다. `image.Mask` 의 출력 소켓 타입은 텐서라 실행 엔진을 지날 때
    프리뷰가 **필수**이므로(`_output_refs`, design.md §4.6), 그 실패가 곧
    "Mask 를 쓰는 그래프는 실행 자체가 안 된다" 였다.

    진짜 `(H, W, C)` 단일 이미지(채널이 1·3·4)는 여기서 `None` 을 돌려줘
    `encode_ndarray_preview` 에 넘긴다 — 배치 하나뿐인 마스크와 채널 없는
    단일 이미지가 shape 만으로 갈리는 유일한 경계가 그 채널 수다.
    """
    if not isinstance(value, np.ndarray):
        return None
    if value.ndim != 3 or value.shape[-1] in CHANNELS:
        return None

    frame = np.clip(value[0], 0.0, 1.0).astype(np.float32, copy=False)
    array = frame[np.newaxis, ..., np.newaxis]  # (1, H, W, 1) — 흑백 프리뷰
    array = _resize_preview(array)
    height, width = int(array.shape[1]), int(array.shape[2])

    return EncodedPreview(
        data=encode_png(array),
        media_type="image/png",
        width=width,
        height=height,
    )


def registry(into: NodeRegistry | None = None) -> NodeRegistry:
    """이 팩의 노드를 담은 레지스트리를 돌려준다.

    Args:
        into: 채울 레지스트리. 없으면 새로 만든다. 여러 팩을 합칠 때 넘긴다.
    """
    target = into if into is not None else NodeRegistry()
    for node_class in NODES:
        target.register(node_class)
    return target
