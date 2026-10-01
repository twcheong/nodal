"""MiniMax H3 adapter. All inference is delegated to diffusers ModularPipeline.

Only local diffusers-layout weights are supported. No implicit model download.
The large pipeline belongs to one execution and is released even on cancellation.
"""

from __future__ import annotations

import gc
import importlib
import json
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from nodal import Combo, Failure, Image, Int, NodeContext, NodeResult, Seed, Socket, Str, node
from nodal.types import OpaqueType

from .h3_pruned import CONVROT_PROFILE, is_pruned, model_class, reviewed_source
from .video import encode_webm, require_video_runtime

MODEL_ENV = "NODAL_H3_MODEL"
H3Video = OpaqueType("MiniMaxH3Video")
PROFILES = ("int8_offload", "bf16_offload", CONVROT_PROFILE)

#: H3 를 올리는 동안 필요한 커밋 여유(RAM + 페이지 파일), GiB.
#: 2026-09-25 실측(RTX 5080 16GB, RAM 64GB, Pruned ConvRot INT8, 512x288): 로딩 중
#: 커밋이 시작점보다 약 162GiB 늘었다 — 텍스트 인코더(bf16 49GB)를 CPU 에서 int8 로
#: 바꾸는 동안 원본과 사본이 같이 산다. 여유가 모자라면 Python 예외가 아니라 네이티브
#: 메모리 접근 위반으로 **엔진 프로세스가 통째로 죽고** 대기열의 다른 실행도 사라졌다.
#: 그래서 올리기 전에 잰다.
H3_COMMIT_HEADROOM_GIB = 160
#: 검사를 끄거나 기준을 바꾼다 (GiB, 0 이면 끔).
H3_HEADROOM_ENV_VAR = "NODAL_H3_MIN_HEADROOM_GIB"


def memory_shortage(profile: str, *, headroom: float | None = None) -> str | None:
    """H3 를 올릴 메모리 여유가 모자라면 사람이 읽을 이유, 충분하거나 잴 수 없으면 None.

    여유 = 더 커밋할 수 있는 메모리 (RAM + 페이지 파일의 빈 곳).
    bf16 프로필은 양자화 사본을 만들지 않아 재지 않는다.
    """
    if profile == "bf16_offload":
        return None
    need = float(os.environ.get(H3_HEADROOM_ENV_VAR, H3_COMMIT_HEADROOM_GIB))
    if need <= 0:
        return None
    if headroom is None:
        headroom = _commit_headroom_gib()
        if headroom is None:
            return None
    if headroom >= need:
        return None
    return (
        f"메모리가 부족해 H3 를 올릴 수 없다 — RAM·페이지 파일 여유가 {headroom:.0f}GB 인데 "
        f"약 {need:.0f}GB 가 필요하다. 메모리를 많이 쓰는 다른 프로그램(다른 엔진·ComfyUI 등)을 "
        "닫거나 Windows 페이지 파일을 늘린 뒤 다시 시도하라."
    )


