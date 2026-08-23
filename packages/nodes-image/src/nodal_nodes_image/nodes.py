"""이미지 노드 7종 (roadmap M3).

모든 노드가 `design.md` §4.4 의 계약을 지킨다 — 입출력은 `float32` 0..1,
`(B, H, W, C)`. 범위 밖 값은 소켓으로 내보내기 전에 클립한다.

`run` 은 전부 평범한 함수다. 엔진 객체 없이 호출할 수 있어야 단위 테스트가 된다
(AGENTS.md 코딩 컨벤션). `ctx` 를 받는 것은 저장소가 필요한 `SaveImage` 뿐이다.
"""

from __future__ import annotations

import io
import os
from typing import Any

import numpy as np
from PIL import Image as PILImage

from nodal import Bool, Combo, Float, Image, Int, Mask, NodeContext, NodeResult, Str, node

from .image import clip01, from_pil, to_float32
from .png import encode_png

__all__ = [
    "NODES",
    "BlendImages",
    "CompositeImages",
    "CropImage",
    "LoadImage",
    "MaskFromImage",
    "ResizeImage",
    "SaveImage",
]

#: PIL 리샘플 필터. 이름은 UI 에 그대로 나온다.
_RESAMPLE = {
    "nearest": PILImage.Resampling.NEAREST,
    "bilinear": PILImage.Resampling.BILINEAR,
    "bicubic": PILImage.Resampling.BICUBIC,
    "lanczos": PILImage.Resampling.LANCZOS,
}

_BLEND_MODES = ("normal", "add", "multiply", "screen", "difference")


def _broadcast_mask(mask: np.ndarray, like: np.ndarray) -> np.ndarray:
    """`(B, H, W)` 마스크를 `(B, H, W, 1)` 로 만들어 이미지에 브로드캐스트한다."""
    if mask.ndim == 3:
        return mask[..., np.newaxis]
    if mask.ndim == 4 and mask.shape[-1] == 1:
        return mask
    raise ValueError(f"마스크는 (B, H, W) 여야 한다. 받은 shape: {mask.shape}")


