import { beforeEach, describe, expect, it } from "vitest";

import { createStarterGraph } from "../editor/graph";
import { useEditorStore } from "./editorStore";

describe("실행 이벤트 상태", () => {
  beforeEach(() => {
    useEditorStore.setState({
      graph: createStarterGraph(),
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
});
