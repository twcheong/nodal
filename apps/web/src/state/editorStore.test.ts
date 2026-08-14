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

  it("node.error 뒤 run.done이 와도 실패를 성공으로 덮지 않는다", () => {
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
      t: "run.done",
      run_id: "run-2",
      elapsed_ms: 12,
    });
    expect(useEditorStore.getState().runStatus).toBe("failed");
    expect(useEditorStore.getState().runtime[nodeId]?.error?.socket).toBe("value");
  });
});
