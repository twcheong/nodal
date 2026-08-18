import type { Viewport, XYPosition } from "@xyflow/react";

import type { Issue, NodeSchema } from "../api/types";
import {
  GRAPH_VERSION,
  isLink,
  type GraphDocument,
  type GraphNode,
  type JsonValue,
} from "../graph/types";
import type { ConnectionIntent, NodalFlowEdge, NodalFlowNode } from "./types";

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export interface FlowProjection {
  nodes: NodalFlowNode[];
  edges: NodalFlowEdge[];
}

export function createStarterGraph(): GraphDocument {
  const seed = crypto.randomUUID();
  const offset = crypto.randomUUID();
  const add = crypto.randomUUID();
  const format = crypto.randomUUID();
  const print = crypto.randomUUID();
  return {
    nodal_version: GRAPH_VERSION,
    id: crypto.randomUUID(),
    nodes: {
      [seed]: { type: "math.Const", inputs: { value: 8 }, meta: { title: "기준값" } },
      [offset]: { type: "math.Const", inputs: { value: 3 }, meta: { title: "오프셋" } },
      [add]: {
        type: "math.Add",
        inputs: {
          a: { $link: [seed, "value"] },
          b: { $link: [offset, "value"] },
        },
      },
      [format]: {
        type: "text.Format",
        inputs: {
          value: { $link: [add, "sum"] },
          template: "최종 결과: {value}",
        },
      },
      [print]: {
        type: "text.Print",
        inputs: { text: { $link: [format, "text"] }, enabled: true },
      },
    },
    outputs: [print],
    ui: {
      [seed]: { pos: [40, 80] },
      [offset]: { pos: [40, 300] },
      [add]: { pos: [360, 180] },
      [format]: { pos: [690, 180] },
      [print]: { pos: [990, 180] },
      viewport: DEFAULT_VIEWPORT,
    },
  };
}

export function normalizeGraph(document: GraphDocument): GraphDocument {
  const nodes = document.nodes ?? {};
  const ui = { ...(document.ui ?? {}) };
  Object.keys(nodes).forEach((nodeId, index) => {
    if (!readNodePosition(ui[nodeId])) {
      const position = defaultPosition(index);
      ui[nodeId] = { pos: [position.x, position.y] };
    }
  });
  return {
    nodal_version: GRAPH_VERSION,
    id: document.id ?? crypto.randomUUID(),
    nodes,
    outputs: document.outputs ?? [],
    ui,
  };
}

export function graphToFlow(
  graph: GraphDocument,
  schemas: ReadonlyMap<string, NodeSchema>,
  issues: readonly Issue[],
  connection: ConnectionIntent | null,
  selected: ReadonlySet<string>,
  measurements: Readonly<Record<string, { width: number; height: number }>> = {},
): FlowProjection {
  const issueMap = groupIssues(issues);
  const nodes: NodalFlowNode[] = Object.entries(graph.nodes ?? {}).map(
    ([nodeId, graphNode], index) => ({
      id: nodeId,
      type: "nodal",
      measured: measurements[nodeId] ?? {
        width: 244,
        height: estimatedNodeHeight(graphNode, schemas.get(graphNode.type)),
      },
      position: readNodePosition(graph.ui?.[nodeId]) ?? defaultPosition(index),
      selected: selected.has(nodeId),
      data: {
        nodeId,
        graphNode,
        schema: schemas.get(graphNode.type) ?? unknownSchema(graphNode.type),
        issues: issueMap.get(nodeId) ?? [],
        connectionSourceType: connection?.type ?? null,
      },
    }),
  );

  const edges: NodalFlowEdge[] = [];
  Object.entries(graph.nodes ?? {}).forEach(([target, node]) => {
    Object.entries(node.inputs ?? {}).forEach(([targetHandle, value]) => {
      if (!isLink(value)) return;
      const [source, sourceHandle] = value.$link;
      edges.push({
        id: edgeId(target, targetHandle),
        source,
        sourceHandle,
        target,
        targetHandle,
        type: "default",
      });
    });
  });
  return { nodes, edges };
}

function estimatedNodeHeight(graphNode: GraphNode, schema: NodeSchema | undefined): number {
  const sockets = (schema?.inputs?.length ?? 0) + (schema?.outputs?.length ?? 0);
  return 72 + sockets * 35 + (graphNode.meta?.notes ? 24 : 0);
}

export function graphViewport(graph: GraphDocument): Viewport {
  const value = graph.ui?.viewport;
  if (!isRecord(value)) return DEFAULT_VIEWPORT;
  const { x, y, zoom } = value;
  return typeof x === "number" && typeof y === "number" && typeof zoom === "number"
    ? { x, y, zoom }
    : DEFAULT_VIEWPORT;
}

export function defaultInputs(schema: NodeSchema): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const socket of schema.inputs ?? []) {
    if ("default" in socket && isJsonValue(socket.default)) result[socket.name] = socket.default;
  }
  return result;
}

export function createGraphNode(schema: NodeSchema): GraphNode {
  return {
    type: schema.id,
    inputs: defaultInputs(schema),
    meta: { title: schema.title },
  };
}

export function edgeId(target: string, targetSocket: string): string {
  return `${target}::${targetSocket}`;
}

export function readNodePosition(value: JsonValue | undefined): XYPosition | null {
  if (!isRecord(value) || !Array.isArray(value.pos)) return null;
  const [x, y] = value.pos;
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

export function createBenchmarkGraph(count = 200): GraphDocument {
  const nodes: Record<string, GraphNode> = {};
  const ui: Record<string, JsonValue> = { viewport: DEFAULT_VIEWPORT };
  let previous: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const nodeId = benchmarkUuid(index + 1);
    nodes[nodeId] =
      previous === null
        ? { type: "math.Const", inputs: { value: 1 } }
        : {
            type: "math.Add",
            inputs: { a: { $link: [previous, index === 1 ? "value" : "sum"] }, b: index },
          };
    ui[nodeId] = { pos: [(index % 20) * 280, Math.floor(index / 20) * 190] };
    previous = nodeId;
  }
  return {
    nodal_version: GRAPH_VERSION,
    id: benchmarkUuid(999_999),
    nodes,
    outputs: previous ? [previous] : [],
    ui,
  };
}

function benchmarkUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function defaultPosition(index: number): XYPosition {
  return { x: (index % 4) * 300 + 40, y: Math.floor(index / 4) * 220 + 60 };
}

function groupIssues(issues: readonly Issue[]): Map<string, Issue[]> {
  const result = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.node_id) continue;
    const group = result.get(issue.node_id) ?? [];
    group.push(issue);
    result.set(issue.node_id, group);
  }
  return result;
}

function unknownSchema(type: string): NodeSchema {
  return {
    id: type,
    title: type,
    category: "알 수 없음",
    aliases: [],
    cacheable: false,
    output_node: false,
    doc: "서버의 노드 카탈로그에 없는 타입입니다.",
    version: "?",
    inputs: [],
    outputs: [],
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
