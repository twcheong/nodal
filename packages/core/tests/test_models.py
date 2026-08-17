"""M4 계약 — 모델 저장소 인터페이스와 디바이스 계획 (`nodal.models`).

여기서 검사하는 것은 **표면이 약속한 것들**이다. 실제 로딩은 `nodes-diffusion`
의 몫이고 그 테스트는 그쪽에 있다. core 는 torch 를 모르므로 여기에도 없다.
"""

from __future__ import annotations

import pytest

from nodal import (
    STRING,
    CancelToken,
    Device,
    DevicePlan,
    ModelLoadError,
    ModelStore,
    NodeRegistry,
    NullCache,
    NullModelStore,
    RecordingEventSink,
    SchemaError,
    Seed,
    execute,
    node,
    parse_graph,
)

# --------------------------------------------------------------------- Device


def test_device_str_matches_torch_spelling():
    # 노드 팩에서 변환이 한 줄로 끝나야 한다.
    assert str(Device("cpu")) == "cpu"
    assert str(Device("mps")) == "mps"
    assert str(Device("cuda")) == "cuda"
    assert str(Device("cuda", 1)) == "cuda:1"


def test_device_rejects_index_on_single_device_backends():
    # mps 와 cpu 는 여러 개가 없다. `mps:0` 은 존재하지 않는 것을 가리킨다.
    with pytest.raises(ValueError, match="인덱스가 없다"):
        Device("mps", 0)
    with pytest.raises(ValueError, match="인덱스가 없다"):
        Device("cpu", 0)


def test_device_rejects_negative_index():
    with pytest.raises(ValueError, match="음수"):
        Device("cuda", -1)


def test_device_is_hashable_and_comparable():
    # DevicePlan.offloading 이 동등성에 기대므로 값 의미론이 필요하다.
    assert Device("cuda", 0) == Device("cuda", 0)
    assert Device("cuda", 0) != Device("cuda", 1)
    assert len({Device("cpu"), Device("cpu")}) == 1


# ----------------------------------------------------------------- DevicePlan


def test_plan_rejects_unknown_dtype():
    # dtype 어휘는 types.json 과 같아야 한다. 오타가 조용히 통과하면 안 된다.
    with pytest.raises(ValueError, match="알 수 없는 dtype"):
        DevicePlan(compute=Device("cuda"), dtype="fp16")


def test_offloading_derives_from_the_two_devices():
    # 별도 불리언을 두지 않는 이유 — 상태가 한 곳에만 있으면 어긋날 수 없다.
    cuda = Device("cuda", 0)
    assert DevicePlan(compute=cuda, offload=Device("cpu")).offloading is True
    assert DevicePlan(compute=cuda, offload=cuda).offloading is False


def test_plan_defaults_to_cpu_offload_float32():
    plan = DevicePlan(compute=Device("cuda"))
    assert plan.offload == Device("cpu")
    assert plan.dtype == "float32"


# -------------------------------------------------------------- ModelLoadError


def test_load_error_says_what_it_tried_to_infer():
    # design.md §9.2 — 추론 실패가 실사용에서 가장 자주 깨지는 지점이라
    # 네 가지(ref · loader · inferred · expected)를 반드시 싣는다.
    err = ModelLoadError(
        "/models/mystery.safetensors",
        loader="diffusers.single_file",
        reason="알려진 아키텍처와 맞지 않았다",
        expected=("sd15", "sdxl", "sd3", "flux"),
        evidence=("model.diffusion_model.*", "cond_stage_model.*"),
    )
    text = str(err)

    assert "/models/mystery.safetensors" in text
    assert "diffusers.single_file" in text
    # 추론 실패는 "없음" 으로 **명시된다**. 조용히 빠지면 사용자가 구분 못 한다.
    assert "추론된 아키텍처: 없음" in text
    assert "sdxl" in text
    assert "cond_stage_model.*" in text


def test_load_error_distinguishes_inferred_from_not_inferred():
    # "추론은 됐는데 그 다음이 실패" 와 "추론 자체가 실패" 는 다른 문제다.
    inferred = ModelLoadError(
        "/models/x.safetensors",
        loader="diffusers.single_file",
        reason="VAE 가 파일에 없다",
        inferred="sdxl",
        expected=("sd15", "sdxl"),
    )
    assert "추론된 아키텍처: sdxl" in str(inferred)
    assert "없음" not in str(inferred)
    assert inferred.inferred == "sdxl"


# ------------------------------------------------------------- NullModelStore


def test_null_store_satisfies_the_protocol():
    assert isinstance(NullModelStore(), ModelStore)


