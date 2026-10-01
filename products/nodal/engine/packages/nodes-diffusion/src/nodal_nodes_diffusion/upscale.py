"""Non-diffusion video restoration delegated to Spandrel (approved 2026-09-15)."""

from __future__ import annotations

import gc
import io
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from nodal import AssetRef, Combo, Failure, Int, NodeContext, NodeResult, Socket, Str, node
from nodal.events import Cancelled

from .h3 import H3Video
from .video import require_video_runtime


class ModelError(RuntimeError):
    """Restore model errors belong to model_path, not the source video socket."""


def target_size(width: int, height: int, short_edge: int) -> tuple[int, int]:
    """Preserve aspect ratio, rounding the longer edge to even codec dimensions."""
    if min(width, height) <= 0 or short_edge not in (720, 1080):
        raise ValueError("영상 크기 또는 목표 짧은 변(720/1080)이 잘못됐다.")
    ratio = short_edge / min(width, height)
    return max(2, round(width * ratio / 2) * 2), max(2, round(height * ratio / 2) * 2)


def model_file(value: str) -> Path:
    """Only local tensor checkpoints; never execute TorchScript or remote source."""
    name = value.strip() or os.environ.get("NODAL_UPSCALE_MODEL", "").strip()
    if not name:
        raise ValueError("업스케일 모델 경로 또는 NODAL_UPSCALE_MODEL을 지정하세요.")
    path = Path(name).expanduser().resolve()
    if not path.is_file() or path.suffix.lower() not in (".pth", ".safetensors"):
        raise ValueError("로컬 .pth 또는 .safetensors 업스케일 가중치가 필요하다.")
    return path


def source_bytes(video: Any, source: str, ctx: NodeContext) -> bytes:
    """Accept the existing H3 socket or a saved clip, with no ambiguous precedence."""
    if video is not None and source.strip():
        raise ValueError("video 연결과 source 입력 중 하나만 지정하세요.")
    if video is not None:
        if not isinstance(video, AssetRef) or video.media_type != "video/webm":
            raise ValueError("video에는 H3의 WebM 에셋을 연결하세요.")
        data = ctx.assets.get(video.hash)
    elif source.startswith("asset:"):
        digest = source.removeprefix("asset:")
        ref = ctx.assets.ref(digest)
        if ref is None or ref.media_type != "video/webm":
            raise ValueError("source의 WebM 에셋을 찾을 수 없다.")
        data = ctx.assets.get(digest)
    elif source.strip():
        path = Path(source).expanduser().resolve()
        if not path.is_file() or path.suffix.lower() != ".webm":
            raise ValueError("source에는 서버 로컬 .webm 파일을 지정하세요.")
        data = path.read_bytes()
    else:
        raise ValueError("video를 연결하거나 source에 WebM 경로/asset:<hash>를 지정하세요.")
    if not data:
        raise ValueError("영상 에셋이 없거나 비어 있다.")
    return data


def tiled_restore(
    image: Any, model: Any, tile_size: int, check_cancelled: Callable[[], None]
) -> Any:
    """Process one frame with contextual tile borders; keep only tile cores."""
    import numpy as np
    import torch
    from PIL import Image

    width, height = image.size
    scale = model.scale
    output = np.empty((height * scale, width * scale, 3), dtype=np.uint8)
    pixels = np.asarray(image.convert("RGB"))
    padding = 32
    with torch.no_grad():
        for top in range(0, height, tile_size):
            for left in range(0, width, tile_size):
                check_cancelled()
                bottom, right = min(top + tile_size, height), min(left + tile_size, width)
                y0, x0 = max(0, top - padding), max(0, left - padding)
                y1, x1 = min(height, bottom + padding), min(width, right + padding)
                tensor = torch.from_numpy(pixels[y0:y1, x0:x1].copy()).permute(2, 0, 1)[None]
                tensor = tensor.to(device=model.device, dtype=model.dtype).div_(255)
                try:
                    restored = model(tensor)
                except Exception as exc:
                    raise ModelError(f"업스케일 모델 추론 실패: {exc}") from exc
                if tuple(restored.shape) != (1, 3, (y1 - y0) * scale, (x1 - x0) * scale):
                    raise ModelError("업스케일 모델이 예상과 다른 타일 크기를 반환했다.")
                if not bool(torch.isfinite(restored).all()):
                    raise ModelError("업스케일 모델 출력에 NaN/Inf가 있다.")
                tile = restored[
                    0,
                    :,
                    (top - y0) * scale : (bottom - y0) * scale,
                    (left - x0) * scale : (right - x0) * scale,
                ]
                output[top * scale : bottom * scale, left * scale : right * scale] = (
                    tile.float().clamp(0, 1).mul(255).round().byte().permute(1, 2, 0).cpu().numpy()
                )
                del tensor, restored, tile
    return Image.fromarray(output)


