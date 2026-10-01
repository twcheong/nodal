// ─────────────────────────────────────────────────────────────────────────────
// workflowDots.ts — 워크플로 리스트/드로어 좌측 상태 점의 색 상태.
//
//   new(초록)   : Team Dashboard 에서 "Copy to my workflows" 한 직후 (아직 안 엶)
//   unseen(흰)  : 아직 한 번도 안 연 워크플로 (기본)
//   seen(회색)  : CT 또는 WF 어디서든 한 번이라도 클릭(열기)한 것
//
// CT(Copilot 탭)와 WF 탭이 같은 상태를 공유하도록 localStorage 로 보관.
// ─────────────────────────────────────────────────────────────────────────────

const OPENED_KEY = 'twixy.wf.opened.v1'
const NEW_KEY    = 'twixy.wf.new.v1'

function load(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]) } catch { return new Set() }
}
function save(key: string, s: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...s])) } catch { /* 용량/모드 문제는 무시 */ }
}

export type WorkflowDot = 'new' | 'unseen' | 'seen'

export function workflowDotState(id: string): WorkflowDot {
  if (load(OPENED_KEY).has(id)) return 'seen'
  if (load(NEW_KEY).has(id))    return 'new'
  return 'unseen'
}

export function workflowDotColor(id: string): string {
  switch (workflowDotState(id)) {
    case 'seen': return 'var(--text-muted)'
    case 'new':  return 'var(--accent)'
    default:     return 'var(--text-primary, #e6e6e6)'
  }
}

// 열람 표시 — seen(회색) 으로. new 였다면 해제.
export function markWorkflowOpened(id: string): void {
  const opened = load(OPENED_KEY)
  if (!opened.has(id)) { opened.add(id); save(OPENED_KEY, opened) }
  const fresh = load(NEW_KEY)
  if (fresh.delete(id)) save(NEW_KEY, fresh)
}

// 새 복사본 표시 — new(초록). 단, 이미 연 적 있으면 무시.
export function markWorkflowNew(id: string): void {
  if (load(OPENED_KEY).has(id)) return
  const fresh = load(NEW_KEY)
  if (!fresh.has(id)) { fresh.add(id); save(NEW_KEY, fresh) }
}
