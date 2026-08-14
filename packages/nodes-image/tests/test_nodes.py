"""노드 7종의 단위 테스트.

`run` 은 평범한 함수라 엔진 없이 그냥 부른다 (AGENTS.md 코딩 컨벤션).
`SaveImage` 만 `ctx` 를 받으므로 가짜 컨텍스트를 넘긴다.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image as PILImage
from preview_encoder_fixture import ensure_preview_encoder_registered  # noqa: F401

from nodal_nodes_image import (
    BlendImages,
    CompositeImages,
    CropImage,
    LoadImage,
    MaskFromImage,
    ResizeImage,
)


def solid(value: float, size: tuple[int, int] = (4, 4), channels: int = 3) -> np.ndarray:
    height, width = size
    return np.full((1, height, width, channels), value, dtype=np.float32)


# ------------------------------------------------------------------ Load


def test_load_normalizes_uint8_png(tmp_path) -> None:
    path = tmp_path / "red.png"
    PILImage.new("RGB", (3, 2), (255, 0, 0)).save(path)

    out = LoadImage().run(str(path)).values[0]

    assert out.shape == (1, 2, 3, 3)
    assert out.dtype == np.float32
    assert out[0, 0, 0, 0] == pytest.approx(1.0)
    assert out[0, 0, 0, 1] == pytest.approx(0.0)


def test_load_reads_jpeg(tmp_path) -> None:
    path = tmp_path / "gray.jpg"
    PILImage.new("RGB", (4, 4), (128, 128, 128)).save(path)

    out = LoadImage().run(str(path)).values[0]

    assert out.dtype == np.float32
    assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0


def test_load_rejects_empty_path() -> None:
    with pytest.raises(ValueError, match="경로"):
        LoadImage().run("")


# ---------------------------------------------------------------- Resize


def test_resize_changes_shape_and_keeps_range() -> None:
    out = ResizeImage().run(solid(0.5, (4, 4)), 8, 6, "bilinear").values[0]

    assert out.shape == (1, 6, 8, 3)
    assert out.dtype == np.float32
    assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0
    # 단색이므로 리샘플 후에도 값이 유지돼야 한다 (uint8 왕복이 없다는 증거).
    assert out[0, 0, 0, 0] == pytest.approx(0.5, abs=1e-3)


def test_resize_preserves_float_precision() -> None:
    """uint8 을 거치면 1/255 격자에 스냅된다. 그러지 않는지 본다."""
    out = ResizeImage().run(solid(0.4999), 2, 2, "nearest").values[0]

    assert out[0, 0, 0, 0] != pytest.approx(round(0.4999 * 255) / 255, abs=1e-7)


def test_resize_handles_batches() -> None:
    batch = np.concatenate([solid(0.2), solid(0.8)], axis=0)

    out = ResizeImage().run(batch, 2, 2, "nearest").values[0]

    assert out.shape == (2, 2, 2, 3)


# ------------------------------------------------------------------ Crop


def test_crop_extracts_region() -> None:
    source = np.arange(16, dtype=np.float32).reshape(1, 4, 4, 1) / 16.0

    out = CropImage().run(source, 1, 1, 2, 2).values[0]

    assert out.shape == (1, 2, 2, 1)
    assert out[0, 0, 0, 0] == pytest.approx(source[0, 1, 1, 0])


def test_crop_clamps_to_image_bounds() -> None:
    out = CropImage().run(solid(1.0, (4, 4)), 2, 2, 99, 99).values[0]

    assert out.shape == (1, 2, 2, 3)


def test_crop_origin_past_the_edge_clamps_to_last_pixel() -> None:
    """원점이 이미지를 벗어나도 빈 결과를 내지 않는다 — 마지막 픽셀로 붙는다.

    빈 결과를 돌려주면 다음 노드가 shape 0 을 만나 엉뚱한 곳에서 터진다.
    """
    out = CropImage().run(solid(1.0, (4, 4)), 4, 4, 2, 2).values[0]

    assert out.shape == (1, 1, 1, 3)


# ----------------------------------------------------------------- Blend


@pytest.mark.parametrize(
    ("a", "b", "mode", "expected"),
    [
        # out = a*(1-f) + mix*f, f=0.5
        (0.5, 1.0, "normal", 0.75),  # mix = b
        (0.5, 0.8, "add", 0.9),  # mix = 1.3 → 클립 전 합
        (0.5, 0.5, "multiply", 0.375),  # mix = 0.25
        (0.5, 0.5, "screen", 0.625),  # mix = 0.75
        (0.5, 0.2, "difference", 0.4),  # mix = 0.3
    ],
)
def test_blend_modes(a: float, b: float, mode: str, expected: float) -> None:
    out = BlendImages().run(solid(a), solid(b), 0.5, mode).values[0]

    assert out[0, 0, 0, 0] == pytest.approx(expected, abs=1e-6)


def test_blend_add_is_clipped_at_one() -> None:
    """더하기는 1을 넘을 수 있다. 소켓으로 나갈 때는 언제나 0..1 이다."""
    out = BlendImages().run(solid(0.9), solid(0.9), 1.0, "add").values[0]

    assert float(out.max()) == pytest.approx(1.0)


def test_blend_rejects_size_mismatch_pointing_at_the_fix() -> None:
    with pytest.raises(ValueError, match="Resize"):
        BlendImages().run(solid(0.5, (4, 4)), solid(0.5, (8, 8)), 0.5, "normal")


def test_blend_matches_channel_counts() -> None:
    """회색조와 RGB 를 섞을 수 있어야 한다."""
    out = BlendImages().run(solid(0.5, channels=1), solid(1.0, channels=3), 0.5, "normal")

    assert out.values[0].shape[-1] == 3


# ------------------------------------------------------------------ Mask


def test_mask_uses_rec709_luminance() -> None:
    green = np.zeros((1, 1, 1, 3), dtype=np.float32)
    green[..., 1] = 1.0

    out = MaskFromImage().run(green, "luminance", False).values[0]

    assert out.shape == (1, 1, 1)  # 채널 축이 없다 (design.md §4.4)
    assert out[0, 0, 0] == pytest.approx(0.7152, abs=1e-4)


def test_mask_invert() -> None:
    out = MaskFromImage().run(solid(0.25, channels=1), "luminance", True).values[0]

    assert out[0, 0, 0] == pytest.approx(0.75)


def test_mask_alpha_requires_rgba() -> None:
    with pytest.raises(ValueError, match="알파"):
        MaskFromImage().run(solid(1.0, channels=3), "alpha", False)


# ------------------------------------------------------------- Composite


def test_composite_follows_mask() -> None:
    mask = np.zeros((1, 2, 2), dtype=np.float32)
    mask[0, 0, :] = 1.0  # 위쪽 줄만 전경

    out = CompositeImages().run(solid(0.0, (2, 2)), solid(1.0, (2, 2)), mask).values[0]

    assert out[0, 0, 0, 0] == pytest.approx(1.0)
    assert out[0, 1, 0, 0] == pytest.approx(0.0)


def test_composite_rejects_mask_size_mismatch() -> None:
    with pytest.raises(ValueError, match="마스크 크기"):
        CompositeImages().run(
            solid(0.0, (2, 2)), solid(1.0, (2, 2)), np.zeros((1, 4, 4), dtype=np.float32)
        )
