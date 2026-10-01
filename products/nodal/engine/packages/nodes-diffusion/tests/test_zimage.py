"""Z-Image split 로더와 img2img 노드의 작은 계약 테스트."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from nodal.models import CPU, DevicePlan
from nodal_nodes_diffusion.handles import Checkpoint, ModelHandle
from nodal_nodes_diffusion.nodes import ZImageImg2Img, ZImageLoader, ZImageLoraLoader

pytest.importorskip("torch")
np = pytest.importorskip("numpy")


class _FakePipe:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}
        self.loaded: list[tuple[str, str]] = []
        self.active: tuple[list[str], list[float]] | None = None
        self.active_at_call: tuple[list[str], list[float]] | None = None

    def load_lora_weights(self, target: str, *, adapter_name: str) -> None:
        self.loaded.append((target, adapter_name))
        self.active = ([adapter_name], [1.0])

    def set_adapters(self, names: list[str], *, adapter_weights: list[float]) -> None:
        self.active = (names, adapter_weights)

    def enable_lora(self) -> None:
        return None

    def disable_lora(self) -> None:
        self.active = None

    def __call__(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        self.active_at_call = self.active
        callback = kwargs["callback_on_step_end"]
        callback(self, 0, None, {})
        callback(self, 1, None, {})
        image = np.asarray(kwargs["image"], dtype=np.float32)[..., :3]
        return SimpleNamespace(images=image * 0.5)


class _Context:
    def __init__(self, models: Any = None) -> None:
        self.models = models
        self.progress_events: list[tuple[int, int]] = []

    def raise_if_cancelled(self) -> None:
        return None

    def progress(self, step: int, total: int, *, preview: Any = None) -> None:
        del preview
        self.progress_events.append((step, total))


def _model(pipe: Any, architecture: str = "ZImageImg2ImgPipeline") -> ModelHandle:
    plan = DevicePlan(compute=CPU, offload=CPU, dtype="float32")
    checkpoint = Checkpoint(
        ref="zimage-test",
        loader="diffusers.zimage_components",
        pipe=pipe,
        plan=plan,
        architecture=architecture,
    )
    return ModelHandle(checkpoint)


def test_img2img_delegates_to_diffusers_and_preserves_image_contract() -> None:
    pipe = _FakePipe()
    ctx = _Context()
    source = np.ones((1, 32, 48, 4), dtype=np.float32)

    result = ZImageImg2Img().run(
        model=_model(pipe),
        image=source,
        prompt="warm editorial photograph",
        negative_prompt="text",
        strength=0.55,
        steps=8,
        guidance_scale=4.0,
        seed=42,
        ctx=ctx,  # type: ignore[arg-type]
    )

    output = result.values[0]
    assert output.shape == (1, 32, 48, 3)
    assert output.dtype == np.float32
    assert float(output[0, 0, 0, 0]) == pytest.approx(0.5)
    assert pipe.kwargs["prompt"] == "warm editorial photograph"
    assert pipe.kwargs["strength"] == pytest.approx(0.55)
    assert pipe.kwargs["generator"].initial_seed() == 42
    assert pipe.kwargs["output_type"] == "np"
    assert pipe.kwargs["image"].shape == (1, 32, 48, 3)
    assert ctx.progress_events == [(1, 5), (2, 5)]


class _FakeTxt2ImgPipe:
    """`diffusers.ZImagePipeline` 대역 — 받은 컴포넌트와 호출 인자를 기록한다."""

    built: list[_FakeTxt2ImgPipe] = []

    def __init__(self, **components: Any) -> None:
        self.components = components
        self.kwargs: dict[str, Any] = {}
        _FakeTxt2ImgPipe.built.append(self)

    def set_progress_bar_config(self, **_: Any) -> None:
        return None

    def __call__(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        callback = kwargs["callback_on_step_end"]
        for index in range(kwargs["num_inference_steps"]):
            callback(self, index, None, {})
        shape = (kwargs["height"], kwargs["width"], 3)
        return SimpleNamespace(images=np.full(shape, 0.25, dtype=np.float32))


def test_txt2img_reuses_the_loader_components_and_needs_no_image(monkeypatch) -> None:
    import diffusers

    from nodal_nodes_diffusion.nodes import ZImageTxt2Img

    _FakeTxt2ImgPipe.built.clear()
    monkeypatch.setattr(diffusers, "ZImagePipeline", _FakeTxt2ImgPipe)
    img2img = _FakePipe()
    img2img.components = {
        "transformer": "T",
        "vae": "V",
        "text_encoder": "E",
        "tokenizer": "K",
        "scheduler": "S",
    }  # type: ignore[attr-defined]
    ctx = _Context()

    result = ZImageTxt2Img().run(
        model=_model(img2img),
        prompt="k-pop idol on a concert stage",
        negative_prompt="",
        width=1280,
        height=720,
        steps=3,
        guidance_scale=4.0,
        seed=11,
        ctx=ctx,  # type: ignore[arg-type]
    )

    # 로더가 조립한 가중치를 그대로 공유한다 — 다시 읽지 않는다.
    [pipe] = _FakeTxt2ImgPipe.built
    assert pipe.components == img2img.components  # type: ignore[attr-defined]
    assert result.values[0].shape == (1, 720, 1280, 3)
    assert pipe.kwargs["width"] == 1280 and pipe.kwargs["height"] == 720
    assert pipe.kwargs["negative_prompt"] is None  # 빈 문자열은 넘기지 않는다
    assert pipe.kwargs["generator"].initial_seed() == 11
    assert "image" not in pipe.kwargs
    assert ctx.progress_events == [(1, 3), (2, 3), (3, 3)]


def test_txt2img_rejects_other_models_and_bad_sizes() -> None:
    from nodal_nodes_diffusion.nodes import ZImageTxt2Img

    common = {"prompt": "x", "negative_prompt": "", "steps": 1, "guidance_scale": 1.0, "seed": 0}
    with pytest.raises(ValueError, match="ZImageLoader 출력만"):
        ZImageTxt2Img().run(
            model=_model(_FakePipe(), "StableDiffusionXLPipeline"),
            width=512,
            height=512,
            ctx=_Context(),
            **common,
        )  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="16의 배수"):
        ZImageTxt2Img().run(
            model=_model(_FakePipe()), width=1000, height=512, ctx=_Context(), **common
        )  # type: ignore[arg-type]


def test_img2img_rejects_an_ordinary_checkpoint() -> None:
    with pytest.raises(ValueError, match="ZImageLoader 출력만"):
        ZImageImg2Img().run(
            model=_model(_FakePipe(), "StableDiffusionXLPipeline"),
            image=np.zeros((1, 8, 8, 3), dtype=np.float32),
            prompt="x",
            negative_prompt="",
            strength=0.5,
            steps=4,
            guidance_scale=1.0,
            seed=0,
            ctx=_Context(),  # type: ignore[arg-type]
        )


def test_zimage_lora_is_active_only_during_img2img(tmp_path, monkeypatch) -> None:
    from nodal_nodes_diffusion import scanner

    monkeypatch.setattr(scanner, "_root", tmp_path)
    lora_dir = tmp_path / "loras"
    lora_dir.mkdir()
    lora_path = lora_dir / "identity.safetensors"
    lora_path.write_bytes(b"weights")

    pipe = _FakePipe()
    loaded = ZImageLoraLoader().run(
        model=_model(pipe),
        lora_name=lora_path.name,
        strength=0.85,
        ctx=_Context(),  # type: ignore[arg-type]
    )
    model = loaded.values[0]

    assert isinstance(model, ModelHandle)
    assert pipe.loaded == [(str(lora_path), "identity_safetensors")]
    assert pipe.active is None

    ZImageImg2Img().run(
        model=model,
        image=np.zeros((1, 8, 8, 3), dtype=np.float32),
        prompt="hwiwon character",
        negative_prompt="",
        strength=0.5,
        steps=4,
        guidance_scale=1.0,
        seed=7,
        ctx=_Context(),  # type: ignore[arg-type]
    )

    assert pipe.active_at_call == (["identity_safetensors"], [0.85])
    assert pipe.active is None


def test_loader_resolves_all_three_local_components(tmp_path, monkeypatch) -> None:
    from nodal_nodes_diffusion import scanner
    from nodal_nodes_diffusion.manager import ModelManager

    monkeypatch.setattr(scanner, "_root", tmp_path)
    names = {
        "diffusion_models": "z.safetensors",
        "text_encoders": "qwen.safetensors",
        "vae": "ae.safetensors",
    }
    for provider, name in names.items():
        folder = tmp_path / scanner.PROVIDERS[provider][0]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(b"weights")

    seen: dict[str, Any] = {}

    def fake_zimage(self: ModelManager, **kwargs: Any) -> ModelHandle:
        del self
        seen.update(kwargs)
        return _model(_FakePipe())

    monkeypatch.setattr(ModelManager, "zimage", fake_zimage)
    manager = ModelManager()
    result = ZImageLoader().run(
        transformer=names["diffusion_models"],
        text_encoder=names["text_encoders"],
        vae=names["vae"],
        config_repo="Tongyi-MAI/Z-Image",
        ctx=_Context(manager),  # type: ignore[arg-type]
    )

    assert isinstance(result.values[0], ModelHandle)
    assert seen["transformer_target"] == str(
        tmp_path / "diffusion_models" / names["diffusion_models"]
    )
    assert seen["text_encoder_target"] == str(tmp_path / "text_encoders" / names["text_encoders"])
    assert seen["vae_target"] == str(tmp_path / "vae" / names["vae"])


def test_loader_missing_component_names_the_provider(tmp_path, monkeypatch) -> None:
    from nodal_nodes_diffusion import scanner
    from nodal_nodes_diffusion.manager import ModelManager

    monkeypatch.setattr(scanner, "_root", tmp_path)
    with pytest.raises(FileNotFoundError, match="diffusion_models"):
        ZImageLoader().run(
            transformer="missing.safetensors",
            text_encoder="also-missing.safetensors",
            vae="missing-vae.safetensors",
            config_repo="Tongyi-MAI/Z-Image",
            ctx=_Context(ModelManager()),  # type: ignore[arg-type]
        )


def test_zimage_fp8_storage_policy(monkeypatch) -> None:
    from nodal.models import Device
    from nodal_nodes_diffusion.manager import ZIMAGE_FP8_ENV_VAR, zimage_fp8_storage

    gib = 2**30
    cuda_bf16 = DevicePlan(compute=Device("cuda", 0), offload=CPU, dtype="bfloat16")
    cuda_fp16 = DevicePlan(compute=Device("cuda", 0), offload=CPU, dtype="float16")
    cpu = DevicePlan(compute=CPU, offload=CPU, dtype="float32")
    monkeypatch.delenv(ZIMAGE_FP8_ENV_VAR, raising=False)

    # 16 GB 카드는 bf16 transformer(12.3 GB)로 VRAM 이 넘친다 → fp8 저장
    assert zimage_fp8_storage(cuda_bf16, 16 * gib) is True
    assert zimage_fp8_storage(cuda_bf16, 24 * gib) is False
    assert zimage_fp8_storage(cuda_bf16, None) is False
    # fp16 계산과 겹치면 NaN — 켜지 않는다. cuda 가 아니면 의미가 없다.
    assert zimage_fp8_storage(cuda_fp16, 16 * gib) is False
    assert zimage_fp8_storage(cpu, 16 * gib) is False

    monkeypatch.setenv(ZIMAGE_FP8_ENV_VAR, "off")
    assert zimage_fp8_storage(cuda_bf16, 16 * gib) is False
    monkeypatch.setenv(ZIMAGE_FP8_ENV_VAR, "on")
    assert zimage_fp8_storage(cuda_bf16, 48 * gib) is True
    assert zimage_fp8_storage(cuda_fp16, 48 * gib) is False