def test_null_store_answers_plan_but_fails_load():
    store = NullModelStore()

    # 디바이스가 무엇인지 묻는 것은 저장소 없이도 되어야 한다.
    assert store.plan == DevicePlan(compute=Device("cpu"), offload=Device("cpu"))

    # 로드는 조용히 None 을 주지 않고 그 자리에서 터진다 (NullAssetStore 와 같은 이유).
    with pytest.raises(ModelLoadError) as caught:
        store.load("anything.safetensors", loader="diffusers.single_file")
    assert "모델 저장소가 없다" in str(caught.value)
    assert caught.value.loader == "diffusers.single_file"


# ------------------------------------------------------------------ ctx.models


async def test_ctx_models_defaults_to_null_store():
    seen: list[object] = []

    @node(id="test.PeekModels", category="test")
    class PeekModels:
        returns = {"kind": STRING}

        def run(self, ctx):
            seen.append(ctx.models)
            return str(ctx.models.plan.compute)

    registry = NodeRegistry()
    registry.register(PeekModels)

    result = await execute(
        parse_graph({"nodes": {"n": {"type": "test.PeekModels"}}, "outputs": ["n"]}),
        ["n"],
        registry=registry,
        cache=NullCache(),
        events=RecordingEventSink(),
        cancel_token=CancelToken(),
    )

    assert isinstance(seen[0], NullModelStore)
    assert result.outputs["n"]["kind"] == "cpu"


async def test_injected_model_store_reaches_the_node():
    class FakeStore:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        @property
        def plan(self) -> DevicePlan:
            return DevicePlan(compute=Device("cuda", 0), dtype="float16")

        def load(self, ref: str, *, loader: str) -> object:
            self.calls.append((ref, loader))
            return {"unet": "u", "vae": "v"}

    store = FakeStore()

    @node(id="test.UseModels", category="test")
    class UseModels:
        returns = {"dtype": STRING}

        def run(self, ctx):
            ctx.models.load("sdxl.safetensors", loader="diffusers.single_file")
            return ctx.models.plan.dtype

    registry = NodeRegistry()
    registry.register(UseModels)

    result = await execute(
        parse_graph({"nodes": {"n": {"type": "test.UseModels"}}, "outputs": ["n"]}),
        ["n"],
        registry=registry,
        cache=NullCache(),
        events=RecordingEventSink(),
        cancel_token=CancelToken(),
        models=store,
    )

    assert store.calls == [("sdxl.safetensors", "diffusers.single_file")]
    assert result.outputs["n"]["dtype"] == "float16"


# ------------------------------------------------------------------ Seed 위젯


def test_seed_is_an_int_socket_with_control_hint():
    # 소켓 타입은 평범한 INT 다. 다른 것은 위젯뿐이다 (design.md §9.4).
    seed = Seed(0)
    assert seed.type.name == "INT"
    assert seed.widget["seed"] is True
    assert seed.widget["control"] == "randomize"
    assert seed.widget["min"] == 0
    assert seed.widget["max"] == 2**53 - 1


def test_seed_max_survives_a_json_round_trip():
    # 프론트가 이 값을 위젯 상한으로 쓴다. 2**64-1 은 JSON.parse 에서 값이
    # 바뀌어 시드가 조용히 달라진다 — 재현성이 존재 이유인 위젯에서 치명적이다.
    import json

    assert json.loads(json.dumps(Seed.MAX)) == Seed.MAX
    assert Seed.MAX == 9007199254740991  # JS Number.MAX_SAFE_INTEGER


def test_seed_rejects_unknown_control():
    # 이 이름들은 프론트 코드에 박히는 에이전트 간 계약이다. 오타를 통과시키면
    # 양쪽 저장소가 다 초록인 채로 런타임에야 어긋난다.
    with pytest.raises(SchemaError, match="알 수 없는 시드 control"):
        Seed(0, control="random")


def test_seed_controls_come_from_types_json():
    # 어휘를 두 곳에 적지 않는다. 프론트도 같은 파일에서 리터럴 타입을 만들므로
    # (apps/web/src/graph/widgets.ts) 여기서 하드코딩하면 조용히 갈라진다.
    from nodal.types import load_catalog

    assert load_catalog().widget_options("seed", "control") == Seed.CONTROLS
    assert Seed.CONTROLS == ("fixed", "increment", "randomize")


def test_unknown_widget_vocabulary_fails_loudly():
    # 조용히 빈 튜플을 돌려주면 control 검증이 통째로 꺼진 채 통과한다.
    from nodal.types import TypeSpecError, load_catalog

    with pytest.raises(TypeSpecError, match="widget_vocabulary"):
        load_catalog().widget_options("seed", "없는키")
