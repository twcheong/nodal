import { TYPES_VERSION } from "../graph/typesystem";
import type { GraphDocument, InputValue } from "../graph/types";
import { isLink } from "../graph/types";
import { ApiError, type EventListener, type GraphApiClient } from "./client";
import type {
  AssetRef,
  CreateRunResponse,
  ExtensionsResponse,
  GraphFromPngResponse,
  Issue,
  NodeSchema,
  NodesResponse,
  ValidateResponse,
  WsEvent,
} from "./types";
import { assetSrc } from "./types";

export const MOCK_IMAGE_HASH = "0f3a8a9c6d4e2f1876b5a493827160ff0f3a8a9c6d4e2f1876b5a493827160ff";

const MOCK_IMAGE_ASSET: AssetRef = {
  hash: MOCK_IMAGE_HASH,
  media_type: "image/svg+xml",
  size_bytes: 604,
  width: 640,
  height: 400,
};

const MOCK_INLINE_PREVIEW =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#14242b"/><stop offset="1" stop-color="#1d6b5e"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><circle cx="320" cy="190" r="112" fill="#68e6b8" opacity=".78"/><text x="320" y="345" fill="#dffcf2" font-family="sans-serif" font-size="25" text-anchor="middle">nodal mock preview</text></svg>',
  );

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

const output = (name: string, type: string): NonNullable<NodeSchema["outputs"]>[number] => ({
  name,
  type,
  doc: "",
});

