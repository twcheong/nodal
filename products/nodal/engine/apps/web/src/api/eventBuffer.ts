import type { WsEvent } from "./types";

type StreamEvent = Extract<WsEvent, { t: "node.progress" | "node.preview" }>;

export interface EventBuffer {
  push: (event: WsEvent) => void;
  dispose: () => void;
}

/** 고빈도 스텝 이벤트는 노드별 최신값만 10fps로 전달한다. 종료 이벤트 앞에서는 즉시 비운다. */
export function createEventBuffer(
  listener: (event: WsEvent) => void,
  intervalMs = 100,
): EventBuffer {
  const pendingProgress = new Map<string, StreamEvent>();
  const pendingPreview = new Map<string, StreamEvent>();
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const flushNode = (nodeId: string) => {
    const progress = pendingProgress.get(nodeId);
    const preview = pendingPreview.get(nodeId);
    pendingProgress.delete(nodeId);
    pendingPreview.delete(nodeId);
    if (progress) listener(progress);
    if (preview) listener(preview);
  };

  const flush = () => {
    timer = null;
    const nodeIds = new Set([...pendingProgress.keys(), ...pendingPreview.keys()]);
    nodeIds.forEach(flushNode);
  };

  return {
    push(event) {
      if (event.t === "node.progress" || event.t === "node.preview") {
        const target = event.t === "node.progress" ? pendingProgress : pendingPreview;
        target.set(event.node_id, event);
        timer ??= globalThis.setTimeout(flush, intervalMs);
        return;
      }
      if ("node_id" in event) flushNode(event.node_id);
      listener(event);
    },
    dispose() {
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = null;
      pendingProgress.clear();
      pendingPreview.clear();
    },
  };
}
