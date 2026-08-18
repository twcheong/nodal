/**
 * 위젯 어휘 계약 테스트.
 *
 * `widgets.ts` 의 리터럴 튜플이 `types.json` 에서 낡지 않았는지 본다.
 * Python 쪽은 `Seed.CONTROLS` 가 같은 파일에서 **읽으므로** 낡을 수 없고,
 * `tools/check_types.py` 가 그 어휘가 실제로 존재하는지 확인한다.
 *
 * 이 파일이 지키는 것은 하나다 — TS 리터럴과 `types.json` 의 일치. 그것만
 * 성립하면 tsc 가 잡는 오타와 백엔드의 검증이 같은 어휘를 말하게 된다.
 */

import { describe, expect, it } from "vitest";

import { SEED_CONTROLS, SEED_CONTROLS_FROM_TYPES, isSeedWidget, parseSeedControl } from "./widgets";

describe("시드 control 어휘", () => {
  it("types.json 이 어휘를 싣고 있다", () => {
    // 비어 있으면 아래 대조가 의미 없이 통과한다.
    expect(SEED_CONTROLS_FROM_TYPES.length).toBeGreaterThan(0);
  });

  it("리터럴 튜플이 types.json 과 정확히 같다 (순서 포함)", () => {
    // 순서가 UI 의 순서라 정렬 비교가 아니라 그대로 비교한다.
    expect([...SEED_CONTROLS]).toEqual([...SEED_CONTROLS_FROM_TYPES]);
  });
});

describe("parseSeedControl", () => {
  it("아는 값을 좁힌다", () => {
    for (const control of SEED_CONTROLS) {
      expect(parseSeedControl(control)).toBe(control);
    }
  });

  it("모르는 값은 null 이다 — 조용히 대체하지 않는다", () => {
    // 이 오타가 이 파일이 존재하는 이유다.
    expect(parseSeedControl("randomise")).toBeNull();
    expect(parseSeedControl("random")).toBeNull();
    expect(parseSeedControl(undefined)).toBeNull();
    expect(parseSeedControl(42)).toBeNull();
  });
});

describe("isSeedWidget", () => {
  it("시드 위젯을 알아본다", () => {
    expect(
      isSeedWidget({ seed: true, control: "randomize", min: 0, max: 9007199254740991, step: 1 }),
    ).toBe(true);
  });

  it("control 이 어휘 밖이면 시드 위젯이 아니다", () => {
    expect(isSeedWidget({ seed: true, control: "randomise" })).toBe(false);
  });

  it("범위 힌트가 빠진 불완전한 시드 계약을 거부한다", () => {
    expect(isSeedWidget({ seed: true, control: "fixed" })).toBe(false);
    expect(isSeedWidget({ seed: true, control: "fixed", min: 0, max: 10, step: 0 })).toBe(false);
  });

  it("평범한 정수 위젯은 아니다", () => {
    expect(isSeedWidget({ min: 1, max: 1000, step: 1 })).toBe(false);
    expect(isSeedWidget(undefined)).toBe(false);
  });
});
