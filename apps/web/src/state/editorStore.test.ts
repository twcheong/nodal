import { beforeEach, describe, expect, it } from "vitest";

import { createStarterGraph } from "../editor/graph";
import { MOCK_NODE_SCHEMAS } from "../api/mock";
import { readSeedControl, withSeedControl } from "../editor/seed";
import type { GraphDocument } from "../graph/types";
import { useEditorStore } from "./editorStore";

describe("실행 이벤트 상태", () => {
  beforeEach(() => {
    useEditorStore.setState({
      graph: createStarterGraph(),
      schemas: [...MOCK_NODE_SCHEMAS],
      runtime: {},
      activeRunId: null,
      runStatus: null,
      runSubmissionPending: false,
      message: null,
    });
  });

  it("node.cached를 별도 캐시 상태로 보존한다", () => {
    const nodeId = Object.keys(useEditorStore.getState().graph.nodes ?? {})[0] ?? "";
    useEditorStore.getState().startRun("run-1");
    useEditorStore.getState().handleEvent({
      t: "node.cached",
      run_id: "run-1",
      node_id: nodeId,
    });
    expect(useEditorStore.getState().runtime[nodeId]?.status).toBe("cached");
  });

  it("두 프리뷰 유니온을 문자열로 축약하지 않고 크기와 함께 보존한다", () => {
    const nodeId = Object.keys(useEditorStore.getState().graph.nodes ?? {})[0] ?? "";
    useEditorStore.getState().startRun("run-preview");
    useEditorStore.getState().handleEvent({
      t: "node.preview",
      run_id: "run-preview",
      node_id: nodeId,
      preview: {
        kind: "inline",
        data_uri: "data:image/png;base64,abc",
        width: 32,
        height: 20,
      },
    });
    expect(useEditorStore.getState().runtime[nodeId]?.preview).toMatchObject({
      kind: "inline",
      width: 32,
      height: 20,
    });

    useEditorStore.getState().handleEvent({
      t: "node.preview",
      run_id: "run-preview",
      node_id: nodeId,
      preview: {
        kind: "asset",
        asset: {
          hash: "image-hash",
          media_type: "image/png",
          size_bytes: 100,
          width: 64,
          height: 40,
        },
      },
    });
    expect(useEditorStore.getState().runtime[nodeId]?.preview).toMatchObject({
      kind: "asset",
      asset: { hash: "image-hash", width: 64, height: 40 },
    });
  });

  it("node.error 뒤 run.failed로 실행 실패를 확정한다", () => {
    const nodeId = Object.keys(useEditorStore.getState().graph.nodes ?? {})[0] ?? "";
    useEditorStore.getState().startRun("run-2");
    useEditorStore.getState().handleEvent({
      t: "node.error",
      run_id: "run-2",
      node_id: nodeId,
      socket: "value",
      message: "잘못된 값",
      traceback: ["ValueError: 잘못된 값"],
    });
    useEditorStore.getState().handleEvent({
      t: "run.failed",
      run_id: "run-2",
      elapsed_ms: 12,
      code: "node_failed",
      message: "노드 실행에 실패했습니다",
    });
    expect(useEditorStore.getState().runStatus).toBe("failed");
    expect(useEditorStore.getState().runtime[nodeId]?.error?.socket).toBe("value");
  });

  it("WS 종료가 POST 응답보다 먼저 와도 queued로 되돌리지 않는다", () => {
    const nodeId = Object.keys(useEditorStore.getState().graph.nodes ?? {})[0] ?? "";
    useEditorStore.setState({ activeRunId: "old-run", runStatus: "succeeded" });
    useEditorStore.getState().handleEvent({
      t: "run.started",
      run_id: "fast-run",
      node_count: 1,
    });
    useEditorStore.getState().handleEvent({
      t: "node.cached",
      run_id: "fast-run",
      node_id: nodeId,
    });
    useEditorStore.getState().handleEvent({
      t: "run.done",
      run_id: "fast-run",
      elapsed_ms: 0,
    });

    useEditorStore.getState().startRun("fast-run");

    expect(useEditorStore.getState().runStatus).toBe("succeeded");
    expect(useEditorStore.getState().runtime[nodeId]?.status).toBe("cached");
  });

  it("첫 HTTP 요청이 끝나기 전 연속 실행 제출을 하나로 제한한다", () => {
    expect(useEditorStore.getState().beginRunSubmission()).toBe(true);
    expect(useEditorStore.getState().beginRunSubmission()).toBe(false);
    expect(useEditorStore.getState().beginRunSubmission()).toBe(false);

    useEditorStore.getState().finishRunSubmission();

    expect(useEditorStore.getState().beginRunSubmission()).toBe(true);
  });

  it("성공한 노드의 시드만 run.done 뒤 다음 실행값으로 넘긴다", () => {
    const sampler = "00000000-0000-4000-8000-000000000404";
    const waiting = "00000000-0000-4000-8000-000000000405";
    let graph: GraphDocument = {
      nodal_version: "1" as const,
      nodes: {
        [sampler]: { type: "diffusion.KSampler", inputs: { seed: 41, steps: 20 } },
        [waiting]: { type: "diffusion.KSampler", inputs: { seed: 90, steps: 20 } },
      },
      outputs: [sampler],
    };
    graph = withSeedControl(graph, sampler, "seed", "increment");
    graph = withSeedControl(graph, waiting, "seed", "increment");
    useEditorStore.setState({ graph });

    useEditorStore.getState().startRun("seed-run");
    useEditorStore.getState().handleEvent({
      t: "run.started",
      run_id: "seed-run",
      node_count: 1,
    });
    useEditorStore.getState().handleEvent({
      t: "node.done",
      run_id: "seed-run",
      node_id: sampler,
      outputs: [],
    });
    useEditorStore.getState().handleEvent({ t: "run.done", run_id: "seed-run", elapsed_ms: 50 });

    const state = useEditorStore.getState();
    expect(state.runtime[sampler]?.submittedSeeds).toEqual({ seed: 41 });
    expect(state.graph.nodes?.[sampler]?.inputs?.seed).toBe(42);
    expect(state.graph.nodes?.[waiting]?.inputs?.seed).toBe(90);

    useEditorStore.getState().handleEvent({ t: "run.done", run_id: "seed-run", elapsed_ms: 50 });
    expect(useEditorStore.getState().graph.nodes?.[sampler]?.inputs?.seed).toBe(42);
  });

  it("실패한 실행은 시드를 바꾸지 않는다", () => {
    const sampler = "00000000-0000-4000-8000-000000000406";
    let graph: GraphDocument = {
      nodal_version: "1" as const,
      nodes: { [sampler]: { type: "diffusion.KSampler", inputs: { seed: 7 } } },
      outputs: [sampler],
    };
    graph = withSeedControl(graph, sampler, "seed", "increment");
    useEditorStore.setState({ graph });
    useEditorStore.getState().startRun("failed-seed-run");
    useEditorStore.getState().handleEvent({
      t: "run.started",
      run_id: "failed-seed-run",
      node_count: 1,
    });
    useEditorStore.getState().handleEvent({
      t: "run.failed",
      run_id: "failed-seed-run",
      elapsed_ms: 10,
      code: "node_failed",
      message: "실패",
    });
    expect(useEditorStore.getState().graph.nodes?.[sampler]?.inputs?.seed).toBe(7);
  });

  it("노드를 옮겨도 ui에 저장한 시드 모드를 보존한다", () => {
    const sampler = "00000000-0000-4000-8000-000000000407";
    const graph: GraphDocument = {
      nodal_version: "1",
      nodes: { [sampler]: { type: "diffusion.KSampler", inputs: { seed: 3 } } },
      ui: { [sampler]: { pos: [0, 0] } },
    };
    useEditorStore.setState({ graph });
    useEditorStore.getState().setSeedControl(sampler, "seed", "randomize");
    useEditorStore
      .getState()
      .applyNodeChanges([
        { id: sampler, type: "position", position: { x: 120, y: 80 }, dragging: false },
      ]);
    expect(readSeedControl(useEditorStore.getState().graph, sampler, "seed", "fixed")).toBe(
      "randomize",
    );
  });
});

