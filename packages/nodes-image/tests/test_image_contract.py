"""`design.md` §4.4 의 Image 계약을 고정한다.

이 파일이 지키는 것은 하나다 — **소켓을 흐르는 이미지는 언제나 `float32` 0..1,
`(B, H, W, C)`**. 노드가 늘어나도 이 성질이 깨지지 않아야 한다.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image as PILImage
from preview_encoder_fixture import ensure_preview_encoder_registered  # noqa: F401

from nodal_nodes_image.image import clip01, ensure_batch, from_pil, to_float32, to_pil, to_uint8


def test_uint8_is_normalized_to_unit_range() -> None:
    source = np.array([[[0, 128, 255]]], dtype=np.uint8)  # (1, 1, 3) = (H, W, C)

    out = to_float32(source)

    assert out.dtype == np.float32
    assert out.shape == (1, 1, 1, 3)  # 배치 축이 붙는다
    assert out[0, 0, 0, 0] == pytest.approx(0.0)
    assert out[0, 0, 0, 2] == pytest.approx(1.0)


def test_batch_axis_is_always_present() -> None:
    assert ensure_batch(np.zeros((4, 4, 3), dtype=np.float32)).shape == (1, 4, 4, 3)
    assert ensure_batch(np.zeros((2, 4, 4, 3), dtype=np.float32)).shape == (2, 4, 4, 3)


def test_rank_2_is_rejected_with_a_useful_message() -> None:
    with pytest.raises(ValueError, match=r"\(B, H, W, C\)"):
        ensure_batch(np.zeros((4, 4), dtype=np.float32))


def test_out_of_range_values_are_clipped_not_wrapped() -> None:
    """범위 밖 값은 **클립**한다. 래핑하면 밝은 곳이 검게 나타난다."""
    source = np.array([[[[-0.5, 0.5, 1.7]]]], dtype=np.float32)

    out = clip01(source)

    assert out[0, 0, 0, 0] == pytest.approx(0.0)
    assert out[0, 0, 0, 1] == pytest.approx(0.5)
    assert out[0, 0, 0, 2] == pytest.approx(1.0)


def test_uint8_roundtrip_preserves_endpoints() -> None:
    """0 과 255 가 왕복에서 살아남아야 한다. 자르기(truncate)면 흰색이 254 가 된다."""
    source = np.array([[[0, 1, 128, 254, 255]]], dtype=np.uint8).reshape(1, 1, 5, 1)

    out = to_uint8(to_float32(source))

    np.testing.assert_array_equal(out.reshape(-1), [0, 1, 128, 254, 255])


def test_unsupported_channel_count_is_rejected() -> None:
    with pytest.raises(ValueError, match="채널 수"):
        to_float32(np.zeros((1, 2, 2, 5), dtype=np.float32))


@pytest.mark.parametrize(("mode", "channels"), [("L", 1), ("RGB", 3), ("RGBA", 4)])
def test_pil_modes_map_to_expected_channel_counts(mode: str, channels: int) -> None:
    image = PILImage.new(mode, (3, 2))

    out = from_pil(image)

    assert out.shape == (1, 2, 3, channels)
    assert out.dtype == np.float32


def test_palette_images_are_expanded_not_dropped() -> None:
    """팔레트(P)는 RGB 로 펼친다. 그대로 두면 인덱스가 픽셀값으로 오해된다."""
    out = from_pil(PILImage.new("P", (2, 2)))

    assert out.shape[-1] in (3, 4)


def test_to_pil_roundtrip_keeps_pixels() -> None:
    source = np.linspace(0.0, 1.0, 2 * 3 * 3, dtype=np.float32).reshape(1, 2, 3, 3)

    restored = from_pil(to_pil(source))

    np.testing.assert_allclose(restored, source, atol=1 / 255)
