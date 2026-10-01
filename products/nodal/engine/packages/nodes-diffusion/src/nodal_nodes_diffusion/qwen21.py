"""Local Qwen-Image-2.1 adapter; all model computation belongs to Diffusers.

Weights are separately licensed for non-commercial research/evaluation. This
module never downloads weights or executes code supplied by a model directory.
"""

from __future__ import annotations

import gc
import hashlib
import importlib
import importlib.metadata
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from nodal import Combo, Failure, Image, Int, NodeContext, NodeResult, Seed, Socket, Str, node

MODEL_ENV = "NODAL_QWEN21_MODEL"
PROFILES = ("group_offload", "sequential_offload")


def model_directory(value: str) -> Path:
    value = value.strip() or os.environ.get(MODEL_ENV, "").strip()
    if not value:
        raise ValueError(f"model_path 또는 {MODEL_ENV}에 로컬 모델 폴더를 지정하세요.")
    root = Path(value).expanduser().resolve()
    index = root / "model_index.json"
    config = json.loads(index.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("_class_name") != "QwenImage21Pipeline":
        raise ValueError(f"{index}: Qwen-Image-2.1 모델이 아닙니다.")
    for component in ("processor", "scheduler", "text_encoder", "transformer", "vae"):
        if not (root / component).is_dir():
            raise ValueError(f"{root}: {component} 폴더가 없습니다.")
    return root


def reference_images(values: tuple[Any, ...]) -> tuple[list[Any], list[str]]:
    """Preserve reference order and alpha; never silently discard batch entries."""
    import numpy as np
    from PIL import Image as PILImage

    images, hashes = [], []
    gap = False
    for index, value in enumerate(values, 1):
        if value is None:
            gap = True
            continue
        if gap:
            raise ValueError(f"reference_{index}: 참조는 reference_1부터 순서대로 연결하세요.")
        array = np.asarray(value)
        if array.ndim != 4 or array.shape[0] != 1 or array.shape[-1] not in (1, 3, 4):
            raise ValueError(f"reference_{index}: 이미지 한 장(B=1, H, W, C)이 필요합니다.")
        if not np.isfinite(array).all():
            raise ValueError(f"reference_{index}: 유효하지 않은 픽셀이 있습니다.")
        pixels = (np.clip(array[0], 0, 1) * 255).round().astype(np.uint8)
        hashes.append(hashlib.sha256(str(pixels.shape).encode() + pixels.tobytes()).hexdigest())
        if pixels.shape[-1] == 1:
            pixels = pixels[..., 0]
        image = PILImage.fromarray(pixels)
        images.append(image.convert("RGB") if image.mode == "L" else image)
    return images, hashes


@contextmanager
def pipeline(root: Path, profile: str, ctx: NodeContext) -> Iterator[Any]:
    import torch

    from .devices import empty_cache

    pipe = None
    try:
        cls = getattr(importlib.import_module("diffusers"), "QwenImage21Pipeline", None)
        if cls is None:
            raise RuntimeError(
                "QwenImage21Pipeline이 없습니다. tools/prepare-qwen21.ps1을 실행하세요."
            )
        pipe = cls.from_pretrained(
            str(root),
            torch_dtype=torch.bfloat16,
            local_files_only=True,
            use_safetensors=True,
        )
        ctx.raise_if_cancelled()
        pipe.vae.enable_tiling()
        device = torch.device(str(ctx.models.plan.compute))
        if profile == "sequential_offload":
            pipe.enable_sequential_cpu_offload(device=device)
        else:
            hooks = importlib.import_module("diffusers.hooks")
            options = {
                "onload_device": device,
                "offload_device": torch.device("cpu"),
                "use_stream": False,
            }
            pipe.transformer.enable_group_offload(
                offload_type="block_level",
                num_blocks_per_group=1,
                **options,
            )
            hooks.apply_group_offloading(
                pipe.text_encoder,
                offload_type="leaf_level",
                **options,
            )
            pipe.vae.enable_group_offload(offload_type="leaf_level", **options)
        yield pipe
    finally:
        if pipe is not None:
            # Break hook cycles before collecting the per-run pipeline.
            pipe.remove_all_hooks()
        del pipe
        gc.collect()
        empty_cache(ctx.models.plan.compute)


@node(
    id="diffusion.QwenImage21",
    title="Qwen Image 2.1",
    category="diffusion/image",
    aliases=["Qwen", "큐웬", "이미지 편집", "RGBA"],
    cacheable=False,
)
class QwenImage21:
    """로컬 이미지 생성·참조 편집. Qwen Research License(비상업 연구·평가용)."""

    model_path: Str = Str("", doc="로컬 Qwen-Image-2.1 폴더. 비우면 NODAL_QWEN21_MODEL.")
    prompt: Str = Str("A ceramic teapot on a wooden table.", multiline=True)
    width: Int = Int(1024, min=256, max=2048, step=32)
    height: Int = Int(1024, min=256, max=2048, step=32)
    steps: Int = Int(40, min=1, max=100)
    seed: Seed = Seed(42, control="fixed")
    reference_resolution: Int = Int(768, min=256, max=2048, step=32)
    memory_profile: Combo = Combo("group_offload", options=PROFILES)
    reference_1: Socket = Socket(Image, None)
    reference_2: Socket = Socket(Image, None)
    reference_3: Socket = Socket(Image, None)
    reference_4: Socket = Socket(Image, None)
    reference_5: Socket = Socket(Image, None)
    reference_6: Socket = Socket(Image, None)
    reference_7: Socket = Socket(Image, None)
    reference_8: Socket = Socket(Image, None)
    reference_9: Socket = Socket(Image, None)
    reference_10: Socket = Socket(Image, None)
    returns = {"image": Image, "metadata": Str}

    def run(
        self,
        model_path: str,
        prompt: str,
        width: int,
        height: int,
        steps: int,
        seed: int,
        reference_resolution: int,
        memory_profile: str,
        ctx: NodeContext,
        reference_1: Any = None,
        reference_2: Any = None,
        reference_3: Any = None,
        reference_4: Any = None,
        reference_5: Any = None,
        reference_6: Any = None,
        reference_7: Any = None,
        reference_8: Any = None,
        reference_9: Any = None,
        reference_10: Any = None,
    ) -> NodeResult | Failure:
        for socket, value in (
            ("width", width),
            ("height", height),
            ("reference_resolution", reference_resolution),
        ):
            if not 256 <= value <= 2048 or value % 32:
                return Failure(ValueError("256~2048 사이의 32 배수여야 합니다."), socket=socket)
        if not 1 <= steps <= 100:
            return Failure(ValueError("steps는 1~100이어야 합니다."), socket="steps")
        if not prompt.strip():
            return Failure(ValueError("프롬프트가 비어 있습니다."), socket="prompt")
        if memory_profile not in PROFILES:
            return Failure(
                ValueError("지원하지 않는 메모리 프로필입니다."), socket="memory_profile"
            )
        try:
            root = model_directory(model_path)
        except (ValueError, OSError) as exc:
            return Failure(exc, socket="model_path")
        try:
            references, hashes = reference_images(
                (
                    reference_1,
                    reference_2,
                    reference_3,
                    reference_4,
                    reference_5,
                    reference_6,
                    reference_7,
                    reference_8,
                    reference_9,
                    reference_10,
                )
            )
        except ValueError as exc:
            return Failure(exc, socket=str(exc).split(":", 1)[0])
        if ctx.models.plan.compute.kind != "cuda":
            return Failure(
                ValueError("Qwen 2.1은 NVIDIA CUDA 실행 환경이 필요합니다."),
                socket="memory_profile",
            )
        import numpy as np
        import torch

        from .manager import ModelManager

        ctx.raise_if_cancelled()
        if isinstance(ctx.models, ModelManager):
            ctx.models.release_unused()
        ctx.progress(0, steps + 2)
        with pipeline(root, memory_profile, ctx) as pipe:
            ctx.progress(1, steps + 2)

            def callback(_pipe: Any, index: int, _time: Any, values: dict[str, Any]) -> Any:
                ctx.raise_if_cancelled()
                ctx.progress(index + 2, steps + 2)
                return values

            with torch.no_grad():
                result = pipe(
                    prompt=prompt,
                    image=references or None,
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    generator=torch.Generator().manual_seed(seed),
                    output_resolution=reference_resolution,
                    callback_on_step_end=callback,
                    output_type="pil",
                )
            ctx.raise_if_cancelled()
            if len(result.images) != 1:
                raise RuntimeError("QwenImage21 출력 image: 이미지 한 장을 기대했습니다.")
            pixels = np.asarray(result.images[0])
            if pixels.ndim != 3 or pixels.shape[-1] not in (3, 4):
                raise RuntimeError("QwenImage21 출력 image: RGB/RGBA 이미지가 아닙니다.")
            array = pixels.astype(np.float32)[None] / np.float32(255)
        manifest = root / "nodal-model.json"
        provenance = json.loads(manifest.read_text(encoding="utf-8")) if manifest.is_file() else {}
        metadata = json.dumps(
            {
                "model_path": str(root),
                "model": provenance,
                "run_id": ctx.run_id,
                "prompt": prompt,
                "seed": seed,
                "steps": steps,
                "width": width,
                "height": height,
                "reference_resolution": reference_resolution,
                "reference_pixel_hashes": hashes,
                "memory_profile": memory_profile,
                "runtime": {
                    name: importlib.metadata.version(name)
                    for name in ("diffusers", "transformers", "torch")
                },
            },
            ensure_ascii=False,
        )
        ctx.progress(steps + 2, steps + 2)
        return NodeResult(array, metadata, preview=array)
