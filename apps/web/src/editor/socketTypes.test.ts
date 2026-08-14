import { describe, expect, it } from "vitest";

import { describeSocketType, parseSocketTypeLabel, socketTypesCompatible } from "./socketTypes";

describe("OpenAPI 소켓 타입 어댑터", () => {
  it("기존 타입 시스템으로 숫자 승격을 판정한다", () => {
    expect(socketTypesCompatible("INT", "FLOAT")).toBe(true);
    expect(socketTypesCompatible("FLOAT", "INT")).toBe(false);
  });

  it("중첩 List·Union 문자열을 구조화된 타입으로 바꾼다", () => {
    const type = parseSocketTypeLabel("Union[List[INT], STRING]");
    expect(describeSocketType("Union[List[INT], STRING]")).toBe("Union[List[INT], STRING]");
    expect(type.kind).toBe("union");
  });

  it("Opaque 능력 태그 방향을 보존한다", () => {
    expect(socketTypesCompatible("Model[sdxl, unet]", "Model[unet]")).toBe(true);
    expect(socketTypesCompatible("Model[unet]", "Model[sdxl, unet]")).toBe(false);
  });
});