describe("M7.4 캐논 그래프 undo/redo", () => {
  const baseline: GraphDocument = {
    nodal_version: "1",
    id: "00000000-0000-4000-8000-000000000710",
    nodes: {},
    outputs: [],
    ui: { viewport: { x: 0, y: 0, zoom: 1 } },
  };

  beforeEach(() => {
    useEditorStore.getState().loadGraph(baseline);
    useEditorStore.setState({ schemas: [...MOCK_NODE_SCHEMAS] });
  });

  it("노드 추가 → undo → redo가 그래프 문서를 정확히 되돌린다", () => {
    const schema = MOCK_NODE_SCHEMAS.find((candidate) => candidate.id === "math.Const");
    if (!schema) throw new Error("math.Const 목 스키마가 없다");
    const before = structuredClone(useEditorStore.getState().graph);

    useEditorStore.getState().addNode(schema, { x: 120, y: 80 });
    const added = structuredClone(useEditorStore.getState().graph);
    expect(added).not.toEqual(before);
    expect(useEditorStore.getState().canUndo).toBe(true);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().graph).toEqual(before);
    expect(useEditorStore.getState().canRedo).toBe(true);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().graph).toEqual(added);
  });

  it("실행 중 편집과 undo는 제출된 실행 상태를 바꾸지 않는다", () => {
    const schema = MOCK_NODE_SCHEMAS.find((candidate) => candidate.id === "math.Const");
    if (!schema) throw new Error("math.Const 목 스키마가 없다");
    const submitted = structuredClone(useEditorStore.getState().graph);
    useEditorStore.getState().startRun("running-edit");
    useEditorStore.getState().handleEvent({
      t: "run.started",
      run_id: "running-edit",
      node_count: 0,
    });

    useEditorStore.getState().addNode(schema, { x: 40, y: 40 });
    expect(useEditorStore.getState().runStatus).toBe("running");
    useEditorStore.getState().undo();

    expect(useEditorStore.getState().graph).toEqual(submitted);
    expect(useEditorStore.getState().runStatus).toBe("running");
    expect(useEditorStore.getState().activeRunId).toBe("running-edit");
  });
});
