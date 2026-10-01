"""Readiness must exercise the processor before allocating H3 model weights."""

from types import SimpleNamespace

import pytest

from nodal.models import Device
from nodal_nodes_diffusion import devices, h3_check


@pytest.mark.parametrize("processor_missing", [False, True])
def test_readiness_loads_local_processor_and_reports_missing_dependency(
    tmp_path, monkeypatch, processor_missing
):
    (tmp_path / "weights.safetensors").touch()
    calls = []

    def load_processor(path, **kwargs):
        calls.append((path, kwargs))
        if processor_missing:
            raise ImportError("Qwen3VLVideoProcessor requires torchvision")
        return object()

    modules = {
        "diffusers": SimpleNamespace(MiniMaxH3Transformer3DModel=object, TorchAoConfig=lambda x: x),
        "torchao.quantization": SimpleNamespace(Int8WeightOnlyConfig=lambda **kw: object()),
        "transformers": SimpleNamespace(
            TorchAoConfig=lambda x: x,
            Qwen3VLProcessor=SimpleNamespace(from_pretrained=load_processor),
        ),
        "psutil": SimpleNamespace(
            virtual_memory=lambda: SimpleNamespace(available=32 * 2**30, total=64 * 2**30)
        ),
    }
    monkeypatch.setattr(h3_check, "version", lambda package: "test")
    monkeypatch.setattr(h3_check, "model_directory", lambda path: tmp_path)
    monkeypatch.setattr(h3_check, "is_pruned", lambda path: False)
    monkeypatch.setattr(h3_check, "require_video_runtime", lambda: None)
    monkeypatch.setattr(
        devices, "resolve_plan", lambda policy: SimpleNamespace(compute=Device("cuda"))
    )
    monkeypatch.setattr(devices, "free_memory", lambda device: 12 * 2**30)
    monkeypatch.setattr(h3_check.importlib, "import_module", modules.__getitem__)

    report = h3_check.check(str(tmp_path))

    assert calls == [(str(tmp_path), {"subfolder": "processor", "local_files_only": True})]
    assert report["inference_verified"] is False
    assert report["checks_passed"] is not processor_missing
    if processor_missing:
        assert report["errors"] == ["Qwen3VLVideoProcessor requires torchvision"]
    else:
        assert report["processor_loaded"] is True


def test_h3_memory_shortage_blocks_before_loading_instead_of_crashing(monkeypatch):
    from nodal_nodes_diffusion.h3 import H3_HEADROOM_ENV_VAR, memory_shortage

    monkeypatch.delenv(H3_HEADROOM_ENV_VAR, raising=False)
    # 2026-09-25: 예전 엔진이 78GB 를 잡고 있어 여유 88GB → 로딩 중 엔진이 죽었다.
    # 이제는 이유를 말하고 멈춘다.
    message = memory_shortage("pruned_convrot_int8_offload", headroom=88)
    assert message is not None and "88GB" in message and "160GB" in message
    assert memory_shortage("pruned_convrot_int8_offload", headroom=167) is None
    assert memory_shortage("int8_offload", headroom=10) is not None
    # bf16 은 양자화 사본을 만들지 않는다 — 재지 않는다.
    assert memory_shortage("bf16_offload", headroom=10) is None
    monkeypatch.setenv(H3_HEADROOM_ENV_VAR, "0")
    assert memory_shortage("pruned_convrot_int8_offload", headroom=10) is None