@contextmanager
def restorer(path: Path, ctx: NodeContext) -> Iterator[Any]:
    """Delegate model implementation; safe tensor loading and bounded GPU lifetime."""
    import spandrel
    import torch

    from .devices import empty_cache
    from .manager import ModelManager

    model = None
    if isinstance(ctx.models, ModelManager):
        ctx.models.release_unused()
    try:
        ctx.raise_if_cancelled()
        if path.suffix.lower() == ".safetensors":
            from safetensors.torch import load_file

            state = load_file(str(path), device="cpu")
        else:
            # Do not use Spandrel's pickle-module fallback or any TorchScript loader.
            state = torch.load(path, map_location="cpu", weights_only=True)
        state = spandrel.canonicalize_state_dict(state)
        model = spandrel.ModelLoader().load_from_state_dict(state)
        del state
        if (
            not isinstance(model, spandrel.ImageModelDescriptor)
            or model.input_channels != 3
            or model.output_channels != 3
            or model.scale not in (2, 4)
            or model.tiling != spandrel.ModelTiling.SUPPORTED
        ):
            raise ValueError("타일 처리를 지원하는 RGB 2x/4x 초해상도 모델이 필요하다.")
        dtype = torch.float32
        if ctx.models.plan.dtype != "float32" and model.supports_half:
            dtype = torch.float16
        model.to(device=str(ctx.models.plan.compute), dtype=dtype).eval()
        ctx.raise_if_cancelled()
        yield model
    finally:
        if model is not None:
            model.to(device="cpu")
        del model
        gc.collect()
        empty_cache(ctx.models.plan.compute)


def restore_webm(
    data: bytes,
    destination: Path,
    restore: Callable[[Any], Any],
    short_edge: int,
    ctx: NodeContext,
    *,
    model_scale: int,
) -> None:
    """Stream frames through restoration; remux Opus packets without recompression."""
    from PIL import Image

    av = require_video_runtime()
    with av.open(io.BytesIO(data)) as source:
        if len(source.streams.video) != 1 or len(source.streams.audio) > 1:
            raise ValueError("단일 영상과 최대 한 개의 Opus 오디오 트랙만 지원한다.")
        original = source.streams.video[0]
        if original.codec_context.name != "vp9" or original.codec_context.format.name != "yuv420p":
            raise ValueError("현재는 H3 형식인 8-bit VP9 WebM만 지원한다.")
        if any(s.type not in ("video", "audio") for s in source.streams):
            raise ValueError("자막/데이터 트랙을 포함한 WebM은 지원하지 않는다.")
        if source.streams.audio and source.streams.audio[0].codec_context.name != "opus":
            raise ValueError("오디오 무손실 전달에는 Opus 트랙이 필요하다.")
        rate = original.average_rate
        if rate is None or rate <= 0 or original.time_base is None:
            raise ValueError("영상의 프레임 속도 또는 타임스탬프가 없다.")
        size = target_size(original.width, original.height, short_edge)
        if short_edge <= min(original.width, original.height):
            raise ValueError("목표 짧은 변은 원본보다 커야 한다.")
        if short_edge > min(original.width, original.height) * model_scale:
            raise ValueError("목표 크기가 모델의 실제 확대 배율을 넘는다. 4x 모델을 사용하세요.")
        estimate = max(1, round((source.duration or 0) / av.time_base * float(rate)))
        with av.open(str(destination), "w", format="webm") as target:
            target.metadata.update(source.metadata)
            graph = ctx.graph_json()
            if graph:
                target.metadata["nodal_graph"] = graph
            target.metadata["nodal_upscale"] = "spandrel; framewise; opus-copy"
            encoded = target.add_stream("libvpx-vp9", rate=rate)
            encoded.width, encoded.height = size
            encoded.pix_fmt = "yuv420p"
            encoded.options = {"crf": "18", "b": "0", "deadline": "good", "cpu-used": "4"}
            copied = {s.index: target.add_stream_from_template(s) for s in source.streams.audio}
            count = 0
            previous_pts = None
            for packet in source.demux():
                ctx.raise_if_cancelled()
                if packet.stream.index in copied:
                    if packet.dts is not None:
                        packet.stream = copied[packet.stream.index]
                        target.mux(packet)
                    continue
                for frame in packet.decode():
                    if frame.pts is None or (
                        previous_pts is not None and frame.pts <= previous_pts
                    ):
                        raise ValueError("영상 프레임 타임스탬프가 없거나 역순이다.")
                    previous_pts = frame.pts
                    result = restore(frame.to_image())
                    ctx.raise_if_cancelled()
                    # AI supplies detail at native scale; Lanczos only fits the requested size.
                    result = result.resize(size, Image.Resampling.LANCZOS)
                    picture = av.VideoFrame.from_image(result)
                    picture.pts, picture.time_base = frame.pts, frame.time_base
                    for output in encoded.encode(picture):
                        target.mux(output)
                    count += 1
                    ctx.progress(count, max(count, estimate) + 1)
            if not count:
                raise ValueError("영상에 디코딩 가능한 프레임이 없다.")
            ctx.raise_if_cancelled()
            for output in encoded.encode(None):
                target.mux(output)
    ctx.progress(count + 1, count + 1)


