import type { NodeSchema } from "../api/types";
import type { GraphDocument, InputValue, JsonValue } from "../graph/types";
import { isLink } from "../graph/types";
import {
  isSeedWidget,
  parseSeedControl,
  type SeedControl,
  type SeedWidget,
} from "../graph/widgets";

const SEED_CONTROLS_KEY = "seed_controls";
const RANDOM_DENOMINATOR = 0x20_0000_0000_0000;

export function readSeedControl(
  graph: GraphDocument,
  nodeId: string,
  socket: string,
  fallback: SeedControl,
): SeedControl {
  const nodeUi = readRecord(graph.ui?.[nodeId]);
  const controls = readRecord(nodeUi?.[SEED_CONTROLS_KEY]);
  return parseSeedControl(controls?.[socket]) ?? fallback;
}

export function withSeedControl(
  graph: GraphDocument,
  nodeId: string,
  socket: string,
  control: SeedControl,
): GraphDocument {
  const nodeUi = readRecord(graph.ui?.[nodeId]) ?? {};
  const controls = readRecord(nodeUi[SEED_CONTROLS_KEY]) ?? {};
  return {
    ...graph,
    ui: {
      ...(graph.ui ?? {}),
      [nodeId]: {
        ...nodeUi,
        [SEED_CONTROLS_KEY]: { ...controls, [socket]: control },
      },
    },
  };
}

export function nextSeedValue(
  value: number,
  control: SeedControl,
  widget: SeedWidget,
  randomFraction?: number,
): number {
  const current = clampInteger(value, widget.min, widget.max);
  if (control === "fixed") return current;
  if (control === "increment") {
    const next = current + widget.step;
    return next <= widget.max ? next : widget.min;
  }
  const slots = Math.floor((widget.max - widget.min) / widget.step) + 1;
  const index = Math.min(
    slots - 1,
    Math.floor(clampFraction(randomFraction ?? secureRandomFraction()) * slots),
  );
  return widget.min + index * widget.step;
}

/** 성공한 실행이 쓴 시드는 그대로 두고, 그래프에는 다음 실행값을 준비한다. */
export function advanceGraphSeeds(
  graph: GraphDocument,
  schemas: readonly NodeSchema[],
  randomFraction: () => number = secureRandomFraction,
  eligibleNodeIds?: ReadonlySet<string>,
): GraphDocument {
  const schemaMap = new Map(schemas.map((schema) => [schema.id, schema]));
  let nextGraph = graph;
  for (const [nodeId, node] of Object.entries(graph.nodes ?? {})) {
    if (eligibleNodeIds && !eligibleNodeIds.has(nodeId)) continue;
    const schema = schemaMap.get(node.type);
    for (const socket of schema?.inputs ?? []) {
      if (!isSeedWidget(socket.widget)) continue;
      const value = seedInputValue(node.inputs?.[socket.name], socket.default);
      if (value === null) continue;
      const control = readSeedControl(graph, nodeId, socket.name, socket.widget.control);
      const next = nextSeedValue(
        value,
        control,
        socket.widget,
        control === "randomize" ? randomFraction() : undefined,
      );
      if (next !== value || node.inputs?.[socket.name] === undefined) {
        nextGraph = withLiteralInput(nextGraph, nodeId, socket.name, next);
      }
    }
  }
  return nextGraph;
}

export function submittedSeedValues(
  graph: GraphDocument,
  schemas: readonly NodeSchema[],
): Record<string, Record<string, number>> {
  const schemaMap = new Map(schemas.map((schema) => [schema.id, schema]));
  const result: Record<string, Record<string, number>> = {};
  for (const [nodeId, node] of Object.entries(graph.nodes ?? {})) {
    const schema = schemaMap.get(node.type);
    for (const socket of schema?.inputs ?? []) {
      if (!isSeedWidget(socket.widget)) continue;
      const value = seedInputValue(node.inputs?.[socket.name], socket.default);
      if (value !== null) (result[nodeId] ??= {})[socket.name] = value;
    }
  }
  return result;
}

function seedInputValue(value: InputValue | undefined, fallback: unknown): number | null {
  if (value !== undefined && !isLink(value) && typeof value === "number") return value;
  return typeof fallback === "number" ? fallback : null;
}

function withLiteralInput(
  graph: GraphDocument,
  nodeId: string,
  socket: string,
  value: number,
): GraphDocument {
  const node = graph.nodes?.[nodeId];
  if (!node) return graph;
  return {
    ...graph,
    nodes: {
      ...(graph.nodes ?? {}),
      [nodeId]: { ...node, inputs: { ...(node.inputs ?? {}), [socket]: value } },
    },
  };
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= 1) return 1 - Number.EPSILON;
  return Math.max(0, value);
}

function secureRandomFraction(): number {
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  const high21 = (words[0] ?? 0) & 0x1f_ffff;
  return (high21 * 0x1_0000_0000 + (words[1] ?? 0)) / RANDOM_DENOMINATOR;
}

function readRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
