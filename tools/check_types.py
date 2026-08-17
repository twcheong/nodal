#!/usr/bin/env python
"""`types.json` 을 검증한다 — 구조 + Python 구현의 적합성 판정.

`types.json` 은 타입 시스템의 단일 소스이자 두 에이전트 사이의 계약이다
(AGENTS.md 협업 규칙 7). 이 스크립트는 그 계약이 스스로 모순되지 않는지 본다.

TypeScript 쪽 판정은 `apps/web/src/graph/typesystem.test.ts` 가 **같은
적합성 케이스**로 검사한다. 둘 다 통과해야 규칙이 하나라고 말할 수 있다.

    uv run python tools/check_types.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from nodal.types import (
    TYPES_FILE,
    TypeCatalog,
    TypeSpecError,
    check_conformance,
    load_catalog,
    parse_type_expr,
)

ROOT = Path(__file__).resolve().parent.parent
TYPES_PATH = ROOT / "packages" / "core" / "src" / "nodal" / TYPES_FILE

#: design.md §4.3 표가 요구하는 규칙. 하나라도 사라지면 스펙과 어긋난 것이다.
REQUIRED_RULES = (
    "exact_match",
    "numeric_promotion",
    "list_promotion",
    "list_covariance",
    "union_widening",
    "union_narrowing",
    "any_bidirectional",
    "opaque_capability_subset",
    "tensor",
)

#: 카탈로그에 반드시 있어야 하는 내장 타입.
REQUIRED_TYPES = ("INT", "FLOAT", "STRING", "BOOL", "Image", "Model", "VAE")

#: 반드시 실려 있어야 하는 닫힌 위젯 어휘 (widget, key).
#: 프론트가 이것으로 리터럴 타입을 만든다 — 사라지면 오타 방어가 조용히 없어진다.
REQUIRED_WIDGET_VOCABULARY = (("seed", "control"),)

#: 거부 케이스를 요구하지 않는 규칙.
#: `any_bidirectional` 은 켜져 있는 한 반례가 존재할 수 없다 — Any 는 무엇과도
#: 호환된다는 것이 규칙 자체다. 반례를 요구하면 만들 수 없는 것을 요구하는 셈이다.
NO_COUNTEREXAMPLE = frozenset({"any_bidirectional"})


def check() -> list[str]:
    """발견된 문제를 전부 모아 돌려준다. 첫 번째에서 멈추지 않는다."""
    problems: list[str] = []

    try:
        catalog = load_catalog()
    except (TypeSpecError, OSError, ValueError) as exc:
        return [f"{TYPES_FILE} 를 읽을 수 없다: {exc}"]

    for rule in REQUIRED_RULES:
        if rule not in catalog.rules:
            problems.append(f"규칙 절이 없다: {rule!r} (design.md §4.3)")

    for name in REQUIRED_TYPES:
        if name not in catalog.named:
            problems.append(f"카탈로그에 내장 타입이 없다: {name!r}")

    if "Any" in catalog.named:
        problems.append("'Any' 는 카탈로그 항목이 아니라 표현식이어야 한다")

    if not catalog.conformance:
        problems.append("적합성 케이스가 하나도 없다 — 두 구현의 일치를 검증할 수 없다")

    # 케이스가 모두 파싱되는지 먼저 본다. 파싱 실패는 판정 실패보다 앞선 문제다.
    for index, case in enumerate(catalog.conformance):
        for side in ("from", "to"):
            try:
                parse_type_expr(case[side], catalog)
            except (TypeSpecError, KeyError, TypeError) as exc:
                problems.append(f"적합성 케이스 [{index}] 의 {side} 를 파싱할 수 없다: {exc}")

    # 규칙마다 참/거짓 케이스가 모두 있는지. 한쪽만 있으면 규칙이 반쯤 검증된다.
    covered: dict[str, set[bool]] = {}
    for case in catalog.conformance:
        rule = case.get("rule")
        if rule:
            covered.setdefault(str(rule), set()).add(bool(case["compatible"]))
    for rule in REQUIRED_RULES:
        verdicts = covered.get(rule, set())
        if not verdicts:
            problems.append(f"규칙 {rule!r} 를 다루는 적합성 케이스가 없다")
        elif len(verdicts) == 1 and rule not in NO_COUNTEREXAMPLE:
            only = "허용" if next(iter(verdicts)) else "거부"
            problems.append(f"규칙 {rule!r} 에 {only} 케이스만 있다 — 반대 케이스도 필요하다")

    problems.extend(f"적합성 불일치 {line}" for line in check_conformance(catalog))
    problems.extend(_check_widget_vocabulary(catalog))
    return problems


def _check_widget_vocabulary(catalog: TypeCatalog) -> list[str]:
    """닫힌 위젯 어휘가 실려 있고 실제로 쓰이는지 본다.

    이 어휘가 `types.json` 에 있는 이유는 프론트가 여기서 리터럴 타입을 만들기
    때문이다 (`apps/web/src/graph/widgets.ts`). Python 쪽은 `Seed.CONTROLS` 가
    **읽어 쓰므로** 낡을 수 없고, 여기서 볼 것은 두 가지다 — 어휘가 존재하는가,
    그리고 누군가 `Seed.CONTROLS` 를 다시 하드코딩하지 않았는가.

    TS 리터럴과의 일치는 `apps/web/src/graph/widgets.test.ts` 가 검사한다.
    한쪽만으로는 "규칙이 하나" 라고 말할 수 없다 — 적합성 케이스와 같은 구조다.
    """
    from nodal.schema import Seed

    problems: list[str] = []
    for widget, key in REQUIRED_WIDGET_VOCABULARY:
        try:
            catalog.widget_options(widget, key)
        except TypeSpecError as exc:
            problems.append(str(exc))

    try:
        declared = catalog.widget_options("seed", "control")
    except TypeSpecError:
        return problems  # 위에서 이미 보고했다

    if tuple(Seed.CONTROLS) != declared:
        problems.append(
            f"Seed.CONTROLS {tuple(Seed.CONTROLS)} 가 "
            f"widget_vocabulary.seed.control {declared} 와 다르다 — "
            "schema.py 가 types.json 을 읽는 대신 목록을 하드코딩했나?"
        )
    return problems


def main() -> int:
    problems = check()
    rel = TYPES_PATH.relative_to(ROOT)

    if problems:
        print(f"{rel} 검증 실패 ({len(problems)}건):")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    catalog = load_catalog()
    print(
        f"{rel} 정상. 타입 {len(catalog.named)}개, 적합성 케이스 {len(catalog.conformance)}건 통과."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