@node(
    id="diffusion.UpscaleVideo",
    title="AI Upscale Video",
    category="diffusion/video",
    aliases=["업스케일", "선명도", "초해상도", "Real-ESRGAN", "720", "1080"],
    output_node=True,
    cacheable=False,
)
class UpscaleVideo:
    """H3 WebM의 프레임을 AI 복원한다. 비율·타이밍·Opus 소리를 유지한다."""

    video: Socket = Socket(H3Video, None, doc="H3 영상 출력. source와 둘 중 하나만 사용.")
    source: Str = Str("", doc="기존 WebM 경로 또는 asset:<hash>. video 연결 시 비운다.")
    model_path: Str = Str("", doc="로컬 2x/4x 모델. 비우면 NODAL_UPSCALE_MODEL 사용.")
    short_edge: Combo = Combo("720", options=["720", "1080"])
    tile_size: Int = Int(
        256, min=64, max=512, step=32, doc="입력 타일 크기. 메모리 부족 시 줄인다."
    )
    returns = {"video": H3Video}

    def run(
        self,
        video: Any,
        source: str,
        model_path: str,
        short_edge: str,
        tile_size: int,
        ctx: NodeContext,
    ) -> NodeResult | Failure:
        if short_edge not in ("720", "1080"):
            return Failure(ValueError("짧은 변은 720 또는 1080이어야 한다."), socket="short_edge")
        if not 64 <= tile_size <= 512 or tile_size % 32:
            return Failure(ValueError("타일은 64~512 사이 32의 배수여야 한다."), socket="tile_size")
        try:
            path = model_file(model_path)
        except (ValueError, OSError) as exc:
            return Failure(exc, socket="model_path")
        socket = "video" if video is not None else "source"
        try:
            ctx.raise_if_cancelled()
            data = source_bytes(video, source, ctx)
            require_video_runtime()
        except Cancelled:
            raise
        except Exception as exc:
            return Failure(exc, socket=socket)
        error_socket = "model_path"
        try:
            ctx.progress(0, 1)
            with restorer(path, ctx) as model, TemporaryDirectory(prefix="nodal-upscale-") as temp:
                error_socket = socket
                destination = Path(temp) / "upscaled.webm"
                restore_webm(
                    data,
                    destination,
                    lambda image: tiled_restore(image, model, tile_size, ctx.raise_if_cancelled),
                    int(short_edge),
                    ctx,
                    model_scale=model.scale,
                )
                ctx.raise_if_cancelled()
                ref = ctx.assets.put(destination.read_bytes(), media_type="video/webm")
            return NodeResult(ref)
        except Cancelled:
            raise
        except ImportError as exc:
            return Failure(
                RuntimeError(f"{exc}. uv sync --extra cuda --group h3 --group upscale"),
                socket="model_path",
            )
        except ModelError as exc:
            return Failure(exc, socket="model_path")
        except Exception as exc:
            return Failure(exc, socket=error_socket)
