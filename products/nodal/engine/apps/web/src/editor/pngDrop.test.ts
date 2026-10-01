import { describe, expect, it } from "vitest";

import { isPngFile } from "./pngDrop";

describe("PNG 캔버스 드롭", () => {
  it("MIME 또는 대소문자 무관 확장자로 PNG를 판별한다", () => {
    expect(isPngFile({ name: "workflow.bin", type: "image/png" })).toBe(true);
    expect(isPngFile({ name: "workflow.PNG", type: "" })).toBe(true);
    expect(isPngFile({ name: "workflow.jpg", type: "image/jpeg" })).toBe(false);
  });
});
