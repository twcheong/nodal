#!/usr/bin/env python
"""캐논 그래프 포맷의 JSON Schema 를 내보낸다 — 프론트엔드가 소비한다.

pydantic 모델이 단일 소스다. 이 스크립트가 생성한 `schemas/graph.schema.json`
은 산출물이며 손으로 고치지 않는다. `--check` 는 커밋된 산출물이 모델과
어긋났는지 검사한다 (CI 용).

    uv run python tools/export_schema.py           # 생성
    uv run python tools/export_schema.py --check    # drift 검사
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from nodal import GRAPH_VERSION, Graph

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "schemas" / "graph.schema.json"

SCHEMA_ID = "https://nodal.local/schemas/graph.schema.json"


def build_schema() -> dict[str, object]:
    schema = Graph.model_json_schema(by_alias=True, mode="validation")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": SCHEMA_ID,
        "title": f"nodal 캐논 그래프 포맷 v{GRAPH_VERSION}",
        "x-generated-by": "tools/export_schema.py — 직접 수정하지 말 것",
        **schema,
    }


def render() -> str:
    return json.dumps(build_schema(), indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="쓰지 않고, 커밋된 파일이 최신인지만 검사한다",
    )
    args = parser.parse_args(argv)

    content = render()
    rel = OUT.relative_to(ROOT)

    if args.check:
        if not OUT.exists():
            print(f"{rel} 가 없다. `uv run python tools/export_schema.py` 를 실행하라.")
            return 1
        if OUT.read_text(encoding="utf-8") != content:
            print(
                f"{rel} 가 pydantic 모델과 어긋났다.\n"
                "`uv run python tools/export_schema.py` 를 실행하고 결과를 커밋하라."
            )
            return 1
        print(f"{rel} 최신 상태.")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(content, encoding="utf-8")
    print(f"{rel} 생성 완료.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
