import { describe, expect, it } from "vitest";

import { MOCK_NODE_SCHEMAS } from "../api/mock";
import { createBenchmarkGraph, createStarterGraph, graphToFlow, normalizeGraph } from "./graph";

const schemas = new Map(MOCK_NODE_SCHEMAS.map((schema) => [schema.id, schema]));

describe("캐논 그래프와 캔버스 투영", () => {
  it("링크를 별도 포맷 없이 React Flow edge로 투영한다", () => {
    const graph = createStarterGraph();
    const projection = graphToFlow(graph, schemas, {}, [], null, new Set());
    expect(projection.nodes).toHaveLength(4);
    expect(projection.edges).toHaveLength(3);
    expect(graph.nodes && Object.values(graph.nodes)[2]?.inputs?.left).toHaveProperty("$link");
  });

  it("좌표가 없는 문서도 ui 필드 안에서만 보완한다", () => {
    const graph = normalizeGraph({
      nodal_version: "1",
      nodes: { a: { type: "math.Number", inputs: { value: 1 } } },
    });
    expect(graph.ui?.a).toEqual({ pos: [40, 60] });
    expect(graph.nodes?.a).toEqual({ type: "math.Number", inputs: { value: 1 } });
  });

  it("200노드 벤치마크 그래프를 만든다", () => {
    const graph = createBenchmarkGraph();
    const projection = graphToFlow(graph, schemas, {}, [], null, new Set());
    expect(projection.nodes).toHaveLength(200);
    expect(projection.edges).toHaveLength(199);
  });
});
