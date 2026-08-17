import type { Connection, Edge, NodeChange, Viewport, XYPosition } from "@xyflow/react";
import { create } from "zustand";

import type { Issue, ModelEntry, NodeSchema, RunStatus, WsEvent } from "../api/types";
import type { GraphDocument, GraphNode, JsonValue } from "../graph/types";
import { isLink, makeLink } from "../graph/types";
import { createGraphNode, createStarterGraph, normalizeGraph } from "../editor/graph";
import { withNodeProgress } from "../editor/progress";
import { advanceGraphSeeds, submittedSeedValues, withSeedControl } from "../editor/seed";
import { describeSocketType, socketTypesCompatible } from "../editor/socketTypes";
import type { SeedControl } from "../graph/widgets";
import type {
  ConnectionIntent,
  NodeRuntimeState,
  NodalFlowNode,
  SearchState,
} from "../editor/types";

interface EditorState {
  graph: GraphDocument;
  schemas: NodeSchema[];
  models: ModelEntry[];
  modelKinds: string[];
  runtime: Record<string, NodeRuntimeState>;
  issues: Issue[];
  selectedNodeIds: string[];
  nodeMeasurements: Record<string, { width: number; height: number }>;
  connection: ConnectionIntent | null;
  search: SearchState;
  catalogState: "loading" | "ready" | "error";
  modelCatalogState: "loading" | "ready" | "error";
  activeRunId: string | null;
  runStatus: RunStatus | null;
  runNodeCount: number;
  runStartedAtMs: number | null;
  runSubmissionPending: boolean;
  message: string | null;
  benchmarkFps: number | null;
  setSchemas: (schemas: NodeSchema[]) => void;
  setCatalogError: (message: string) => void;
  setModels: (models: ModelEntry[], kinds: string[]) => void;
  setModelCatalogError: (message: string) => void;
  addNode: (schema: NodeSchema, position: XYPosition) => string;
  toggleOutput: (nodeId: string) => void;
  applyNodeChanges: (changes: NodeChange<NodalFlowNode>[]) => void;
  deleteEdges: (edges: Edge[]) => void;
  connectNodes: (connection: Connection) => boolean;
  setLiteralInput: (nodeId: string, socket: string, value: JsonValue) => void;
  setSeedControl: (nodeId: string, socket: string, control: SeedControl) => void;
  setViewport: (viewport: Viewport) => void;
  beginConnection: (intent: ConnectionIntent | null) => void;
  openSearch: (position: XYPosition) => void;
  closeSearch: () => void;
  loadGraph: (graph: GraphDocument) => void;
  setIssues: (issues: Issue[]) => void;
  beginRunSubmission: () => boolean;
  finishRunSubmission: () => void;
  startRun: (runId: string) => void;
  handleEvent: (event: WsEvent) => void;
  setMessage: (message: string | null) => void;
  setBenchmarkFps: (fps: number | null) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  graph: createStarterGraph(),
  schemas: [],
  models: [],
  modelKinds: [],
  runtime: {},
  issues: [],
  selectedNodeIds: [],
  nodeMeasurements: {},
  connection: null,
  search: { open: false, flowPosition: { x: 120, y: 120 } },
  catalogState: "loading",
  modelCatalogState: "loading",
  activeRunId: null,
  runStatus: null,
  runNodeCount: 0,
  runStartedAtMs: null,
  runSubmissionPending: false,
  message: null,
  benchmarkFps: null,

  setSchemas: (schemas) => set({ schemas, catalogState: "ready" }),
  setCatalogError: (message) => set({ catalogState: "error", message }),
  setModels: (models, modelKinds) => set({ models, modelKinds, modelCatalogState: "ready" }),
  setModelCatalogError: (message) =>
    set({ modelCatalogState: "error", message: `모델 목록을 불러오지 못했습니다: ${message}` }),

  addNode: (schema, position) => {
    const nodeId = crypto.randomUUID();
    set((state) => ({
      graph: {
        ...state.graph,
        nodes: { ...(state.graph.nodes ?? {}), [nodeId]: createGraphNode(schema) },
        outputs: schema.output_node
          ? [...new Set([...(state.graph.outputs ?? []), nodeId])]
          : state.graph.outputs,
        ui: { ...(state.graph.ui ?? {}), [nodeId]: { pos: [position.x, position.y] } },
      },
      selectedNodeIds: [nodeId],
      message: `${schema.title} 노드를 추가했습니다`,
    }));
    return nodeId;
  },

  toggleOutput: (nodeId) =>
    set((state) => {
      const outputs = state.graph.outputs ?? [];
      return {
        graph: {
          ...state.graph,
          outputs: outputs.includes(nodeId)
            ? outputs.filter((output) => output !== nodeId)
            : [...outputs, nodeId],
        },
      };
    }),

