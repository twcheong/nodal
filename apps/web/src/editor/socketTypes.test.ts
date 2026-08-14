import { describe, expect, it } from "vitest";

import { describeSocketType, parseSocketType, socketTypesCompatible } from "./socketTypes";

describe("OpenAPI 구조화 소켓 타입", () => {
  it("기존 타입 시스템으로 숫자 승격을 판정한다", () => {
    expect(socketTypesCompatible("INT", "FLOAT")).toBe(true);
    expect(socketTypesCompatible("FLOAT", "INT")).toBe(false);
  });

  it("중첩 List·Union 표현식을 손실 없이 판정기에 전달한다", () => {
    const expression = { union: [{ list: "INT" }, "STRING"] };
    const type = parseSocketType(expression);
    expect(describeSocketType(expression)).toBe("Union[List[INT], STRING]");
    expect(type.kind).toBe("union");
  });

  it("Opaque 능력 태그 방향을 보존한다", () => {
    expect(
      socketTypesCompatible(
        { opaque: "Model", capabilities: ["sdxl", "unet"] },
        { opaque: "Model", capabilities: ["unet"] },
      ),
    ).toBe(true);
    expect(
      socketTypesCompatible(
        { opaque: "Model", capabilities: ["unet"] },
        { opaque: "Model", capabilities: ["sdxl", "unet"] },
      ),
    ).toBe(false);
  });

  it("Tensor의 dtype과 심볼 차원을 그대로 보존한다", () => {
    expect(
      describeSocketType({ tensor: { dtypes: ["float32"], shape: [null, "channels"] } }),
    ).toBe("Tensor[float32, (?, channels)]");
  });
});
