/**
 * 프론트/백 계약 테스트.
 *
 * design.md §10 의 리스크 "프론트/백 타입 규칙이 어긋남"을 여기서 막는다.
 * 아래 문서 목록은 `packages/core/tests/test_schema_export.py` 와 같은 판정을
 * 받아야 한다.
 */

import { describe, expect, it } from "vitest";

import { graphSchema, validateGraphDocument } from "./schema";
import { GRAPH_VERSION, LINK_KEY, isLink, linkSource, makeLink } from "./types";
import type { GraphDocument } from "./types";

// design.md §4.1 예제 문서.
const DESIGN_DOC_EXAMPLE: GraphDocument = {
  nodal_version: "1",
  id: "018f2c00-0000-7000-8000-000000000000",
  nodes: {
    n_c3d4: { type: "image.Load", inputs: { path: "cat.png" } },
    n_a1b2: {
      type: "image.Resize",
      inputs: {
        image: { $link: ["n_c3d4", "image"] },
        width: 512,
        method: "lanczos",
      },
      meta: { title: "Resize to 512" },
    },
  },
  outputs: ["n_a1b2"],
  ui: {
    n_a1b2: { pos: [340, 120], collapsed: false, color: "#3a5" },
    viewport: { x: 0, y: 0, zoom: 1.0 },
    groups: [],
  },
};

describe("생성된 스키마", () => {
  it("백엔드가 만든 산출물을 그대로 읽는다", () => {
    expect(graphSchema.$id).toContain("graph.schema.json");
    expect(graphSchema["x-generated-by"]).toContain("tools/export_schema.py");
  });

  it("상수가 백엔드와 일치한다", () => {
    expect(GRAPH_VERSION).toBe("1");
    expect(graphSchema.properties.nodal_version.const).toBe(GRAPH_VERSION);
    expect(Object.keys(graphSchema.$defs.Link.properties)).toEqual([LINK_KEY]);
  });
});

describe("유효한 문서", () => {
  const valid: Array<[string, unknown]> = [
    ["빈 그래프", { nodal_version: "1", nodes: {}, outputs: [] }],
    ["design.md 예제", DESIGN_DOC_EXAMPLE],
    [
      "리터럴 객체 입력",
      { nodal_version: "1", nodes: { a: { type: "core.Sink", inputs: { opts: { k: 1 } } } } },
    ],
  ];

  it.each(valid)("%s", (_name, document) => {
    const result = validateGraphDocument(document);
    expect(result.valid ? [] : result.issues).toEqual([]);
  });
});

describe("무효한 문서", () => {
  const invalid: Array<[string, unknown]> = [
    ["미래 버전", { nodal_version: "2", nodes: {} }],
    ["네임스페이스 없는 타입", { nodal_version: "1", nodes: { a: { type: "Resize" } } }],
    ["공백 있는 노드 ID", { nodal_version: "1", nodes: { "a b": { type: "image.Resize" } } }],
    [
      "알 수 없는 노드 필드",
      { nodal_version: "1", nodes: { a: { type: "image.Resize", extra: 1 } } },
    ],
    ["알 수 없는 최상위 필드", { nodal_version: "1", nodes: {}, unknown_top_level: 1 }],
    ["UUID 가 아닌 id", { nodal_version: "1", id: "not-a-uuid", nodes: {} }],
    [
      "잘린 링크 튜플",
      { nodal_version: "1", nodes: { a: { type: "core.Sink", inputs: { x: { $link: ["b"] } } } } },
    ],
  ];

  it.each(invalid)("%s", (_name, document) => {
    expect(validateGraphDocument(document).valid).toBe(false);
  });

  it("문제 위치를 노드·소켓으로 지목한다", () => {
    const result = validateGraphDocument({
      nodal_version: "1",
      nodes: { n_a1b2: { type: "core.Sink", inputs: { x: { $link: ["b"] } } } },
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((i) => i.location.startsWith("nodes.n_a1b2.inputs.x"))).toBe(true);
  });
});

describe("링크 헬퍼", () => {
  it("링크와 리터럴을 구분한다", () => {
    expect(isLink(makeLink("n_c3d4", "image"))).toBe(true);
    expect(isLink(512)).toBe(false);
    expect(isLink("lanczos")).toBe(false);
    expect(isLink({ k: 1 })).toBe(false);
    expect(isLink([1, 2])).toBe(false);
    expect(isLink(null)).toBe(false);
  });

  it("출처를 되돌려준다", () => {
    expect(linkSource(makeLink("n_c3d4", "image"))).toEqual({
      nodeId: "n_c3d4",
      socket: "image",
    });
  });
});
