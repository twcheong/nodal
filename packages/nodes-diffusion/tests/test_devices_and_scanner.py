"""능력 테이블과 모델 스캐너 — **하드웨어 없이** 검사한다.

저자가 맥에서 개발하고 GPU 는 별도 리눅스 장비인 환경에서, "cuda 면 어떻게
되는가" 를 GPU 에서만 확인할 수 있으면 그 분기는 사실상 검사되지 않는다.
정책이 값으로 주입되기 때문에 세 백엔드의 계획을 어디서나 확인할 수 있다
(design.md §9.3).
"""

from __future__ import annotations

import pytest

from nodal.models import DTYPES
from nodal_nodes_diffusion import scanner
from nodal_nodes_diffusion.devices import BACKENDS, DevicePolicy

# ------------------------------------------------------------------ 능력 테이블


def test_every_backend_has_a_capability_row():
    # 새 백엔드를 DeviceKind 에 추가하고 테이블에 넣는 것을 잊으면 KeyError 가
    # 런타임에 난다. 여기서 먼저 잡는다.
    from typing import get_args

    from nodal.models import DeviceKind

    assert set(BACKENDS) == set(get_args(DeviceKind))


def test_capability_dtypes_are_in_the_shared_vocabulary():
    # dtype 어휘는 types.json 과 같아야 한다 (`nodal.models.DTYPES`).
    for backend in BACKENDS.values():
        assert backend.dtype in DTYPES


def test_cpu_defaults_to_float32():
    # CPU 의 fp16 은 대부분의 커널에서 미지원이거나 에뮬레이션이라 더 느리다.
    assert BACKENDS["cpu"].dtype == "float32"


def test_offload_is_only_meaningful_on_cuda():
    # mps 는 통합 메모리, cpu 는 애초에 호스트다 — 오프로드가 이득이 아니라
    # 같은 메모리 안에서 텐서를 옮기기만 하는 순손실이다.
    assert BACKENDS["cuda"].supports_offload is True
    assert BACKENDS["mps"].supports_offload is False
    assert BACKENDS["cpu"].supports_offload is False


def test_only_cuda_reports_free_memory():
    assert BACKENDS["cuda"].reports_free_memory is True
    assert BACKENDS["mps"].reports_free_memory is False
    assert BACKENDS["cpu"].reports_free_memory is False


# ------------------------------------------------------------------- 정책


def test_policy_rejects_unknown_backend():
    with pytest.raises(ValueError, match="알 수 없는 디바이스 정책"):
        DevicePolicy("gpu")


def test_policy_reads_the_env_var():
    assert DevicePolicy.from_env({"NODAL_DEVICE": "cpu"}).preferred == "cpu"
    assert DevicePolicy.from_env({}).preferred == "auto"


def test_explicit_backend_fails_loudly_when_absent():
    """cuda 를 지정했는데 없으면 **조용히 cpu 로 떨어지지 않는다.**

    cuda 를 지정했는데 cpu 로 도는 것은 거의 언제나 사고다 — 20 분 뒤에
    "왜 이렇게 느리지" 로 발견하는 것보다 지금 실패하는 편이 낫다.
    """
    pytest.importorskip("torch")
    from nodal_nodes_diffusion.devices import detect_kind

    # `torch.cuda.is_available()` 을 여기서 부르지 않는다 — 그것이 정확히
    # `devices.py` 밖에서 금지된 것이고, CI 의 경계 검사가 이 파일도 훑는다.
    # 대신 경계를 **통해서** 묻는다.
    if detect_kind(DevicePolicy("auto")) == "cuda":  # pragma: no cover - GPU 장비에서만
        pytest.skip("이 머신에는 cuda 가 있다")

    with pytest.raises(RuntimeError, match="쓸 수 없다"):
        detect_kind(DevicePolicy("cuda"))


def test_cpu_plan_has_no_offload():
    pytest.importorskip("torch")
    from nodal_nodes_diffusion.devices import resolve_plan

    plan = resolve_plan(DevicePolicy("cpu"))
    assert plan.compute.kind == "cpu"
    assert plan.offloading is False
    assert plan.dtype == "float32"


# ------------------------------------------------------------------ 스캐너


@pytest.fixture
def models_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "_root", tmp_path)
    return tmp_path


