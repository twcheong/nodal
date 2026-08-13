#!/usr/bin/env python
"""OpenAPI 산출물을 내보낸다 — 프론트엔드가 타입을 생성한다.

`graph.schema.json` 과 같은 규칙이다: pydantic 모델이 단일 소스이고
`schemas/openapi.json` 은 **산출물**이다. 손으로 고치지 않는다.

WebSocket 이벤트는 OpenAPI 가 다루지 않으므로 여기서 `components.schemas` 에
직접 주입하고 `x-nodal-ws-events` 로 어느 것이 WS 메시지인지 표시한다. 그래야
`openapi-typescript` 가 프론트용 타입을 함께 만들어 준다.

    uv run python tools/export_openapi.py           # 생성
    uv run python tools/export_openapi.py --check    # drift 검사 (CI)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from nodal.types import load_catalog
from nodal_server.app import create_app
from nodal_server.schemas import WsEvent

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "schemas" / "openapi.json"

#: WS 이벤트 스키마를 넣을 컴포넌트 접두사. REST 모델과 같은 네임스페이스를 쓴다.
_WS_DEFS_KEY = "$defs"


def build_openapi() -> dict[str, Any]:
    """FastAPI 가 만든 문서에 WS 이벤트 스키마를 얹는다."""
    document: dict[str, Any] = create_app().openapi()

    schemas: dict[str, Any] = document.setdefault("components", {}).setdefault("schemas", {})

    # WsEvent 유니온을 컴포넌트로 풀어 넣는다. `$defs` 로 나온 멤버들을
    # components/schemas 로 옮기고 참조 경로를 맞춘다.
    adapter: TypeAdapter[Any] = TypeAdapter(WsEvent)
    event_schema = adapter.json_schema(ref_template="#/components/schemas/{model}")
    for name, definition in event_schema.pop(_WS_DEFS_KEY, {}).items():
        schemas.setdefault(name, definition)
    schemas["WsEvent"] = event_schema

    document["x-nodal-ws-events"] = {
        "path": "/ws",
        "description": (
            "전역 이벤트 스트림. 모든 메시지는 WsEvent 유니온의 한 항목이고 `t` 로 판별한다."
        ),
        "schema": "#/components/schemas/WsEvent",
    }
    document["x-nodal-types-version"] = load_catalog().version

    return document


def render() -> str:
    return json.dumps(build_openapi(), indent=2, ensure_ascii=False, sort_keys=True) + "\n"


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
            print(f"{rel} 가 없다. `uv run python tools/export_openapi.py` 를 실행하라.")
            return 1
        if OUT.read_text(encoding="utf-8") != content:
            print(
                f"{rel} 가 pydantic 모델과 어긋났다.\n"
                "`uv run python tools/export_openapi.py` 를 실행하고 결과를 커밋하라."
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
