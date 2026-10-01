import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../graph/types";
import { GraphHistory } from "./graphHistory";

const BASE: GraphDocument = {
  nodal_version: "1",
  id: "00000000-0000-4000-8000-000000000701",
  nodes: {},
  outputs: [],
  ui: { viewport: { x: 0, y: 0, zoom: 1 } },
};

describe("Yjs 캐논 그래프 히스토리", () => {
  it("캐논 문서 변경을 정확히 undo/redo한다", () => {
    const history = new GraphHistory(BASE);
    const added: GraphDocument = {
      ...BASE,
      nodes: {
        "00000000-0000-4000-8000-000000000702": { type: "math.Const", inputs: { value: 3 } },
      },
    };

    history.capture(BASE, added);

    expect(history.undo(added)).toEqual(BASE);
    expect(history.redo(BASE)).toEqual(added);
  });

  it("노드 위치는 되돌리되 현재 viewport는 유지한다", () => {
    const history = new GraphHistory(BASE);
    const nodeId = "00000000-0000-4000-8000-000000000703";
    const before: GraphDocument = {
      ...BASE,
      nodes: { [nodeId]: { type: "math.Const", inputs: { value: 1 } } },
      ui: { [nodeId]: { pos: [10, 20] }, viewport: { x: 0, y: 0, zoom: 1 } },
    };
    const moved: GraphDocument = {
      ...before,
      ui: { [nodeId]: { pos: [80, 90] }, viewport: { x: 0, y: 0, zoom: 1 } },
    };
    history.reset(before);
    history.capture(before, moved, true);
    history.stopCapturing();
    const navigated: GraphDocument = {
      ...moved,
      ui: { ...moved.ui, viewport: { x: 400, y: 200, zoom: 0.5 } },
    };

    expect(history.undo(navigated)).toEqual({
      ...before,
      ui: { ...before.ui, viewport: { x: 400, y: 200, zoom: 0.5 } },
    });
  });
});