  applyNodeChanges: (changes) =>
    set((state) => {
      let graph = state.graph;
      let nodeMeasurements = state.nodeMeasurements;
      const selected = new Set(state.selectedNodeIds);
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          graph = withNodePosition(graph, change.id, change.position);
        } else if (change.type === "remove") {
          graph = withoutNode(graph, change.id);
          selected.delete(change.id);
        } else if (change.type === "select") {
          if (change.selected) selected.add(change.id);
          else selected.delete(change.id);
        } else if (change.type === "dimensions" && change.dimensions) {
          const current = nodeMeasurements[change.id];
          if (
            current?.width !== change.dimensions.width ||
            current.height !== change.dimensions.height
          ) {
            nodeMeasurements = { ...nodeMeasurements, [change.id]: change.dimensions };
          }
        }
      }
      return { graph, nodeMeasurements, selectedNodeIds: [...selected] };
    }),

  deleteEdges: (edges) =>
    set((state) => {
      let graph = state.graph;
      for (const edge of edges) {
        if (edge.targetHandle) graph = withoutInput(graph, edge.target, edge.targetHandle);
      }
      return { graph };
    }),

  connectNodes: (connection) => {
    const { source, target, sourceHandle, targetHandle } = connection;
    if (!source || !target || !sourceHandle || !targetHandle) return false;
    const state = get();
    const sourceNode = state.graph.nodes?.[source];
    const targetNode = state.graph.nodes?.[target];
    const sourceSchema = state.schemas.find((schema) => schema.id === sourceNode?.type);
    const targetSchema = state.schemas.find((schema) => schema.id === targetNode?.type);
    const sourceSocket = sourceSchema?.outputs?.find((socket) => socket.name === sourceHandle);
    const targetSocket = targetSchema?.inputs?.find((socket) => socket.name === targetHandle);
    if (!sourceSocket || !targetSocket) return false;
    if (!socketTypesCompatible(sourceSocket.type, targetSocket.type)) {
      set({
        message: `${describeSocketType(sourceSocket.type)} → ${describeSocketType(targetSocket.type)} 연결은 호환되지 않습니다`,
      });
      return false;
    }
    set((current) => ({
      graph: withInput(current.graph, target, targetHandle, makeLink(source, sourceHandle)),
      issues: current.issues.filter(
        (issue) => !(issue.node_id === target && issue.socket === targetHandle),
      ),
      message: `${sourceSocket.name} → ${targetSocket.name} 연결`,
    }));
    return true;
  },

  setLiteralInput: (nodeId, socket, value) =>
    set((state) => ({ graph: withInput(state.graph, nodeId, socket, value) })),
  setSeedControl: (nodeId, socket, control) =>
    set((state) => ({ graph: withSeedControl(state.graph, nodeId, socket, control) })),

  setViewport: (viewport) =>
    set((state) => ({
      graph: { ...state.graph, ui: { ...(state.graph.ui ?? {}), viewport } },
    })),

  beginConnection: (connection) => set({ connection }),
  openSearch: (flowPosition) => set({ search: { open: true, flowPosition } }),
  closeSearch: () => set((state) => ({ search: { ...state.search, open: false } })),

  loadGraph: (graph) =>
    set({
      graph: normalizeGraph(graph),
      runtime: {},
      issues: [],
      selectedNodeIds: [],
      nodeMeasurements: {},
      activeRunId: null,
      runStatus: null,
      runNodeCount: 0,
      runStartedAtMs: null,
      runSubmissionPending: false,
      message: "캐논 그래프를 불러왔습니다",
    }),

  setIssues: (issues) => set({ issues }),
  beginRunSubmission: () => {
    if (get().runSubmissionPending) return false;
    set({ runSubmissionPending: true });
    return true;
  },
  finishRunSubmission: () => set({ runSubmissionPending: false }),
  startRun: (runId) =>
    set((state) => {
      // 단일 워커가 매우 빠르면 run.started/run.done이 POST 응답보다 먼저 올 수 있다.
      // 같은 run의 WS 상태를 이미 받았다면 늦은 HTTP 응답으로 queued를 덮지 않는다.
      if (state.activeRunId === runId && state.runStatus !== null) return state;
      return {
        activeRunId: runId,
        runStatus: "queued",
        runNodeCount: 0,
        runStartedAtMs: null,
        runtime: initialRuntime(state.graph, state.schemas, "queued"),
        message: "실행을 큐에 등록했습니다",
      };
    }),

  handleEvent: (event) =>
    set((state) => {
      if (
        "run_id" in event &&
        state.activeRunId &&
        event.run_id !== state.activeRunId &&
        !(
          event.t === "run.started" &&
          state.runStatus !== "queued" &&
          state.runStatus !== "running"
        )
      ) {
        return state;
      }
      switch (event.t) {
        case "run.started":
          return {
            activeRunId: event.run_id,
            runStatus: "running",
            runNodeCount: event.node_count,
            runStartedAtMs: Date.now(),
            runtime: initialRuntime(
              state.graph,
              state.schemas,
              "queued",
              state.activeRunId === event.run_id ? state.runtime : undefined,
            ),
          };
        case "node.started":
          return {
            runtime: withRuntime(state.runtime, event.node_id, {
              ...state.runtime[event.node_id],
              status: "running",
              startedAtMs: Date.now(),
            }),
          };
        case "node.progress":
          return {
            runtime: withRuntime(
              state.runtime,
              event.node_id,
              withNodeProgress(state.runtime[event.node_id], event.step, event.total, Date.now()),
            ),
          };
        case "node.preview":
          return {
            runtime: withRuntime(state.runtime, event.node_id, {
              ...state.runtime[event.node_id],
              status: "running",
              preview: event.preview,
            }),
          };
        case "node.cached":
          return {
            runtime: withRuntime(state.runtime, event.node_id, {
              ...state.runtime[event.node_id],
              status: "cached",
            }),
          };
        case "node.done":
          return {
            runtime: withRuntime(state.runtime, event.node_id, {
              ...state.runtime[event.node_id],
              status: "succeeded",
              outputs: event.outputs ?? [],
            }),
          };
        case "node.error":
          return {
            runStatus: "failed",
            runtime: withRuntime(state.runtime, event.node_id, {
              ...state.runtime[event.node_id],
              status: "error",
              error: {
                message: event.message,
                socket: event.socket,
                traceback: event.traceback ?? [],
              },
            }),
          };
        case "run.done": {
          // 전역 WS의 늦거나 중복된 종료 이벤트가 다음 시드를 두 번 굴리면 안 된다.
          if (state.activeRunId !== event.run_id) return state;
          if (state.runStatus === "failed") {
            return { runStatus: "failed", message: "오류와 함께 실행이 종료됐습니다" };
          }
          if (state.runStatus !== "running") return state;
          const completedNodeIds = new Set(
            Object.entries(state.runtime)
              .filter(([, runtime]) => ["succeeded", "cached"].includes(runtime.status))
              .map(([nodeId]) => nodeId),
          );
          return {
            graph: advanceGraphSeeds(state.graph, state.schemas, undefined, completedNodeIds),
            runStatus: "succeeded",
            message: `${event.elapsed_ms}ms에 실행을 마쳤습니다`,
          };
        }
        case "run.failed":
          return {
            runStatus: "failed",
            message: `${event.code}: ${event.message}`,
          };
        case "run.cancelled":
          return {
            runStatus: "cancelled",
            message: `${event.elapsed_ms}ms에 실행을 취소했습니다`,
          };
        case "queue":
          return state;
      }
    }),

  setMessage: (message) => set({ message }),
  setBenchmarkFps: (benchmarkFps) => set({ benchmarkFps }),
}));

