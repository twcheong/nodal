"""노드 스키마 공개 API 테스트 (docs/design.md §4.2)."""

from __future__ import annotations

from nodal import Combo, register_combo_provider

COMBO_PROVIDER_NAME = "tests.dynamic-models"


def test_combo_provider_is_registerable_from_public_api() -> None:
    """동적 Combo 공급자는 최상위 nodal API로 등록하고 매번 조회한다 (§4.2)."""
    options = ["model-a"]
    register_combo_provider(COMBO_PROVIDER_NAME, lambda: tuple(options))
    combo = Combo.from_provider(COMBO_PROVIDER_NAME)

    assert tuple(combo.options()) == ("model-a",)
    options.append("model-b")
    assert tuple(combo.options()) == ("model-a", "model-b")
