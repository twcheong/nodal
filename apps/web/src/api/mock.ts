import { TYPES_VERSION } from "../graph/typesystem";
import type { GraphDocument, InputValue } from "../graph/types";
import { isLink } from "../graph/types";
import type { GraphApiClient, EventListener } from "./client";
import type {
  CreateRunResponse,
  Issue,
  NodeSchema,
  NodesResponse,
  ValidateResponse,
  WsEvent,
} from "./types";

const input = (
  name: string,
  type: string,
  defaultValue: unknown,
  widget: Record<string, unknown> = {},
): NonNullable<NodeSchema["inputs"]>[number] => ({
  name,
  type,
  default: defaultValue,
  required: false,
  lazy: false,
  doc: "",
  widget,
});

const requiredInput = (
  name: string,
  type: string,
): NonNullable<NodeSchema["inputs"]>[number] => ({
  name,
  type,
  required: true,
  lazy: false,
  doc: "",
  widget: {},
});

const output = (name: string, type: string): NonNullable<NodeSchema["outputs"]>[number] => ({
  name,
  type,
  doc: "",
});

export const MOCK_NODE_SCHEMAS: readonly NodeSchema[] = [
  {
    id: "math.Number",
    title: "숫자",
    category: "수학/입력",
    aliases: ["number", "상수", "값"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "그래프에 숫자 값을 공급합니다.",
    inputs: [input("value", "FLOAT", 1, { min: -1000, max: 1000, step: 1 })],
    outputs: [output("value", "FLOAT")],
  },
  {
    id: "math.Integer",
    title: "정수",
    category: "수학/입력",
    aliases: ["integer", "int", "정수값"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "정수 값을 공급합니다.",
    inputs: [input("value", "INT", 1, { min: -1000, max: 1000, step: 1 })],
    outputs: [output("value", "INT")],
  },
  {
    id: "math.Add",
    title: "더하기",
    category: "수학/연산",
    aliases: ["add", "sum", "합계", "덧셈"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "두 수를 더합니다.",
    inputs: [input("left", "FLOAT", 0), input("right", "FLOAT", 0)],
    outputs: [output("value", "FLOAT")],
  },
  {
    id: "math.Multiply",
    title: "곱하기",
    category: "수학/연산",
    aliases: ["multiply", "product", "곱셈"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "두 수를 곱합니다.",
    inputs: [input("left", "FLOAT", 1), input("right", "FLOAT", 1)],
    outputs: [output("value", "FLOAT")],
  },
  {
    id: "math.Divide",
    title: "나누기",
    category: "수학/연산",
    aliases: ["divide", "division", "나눗셈"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "0으로 나누면 노드 안에 오류와 스택을 표시합니다.",
    inputs: [input("left", "FLOAT", 1), input("right", "FLOAT", 1)],
    outputs: [output("value", "FLOAT")],
  },
  {
    id: "math.Clamp",
    title: "범위 제한",
    category: "수학/연산",
    aliases: ["clamp", "제한", "최솟값", "최댓값"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "값을 최소·최대 범위 안으로 제한합니다.",
    inputs: [
      requiredInput("value", "FLOAT"),
      input("minimum", "FLOAT", 0),
      input("maximum", "FLOAT", 100),
    ],
    outputs: [output("value", "FLOAT")],
  },
  {
    id: "logic.GreaterThan",
    title: "보다 큼",
    category: "논리",
    aliases: ["greater", "비교", "초과"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "왼쪽 값이 오른쪽보다 큰지 검사합니다.",
    inputs: [input("left", "FLOAT", 0), input("right", "FLOAT", 0)],
    outputs: [output("value", "BOOL")],
  },
  {
    id: "text.Template",
    title: "텍스트 포맷",
    category: "텍스트",
    aliases: ["format", "template", "문자열", "출력"],
    version: "1",
    cacheable: true,
    output_node: true,
    doc: "{value} 자리에 입력 값을 넣어 텍스트를 만듭니다.",
    inputs: [requiredInput("value", "FLOAT"), input("template", "STRING", "결과: {value}")],
    outputs: [output("text", "STRING")],
  },
];

export class MockGraphApiClient implements GraphApiClient {
  readonly mode = "mock" as const;
  readonly #listeners = new Set<EventListener>();
  #hasCompletedRun = false;
  #disposed = false;

  async listNodes(): Promise<NodesResponse> {
    await Promise.resolve();
    return { nodes: [...MOCK_NODE_SCHEMAS], types_version: TYPES_VERSION };
  }

  async validateGraph(graph: GraphDocument): Promise<ValidateResponse> {
    await Promise.resolve();
    const issues = validateReferences(graph);
    return { valid: issues.length === 0, issues };
  }

  async createRun(graph: GraphDocument, useCache: boolean): Promise<CreateRunResponse> {
    await Promise.resolve();
    const runId = crypto.randomUUID();
    const nodes = executionNodes(graph);
    globalThis.setTimeout(() => this.#simulate(runId, nodes, useCache), 0);
    return { run_id: runId, status: "queued" };
  }

  subscribe(listener: EventListener): () => void {
    this.#disposed = false;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #emit(event: WsEvent): void {
    if (this.#disposed) return;
    this.#listeners.forEach((listener) => listener(event));
  }

  #simulate(
    runId: string,
    nodes: [string, NonNullable<GraphDocument["nodes"]>[string]][],
    useCache: boolean,
  ): void {
    this.#emit({ t: "run.started", run_id: runId, node_count: nodes.length });
    nodes.forEach(([nodeId, node], index) => {
      const delay = 100 + index * 150;
      globalThis.setTimeout(() => {
        if (useCache && this.#hasCompletedRun && index % 4 === 1) {
          this.#emit({ t: "node.cached", run_id: runId, node_id: nodeId });
          return;
        }
        this.#emit({ t: "node.started", run_id: runId, node_id: nodeId });
        this.#emit({
          t: "node.progress",
          run_id: runId,
          node_id: nodeId,
          step: 1,
          total: 2,
        });
        if (node.type === "math.Divide" && literalNumber(node.inputs?.right) === 0) {
          this.#emit({
            t: "node.error",
            run_id: runId,
            node_id: nodeId,
            socket: "right",
            message: "0으로 나눌 수 없습니다",
            traceback: [
              "math.Divide.run(left, right)",
              "ZeroDivisionError: division by zero",
            ],
          });
          return;
        }
        this.#emit({
          t: "node.done",
          run_id: runId,
          node_id: nodeId,
          outputs: mockOutputs(node.type, index),
        });
      }, delay);
    });
    globalThis.setTimeout(
      () => {
        this.#hasCompletedRun = true;
        this.#emit({ t: "run.done", run_id: runId, elapsed_ms: nodes.length * 150 });
      },
      180 + nodes.length * 150,
    );
  }
}

function mockOutputs(nodeType: string, index: number) {
  const schema = MOCK_NODE_SCHEMAS.find((candidate) => candidate.id === nodeType);
  return (schema?.outputs ?? []).map((socket) => ({
    socket: socket.name,
    type: socket.type,
    inline: socket.type === "STRING" ? `목 실행 결과 ${index + 1}` : index + 1,
  }));
}

function executionNodes(
  graph: GraphDocument,
): [string, NonNullable<GraphDocument["nodes"]>[string]][] {
  const nodes = graph.nodes ?? {};
  const required = new Set<string>();
  const visit = (nodeId: string) => {
    if (required.has(nodeId)) return;
    const node = nodes[nodeId];
    if (!node) return;
    required.add(nodeId);
    Object.values(node.inputs ?? {}).forEach((value) => {
      if (isLink(value)) visit(value.$link[0]);
    });
  };
  (graph.outputs ?? []).forEach(visit);
  return Object.entries(nodes).filter(([nodeId]) => required.has(nodeId));
}

function literalNumber(value: InputValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function validateReferences(graph: GraphDocument): Issue[] {
  const nodes = graph.nodes ?? {};
  const issues: Issue[] = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const [socket, value] of Object.entries(node.inputs ?? {})) {
      if (!isLink(value)) continue;
      const [sourceNode, sourceSocket] = value.$link;
      if (!(sourceNode in nodes)) {
        issues.push({
          code: "unknown_link_target",
          message: `존재하지 않는 노드 ${sourceNode}를 가리킵니다`,
          node_id: nodeId,
          socket,
          location: `nodes.${nodeId}.inputs.${socket}`,
        });
      } else if (!sourceSocket) {
        issues.push({
          code: "unknown_output_socket",
          message: "출력 소켓 이름이 비어 있습니다",
          node_id: nodeId,
          socket,
          location: `nodes.${nodeId}.inputs.${socket}`,
        });
      }
    }
  }
  return issues;
}
