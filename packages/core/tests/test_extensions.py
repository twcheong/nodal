"""확장 로더 (docs/design.md §8, M7.2).

`nodal_api` 범위 검사는 **양쪽 다** 검사한다는 것이 이 파일의 절반이다 — 하한
미만과 상한 초과를 각각 별도로 고정한다. M6 에서 `PREVIEW_MAX_EDGE` 를 한쪽만
테스트해 "512 이하에서만 동작하는 수정"이 초록으로 통과한 적이 있다.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from nodal import (
    ExtensionsResult,
    NodeRegistry,
    is_api_compatible,
    load_extensions,
    parse_caret_range,
)

# ---------------------------------------------------------------- 범위 문법


def test_parse_caret_range_major():
    assert parse_caret_range("^1.2.3") == ((1, 2, 3), (2, 0, 0))


def test_parse_caret_range_zero_major():
    assert parse_caret_range("^0.2.3") == ((0, 2, 3), (0, 3, 0))


def test_parse_caret_range_zero_major_minor():
    assert parse_caret_range("^0.0.3") == ((0, 0, 3), (0, 0, 4))


def test_parse_caret_range_missing_components_default_to_zero():
    assert parse_caret_range("^1") == ((1, 0, 0), (2, 0, 0))
    assert parse_caret_range("^1.2") == ((1, 2, 0), (2, 0, 0))


def test_parse_caret_range_rejects_non_caret_syntax():
    with pytest.raises(ValueError, match="캐럿"):
        parse_caret_range(">=1.0.0")


def test_parse_caret_range_rejects_garbage_version():
    with pytest.raises(ValueError, match="버전 형식"):
        parse_caret_range("^not-a-version")


def test_is_api_compatible_within_range():
    assert is_api_compatible("^1.0", (1, 0, 0)) is True
    assert is_api_compatible("^1.0", (1, 9, 9)) is True


def test_is_api_compatible_below_lower_bound():
    """하한 미만은 거부한다 — 한쪽만 테스트하지 않는다."""
    assert is_api_compatible("^1.0", (0, 9, 0)) is False


def test_is_api_compatible_at_and_above_upper_bound():
    """상한(제외)과 그 너머는 거부한다 — 다른 쪽도 함께 고정한다."""
    assert is_api_compatible("^1.0", (2, 0, 0)) is False
    assert is_api_compatible("^1.0", (3, 0, 0)) is False


# ------------------------------------------------------------------- 로더


def _write_manifest(ext_dir: Path, *, ext_id: str, nodal_api: str, name: str | None = None) -> None:
    ext_dir.mkdir(parents=True, exist_ok=True)
    (ext_dir / "nodal.toml").write_text(
        textwrap.dedent(f"""\
            [extension]
            id = "{ext_id}"
            name = "{name or ext_id}"
            version = "0.1.0"
            nodal_api = "{nodal_api}"
            """),
        encoding="utf-8",
    )


_GOOD_NODE_SOURCE = textwrap.dedent("""\
    from nodal import Int, NodeResult, node


    @node(id="ext_test.Echo", title="Echo", category="test")
    class Echo:
        value: Int = Int(0)
        returns = {"value": Int}

        def run(self, value: int) -> NodeResult:
            return NodeResult(value)
    """)

_BROKEN_NODE_SOURCE = "raise RuntimeError('의도적으로 깨진 확장')\n"


def test_load_extensions_missing_directory_returns_empty(tmp_path: Path):
    registry = NodeRegistry()
    result = load_extensions(registry, tmp_path / "does-not-exist")
    assert result.loaded == ()
    assert result.failed == ()
    assert len(registry) == 0


def test_load_extensions_registers_nodes_from_valid_extension(tmp_path: Path):
    ext_root = tmp_path / "extensions"
    good = ext_root / "good-pack"
    _write_manifest(good, ext_id="com.example.good", nodal_api="^1.0")
    (good / "nodes").mkdir()
    (good / "nodes" / "echo.py").write_text(_GOOD_NODE_SOURCE, encoding="utf-8")

    registry = NodeRegistry()
    result = load_extensions(registry, ext_root)

    assert len(result.loaded) == 1
    record = result.loaded[0]
    assert record.id == "com.example.good"
    assert record.node_count == 1
    assert record.loaded is True
    assert "ext_test.Echo" in registry


def test_load_extensions_rejects_out_of_range_api_below_lower_bound(tmp_path: Path):
    ext_root = tmp_path / "extensions"
    _write_manifest(ext_root / "old-pack", ext_id="com.example.old", nodal_api="^99.0")

    registry = NodeRegistry()
    result = load_extensions(registry, ext_root)

    assert result.loaded == ()
    assert len(result.failed) == 1
    assert "nodal_api" in (result.failed[0].error or "")


def test_load_extensions_missing_manifest_fails_clearly(tmp_path: Path):
    ext_root = tmp_path / "extensions"
    (ext_root / "no-manifest").mkdir(parents=True)

    registry = NodeRegistry()
    result = load_extensions(registry, ext_root)

    assert len(result.failed) == 1
    assert "nodal.toml" in (result.failed[0].error or "")


def test_load_extensions_one_broken_extension_does_not_block_others(tmp_path: Path):
    """확장 하나가 예외를 던져도 나머지는 로드된다 (design.md §8)."""
    ext_root = tmp_path / "extensions"

    good = ext_root / "a-good-pack"
    _write_manifest(good, ext_id="com.example.a_good", nodal_api="^1.0")
    (good / "nodes").mkdir()
    (good / "nodes" / "echo.py").write_text(_GOOD_NODE_SOURCE, encoding="utf-8")

    broken = ext_root / "b-broken-pack"
    _write_manifest(broken, ext_id="com.example.b_broken", nodal_api="^1.0")
    (broken / "nodes").mkdir()
    (broken / "nodes" / "boom.py").write_text(_BROKEN_NODE_SOURCE, encoding="utf-8")

    registry = NodeRegistry()
    result = load_extensions(registry, ext_root)

    assert [r.id for r in result.loaded] == ["com.example.a_good"]
    assert [r.id for r in result.failed] == ["com.example.b_broken"]
    assert "RuntimeError" in (result.failed[0].error or "")
    assert "ext_test.Echo" in registry


def test_load_extensions_missing_nodal_api_is_rejected(tmp_path: Path):
    ext_root = tmp_path / "extensions"
    ext_dir = ext_root / "no-api-range"
    ext_dir.mkdir(parents=True)
    (ext_dir / "nodal.toml").write_text(
        textwrap.dedent("""\
            [extension]
            id = "com.example.no_api"
            name = "No API"
            version = "0.1.0"
            """),
        encoding="utf-8",
    )

    registry = NodeRegistry()
    result = load_extensions(registry, ext_root)

    assert len(result.failed) == 1
    assert "nodal_api" in (result.failed[0].error or "")


def test_extensions_result_template_sources_sorted_by_id(tmp_path: Path):
    ext_root = tmp_path / "extensions"
    for ext_id, dirname in (("zzz.pack", "z-pack"), ("aaa.pack", "a-pack")):
        ext_dir = ext_root / dirname
        _write_manifest(ext_dir, ext_id=ext_id, nodal_api="^1.0")
        (ext_dir / "templates").mkdir()

    registry = NodeRegistry()
    result = load_extensions(registry, ext_root)

    assert [ext_id for ext_id, _ in result.template_sources] == ["aaa.pack", "zzz.pack"]


def test_extensions_result_is_exported_from_nodal():
    assert ExtensionsResult(root=Path("/tmp/nowhere")).loaded == ()