def test_scan_is_empty_without_a_root(monkeypatch):
    monkeypatch.setattr(scanner, "_root", None)
    monkeypatch.delenv(scanner.MODELS_ENV_VAR, raising=False)
    assert scanner.scan("checkpoints") == []


def test_scan_finds_single_files_and_folders(models_dir):
    root = models_dir / "checkpoints"
    root.mkdir()
    (root / "sdxl.safetensors").write_bytes(b"")
    (root / "old.ckpt").write_bytes(b"")
    (root / "notes.txt").write_text("x", encoding="utf-8")
    folder = root / "sd15-folder"
    folder.mkdir()
    (folder / "model_index.json").write_text("{}", encoding="utf-8")

    assert scanner.scan("checkpoints") == ["old.ckpt", "sd15-folder", "sdxl.safetensors"]


def test_scan_skips_hidden_entries(models_dir):
    root = models_dir / "loras"
    root.mkdir()
    (root / ".DS_Store").write_bytes(b"")
    (root / "style.safetensors").write_bytes(b"")
    assert scanner.scan("loras") == ["style.safetensors"]


def test_component_folders_are_found_by_config_json(models_dir):
    # VAE · ControlNet 은 파이프라인이 아니라 단일 모델이라 model_index.json 이 없다.
    root = models_dir / "vae"
    root.mkdir()
    folder = root / "sdxl-vae"
    folder.mkdir()
    (folder / "config.json").write_text("{}", encoding="utf-8")
    assert scanner.scan("vae") == ["sdxl-vae"]


def test_unknown_provider_raises():
    # 조용히 빈 목록을 주면 오타 난 공급자와 "모델이 없다" 를 구분할 수 없다.
    with pytest.raises(KeyError):
        scanner.scan("checkpoint")  # 단수형 오타


def test_providers_are_registered_in_core():
    """`Combo.from_provider` 가 실제로 이 공급자들을 찾을 수 있다."""
    from nodal import combo_options

    for name in scanner.PROVIDERS:
        combo_options(name)  # 등록되지 않았으면 SchemaError


#: 공급자를 쓰는 소켓 전부 — (노드 ID, 소켓 이름, 공급자, 놓을 파일).
#:
#: 하나만 검사하면 나머지 셋이 조용히 비어 있어도 통과한다. `/api/nodes` 가
#: **모델 목록의 유일한 경로**이므로 (`/api/models` 는 뺐다 — `decisions.md`
#: 2026-08-18) 여기가 비면 그 소켓의 콤보는 화면에서 "모델 없음" 이 된다.
_PROVIDER_SOCKETS = [
    ("diffusion.LoadCheckpoint", "ckpt", "checkpoints", "my-model.safetensors"),
    ("diffusion.LoraLoader", "lora_name", "loras", "my-lora.safetensors"),
    ("diffusion.ControlNetLoader", "control_net_name", "controlnet", "my-cnet.safetensors"),
]


def test_scanned_names_reach_the_node_schema(models_dir):
    """스캔 결과가 **실제 서버의** `/api/nodes` 위젯 옵션까지 간다.

    목이 아니라 `create_app` 이 만든 앱에 붙는다 — 스캐너 · `Combo` 공급자 ·
    `wire._widget_model` · 라우트가 전부 실제로 이어져야 통과한다. 그 사슬 중
    하나만 끊겨도 프론트의 모델 콤보가 빈다.
    """
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from nodal_nodes_diffusion import registry
    from nodal_server.app import create_app

    for _, _, provider, filename in _PROVIDER_SOCKETS:
        subdir = models_dir / scanner.PROVIDERS[provider][0]
        subdir.mkdir(parents=True, exist_ok=True)
        (subdir / filename).write_bytes(b"")

    client = TestClient(create_app(registry()))
    nodes = {n["id"]: n for n in client.get("/api/nodes").json()["nodes"]}

    for node_id, socket_name, provider, filename in _PROVIDER_SOCKETS:
        socket = next(i for i in nodes[node_id]["inputs"] if i["name"] == socket_name)
        assert socket["widget"]["provider"] == provider
        assert socket["widget"]["options"] == [filename], (
            f"{node_id}.{socket_name} 의 옵션이 비었다 — 이 콤보는 화면에서 '모델 없음' 이다"
        )