export const MOCK_NODE_SCHEMAS: readonly NodeSchema[] = [
  {
    id: "math.Const",
    title: "Const",
    category: "math",
    aliases: ["상수", "const"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "그래프에 숫자 값을 공급합니다.",
    inputs: [input("value", "INT", 0)],
    outputs: [output("value", "INT")],
  },
  {
    id: "math.Add",
    title: "Add",
    category: "math",
    aliases: ["더하기", "plus", "+"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "두 수를 더합니다.",
    inputs: [input("a", "INT", 0), input("b", "INT", 0)],
    outputs: [output("sum", "INT")],
  },
  {
    id: "math.Subtract",
    title: "Subtract",
    category: "math",
    aliases: ["빼기", "minus", "-"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "두 정수를 뺍니다.",
    inputs: [input("a", "INT", 0), input("b", "INT", 0)],
    outputs: [output("difference", "INT")],
  },
  {
    id: "math.Multiply",
    title: "Multiply",
    category: "math",
    aliases: ["곱하기", "times", "*"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "두 수를 곱합니다.",
    inputs: [input("a", "INT", 1), input("b", "INT", 1)],
    outputs: [output("product", "INT")],
  },
  {
    id: "math.Divide",
    title: "Divide",
    category: "math",
    aliases: ["나누기", "/"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "0으로 나누면 노드 안에 오류와 스택을 표시합니다.",
    inputs: [input("a", "FLOAT", 0), input("b", "FLOAT", 1)],
    outputs: [output("quotient", "FLOAT")],
  },
  {
    id: "math.Negate",
    title: "Negate",
    category: "math",
    aliases: ["부호 반전"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "정수의 부호를 반전합니다.",
    inputs: [input("value", "INT", 0)],
    outputs: [output("value", "INT")],
  },
  {
    id: "math.Power",
    title: "Power",
    category: "math",
    aliases: ["거듭제곱", "pow"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "정수 거듭제곱을 계산합니다.",
    inputs: [input("base", "INT", 2), input("exponent", "INT", 2, { min: 0, max: 16 })],
    outputs: [output("value", "INT")],
  },
  {
    id: "math.Clamp",
    title: "Clamp",
    category: "math",
    aliases: ["범위 제한"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "값을 최소·최대 범위 안으로 제한합니다.",
    inputs: [input("value", "INT", 0), input("low", "INT", 0), input("high", "INT", 100)],
    outputs: [output("value", "INT")],
  },
  {
    id: "math.Sum3",
    title: "Sum 3",
    category: "math",
    aliases: ["세 수 합"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "세 정수를 더합니다.",
    inputs: [input("a", "INT", 0), input("b", "INT", 0), input("c", "INT", 0)],
    outputs: [output("sum", "INT")],
  },
  {
    id: "text.Format",
    title: "Format",
    category: "text",
    aliases: ["문자열 조립"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "{value} 자리에 입력 값을 넣어 텍스트를 만듭니다.",
    inputs: [input("template", "STRING", "{value}"), input("value", "INT", 0)],
    outputs: [output("text", "STRING")],
  },
  {
    id: "text.Print",
    title: "Print",
    category: "text",
    aliases: ["출력", "print"],
    version: "1",
    cacheable: true,
    output_node: true,
    doc: "텍스트를 출력합니다.",
    inputs: [input("text", "STRING", ""), input("enabled", "BOOL", true)],
    outputs: [output("text", "STRING")],
  },
  {
    id: "diffusion.LoadCheckpoint",
    title: "Load Checkpoint",
    category: "diffusion/loaders",
    aliases: ["체크포인트", "모델"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "Combo.from_provider 체크포인트 선택 UI를 백엔드 없이 확인합니다.",
    // 실서버는 `provider` 와 함께 스캔 결과를 `options` 로 실어 보낸다
    // (`nodal_server.wire._widget_model`). 목이 그것을 흉내내지 않으면 목에서만
    // "모델 없음" 이 뜨고, 그러면 목으로 UI 를 볼 수 없다.
    inputs: [
      input("ckpt", "STRING", "", {
        provider: "checkpoints",
        options: ["sdxl-demo.safetensors", "tiny-sd-pipe"],
      }),
    ],
    outputs: [output("model", "Model"), output("clip", "CLIP"), output("vae", "VAE")],
  },
  {
    id: "diffusion.KSampler",
    title: "KSampler",
    category: "diffusion/sampling",
    aliases: ["샘플러", "생성"],
    version: "1",
    cacheable: true,
    output_node: false,
    doc: "고빈도 스텝 프리뷰와 시드 전환을 백엔드 없이 확인합니다.",
    inputs: [
      input("seed", "INT", 0, {
        seed: true,
        control: "fixed",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        step: 1,
      }),
      input("steps", "INT", 20, { min: 1, max: 1000, step: 1 }),
      input("sampler_name", "STRING", "euler", { options: ["euler", "ddim"] }),
    ],
    outputs: [output("latent", "Latent")],
  },
  {
    id: "image.MockPreview",
    title: "Mock Image",
    category: "image",
    aliases: ["목 이미지", "preview"],
    version: "1",
    cacheable: true,
    output_node: true,
    doc: "M3 이미지 프리뷰와 결과 표시를 백엔드 없이 확인합니다.",
    inputs: [],
    outputs: [output("image", "Image")],
  },
];

export class MockGraphApiClient implements GraphApiClient {
  readonly mode = "mock" as const;
  readonly #listeners = new Set<EventListener>();
  #hasCompletedRun = false;
  #disposed = false;

  assetUrl(asset: AssetRef): string {
    return asset.hash === MOCK_IMAGE_HASH ? MOCK_INLINE_PREVIEW : assetSrc(asset);
  }

  async listNodes(): Promise<NodesResponse> {
    await Promise.resolve();
    return { nodes: [...MOCK_NODE_SCHEMAS], types_version: TYPES_VERSION };
  }

  async listExtensions(): Promise<ExtensionsResponse> {
    await Promise.resolve();
    return { loaded: [], failed: [] };
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

  async graphFromPng(file: File): Promise<GraphFromPngResponse> {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => signature[index] === value,
    );
    if (!isPng) throw new ApiError("PNG 파일이 손상됐거나 올바른 PNG가 아닙니다", 400);
    if (file.name.toLowerCase().includes("no-workflow")) {
      throw new ApiError("PNG에 nodal_workflow 정보가 없습니다", 404);
    }
    return { graph: mockRestoredGraph(), nodal_version: "mock-m3" };
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
    const failedNode = nodes.find(
      ([, node]) => node.type === "math.Divide" && literalNumber(node.inputs?.b) === 0,
    );
    const sampler = nodes.findIndex(([, node]) => node.type === "diffusion.KSampler");
    const samplerWillRun =
      sampler >= 0 && !(useCache && this.#hasCompletedRun && sampler % 4 === 1);
    const samplerSteps = samplerWillRun
      ? (literalNumber(nodes[sampler]?.[1].inputs?.steps) ?? 20)
      : 0;
    const completionDelay = Math.max(
      180 + nodes.length * 150,
      samplerWillRun ? 180 + sampler * 150 + samplerSteps * 35 : 0,
    );
    this.#emit({ t: "run.started", run_id: runId, node_count: nodes.length });
    nodes.forEach(([nodeId, node], index) => {
      const delay = 100 + index * 150;
      globalThis.setTimeout(() => {
        if (useCache && this.#hasCompletedRun && index % 4 === 1) {
          this.#emit({ t: "node.cached", run_id: runId, node_id: nodeId });
          return;
        }
        this.#emit({ t: "node.started", run_id: runId, node_id: nodeId });
        if (node.type === "diffusion.KSampler") {
          const steps = literalNumber(node.inputs?.steps) ?? 20;
          for (let step = 1; step <= steps; step += 1) {
            globalThis.setTimeout(() => {
              this.#emit({
                t: "node.progress",
                run_id: runId,
                node_id: nodeId,
                step,
                total: steps,
              });
              this.#emit({
                t: "node.preview",
                run_id: runId,
                node_id: nodeId,
                preview: {
                  kind: "inline",
                  data_uri: mockStepPreview(step, steps),
                  width: 640,
                  height: 400,
                },
              });
              if (step === steps) {
                this.#emit({
                  t: "node.done",
                  run_id: runId,
                  node_id: nodeId,
                  outputs: mockOutputs(node.type, index),
                });
              }
            }, step * 35);
          }
          return;
        }
        this.#emit({
          t: "node.progress",
          run_id: runId,
          node_id: nodeId,
          step: 1,
          total: 2,
        });
        if (node.type === "image.MockPreview") {
          this.#emit({
            t: "node.preview",
            run_id: runId,
            node_id: nodeId,
            preview: {
              kind: "inline",
              data_uri: MOCK_INLINE_PREVIEW,
              width: 640,
              height: 400,
            },
          });
          globalThis.setTimeout(() => {
            this.#emit({
              t: "node.preview",
              run_id: runId,
              node_id: nodeId,
              preview: { kind: "asset", asset: MOCK_IMAGE_ASSET },
            });
            this.#emit({
              t: "node.done",
              run_id: runId,
              node_id: nodeId,
              outputs: mockOutputs(node.type, index),
            });
          }, 60);
          return;
        }
        if (node.type === "math.Divide" && literalNumber(node.inputs?.b) === 0) {
          this.#emit({
            t: "node.error",
            run_id: runId,
            node_id: nodeId,
            socket: "b",
            message: "0으로 나눌 수 없습니다",
            traceback: ["math.Divide.run(left, right)", "ZeroDivisionError: division by zero"],
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
    globalThis.setTimeout(() => {
      if (failedNode) {
        this.#emit({
          t: "run.failed",
          run_id: runId,
          elapsed_ms: completionDelay,
          code: "node_failed",
          message: `${failedNode[0]} 노드 실행에 실패했습니다`,
        });
      } else {
        this.#hasCompletedRun = true;
        this.#emit({ t: "run.done", run_id: runId, elapsed_ms: completionDelay });
      }
    }, completionDelay);
  }
}

function mockStepPreview(step: number, total: number): string {
  const hue = Math.round(160 + (step / total) * 80);
  return (
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="hsl(${hue} 36% 12%)"/><circle cx="320" cy="190" r="${70 + step * 2}" fill="hsl(${hue} 72% 64%)" opacity=".76"/><text x="320" y="350" fill="#e8fff8" font-family="sans-serif" font-size="26" text-anchor="middle">latent step ${step} / ${total}</text></svg>`,
    )
  );
}

function mockOutputs(nodeType: string, index: number) {
  const schema = MOCK_NODE_SCHEMAS.find((candidate) => candidate.id === nodeType);
  return (schema?.outputs ?? []).map((socket) => ({
    socket: socket.name,
    type: socket.type,
    ...(socket.type === "Image"
      ? { asset: MOCK_IMAGE_ASSET }
      : { inline: socket.type === "STRING" ? `목 실행 결과 ${index + 1}` : index + 1 }),
  }));
}

function mockRestoredGraph(): GraphDocument {
  const nodeId = "00000000-0000-4000-8000-000000000301";
  return {
    nodal_version: "1",
    id: "00000000-0000-4000-8000-000000000300",
    nodes: {
      [nodeId]: { type: "image.MockPreview", inputs: {}, meta: { title: "PNG에서 복원됨" } },
    },
    outputs: [nodeId],
    ui: {
      [nodeId]: { pos: [180, 120] },
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };
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
