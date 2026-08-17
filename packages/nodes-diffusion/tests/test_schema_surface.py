"""diffusion 노드의 **스키마 표면** 검사 (M4 얇은 수직 절단).

이 파일의 요점은 하나다 — **프론트가 실제로 받는 것**을 검사한다. 노드 클래스를
직접 들여다보는 것이 아니라 `/api/nodes` 응답까지 가서 본다. 시드 위젯이
`Seed` 클래스에는 있는데 전송 중 어딘가에서 사라지는 상황이 정확히 이 계약이
깨지는 방식이기 때문이다 (AGENTS.md 규칙 7 의 "조용히 어긋난다").

**대부분의 테스트가 torch 없이 돈다.** 그래야 기본 `uv sync` 환경에서도 이
계약이 지켜지는지 확인된다 — 스키마 노출에 런타임이 필요 없다는 것이 이
설계의 핵심 주장이므로, 그 주장 자체를 테스트가 검증해야 한다.
"""

from __future__ import annotations

import json

import pytest

from nodal import Seed
from nodal_nodes_diffusion import NODES, SAMPLERS, SCHEDULERS, registry


def _inputs(node_id: str) -> dict[str, dict[str, object]]:
    """`/api/nodes` 를 거쳐 온 입력 서술을 이름으로 색인해 돌려준다."""
    fastapi = pytest.importorskip("fastapi.testclient")
    pytest.importorskip("nodal_server")
    from nodal_server.app import create_app

    client = fastapi.TestClient(create_app(registry()))
    response = client.get("/api/nodes")
    assert response.status_code == 200
    schema = next(n for n in response.json()["nodes"] if n["id"] == node_id)
    return {item["name"]: item for item in schema["inputs"]}


# ------------------------------------------------------------ torch 없이 등록


def test_pack_registers_without_torch():
    # 이 팩은 스키마 노출을 위해 언제나 설치된다. torch 는 옵트인이므로
    # 등록 경로가 런타임을 요구하면 팔레트에서 노드가 통째로 사라진다.
    ids = {schema.id for schema in registry()}
    assert ids == {
        "diffusion.CLIPTextEncode",
        "diffusion.ControlNetApply",
        "diffusion.ControlNetLoader",
        "diffusion.EmptyLatent",
        "diffusion.KSampler",
        "diffusion.LoadCheckpoint",
        "diffusion.LoraLoader",
        "diffusion.VAEDecode",
    }
    assert len(NODES) == len(ids)


# ---------------------------------------------------------------- 시드 위젯


def test_seed_widget_reaches_the_api():
    seed = _inputs("diffusion.KSampler")["seed"]

    # 소켓은 평범한 INT 다 — 프론트는 타입이 아니라 위젯 힌트로 판별한다.
    assert seed["type"] == "INT"
    assert seed["widget"]["seed"] is True
    assert seed["widget"]["control"] in Seed.CONTROLS


def test_seed_bounds_survive_json():
    # 여기가 이 파일에서 가장 중요한 단언이다. 2**64-1 을 상한으로 두면
    # JSON.parse 가 18446744073709552000 을 돌려주고 시드가 조용히 달라진다.
    seed = _inputs("diffusion.KSampler")["seed"]
    maximum = seed["widget"]["max"]

    assert maximum == 2**53 - 1
    assert json.loads(json.dumps(maximum)) == maximum
    assert seed["widget"]["min"] == 0


def test_seed_is_optional_with_a_default():
    # 시드가 필수 입력이면 새 노드를 놓자마자 빨간 소켓이 된다.
    seed = _inputs("diffusion.KSampler")["seed"]
    assert seed["required"] is False
    assert seed["default"] == 0


# ------------------------------------------------------------------ 소켓 타입


def test_conditioning_sockets_are_not_clip():
    # CLIP 은 인코더, Conditioning 은 그 출력이다. 하나로 합치면 KSampler 의
    # positive 에 텍스트 인코더가 그대로 꽂힌다 (types.json conformance).
    inputs = _inputs("diffusion.KSampler")
    assert inputs["positive"]["type"] == "Conditioning"
    assert inputs["negative"]["type"] == "Conditioning"
    assert inputs["model"]["type"] == "Model"
    assert inputs["latent"]["type"] == "Latent"


def test_required_sockets_have_no_default():
    # 링크로만 채울 수 있는 소켓들. 기본값이 있으면 연결하지 않아도 실행돼 버린다.
    inputs = _inputs("diffusion.KSampler")
    for name in ("model", "positive", "negative", "latent"):
        assert inputs[name]["required"] is True, name


def test_combo_options_come_from_the_schema():
    # 프론트가 샘플러 목록을 하드코딩하지 않도록 스키마가 실어 보낸다.
    inputs = _inputs("diffusion.KSampler")
    assert tuple(inputs["sampler_name"]["widget"]["options"]) == SAMPLERS
    assert tuple(inputs["scheduler"]["widget"]["options"]) == SCHEDULERS


def test_empty_latent_takes_pixels_not_latent_units():
    # 사용자가 생각하는 단위는 픽셀이다. 기본값이 잠재 단위(128)면 실수한 것.
    inputs = _inputs("diffusion.EmptyLatent")
    assert inputs["width"]["default"] == 1024
    assert inputs["height"]["default"] == 1024
    assert inputs["width"]["widget"]["step"] == 8
