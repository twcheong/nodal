"""Z-Image split 로더와 img2img 노드의 작은 계약 테스트."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from nodal.models import CPU, DevicePlan
from nodal_nodes_diffusion.handles import Checkpoint, ModelHandle
from nodal_nodes_diffusion.nodes import ZImageImg2Img, ZImageLoader

pytest.importorskip("torch")
np = pytest.importorskip("numpy")


class _FakePipe:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    def __call__(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
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
