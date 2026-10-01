import * as Y from "yjs";

import type { GraphDocument } from "../graph/types";

const EDIT_ORIGIN = Symbol("nodal.graph-edit");
const GRAPH_KEY = "graph";

export interface GraphHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Yjs는 캐논 GraphDocument의 편집 이력만 표현한다.
 *
 * 별도 Yjs 그래프 스키마를 만들지 않고 Map의 단일 값에 캐논 문서 자체를 둔다.
 * 저장·내보내기·실행에는 언제나 GraphDocument만 사용한다. viewport는 문서에
 * 저장되지만 탐색 상태라 undo 대상에서 제외하며, 복원할 때 현재 값을 유지한다.
 */
export class GraphHistory {
  readonly #document = new Y.Doc();
  readonly #state = this.#document.getMap<GraphDocument>("canonical");
  readonly #undo = new Y.UndoManager(this.#state, {
    trackedOrigins: new Set([EDIT_ORIGIN]),
    captureTimeout: 500,
  });

  constructor(graph: GraphDocument) {
    this.reset(graph);
  }

  get status(): GraphHistoryState {
    return { canUndo: this.#undo.canUndo(), canRedo: this.#undo.canRedo() };
  }

  /** 외부 로드나 서버 투영은 새 기준선이다. 그 이전 로컬 편집 이력은 섞지 않는다. */
  reset(graph: GraphDocument): void {
    this.#document.transact(() => {
      this.#state.set(GRAPH_KEY, clone(withoutViewport(graph)));
    });
    this.#undo.clear();
  }

  /** 원자 편집은 한 번의 undo, 연속 편집(드래그)은 stopCapturing까지 한 번의 undo다. */
  capture(previous: GraphDocument, next: GraphDocument, continuous = false): void {
    if (!sameGraph(this.current(), withoutViewport(previous))) this.reset(previous);
    const historyNext = withoutViewport(next);
    if (sameGraph(this.current(), historyNext)) return;
    if (!continuous) this.#undo.stopCapturing();
    this.#document.transact(() => {
      this.#state.set(GRAPH_KEY, clone(historyNext));
    }, EDIT_ORIGIN);
    if (!continuous) this.#undo.stopCapturing();
  }

  stopCapturing(): void {
    this.#undo.stopCapturing();
  }

  undo(currentGraph: GraphDocument): GraphDocument | null {
    if (!this.#undo.canUndo()) return null;
    this.#undo.undo();
    return withCurrentViewport(this.current(), currentGraph);
  }

  redo(currentGraph: GraphDocument): GraphDocument | null {
    if (!this.#undo.canRedo()) return null;
    this.#undo.redo();
    return withCurrentViewport(this.current(), currentGraph);
  }

  private current(): GraphDocument {
    const graph = this.#state.get(GRAPH_KEY);
    if (!graph) throw new Error("Yjs 편집 문서에 캐논 그래프가 없다");
    return clone(graph);
  }
}

function withoutViewport(graph: GraphDocument): GraphDocument {
  if (graph.ui === undefined || !("viewport" in graph.ui)) return clone(graph);
  const ui = { ...graph.ui };
  delete ui.viewport;
  return { ...clone(graph), ui };
}

function withCurrentViewport(
  historyGraph: GraphDocument,
  currentGraph: GraphDocument,
): GraphDocument {
  const viewport = currentGraph.ui?.viewport;
  if (viewport === undefined) return historyGraph;
  return {
    ...historyGraph,
    ui: { ...(historyGraph.ui ?? {}), viewport: clone(viewport) },
  };
}

function sameGraph(left: GraphDocument, right: GraphDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
