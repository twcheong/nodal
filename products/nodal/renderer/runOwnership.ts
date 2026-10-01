// 엔진 실행 → 대화 귀속. 엔진은 대화를 모르므로 추정한다:
//   · 패널이 떠 있고 이 대화의 에이전트가 일하는 중(isThinking)에 처음 보인 실행 → 이 대화
//   · 패널이 막 열린 첫 조회에서 처음 보인, 최근(RECENT_MS) 실행 → 이 대화. 패널은 첫 답장 뒤에야
//     열리므로(CopilotView) 첫 턴에 시킨 실행은 이 경로로 잡힌다
//   · 노드 탭에서 직접 돌린 실행은 만들 때 markRunSeen 으로 미리 "본 것" 처리 — 대화에 안 섞인다
// 어디에도 안 걸린 실행은 "전체 보기"에서만 보인다.
//
// 사용자별 편의 상태라 localStorage 에 둔다. 비어 있거나 막혀 있어도 동작은 한다 (전부 "전체"로).
import type { RunSummary } from './engineApi'

const KEY = 'nodal.runOwnership.v1'
const MAX_SEEN = 1000
const RECENT_MS = 15 * 60_000

interface Store { seen: string[]; byConv: Record<string, string[]> }

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as Store
      if (Array.isArray(s.seen) && s.byConv && typeof s.byConv === 'object') return s
    }
  } catch { /* 없거나 막힘 */ }
  return { seen: [], byConv: {} }
}

function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* 막힘 — 이번 세션만 메모리로 */ }
}

let cache: Store | null = null
const store = () => (cache ??= load())

/** 새로 보인 실행을 기록하고, 위 규칙에 맞으면 convId 대화 것으로. */
export function claimNewRuns(
  convId: string | null,
  runs: RunSummary[],
  ctx: { thinking: boolean; firstPoll: boolean; now?: number },
): void {
  const s = store()
  const seen = new Set(s.seen)
  const now = ctx.now ?? Date.now()
  let changed = false
  for (const r of runs) {
    if (seen.has(r.run_id)) continue
    seen.add(r.run_id)
    s.seen.push(r.run_id)
    changed = true
    const recent = now - Date.parse(r.created_at) < RECENT_MS
    if (convId && (ctx.thinking || (ctx.firstPoll && recent))) (s.byConv[convId] ??= []).push(r.run_id)
  }
  if (!changed) return
  if (s.seen.length > MAX_SEEN) s.seen.splice(0, s.seen.length - MAX_SEEN)
  save(s)
}

/** 대화 밖(노드 탭)에서 시킨 실행 — 어느 대화에도 귀속시키지 않는다. */
export function markRunSeen(runId: string): void {
  const s = store()
  if (s.seen.includes(runId)) return
  s.seen.push(runId)
  save(s)
}

export function runsForConversation(convId: string | null, runs: RunSummary[]): RunSummary[] {
  if (!convId) return []
  const mine = new Set(store().byConv[convId] ?? [])
  return runs.filter((r) => mine.has(r.run_id))
}

/** 테스트용. */
export function resetRunOwnership(): void {
  cache = null
  try { localStorage.removeItem(KEY) } catch { /* noop */ }
}