def _commit_headroom_gib() -> float | None:
    """더 커밋할 수 있는 메모리(GiB). 모르면 None.

    Windows 는 커밋 한도에서 직접 읽고, 그 밖은 psutil 로 근사한다.
    """
    if sys.platform == "win32":
        import ctypes

        class _Status(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("load", ctypes.c_ulong),
                ("total_phys", ctypes.c_ulonglong),
                ("avail_phys", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("avail_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("avail_virtual", ctypes.c_ulonglong),
                ("avail_extended_virtual", ctypes.c_ulonglong),
            ]

        status = _Status()
        status.length = ctypes.sizeof(_Status)
        # ullAvailPageFile 은 이름과 달리 "커밋 한도 - 커밋 사용량" 이다 (RAM + 페이지 파일).
        kernel32 = ctypes.windll.kernel32
        if kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return float(status.avail_page_file) / 2**30
        return None
    try:
        psutil = importlib.import_module("psutil")
    except ImportError:
        return None
    return float((psutil.virtual_memory().available + psutil.swap_memory().free) / 2**30)


def model_directory(value: str, component: str = "transformer") -> Path:
    """Validate the local layout without importing torch or reading weight tensors."""
    value = value.strip() or os.environ.get(MODEL_ENV, "").strip()
    if not value:
        raise ValueError(f"model_path 또는 원격 서버의 {MODEL_ENV}에 H3 폴더를 지정하세요.")
    root = Path(value).expanduser().resolve()
    index = root / "modular_model_index.json"
    if not index.is_file():
        raise ValueError(
            f"{root}: modular_model_index.json이 없다. diffusers 형식의 MiniMax H3 폴더가 "
            "필요하다. FL2VA 원본 폴더나 단일 GGUF/FP8 파일은 이 로더로 열 수 없다."
        )
    config = json.loads(index.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("_class_name") != "MiniMaxH3ModularPipeline":
        raise ValueError(f"{index}: MiniMax H3 ModularPipeline 설정이 아니다.")
    required = (
        component,
        "text_encoder",
        "tokenizer",
        "vae",
        "audio_vae",
        "scheduler",
        "audio_scheduler",
    )
    missing = [name for name in required if not (root / name).is_dir()]
    if missing:
        raise ValueError(f"{root}: 필요한 H3 구성요소 폴더가 없다: {', '.join(missing)}")
    if is_pruned(root, component):
        reviewed_source(root, component)
    return root


def _keyframe(value: Any) -> Any:
    if value is None:
        return None
    import numpy as np
    from PIL import Image as PILImage

    if hasattr(value, "detach"):
        value = value.detach().float().cpu().numpy()
    array = np.asarray(value)
    if array.ndim != 4 or array.shape[0] != 1 or array.shape[-1] not in (1, 3, 4):
        raise ValueError("키프레임은 이미지 한 장(B=1, H, W, C)이어야 한다.")
    if not np.isfinite(array).all():
        raise ValueError("키프레임에 유효하지 않은 픽셀이 있다.")
    pixels = (np.clip(array[0], 0, 1) * 255).round().astype(np.uint8)
    if pixels.shape[-1] == 1:
        pixels = pixels[..., 0]
    return PILImage.fromarray(pixels).convert("RGB")


@contextmanager
def _pipeline(root: Path, workflow: str, profile: str, ctx: NodeContext) -> Iterator[Any]:
    import torch

    diffusers = importlib.import_module("diffusers")

    from .devices import empty_cache

    component = "transformer_ref" if workflow == "ref2va" else "transformer"
    pruned = is_pruned(root, component)
    if profile == CONVROT_PROFILE and not pruned:
        raise ValueError("ConvRot 프로필에는 MiniMax-H3-Pruned 폴더가 필요하다.")
    pipe = None
    try:
        pipe = diffusers.ModularPipeline.from_pretrained(
            str(root), workflow=workflow, local_files_only=True
        )
        if pruned and profile != "int8_offload":
            transformer = model_class(root, component).from_pretrained(
                str(root / component),
                torch_dtype=torch.bfloat16,
                local_files_only=True,
                use_safetensors=True,
                low_cpu_mem_usage=True,
            )
            pipe.update_components(**{component: transformer})
            del transformer
            ctx.raise_if_cancelled()
            if profile == CONVROT_PROFILE:
                getattr(pipe, component).requires_grad_(False)
                getattr(pipe, component).quantize_8bit(device=str(ctx.models.plan.compute))
                ctx.raise_if_cancelled()
        if profile in ("int8_offload", CONVROT_PROFILE):
            from transformers import Qwen3VLForConditionalGeneration
            from transformers import TorchAoConfig as TextTorchAoConfig

            quant = importlib.import_module("torchao.quantization")
            if profile == "int8_offload":
                pipe.update_components(
                    **{
                        component: (
                            model_class(root, component)
                            if pruned
                            else diffusers.MiniMaxH3Transformer3DModel
                        ).from_pretrained(
                            str(root),
                            subfolder=component,
                            torch_dtype=torch.bfloat16,
                            local_files_only=True,
                            low_cpu_mem_usage=False,
                            quantization_config=diffusers.TorchAoConfig(
                                quant.Int8WeightOnlyConfig(version=2),
                                modules_to_not_convert=[
                                    "proj_in",
                                    "audio_proj_in",
                                    "context_embedder",
                                    "time_embedder",
                                    "time_proj",
                                    "token_refiner",
                                    "norm_out",
                                    "proj_out",
                                    "audio_proj_out",
                                ]
                                + (["adaln_proj"] if pruned else []),
                            ),
                        )
                    }
                )
            ctx.raise_if_cancelled()
            pipe.update_components(
                text_encoder=Qwen3VLForConditionalGeneration.from_pretrained(
                    str(root),
                    subfolder="text_encoder",
                    dtype=torch.bfloat16,
                    local_files_only=True,
                    quantization_config=TextTorchAoConfig(
                        quant.Int8WeightOnlyConfig(version=2),
                        modules_to_not_convert=[
                            "model.visual",
                            "model.language_model.embed_tokens",
                            "model.language_model.norm",
                            "lm_head",
                        ],
                    ),
                )
            )
        ctx.raise_if_cancelled()
        pipe.load_components(
            dtype=torch.bfloat16, local_files_only=True, pretrained_model_name_or_path=str(root)
        )
        # load_components logs and skips individual failures; surface them before inference.
        for spec in pipe.blocks.expected_components:
            if getattr(pipe, spec.name, None) is None:
                raise RuntimeError(f"H3 구성요소 {spec.name} 로딩 실패. 서버 로그를 확인하세요.")
        hooks = importlib.import_module("diffusers.hooks")

        onload = torch.device(str(ctx.models.plan.compute))
        offload = {"onload_device": onload, "offload_device": torch.device("cpu")}
        transformer = getattr(pipe, component)
        transformer.requires_grad_(False)
        pipe.text_encoder.requires_grad_(False)
        transformer.enable_group_offload(
            offload_type="block_level",
            num_blocks_per_group=1,
            use_stream=not pruned,
            **offload,
        )
        hooks.apply_group_offloading(
            pipe.text_encoder.model,
            offload_type="leaf_level",
            use_stream=not pruned,
            **offload,
        )
        # Keep the video decoder off the GPU between layers on 12-16 GB devices.
        pipe.vae.enable_group_offload(offload_type="leaf_level", use_stream=False, **offload)
        pipe.audio_vae.to(onload)
        del transformer
        ctx.raise_if_cancelled()
        yield pipe
    finally:
        if pipe is not None:
            pipe.unload_components([spec.name for spec in pipe.blocks.expected_components])
        del pipe
        gc.collect()
        empty_cache(ctx.models.plan.compute)


@node(
    id="diffusion.MiniMaxH3",
    title="MiniMax H3 Video",
    category="diffusion/video",
    aliases=["영상", "동영상", "비디오", "미니맥스", "H3", "Pruned", "ConvRot"],
    output_node=True,
    cacheable=False,
)
class MiniMaxH3:
    """텍스트, 시작/끝 프레임 또는 참조 이미지에서 24fps 유성 WebM을 생성한다."""

    model_path: Str = Str("", doc="원격 서버의 H3 diffusers 폴더. 비워 두면 NODAL_H3_MODEL 사용.")
    prompt: Str = Str(
        "A cat looks out of a sunlit window. Slow camera push in. Quiet birdsong.", multiline=True
    )
    first_frame: Socket = Socket(Image, None, doc="선택: 시작 이미지 한 장")
    last_frame: Socket = Socket(Image, None, doc="선택: 마지막 이미지 한 장")
    reference_1: Socket = Socket(Image, None, doc="Ref2VA 참조 1. 시작/끝 이미지와 함께 사용 불가.")
    reference_2: Socket = Socket(Image, None, doc="선택: Ref2VA 참조 2. 참조 1 다음 순서.")
    reference_3: Socket = Socket(Image, None, doc="선택: Ref2VA 참조 3. 참조 2 다음 순서.")
    reference_short_edge: Int = Int(
        2048,
        min=256,
        max=2048,
        step=32,
        doc="Ref2VA 참조 인코딩 짧은 변. 공식 기본 2048; 작은 값은 메모리와 참조 세부정보 감소.",
    )
    width: Int = Int(960, min=256, max=1920, step=32)
    height: Int = Int(544, min=256, max=1920, step=32)
    num_frames: Int = Int(124, min=124, max=345, step=17, doc="24fps. 124장 ≈ 5.17초; 17장 단위.")
    steps: Int = Int(30, min=2, max=100, doc="sigma 지점 수. 실제 모델 계산 횟수는 steps - 1.")
    seed: Seed = Seed(0, control="fixed")
    memory_profile: Combo = Combo("int8_offload", options=PROFILES)
    returns = {"video": H3Video}

    def run(
        self,
        model_path: str,
        prompt: str,
        first_frame: Any,
        last_frame: Any,
        width: int,
        height: int,
        num_frames: int,
        steps: int,
        seed: int,
        memory_profile: str,
        ctx: NodeContext,
        reference_1: Any = None,
        reference_2: Any = None,
        reference_3: Any = None,
        reference_short_edge: int = 2048,
    ) -> NodeResult | Failure:
        references = []
        gap = False
        for socket, value in (
            ("reference_1", reference_1),
            ("reference_2", reference_2),
            ("reference_3", reference_3),
        ):
            if value is None:
                gap = True
                continue
            if gap:
                return Failure(
                    ValueError("참조는 reference_1부터 순서대로 연결하세요."), socket=socket
                )
            try:
                references.append(_keyframe(value))
            except ValueError as exc:
                return Failure(exc, socket=socket)
        if references and (first_frame is not None or last_frame is not None):
            return Failure(
                ValueError("Ref2VA 참조와 시작/끝 키프레임을 섞을 수 없다."), socket="reference_1"
            )
        component = "transformer_ref" if references else "transformer"
        try:
            root = model_directory(model_path, component)
        except (ValueError, OSError) as exc:
            return Failure(exc, socket="model_path")
        for name, value in (("width", width), ("height", height)):
            if not 256 <= value <= 1920 or value % 32:
                return Failure(ValueError("크기는 256~1920 사이의 32 배수여야 한다."), socket=name)
        if not 0.25 <= width / height <= 4:
            return Failure(ValueError("가로세로 비율은 1:4~4:1이어야 한다."), socket="width")
        if not 124 <= num_frames <= 345 or (num_frames - 5) % 17:
            return Failure(ValueError("프레임 수는 124~345, 17n+5여야 한다."), socket="num_frames")
        if not 2 <= steps <= 100:
            return Failure(ValueError("steps는 2~100이어야 한다."), socket="steps")
        if not 256 <= reference_short_edge <= 2048 or reference_short_edge % 32:
            return Failure(
                ValueError("참조 짧은 변은 256~2048 사이의 32 배수여야 한다."),
                socket="reference_short_edge",
            )
        if not prompt.strip():
            return Failure(ValueError("프롬프트를 입력하세요."), socket="prompt")
        if memory_profile not in PROFILES:
            return Failure(ValueError("지원하지 않는 메모리 프로필이다."), socket="memory_profile")
        if memory_profile == CONVROT_PROFILE and not is_pruned(root, component):
            return Failure(
                ValueError("ConvRot 프로필에는 MiniMax-H3-Pruned 폴더가 필요하다."),
                socket="memory_profile",
            )
        if ctx.models.plan.compute.kind != "cuda":
            return Failure(
                RuntimeError("H3는 NVIDIA GPU 서버에서 실행하세요. docs/minimax-h3.md 참고."),
                socket="model_path",
            )
        images = {}
        for socket, argument, value in (
            ("first_frame", "image", first_frame),
            ("last_frame", "last_image", last_frame),
        ):
            try:
                image = _keyframe(value)
            except ValueError as exc:
                return Failure(exc, socket=socket)
            if image is not None:
                images[argument] = image
        try:
            require_video_runtime()
            import torch
            from diffusers import MiniMaxH3Transformer3DModel  # noqa: F401

            if references:
                from diffusers.modular_pipelines.minimax_h3.references import (
                    MiniMaxH3ImageReference,
                )

                images["references"] = [MiniMaxH3ImageReference(image=ref) for ref in references]

            if memory_profile in ("int8_offload", CONVROT_PROFILE):
                importlib.import_module("torchao.quantization")
        except (ImportError, RuntimeError) as exc:
            return Failure(
                RuntimeError(f"H3 런타임 확인 실패: {exc}. `uv sync --extra cuda --group h3`"),
                socket="memory_profile",
            )
        ctx.raise_if_cancelled()
        total = steps + 2
        from .manager import ModelManager

        if isinstance(ctx.models, ModelManager):
            ctx.models.release_unused()
        shortage = memory_shortage(memory_profile)
        if shortage is not None:
            return Failure(MemoryError(shortage), socket="memory_profile")
        ctx.progress(0, total)
        workflow = "ref2va" if references else ("fl2va" if images else "t2va")
        with _pipeline(root, workflow, memory_profile, ctx) as pipe:
            if references:
                pipe.update_components(reference_image_short_edge=reference_short_edge)
            ctx.progress(1, total)
            completed = 1

            def before_forward(_module: Any, _args: Any) -> None:
                ctx.raise_if_cancelled()

            def after_forward(_module: Any, _args: Any, _output: Any) -> None:
                nonlocal completed
                completed += 1
                ctx.progress(min(completed, steps), total)
                ctx.raise_if_cancelled()

            transformer = getattr(pipe, component)
            pre_hook = transformer.register_forward_pre_hook(before_forward)
            post_hook = transformer.register_forward_hook(after_forward)
            try:
                # TorchAO Int8Tensor CPU/CUDA transfers need storage/view tracking.
                # inference_mode breaks group offloading on torch 2.13 + torchao 0.18.
                with torch.no_grad():
                    result = pipe(
                        prompt=prompt,
                        width=width,
                        height=height,
                        num_frames=num_frames,
                        num_inference_steps=steps,
                        generator=torch.Generator().manual_seed(seed),
                        output=["videos", "audio", "sampling_rate"],
                        **images,
                    )
            finally:
                pre_hook.remove()
                post_hook.remove()
                del transformer
            ctx.raise_if_cancelled()
            frames = result["videos"][0]
            waveform = result["audio"][0].detach().float().cpu().numpy()
            sampling_rate = int(result["sampling_rate"])
        ctx.progress(steps + 1, total)
        with TemporaryDirectory(prefix="nodal-h3-") as temporary:
            path = Path(temporary) / "video.webm"
            encode_webm(
                path,
                frames,
                waveform,
                sampling_rate,
                check_cancelled=ctx.raise_if_cancelled,
                graph_json=ctx.graph_json(),
            )
            ctx.raise_if_cancelled()
            asset = ctx.assets.put(path.read_bytes(), media_type="video/webm")
        ctx.progress(total, total)
        return NodeResult(asset)
