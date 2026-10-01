// 채팅 패널의 노드 보기 — 엔진이 돌린 실행을 웹 에디터 스토어가 그리는 모양으로 옮긴다.
//
// 그래프는 엔진이 준다 (RunDetail.graph — 평탄화 후라 노드 ID 가 WS 이벤트·executed 와 같고, 입력값이
// 그 실행의 것). 여기서 하는 일은 둘뿐이다:
//   1. 배치 — 엔진 그래프에는 ui 좌표가 없다. 링크를 따라 왼→오 층으로 놓는다
//   2. 실행 상태 — 상세(폴링) 를 에디터의 runtime 으로. 실시간 이벤트는 에디터 스토어의 handleEvent 가 접는다
import type { OutputRef } from '../../engine/apps/web/src/api/types'
import type { NodeRuntimeState } from '../../engine/apps/web/src/editor/types'
import type { GraphDocument } from '../../engine/apps/web/src/graph/types'
import { isLink } from '../../engine/apps/web/src/graph/types'

/** 웹 에디터 NodalNode 카드는 위젯까지 그려 크다 — 겹치지 않게 넉넉히. */
const COL_W = 400
const ROW_H = 340

/** ui.pos 가 없는 노드를 왼→오 층(가장 긴 선행 경로)으로 놓는다. 이미 있는 좌표는 건드리지 않는다. */
export function layoutGraph(graph: GraphDocument): GraphDocument {
  const nodes = graph.nodes ?? {}
  const ids = Object.keys(nodes)
  const preds = new Map<string, string[]>()
  for (const [id, node] of Object.entries(nodes)) {
    for (const value of Object.values(node.inputs ?? {})) {
      if (isLink(value) && nodes[value.$link[0]]) preds.set(id, [...(preds.get(id) ?? []), value.$link[0]])
    }
  }
  const depth = new Map<string, number>()
  const depthOf = (id: string, guard = 0): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const d = guard > ids.length ? 0 : Math.max(-1, ...(preds.get(id) ?? []).map((p) => depthOf(p, guard + 1))) + 1
    depth.set(id, d)
    return d
  }
  const rows = new Map<number, number>()
  const ui: NonNullable<GraphDocument['ui']> = { ...(graph.ui ?? {}) }
  for (const id of ids) {
    const d = depthOf(id)
    const row = rows.get(d) ?? 0
    rows.set(d, row + 1)
    const current = ui[id] as { pos?: unknown } | undefined
    if (!Array.isArray(current?.pos)) ui[id] = { pos: [d * COL_W, row * ROW_H] }
  }
  return { ...graph, ui }
}

export interface DetailLike {
  status: string
  executed?: string[]
  cached?: string[]
  outputs?: Record<string, OutputRef[]>
  error?: { message: string } | null
  progress?: { node_id?: string | null; step?: number | null; total_steps?: number | null } | null
}

/** 엔진 에러 메시지의 `nodes.<id>: ...` 머리에서 노드 ID. */
export function nodeIdFromError(message: string | undefined): string | null {
  const m = message?.match(/^nodes\.(\S+?):\s/)
  return m ? m[1] : null
}

const RANK: Record<NodeRuntimeState['status'], number> = { idle: 0, queued: 1, running: 2, cached: 3, succeeded: 3, error: 4 }

/**
 * 상세 → 에디터 runtime. `prev` 는 지금까지(실시간 이벤트로) 쌓인 것 — 상세가 그보다 뒤처져 있으면
 * (이벤트가 먼저 왔으면) 되돌리지 않는다. 미리보기처럼 이벤트로만 오는 것은 남긴다.
 */
export function runtimeFromDetail(
  graph: GraphDocument,
  detail: DetailLike,
  prev: Readonly<Record<string, NodeRuntimeState>>,
): Record<string, NodeRuntimeState> {
  const executed = new Set(detail.executed ?? [])
  const cached = new Set(detail.cached ?? [])
  const failed = detail.status === 'failed' ? nodeIdFromError(detail.error?.message) : null
  const activeId = detail.status === 'running' ? detail.progress?.node_id ?? null : null
  const out: Record<string, NodeRuntimeState> = {}
  for (const id of Object.keys(graph.nodes ?? {})) {
    let next: NodeRuntimeState = { status: detail.status === 'queued' || detail.status === 'running' ? 'queued' : 'idle' }
    const outputs = detail.outputs?.[id] ? { outputs: detail.outputs[id] } : {}
    if (executed.has(id)) next = { status: 'succeeded', ...outputs }
    else if (cached.has(id)) next = { status: 'cached', ...outputs }
    else if (id === failed) next = { status: 'error', error: { message: detail.error?.message ?? '', socket: null, traceback: [] } }
    else if (id === activeId) {
      const { step, total_steps: total } = detail.progress ?? {}
      next = { status: 'running', ...(step != null && total ? { progress: { step, total, etaMs: null } } : {}) }
    }
    const old = prev[id]
    if (old && RANK[old.status] > RANK[next.status]) out[id] = old
    else out[id] = { ...old, ...next, preview: old?.preview }
  }
  return out
}
