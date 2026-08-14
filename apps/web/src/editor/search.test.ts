import { describe, expect, it } from "vitest";

import { MOCK_NODE_SCHEMAS } from "../api/mock";
import { searchSchemas } from "./search";

describe("searchSchemas", () => {
  it("한글 제목과 별칭으로 노드를 찾는다", () => {
    expect(searchSchemas(MOCK_NODE_SCHEMAS, "더하기")[0]?.id).toBe("math.Add");
    expect(searchSchemas(MOCK_NODE_SCHEMAS, "합계")[0]?.id).toBe("math.Add");
  });

  it("띄엄띄엄 입력한 영문도 퍼지 매칭한다", () => {
    expect(searchSchemas(MOCK_NODE_SCHEMAS, "madd")[0]?.id).toBe("math.Add");
  });
});
