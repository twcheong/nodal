// ─────────────────────────────────────────────────────────────────────────────
// runLogs.ts — 실행 로그 헬퍼 (Epic 3).
//
// 에러 분류/제안은 heuristic — reason 문자열과 툴 흔적으로 추정한다. 정밀한
// 분류보다 "다음에 뭘 하면 되는지"를 알려주는 게 목적. 팀 업로드용 fail_log 는
// 노드당 prompt/output 을 클립하고 총량 상한을 둔다 (jsonb 비대 방지).
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCategory = 'system' | 'agent' | 'browser' | 'input'

export function categorizeError(
  reason: string | undefined,
  toolCalls?: Array<{ name: string; detail?: string }>,
): ErrorCategory {
  const r = (reason ?? '').toLowerCase()
  if (/timeout|timed out|cancelled|network|econn|fetch failed|socket/.test(r)) return 'system'
  if (/browser|chrome|cdp|navigate|selector|captcha|page/.test(r)) return 'browser'
  if ((toolCalls ?? []).some(t => /browser|chrome/.test(t.name.toLowerCase()))) return 'browser'
  if (/input|missing|placeholder|invalid|required|파일을 못|not found|no such file/.test(r)) return 'input'
  return 'agent'  // NODE_STATUS 자기보고 등 러너의 작업 실패
}

export function suggestNextAction(category: ErrorCategory): string {
  switch (category) {
    case 'system':  return 'Transient failure (timeout/network). Retry from the failed node — no workflow change needed.'
    case 'browser': return 'Browser step failed. Check the target site (layout change, login, captcha), then retry from the failed node.'
    case 'input':   return 'An input or file was missing/invalid. Fix the workflow inputs or referenced files, then retry.'
    case 'agent':   return 'The agent could not complete the task. Review the node instructions (the builder chat can suggest a fix), then retry.'
  }
}

// ── 팀 업로드용 fail_log ─────────────────────────────────────────────────────
// 노드당 prompt/output 2000자 클립 + 전체 200KB 상한 (초과 시 output 부터 제거).
const CLIP_PER_FIELD = 2_000
const MAX_FAIL_LOG_BYTES = 200 * 1024

export function buildFailLog(detail: TwixyRunDetail): unknown {
  const clip = (s: string | undefined) =>
    s && s.length > CLIP_PER_FIELD ? s.slice(0, CLIP_PER_FIELD) + '…' : s
  const nodes = detail.nodes.map(n => ({
    nodeId: n.nodeId, title: n.title, type: n.type, tool: n.tool,
    status: n.status, durationMs: n.durationMs, costUsd: n.costUsd,
    reason: clip(n.reason), prompt: clip(n.prompt), output: clip(n.output),
    toolCalls: n.toolCalls?.slice(0, 30),
  }))
  let log: unknown = { runId: detail.runId, wfTitle: detail.wfTitle, startedAt: detail.startedAt, nodes }
  if (JSON.stringify(log).length > MAX_FAIL_LOG_BYTES) {
    // 상한 초과 — output 제거본으로 축소. 그래도 크면 실패 노드만 남긴다.
    const slim = nodes.map(n => ({ ...n, output: undefined, prompt: n.status === 'failed' ? n.prompt : undefined }))
    log = { runId: detail.runId, wfTitle: detail.wfTitle, startedAt: detail.startedAt, nodes: slim }
    if (JSON.stringify(log).length > MAX_FAIL_LOG_BYTES) {
      log = { runId: detail.runId, wfTitle: detail.wfTitle, startedAt: detail.startedAt, nodes: slim.filter(n => n.status === 'failed') }
    }
  }
  return log
}

// ── CSV export — 노드 단위 플랫 ─────────────────────────────────────────────
export function runDetailToCsv(detail: TwixyRunDetail): string {
  const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
  const header = 'order,node,type,tool,status,started_at,duration_ms,cost_usd,tokens_in,tokens_out,tool_calls,reason,output'
  const lines = detail.nodes.map((n, i) => [
    i + 1, esc(n.title), n.type ?? '', esc(n.tool ?? ''), n.status,
    n.startedAt ? new Date(n.startedAt).toISOString() : '',
    n.durationMs ?? '', n.costUsd ?? '', n.tokensIn ?? '', n.tokensOut ?? '',
    esc((n.toolCalls ?? []).map(t => t.detail ? `${t.name}(${t.detail})` : t.name).join('; ')),
    esc(n.reason ?? ''), esc(n.output ?? ''),
  ].join(','))
  return header + '\n' + lines.join('\n')
}
