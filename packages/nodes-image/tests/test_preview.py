"""이미지·마스크 프리뷰의 크기 경계와 배열 형상 계약."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image as PILImage

from nodal_nodes_image import PREVIEW_MAX_EDGE, encode_mask_preview, encode_ndarray_preview


@pytest.mark.parametrize("edge", [PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE * 2])
def test_mask_preview_preserves_channel_shape_across_resize_boundary(edge: int) -> None:
    mask = np.zeros((1, edge, edge), dtype=np.float32)

    preview = encode_mask_preview(mask)

    assert preview is not None
    assert (preview.width, preview.height) == (
        min(edge, PREVIEW_MAX_EDGE),
        min(edge, PREVIEW_MAX_EDGE),
    )
    with PILImage.open(io.BytesIO(preview.data)) as image:
        assert image.mode == "L"
        assert image.size == (preview.width, preview.height)


@pytest.mark.parametrize("edge", [PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE * 2])
def test_single_channel_image_preview_preserves_shape_across_resize_boundary(edge: int) -> None:
    image = np.zeros((1, edge, edge, 1), dtype=np.float32)

    preview = encode_ndarray_preview(image)

    assert preview is not None
    assert (preview.width, preview.height) == (
        min(edge, PREVIEW_MAX_EDGE),
        min(edge, PREVIEW_MAX_EDGE),
    )
    with PILImage.open(io.BytesIO(preview.data)) as encoded:
        assert encoded.mode == "L"
        assert encoded.size == (preview.width, preview.height)
