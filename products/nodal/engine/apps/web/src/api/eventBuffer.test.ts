import { afterEach, describe, expect, it, vi } from "vitest";

import type { WsEvent } from "./types";
import { createEventBuffer } from "./eventBuffer";

afterEach(() => vi.useRealTimers());

describe("고빈도 스텝 이벤트 버퍼", () => {
  it("한 구간의 프리뷰 여러 장 중 최신 한 장만 전달한다", () => {
    vi.useFakeTimers();
    const received: WsEvent[] = [];
    const buffer = createEventBuffer((event) => received.push(event), 100);
    for (let step = 1; step <= 20; step += 1) {
      buffer.push({
        t: "node.preview",
        run_id: "run",
        node_id: "sampler",
        preview: {
          kind: "inline",
          data_uri: `data:image/png,${step}`,
          width: null,
          height: null,
        },
      });
    }
    expect(received).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ preview: { data_uri: "data:image/png,20" } });
    buffer.dispose();
  });

  it("node.done 전에 같은 노드의 마지막 진행률과 프리뷰를 비운다", () => {
    vi.useFakeTimers();
    const received: WsEvent[] = [];
    const buffer = createEventBuffer((event) => received.push(event));
    buffer.push({ t: "node.progress", run_id: "run", node_id: "sampler", step: 7, total: 8 });
    buffer.push({
      t: "node.preview",
      run_id: "run",
      node_id: "sampler",
      preview: {
        kind: "inline",
        data_uri: "data:image/png,last",
        width: null,
        height: null,
      },
    });
    buffer.push({ t: "node.done", run_id: "run", node_id: "sampler", outputs: [] });
    expect(received.map((event) => event.t)).toEqual([
      "node.progress",
      "node.preview",
      "node.done",
    ]);
    buffer.dispose();
  });
});
