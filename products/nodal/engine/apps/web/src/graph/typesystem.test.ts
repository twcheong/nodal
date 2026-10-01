/**
 * 타입 시스템 계약 테스트.
 *
 * `types.json` 의 적합성 케이스를 TS 구현으로 돌린다. Python 쪽은
 * `tools/check_types.py` 가 같은 케이스를 돌린다. 둘 다 통과해야 "규칙이
 * 하나"라고 말할 수 있다.
 */

import { describe, expect, it } from "vitest";

import {
  CATALOG,
  CONFORMANCE_CASES,
  TYPES_VERSION,
  TypeSpecError,
  checkConformance,
  describeType,
  explainIncompatibility,
  isCompatible,
  parseTypeExpr,
  resolveTypeName,
} from "./typesystem";

describe("types.json 적합성", () => {
  it("케이스가 비어 있지 않다", () => {
    expect(CONFORMANCE_CASES.length).toBeGreaterThan(20);
  });

  it("모든 케이스에서 Python 구현과 같은 판정을 낸다", () => {
    expect(checkConformance()).toEqual([]);
  });

  // 케이스별로 나눠 실패 시 어느 규칙이 깨졌는지 바로 보이게 한다.
  it.each(
    CONFORMANCE_CASES.map(
      (c, i) =>
        [
          `${i}: ${describeType(parseTypeExpr(c.from))} → ${describeType(parseTypeExpr(c.to))} (${c.rule ?? "?"})`,
          c,
        ] as const,
    ),
  )("%s", (_label, testCase) => {
    const source = parseTypeExpr(testCase.from);
    const target = parseTypeExpr(testCase.to);
    expect(isCompatible(source, target)).toBe(testCase.compatible);
  });
});

describe("카탈로그", () => {
  it("design.md §4.3 의 내장 타입을 담는다", () => {
    for (const name of ["INT", "FLOAT", "STRING", "BOOL", "Image", "Model", "VAE"]) {
      expect(CATALOG.has(name)).toBe(true);
    }
    expect(TYPES_VERSION).toBe("1");
  });

  it("Any 는 이름이 아니라 표현식이다", () => {
    expect(CATALOG.has("Any")).toBe(false);
    expect(resolveTypeName("Any")).toEqual({ kind: "any" });
  });

  it("모르는 이름은 카탈로그를 보여주며 거부한다", () => {
    expect(() => resolveTypeName("Nonexistent")).toThrow(TypeSpecError);
    expect(() => resolveTypeName("Nonexistent")).toThrow(/카탈로그/);
  });
});

describe("호환 판정의 방향성", () => {
  it("INT → FLOAT 는 되고 그 역은 안 된다", () => {
    const int = resolveTypeName("INT");
    const float = resolveTypeName("FLOAT");
    expect(isCompatible(int, float)).toBe(true);
    expect(isCompatible(float, int)).toBe(false);
  });

  it("불호환은 이유를 말한다 — 익명 에러 금지", () => {
    const why = explainIncompatibility(resolveTypeName("FLOAT"), resolveTypeName("INT"));
    expect(why).toContain("FLOAT → INT");
    expect(why).toBeTruthy();
  });

  it("호환이면 이유가 없다", () => {
    expect(explainIncompatibility(resolveTypeName("INT"), resolveTypeName("FLOAT"))).toBeNull();
  });
});

describe("표기", () => {
  it.each([
    ["Any", "Any"],
    ["INT", "INT"],
    ["Image", "Image"],
  ])("%s 는 %s 로 표기된다", (name, expected) => {
    expect(describeType(resolveTypeName(name))).toBe(expected);
  });

  it("합성 타입도 읽을 수 있게 표기된다", () => {
    expect(describeType(parseTypeExpr({ list: "Image" }))).toBe("List[Image]");
    expect(describeType(parseTypeExpr({ union: ["INT", "FLOAT"] }))).toBe("Union[INT, FLOAT]");
    expect(describeType(parseTypeExpr({ opaque: "Model", capabilities: ["unet", "sdxl"] }))).toBe(
      "Model[sdxl, unet]",
    );
  });
});
