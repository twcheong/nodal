"""노드 스키마 공개 API 테스트 (docs/design.md §4.2)."""

from __future__ import annotations

from typing import Any

from nodal import Combo, Image, Socket, as_type, register_combo_provider

COMBO_PROVIDER_NAME = "tests.dynamic-models"


def test_combo_provider_is_registerable_from_public_api() -> None:
    """동적 Combo 공급자는 최상위 nodal API로 등록하고 매번 조회한다 (§4.2)."""
    options = ["model-a"]
    register_combo_provider(COMBO_PROVIDER_NAME, lambda: tuple(options))
    combo = Combo.from_provider(COMBO_PROVIDER_NAME)

    assert tuple(combo.options()) == ("model-a",)
    options.append("model-b")
    assert tuple(combo.options()) == ("model-a", "model-b")


def test_socket_normalizes_catalog_name_classes() -> None:
    """`Image`가 이름 클래스여도 `Socket(Image)`는 실제 서술자를 저장한다."""
    socket = Socket(Image)

    assert socket.type == as_type(Image)
    assert socket.type.describe() == "Image"


def test_image_contract_keeps_core_alias_neutral_and_socket_float32_only() -> None:
    """core의 `Image.T`는 Any이고 실제 소켓 정본은 float32 하나다."""
    descriptor = as_type(Image)

    assert Image.T is Any
    assert descriptor.dtypes == frozenset({"float32"})  # type: ignore[attr-defined]
