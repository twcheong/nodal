"""JSON Schema 산출물 계약 테스트.

design.md §10 의 리스크 "프론트/백 타입 규칙이 어긋남"에 대한 방어선이다.
pydantic 모델이 단일 소스이고, 프론트는 `schemas/graph.schema.json` 만 본다.
둘의 판정이 갈리면 여기서 깨진다.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from nodal import GraphValidationError, parse_graph

from .test_graph import DESIGN_DOC_EXAMPLE

ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = ROOT / "schemas" / "graph.schema.json"

sys.path.insert(0, str(ROOT / "tools"))
import export_schema  # noqa: E402


@pytest.fixture(scope="module")
def validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    # `format` 은 기본적으로 주석 취급이다. 실제로 검사해야 프론트(ajv-formats)와
    # 같은 판정이 나온다.
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def test_committed_schema_is_up_to_date() -> None:
    """모델을 고치고 스키마 재생성을 잊으면 여기서 잡힌다."""
    assert SCHEMA_PATH.read_text(encoding="utf-8") == export_schema.render(), (
        "schemas/graph.schema.json 가 낡았다. "
        "`uv run python tools/export_schema.py` 를 실행하고 커밋하라."
    )


VALID_DOCS: list[dict[str, Any]] = [
    {"nodal_version": "1", "nodes": {}, "outputs": []},
    DESIGN_DOC_EXAMPLE,
    {"nodal_version": "1", "nodes": {"a": {"type": "core.Sink", "inputs": {"opts": {"k": 1}}}}},
]

INVALID_DOCS: list[dict[str, Any]] = [
    {"nodal_version": "2", "nodes": {}},
    {"nodal_version": "1", "nodes": {"a": {"type": "Resize"}}},
    {"nodal_version": "1", "nodes": {"a b": {"type": "image.Resize"}}},
    {"nodal_version": "1", "nodes": {"a": {"type": "image.Resize", "extra": 1}}},
    {"nodal_version": "1", "nodes": {}, "unknown_top_level": 1},
    {"nodal_version": "1", "id": "not-a-uuid", "nodes": {}},
]


@pytest.mark.parametrize("doc", VALID_DOCS)
def test_python_and_schema_agree_on_valid(doc: dict[str, Any], validator: object) -> None:
    parse_graph(doc)  # pydantic 통과
    assert isinstance(validator, Draft202012Validator)
    assert list(validator.iter_errors(doc)) == []  # 스키마도 통과


@pytest.mark.parametrize("doc", INVALID_DOCS)
def test_python_and_schema_agree_on_invalid(doc: dict[str, Any], validator: object) -> None:
    with pytest.raises(GraphValidationError):
        parse_graph(doc)
    assert isinstance(validator, Draft202012Validator)
    assert list(validator.iter_errors(doc)), "pydantic 은 거부했는데 스키마는 통과시켰다"


def test_link_matches_exactly_one_branch(validator: object) -> None:
    """`$link` 객체가 링크와 리터럴 양쪽에 매칭되면 oneOf 가 무너진다."""
    assert isinstance(validator, Draft202012Validator)
    doc = {
        "nodal_version": "1",
        "nodes": {
            "a": {"type": "core.Sink", "inputs": {"x": {"$link": ["b", "out"]}}},
            "b": {"type": "core.Source"},
        },
    }
    assert list(validator.iter_errors(doc)) == []


def test_malformed_link_is_rejected_by_schema(validator: object) -> None:
    assert isinstance(validator, Draft202012Validator)
    doc = {
        "nodal_version": "1",
        "nodes": {"a": {"type": "core.Sink", "inputs": {"x": {"$link": ["b"]}}}},
    }
    assert list(validator.iter_errors(doc))
