"""FLUX.2 Klein split 로더와 네 장 다중 레퍼런스 노드 계약."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from nodal.models import CPU, DevicePlan
from nodal_nodes_diffusion.handles import Checkpoint, ModelHandle
from nodal_nodes_diffusion.nodes import Flux2KleinLoader, Flux2KleinMultiReference

pytest.importorskip("torch")
np = pytest.importorskip("numpy")


class _FakePipe:
    def __init__(self, *, is_distilled: bool = True) -> None:
        self.kwargs: dict[str, Any] = {}
        self.config = SimpleNamespace(is_distilled=is_distilled)

    def __call__(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        callback = kwargs["callback_on_step_end"]
        callback(self, 0, None, {})
        callback(self, 1, None, {})
        return SimpleNamespace(
            images=np.full((1, kwargs["height"], kwargs["width"], 3), 0.25, np.float32)
        )


class _Context:
    def __init__(self, models: Any = None) -> None:
        self.models = models
        self.progress_events: list[tuple[int, int]] = []

    def raise_if_cancelled(self) -> None:
        return None

    def progress(self, step: int, total: int, *, preview: Any = None) -> None:
        del preview
        self.progress_events.append((step, total))


def _model(pipe: Any, architecture: str = "Flux2KleinPipeline") -> ModelHandle:
    plan = DevicePlan(compute=CPU, offload=CPU, dtype="float32")
    checkpoint = Checkpoint(
        ref="flux2-klein-test",
        loader="diffusers.flux2_klein_components",
        pipe=pipe,
        plan=plan,
        architecture=architecture,
    )
    return ModelHandle(checkpoint)


@pytest.mark.parametrize("is_distilled,steps,guidance", [(True, 4, 1.0), (False, 50, 4.0)])
def test_multi_reference_passes_four_distinct_images_to_diffusers(
    is_distilled: bool, steps: int, guidance: float
) -> None:
    pipe = _FakePipe(is_distilled=is_distilled)
    ctx = _Context()
    references = [
        np.full((1, 18 + index, 20 + index, 4), index / 4, np.float32) for index in range(1, 5)
    ]

    result = Flux2KleinMultiReference().run(
        model=_model(pipe),
        reference_1=references[0],
        reference_2=references[1],
        reference_3=references[2],
        reference_4=references[3],
        prompt="Use the face from image 1 and outfit from image 3",
        width=64,
        height=80,
        steps=steps,
        seed=42,
        ctx=ctx,  # type: ignore[arg-type]
    )

    output = result.values[0]
    assert output.shape == (1, 80, 64, 3)
    assert output.dtype == np.float32
    assert len(pipe.kwargs["image"]) == 4
    assert [image.size for image in pipe.kwargs["image"]] == [
        (21, 19),
        (22, 20),
        (23, 21),
        (24, 22),
    ]
    assert pipe.kwargs["guidance_scale"] == guidance
    assert pipe.kwargs["num_inference_steps"] == steps
    assert pipe.kwargs["generator"].initial_seed() == 42
    assert ctx.progress_events == [(1, steps), (2, steps)]


def test_multi_reference_omits_unconnected_optional_images() -> None:
    pipe = _FakePipe()
    source = np.zeros((1, 16, 16, 3), np.float32)

    Flux2KleinMultiReference().run(
        model=_model(pipe),
        reference_1=source,
        reference_2=None,
        reference_3=None,
        reference_4=None,
        prompt="same character",
        width=32,
        height=32,
        steps=4,
        seed=0,
        ctx=_Context(),  # type: ignore[arg-type]
    )

    assert len(pipe.kwargs["image"]) == 1


def test_multi_reference_rejects_other_pipeline_architectures() -> None:
    with pytest.raises(ValueError, match="Flux2KleinLoader 출력만"):
        Flux2KleinMultiReference().run(
            model=_model(_FakePipe(), "ZImageImg2ImgPipeline"),
            reference_1=np.zeros((1, 8, 8, 3), np.float32),
            reference_2=None,
            reference_3=None,
            reference_4=None,
            prompt="same character",
            width=32,
            height=32,
            steps=4,
            seed=0,
            ctx=_Context(),  # type: ignore[arg-type]
        )


def test_loader_resolves_all_local_components(tmp_path, monkeypatch) -> None:
    from nodal_nodes_diffusion import scanner
    from nodal_nodes_diffusion.manager import ModelManager

    monkeypatch.setattr(scanner, "_root", tmp_path)
    names = {
        "diffusion_models": "flux2.safetensors",
        "text_encoders": "qwen.safetensors",
        "vae": "flux2-ae.safetensors",
    }
    for provider, name in names.items():
        folder = tmp_path / scanner.PROVIDERS[provider][0]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(b"weights")

    seen: dict[str, Any] = {}

    def fake_flux2_klein(self: ModelManager, **kwargs: Any) -> ModelHandle:
        del self
        seen.update(kwargs)
        return _model(_FakePipe())

    monkeypatch.setattr(ModelManager, "flux2_klein", fake_flux2_klein)
    manager = ModelManager()
    result = Flux2KleinLoader().run(
        transformer=names["diffusion_models"],
        text_encoder=names["text_encoders"],
        vae=names["vae"],
        config_repo="black-forest-labs/FLUX.2-klein-4B",
        ctx=_Context(manager),  # type: ignore[arg-type]
    )

    assert isinstance(result.values[0], ModelHandle)
    assert seen["transformer_target"] == str(
        tmp_path / "diffusion_models" / names["diffusion_models"]
    )
    assert seen["text_encoder_target"] == str(tmp_path / "text_encoders" / names["text_encoders"])
    assert seen["vae_target"] == str(tmp_path / "vae" / names["vae"])
