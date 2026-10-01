"""소켓 타입 호환성 계약 테스트 (docs/design.md §4.3).

이 파일의 기대값은 ``types.py`` 와 ``types.json`` 을 읽기 전에 §4.3 표만 보고
작성했다. 호환 방향은 언제나 source(출력) → target(입력)이다.
"""

from __future__ import annotations

import pytest

from nodal import (
    FLOAT,
    INT,
    STRING,
    Any,
    Image,
    ListType,
    Model,
    OpaqueType,
    TensorType,
    UnionType,
    is_compatible,
    load_catalog,
    parse_type_expr,
)


@pytest.mark.parametrize(
    ("source", "target", "expected"),
    [
        (Image, Image, True),
        (INT, FLOAT, True),
        (FLOAT, INT, False),
        (INT, ListType(INT), True),
        (ListType(INT), INT, False),
        (ListType(INT), ListType(FLOAT), True),
        (ListType(FLOAT), ListType(INT), False),
        (Any, Image, True),
        (Image, Any, True),
    ],
)
def test_directional_compatibility_rules(source: object, target: object, expected: bool) -> None:
    """정확 일치·승격·공변·Any 양방향 규칙을 고정한다 (§4.3)."""
    assert is_compatible(source, target) is expected


@pytest.mark.parametrize(
    ("source", "target", "expected"),
    [
        (INT, UnionType((INT, STRING)), True),
        (FLOAT, UnionType((INT, STRING)), False),
        (UnionType((INT, FLOAT)), FLOAT, True),
        (UnionType((INT, STRING)), FLOAT, False),
        (UnionType((INT, STRING)), UnionType((FLOAT, STRING)), True),
        (UnionType((FLOAT, STRING)), UnionType((INT, STRING)), False),
    ],
)
def test_union_is_wide_at_the_target_and_safe_at_the_source(
    source: object,
    target: object,
    expected: bool,
) -> None:
    """대상 Union은 any, 출처 Union은 all로 판정한다 (§4.3 Union 양방향)."""
    assert is_compatible(source, target) is expected


def test_opaque_requires_same_handle_name_and_target_capabilities() -> None:
    """Opaque는 이름이 같고 출처 능력이 대상 요구를 모두 포함해야 한다 (§4.3)."""
    full_model = OpaqueType("Model", frozenset({"sdxl", "unet"}))
    unet_model = OpaqueType("Model", frozenset({"unet"}))
    other_handle = OpaqueType("Pipeline", frozenset({"unet"}))

    assert is_compatible(full_model, unet_model)
    assert not is_compatible(unet_model, full_model)
    assert not is_compatible(full_model, other_handle)
    assert is_compatible(Model, OpaqueType("Model", frozenset()))


@pytest.mark.parametrize(
    ("source", "target", "expected"),
    [
        (
            TensorType(frozenset({"uint8"}), ("B", "H", "W", "C")),
            TensorType(frozenset({"uint8", "float32"}), (None, None, None, None)),
            True,
        ),
        (
            TensorType(frozenset({"uint8", "float32"}), ("B", "H", "W", "C")),
            TensorType(frozenset({"float32"}), (None, None, None, None)),
            False,
        ),
        (
            TensorType(frozenset({"uint8"}), (1, 512, 512, 3)),
            TensorType(frozenset({"uint8"}), ("B", "H", "W", "C")),
            True,
        ),
        (
            TensorType(frozenset({"uint8"}), (1, 512, 512, 3)),
            TensorType(frozenset({"uint8"}), (1, 256, 512, 3)),
            False,
        ),
        (
            TensorType(frozenset({"uint8"}), (1, 512, 512, 3)),
            TensorType(frozenset({"uint8"}), ("H", "W", "C")),
            False,
        ),
    ],
)
def test_tensor_dtype_rank_and_dimensions(source: object, target: object, expected: bool) -> None:
    """dtype 부분집합·동일 랭크·정수 차원 일치 규칙을 고정한다 (§4.3)."""
    assert is_compatible(source, target) is expected


def test_types_json_conformance_cases_match_the_documented_rules() -> None:
    """§4.3 해석 뒤 대조한 types.json의 모든 케이스도 같은 방향으로 판정한다."""
    catalog = load_catalog()
    mismatches: list[str] = []

    for case in catalog.conformance:
        source = parse_type_expr(case["from"], catalog)
        target = parse_type_expr(case["to"], catalog)
        actual = is_compatible(source, target, catalog)
        expected = bool(case["compatible"])
        if actual != expected:
            mismatches.append(
                f"{source.describe()} → {target.describe()}: expected={expected}, actual={actual}"
            )

    assert mismatches == []