def _match_channels(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """두 이미지의 채널 수를 맞춘다. 좁은 쪽을 넓은 쪽으로 펼친다."""
    ca, cb = a.shape[-1], b.shape[-1]
    if ca == cb:
        return a, b
    target = max(ca, cb)
    return _expand_channels(a, target), _expand_channels(b, target)


def _expand_channels(array: np.ndarray, target: int) -> np.ndarray:
    channels = array.shape[-1]
    if channels == target:
        return array
    # L(1) 은 회색조를 RGB 로 펼치고, 넓은 쪽은 앞 3채널만 쓴다.
    expanded = np.repeat(array, min(target, 3), axis=-1) if channels == 1 else array[..., :3]
    if target == 4:
        alpha = np.ones((*expanded.shape[:-1], 1), dtype=np.float32)
        expanded = np.concatenate([expanded, alpha], axis=-1)
    return expanded.astype(np.float32, copy=False)


@node(
    id="image.Load",
    title="Load Image",
    category="image/io",
    aliases=["열기", "불러오기", "open"],
    cacheable=True,
)
class LoadImage:
    """파일에서 이미지를 읽는다. `uint8` PNG/JPEG 를 `float32` 0..1 로 정규화한다."""

    path: Str = Str("")

    returns = Image

    @staticmethod
    def is_changed(path: str) -> str:
        """파일 내용 변경을 mtime 나노초와 크기로 캐시 키에 반영한다 (§5.3)."""
        stat = os.stat(path)
        return f"{stat.st_mtime_ns}:{stat.st_size}"

    def run(self, path: str) -> NodeResult:
        if not path:
            raise ValueError("경로가 비어 있다")
        with PILImage.open(path) as handle:
            handle.load()
            array = from_pil(handle)
        return NodeResult(array, preview=array)


@node(
    id="image.Save",
    title="Save Image",
    category="image/io",
    aliases=["저장", "save", "출력"],
    output_node=True,
    cacheable=False,
)
class SaveImage:
    """이미지를 PNG 로 인코딩해 `AssetStore` 에 넣는다.

    `embed_workflow` 가 켜져 있으면 캐논 그래프를 `iTXt` 로 심는다 — 그러면 이미지
    파일 자체가 재현 가능한 레시피가 된다 (design.md §1.2).

    출력 노드이고 캐시하지 않는다. 저장은 부수효과라 "이미 같은 입력으로 돌렸으니
    건너뛴다" 가 사용자 기대와 어긋난다.
    """

    image: Image
    embed_workflow: Bool = Bool(True)

    returns = {"asset": Image}

    def run(self, image: Any, embed_workflow: bool, ctx: NodeContext) -> NodeResult:
        array = to_float32(image)
        workflow = ctx.graph_json() if embed_workflow else None
        version = ctx.graph_version() if workflow is not None else None
        data = encode_png(array, workflow=workflow, nodal_version=version)
        ref = ctx.assets.put(
            data,
            media_type="image/png",
            filename=f"{ctx.node_id}.png",
            width=int(array.shape[2]),
            height=int(array.shape[1]),
        )
        return NodeResult(ref, preview=array)


@node(
    id="image.Resize",
    title="Resize Image",
    category="image/transform",
    aliases=["크기", "scale"],
)
class ResizeImage:
    """이미지 크기를 바꾼다. 배치의 모든 장에 같은 크기를 적용한다."""

    image: Image
    width: Int = Int(512, min=1, max=16384, step=8)
    height: Int = Int(512, min=1, max=16384, step=8)
    method: Combo = Combo("lanczos", options=list(_RESAMPLE))

    returns = Image

    def run(self, image: Any, width: int, height: int, method: str) -> NodeResult:
        array = to_float32(image)
        resample = _RESAMPLE[method]
        frames = []
        for index in range(array.shape[0]):
            # PIL 로 리샘플하되 float 정밀도를 유지한다. 채널별로 F 모드를 쓰면
            # uint8 왕복 없이 0..1 이 보존된다.
            channels = [
                np.asarray(
                    PILImage.fromarray(array[index, ..., c], mode="F").resize(
                        (width, height), resample
                    ),
                    dtype=np.float32,
                )
                for c in range(array.shape[-1])
            ]
            frames.append(np.stack(channels, axis=-1))
        out = clip01(np.stack(frames, axis=0))
        return NodeResult(out, preview=out)


@node(id="image.Crop", title="Crop Image", category="image/transform", aliases=["자르기"])
class CropImage:
    """직사각형으로 자른다. 범위를 벗어나면 이미지 경계로 잘린다."""

    image: Image
    x: Int = Int(0, min=0, max=16384)
    y: Int = Int(0, min=0, max=16384)
    width: Int = Int(256, min=1, max=16384)
    height: Int = Int(256, min=1, max=16384)

    returns = Image

    def run(self, image: Any, x: int, y: int, width: int, height: int) -> NodeResult:
        array = to_float32(image)
        _, source_h, source_w, _ = array.shape
        left, top = min(x, source_w - 1), min(y, source_h - 1)
        right, bottom = min(left + width, source_w), min(top + height, source_h)
        if right <= left or bottom <= top:
            raise ValueError(
                f"자를 영역이 비어 있다: x={x} y={y} {width}x{height}, 원본 {source_w}x{source_h}"
            )
        return NodeResult(array[:, top:bottom, left:right, :])


@node(id="image.Blend", title="Blend Images", category="image/composite", aliases=["섞기"])
class BlendImages:
    """두 이미지를 섞는다. 결과는 언제나 0..1 로 클립된다."""

    a: Image
    b: Image
    factor: Float = Float(0.5, min=0.0, max=1.0, step=0.01)
    mode: Combo = Combo("normal", options=list(_BLEND_MODES))

    returns = Image

    def run(self, a: Any, b: Any, factor: float, mode: str) -> NodeResult:
        left, right = _match_channels(to_float32(a), to_float32(b))
        if left.shape[1:3] != right.shape[1:3]:
            raise ValueError(
                f"두 이미지의 크기가 다르다: {left.shape[2]}x{left.shape[1]} vs "
                f"{right.shape[2]}x{right.shape[1]}. Resize 를 먼저 쓰라"
            )
        match mode:
            case "add":
                mixed = left + right
            case "multiply":
                mixed = left * right
            case "screen":
                mixed = 1.0 - (1.0 - left) * (1.0 - right)
            case "difference":
                mixed = np.abs(left - right)
            case _:
                mixed = right
        out = clip01(left * (1.0 - factor) + mixed * factor)
        return NodeResult(out, preview=out)


@node(id="image.Mask", title="Mask from Image", category="image/composite", aliases=["마스크"])
class MaskFromImage:
    """이미지에서 마스크를 뽑는다. `(B, H, W)` 로 채널 축이 없다 (design.md §4.4)."""

    image: Image
    channel: Combo = Combo("luminance", options=["luminance", "red", "green", "blue", "alpha"])
    invert: Bool = Bool(False)

    returns = Mask

    def run(self, image: Any, channel: str, invert: bool) -> NodeResult:
        array = to_float32(image)
        channels = array.shape[-1]
        if channel == "alpha":
            if channels != 4:
                raise ValueError(f"알파 채널이 없다 (채널 수 {channels}). RGBA 이미지가 필요하다")
            extracted = array[..., 3]
        elif channel == "luminance" or channels == 1:
            if channels == 1:
                extracted = array[..., 0]
            else:
                # Rec.709 — 사람 눈의 채널별 민감도.
                extracted = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
        else:
            index = {"red": 0, "green": 1, "blue": 2}[channel]
            if index >= channels:
                raise ValueError(f"{channel} 채널이 없다 (채널 수 {channels})")
            extracted = array[..., index]
        out = clip01(1.0 - extracted if invert else extracted)
        return NodeResult(out)


@node(
    id="image.Composite",
    title="Composite Images",
    category="image/composite",
    aliases=["합성", "over"],
)
class CompositeImages:
    """마스크를 따라 전경을 배경 위에 올린다. 마스크 1.0 이 전경이다."""

    background: Image
    foreground: Image
    mask: Mask

    returns = Image

    def run(self, background: Any, foreground: Any, mask: Any) -> NodeResult:
        back, front = _match_channels(to_float32(background), to_float32(foreground))
        if back.shape[1:3] != front.shape[1:3]:
            raise ValueError(
                f"배경과 전경의 크기가 다르다: {back.shape[2]}x{back.shape[1]} vs "
                f"{front.shape[2]}x{front.shape[1]}. Resize 를 먼저 쓰라"
            )
        alpha = _broadcast_mask(np.asarray(mask, dtype=np.float32), back)
        if alpha.shape[1:3] != back.shape[1:3]:
            raise ValueError(
                f"마스크 크기가 이미지와 다르다: {alpha.shape[2]}x{alpha.shape[1]} vs "
                f"{back.shape[2]}x{back.shape[1]}"
            )
        out = clip01(back * (1.0 - alpha) + front * alpha)
        return NodeResult(out, preview=out)


def _decode_bytes(data: bytes) -> np.ndarray:
    """바이트에서 이미지를 읽는다. 업로드된 에셋을 노드가 쓸 때를 위한 것."""
    with PILImage.open(io.BytesIO(data)) as handle:
        handle.load()
        return from_pil(handle)


#: 이 팩이 제공하는 노드 전부. 레지스트리에 넣는 쪽이 이 목록을 쓴다.
NODES = (
    LoadImage,
    SaveImage,
    ResizeImage,
    CropImage,
    BlendImages,
    MaskFromImage,
    CompositeImages,
)
