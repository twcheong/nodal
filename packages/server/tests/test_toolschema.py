"""params → MCP 툴 `inputSchema` 변환 계약 (design.md §12.3).

이 파일이 고정하는 것은 셋이다:

1. 타입 매핑표가 문서와 같은가
2. **엔진보다 엄격해지지 않는가** — 옮길 수 없는 제약은 옮기지 않는다
3. 변환할 수 없는 타입이 있으면 스키마가 **아예 나오지 않는가**
"""

from __future__ import annotations

from typing import Any

import pytest

from nodal import ParamDef
from nodal_server.toolschema import build_input_schema


def param(type_expr: Any, **kwargs: Any) -> ParamDef:
    return ParamDef(type=type_expr, **kwargs)


# ------------------------------------------------------------------ 타입 매핑


@pytest.mark.parametrize(
    ("type_expr", "expected"),
    [
        ("INT", {"type": "integer"}),
        ("FLOAT", {"type": "number"}),
        ("STRING", {"type": "string"}),
        ("BOOL", {"type": "boolean"}),
        ({"list": "INT"}, {"type": "array", "items": {"type": "integer"}}),
        (
            {"union": ["INT", "STRING"]},
            {"anyOf": [{"type": "integer"}, {"type": "string"}]},
        ),
        (
            {"list": {"union": ["INT", "STRING"]}},
            {"type": "array", "items": {"anyOf": [{"type": "integer"}, {"type": "string"}]}},
        ),
    ],
)
def test_convertible_types(type_expr: Any, expected: dict[str, Any]) -> None:
    result = build_input_schema({"p": param(type_expr)})
    assert result.schema is not None
    assert result.schema["properties"]["p"] == expected


@pytest.mark.parametrize(
    "type_expr",
    [
        "Any",  # 검증할 것이 없으면 툴을 템플릿당 하나 만든 이유가 사라진다
        "Image",  # 텐서 — 클라이언트가 JSON 으로 만들 수 없다
        "Mask",
        "Latent",
        "Model",  # 불투명 핸들 — 엔진 안에서만 산다
        "VAE",
        {"list": "Image"},  # 담는 그릇이 바뀌어도 안의 것은 그대로다
        {"union": ["INT", "Image"]},  # 멤버 하나가 안 되면 union 도 안 된다
        {"tensor": {"dtypes": ["float32"], "shape": ["B", "H", "W", "C"]}},
    ],
)
def test_unconvertible_types_block_the_template(type_expr: Any) -> None:
    result = build_input_schema({"p": param(type_expr)})
    assert result.schema is None, "구멍 난 스키마를 내보내느니 툴이 없는 편이 낫다"
    assert [note.param for note in result.errors] == ["p"]


def test_broken_type_expression_is_reported_not_raised() -> None:
    result = build_input_schema({"p": param({"nonsense": 1})})
    assert result.schema is None
    assert "타입 표현식" in result.errors[0].reason


def test_one_bad_param_blocks_but_all_are_reported() -> None:
    """파라미터 셋이 잘못됐으면 셋 다 보고한다 — 한 번에 고칠 수 있어야 한다."""
    result = build_input_schema({"a": param("Image"), "b": param("INT"), "c": param("Model")})
    assert result.schema is None
    assert {note.param for note in result.errors} == {"a", "c"}


# ------------------------------------------------------------------ 필수 · 기본값


def test_default_decides_required() -> None:
    result = build_input_schema(
        {
            "needed": param("STRING"),
            "optional": param("INT", default=256),
            "explicit_null": param("INT", default=None),
        }
    )
    assert result.schema is not None
    # `default` 가 없는 것과 `null` 인 것을 구분하지 않는다 (§5.5).
    assert result.schema["required"] == ["needed", "explicit_null"]
    assert result.schema["properties"]["optional"]["default"] == 256
    assert "default" not in result.schema["properties"]["needed"]


def test_only_declared_params_are_accepted() -> None:
    result = build_input_schema({"a": param("INT")})
    assert result.schema is not None
    assert result.schema["additionalProperties"] is False


def test_no_params_is_a_valid_tool() -> None:
    result = build_input_schema({})
    assert result.schema == {"type": "object", "properties": {}, "additionalProperties": False}


# ------------------------------------------------------------------ 위젯 제약


def test_widget_min_max_step_become_constraints() -> None:
    result = build_input_schema(
        {"size": param("INT", default=256, widget={"min": 16, "max": 2048, "step": 8})}
    )
    assert result.schema is not None
    assert result.schema["properties"]["size"] == {
        "type": "integer",
        "minimum": 16,
        "maximum": 2048,
        "multipleOf": 8,
        "default": 256,
    }
    assert result.notes == ()


def test_options_become_enum() -> None:
    result = build_input_schema(
        {"method": param("STRING", default="lanczos", widget={"options": ["nearest", "lanczos"]})}
    )
    assert result.schema is not None
    assert result.schema["properties"]["method"]["enum"] == ["nearest", "lanczos"]


def test_step_is_dropped_when_min_is_not_a_multiple() -> None:
    """`multipleOf: 8` 에 `min: 1` 을 더하면 엔진이 받는 100 을 스키마가 거부한다."""
    result = build_input_schema({"w": param("INT", widget={"min": 1, "max": 16384, "step": 8})})
    assert result.schema is not None
    prop = result.schema["properties"]["w"]
    assert "multipleOf" not in prop
    assert prop["minimum"] == 1
    assert [note.param for note in result.notes] == ["w"]


def test_float_step_is_dropped() -> None:
    """`multipleOf: 0.1` 은 IEEE-754 때문에 0.3 을 거부하는 검증기가 있다."""
    result = build_input_schema({"scale": param("FLOAT", widget={"min": 0.0, "step": 0.1})})
    assert result.schema is not None
    assert "multipleOf" not in result.schema["properties"]["scale"]
    assert result.notes


def test_numeric_hints_on_a_string_are_reported() -> None:
    result = build_input_schema({"name": param("STRING", widget={"min": 1})})
    assert result.schema is not None
    assert "minimum" not in result.schema["properties"]["name"]
    assert result.notes


def test_provider_options_are_not_invented() -> None:
    """공급자 옵션은 실행 시점에 정해진다 — 열거하지 못한 것을 열거한 척하지 않는다."""
    result = build_input_schema({"ckpt": param("STRING", widget={"provider": "checkpoints"})})
    assert result.schema is not None
    assert "enum" not in result.schema["properties"]["ckpt"]
    assert "checkpoints" in result.notes[0].reason


def test_presentation_hints_are_silent() -> None:
    """표현만 바꾸는 힌트는 스키마에 대응물이 없고, 없어도 잃는 것이 없다."""
    result = build_input_schema(
        {
            "prompt": param("STRING", default="", widget={"multiline": True, "placeholder": "..."}),
            "seed": param("INT", default=0, widget={"seed": True, "control": "randomize"}),
        }
    )
    assert result.schema is not None
    assert result.notes == ()
