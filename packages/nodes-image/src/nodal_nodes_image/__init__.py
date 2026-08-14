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

from .image import to_float32
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
    "LoadImage",
    "MaskFromImage",
    "ResizeImage",
    "SaveImage",
    "encode_ndarray_preview",
    "encode_png",
    "registry",
]

#: 프리뷰를 이 변보다 크게 만들지 않는다. 노드 안에 그리는 그림이라 원본 해상도가
#: 필요 없고, WS 로 나가는 data URI 가 작을수록 좋다.
PREVIEW_MAX_EDGE = 512


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

    height, width = int(array.shape[1]), int(array.shape[2])
    longest = max(height, width)
    if longest > PREVIEW_MAX_EDGE:
        scale = PREVIEW_MAX_EDGE / longest
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        from PIL import Image as PILImage

        from .image import to_pil

        thumb = to_pil(array).resize(target, PILImage.Resampling.BILINEAR)
        array = to_float32(np.asarray(thumb))
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