function withNodePosition(
  graph: GraphDocument,
  nodeId: string,
  position: XYPosition,
): GraphDocument {
  const current = graph.ui?.[nodeId];
  const nodeUi =
    typeof current === "object" && current !== null && !Array.isArray(current) ? current : {};
  return {
    ...graph,
    ui: { ...(graph.ui ?? {}), [nodeId]: { ...nodeUi, pos: [position.x, position.y] } },
  };
}

function withInput(
  graph: GraphDocument,
  nodeId: string,
  socket: string,
  value: JsonValue | ReturnType<typeof makeLink>,
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

function withoutInput(graph: GraphDocument, nodeId: string, socket: string): GraphDocument {
  const node = graph.nodes?.[nodeId];
  if (!node?.inputs || !(socket in node.inputs)) return graph;
  const inputs = { ...node.inputs };
  delete inputs[socket];
  return {
    ...graph,
    nodes: { ...(graph.nodes ?? {}), [nodeId]: { ...node, inputs } },
  };
}

function withoutNode(graph: GraphDocument, nodeId: string): GraphDocument {
  const nodes = { ...(graph.nodes ?? {}) };
  delete nodes[nodeId];
  for (const [id, node] of Object.entries(nodes)) {
    const inputs = { ...(node.inputs ?? {}) };
    let changed = false;
    for (const [socket, value] of Object.entries(inputs)) {
      if (isLink(value) && value.$link[0] === nodeId) {
        delete inputs[socket];
        changed = true;
      }
    }
    if (changed) nodes[id] = { ...node, inputs };
  }
  const ui = { ...(graph.ui ?? {}) };
  delete ui[nodeId];
  return {
    ...graph,
    nodes,
    outputs: (graph.outputs ?? []).filter((output) => output !== nodeId),
    ui,
  };
}

function withRuntime(
  runtime: Record<string, NodeRuntimeState>,
  nodeId: string,
  next: NodeRuntimeState,
): Record<string, NodeRuntimeState> {
  return { ...runtime, [nodeId]: next };
}

function initialRuntime(
  graph: GraphDocument,
  schemas: readonly NodeSchema[],
  status: NodeRuntimeState["status"],
  previous?: Readonly<Record<string, NodeRuntimeState>>,
): Record<string, NodeRuntimeState> {
  const seeds = submittedSeedValues(graph, schemas);
  return Object.fromEntries(
    Object.keys(graph.nodes ?? {}).map((nodeId) => [
      nodeId,
      {
        status,
        submittedSeeds: previous?.[nodeId]?.submittedSeeds ?? seeds[nodeId],
      },
    ]),
  );
}

export function schemaForNode(
  schemas: readonly NodeSchema[],
  node: GraphNode | undefined,
): NodeSchema | undefined {
  return schemas.find((schema) => schema.id === node?.type);
}
