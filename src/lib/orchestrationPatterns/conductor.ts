// Conductor (Magentic) — 매니저(LLM)가 task ledger 를 구성, 멤버를 동적으로 호출·
// 재정렬하며 목표 달성까지 반복. 원장은 감사 추적용으로 run state 에 보존.
// 루프 캡: config.maxRounds. 정체(진전 없음) 감지 시 중단.
import type { StrategyCtx, LedgerItem } from './types'
import { memberLabel, parseJsonLoose } from './util'

export async function runConductor(ctx: StrategyCtx): Promise<void> {
  const roster = ctx.members.map(m => `${m.id}: ${memberLabel(ctx, m)}`).join('\n')
  const goal = ctx.orchestration.prompt || ctx.orchestration.title
  const mgr = ctx.config.managerInstructions ? `\nManager instructions (follow these): ${ctx.config.managerInstructions}\n` : ''

  // 1) 초기 원장 구성.
  const planText = await ctx.llm(
    `You are the conductor (manager). Build an initial task ledger to accomplish this goal using the available member workflows.\n${mgr}\n` +
    `Goal:\n${goal}\n\nMembers:\n${roster}\n\n` +
    `Reply JSON only: {"items":[{"goal":"...","memberId":"<id>"}]} — ordered, 1 item per member invocation.`)
  const parsed = parseJsonLoose<{ items?: Array<{ goal?: string; memberId?: string }> }>(planText)
  let ledger: LedgerItem[] = (parsed?.items ?? []).map((it, i) => ({
    id: `L${i + 1}`, goal: it.goal || `Step ${i + 1}`, memberId: it.memberId, status: 'pending',
  }))
  // fallback: 원장 파싱 실패 → 멤버 순서대로.
  if (ledger.length === 0) {
    ledger = ctx.members.map((m, i) => ({ id: `L${i + 1}`, goal: `Run ${memberLabel(ctx, m)}`, memberId: m.id, status: 'pending' as const }))
  }
  ctx.patch({ ledger: [...ledger] })

  const byId = new Map(ctx.members.map(m => [m.id, m]))
  let lastOutput = ''
  let noProgress = 0

  for (let round = 0; round < ctx.config.maxRounds; round++) {
    if (ctx.abort.aborted) break
    const item = ledger.find(l => l.status === 'pending')
    if (!item) break

    const member = item.memberId ? byId.get(item.memberId) : ctx.members[0]
    if (!member) { item.status = 'dropped'; item.note = 'no member'; ctx.patch({ ledger: [...ledger] }); continue }

    item.status = 'running'; ctx.patch({ ledger: [...ledger] })
    ctx.log(`Conductor → ${item.goal} (${memberLabel(ctx, member)})`)
    const r = await ctx.runMember(member, { preamble: `${goal}\n\nSubgoal: ${item.goal}\n\nPrior result:\n${lastOutput}`.trim() })
    item.status = r.status === 'done' ? 'done' : 'failed'
    if (r.status === 'done') { lastOutput = r.finalOutput; noProgress = 0 } else { noProgress++ }
    ctx.patch({ ledger: [...ledger] })

    // 매니저 재평가 — 만족? 정체? 항목 추가?
    const evalText = await ctx.llm(
      `Manager re-evaluation.\nGoal:\n${goal}\n\nLatest result:\n${lastOutput}\n\n` +
      `Ledger so far:\n${ledger.map(l => `${l.id} [${l.status}] ${l.goal}`).join('\n')}\n\n` +
      `Members:\n${roster}\n\n` +
      `Reply JSON only: {"done":true} OR {"done":false,"add":[{"goal":"...","memberId":"<id>"}]}`)
    const ev = parseJsonLoose<{ done?: boolean; add?: Array<{ goal?: string; memberId?: string }> }>(evalText)
    if (ev?.done) { ctx.log('Conductor — goal satisfied'); break }
    if (ev?.add?.length) {
      const base = ledger.length
      ledger.push(...ev.add.map((it, i) => ({ id: `L${base + i + 1}`, goal: it.goal || 'Added step', memberId: it.memberId, status: 'pending' as const })))
      ctx.patch({ ledger: [...ledger] })
    }
    if (noProgress >= 2) { ctx.patch({ warning: 'Conductor stalled — no progress in 2 rounds' }); break }
  }
  if (ledger.some(l => l.status === 'pending')) {
    ctx.patch({ warning: ctx.abort.aborted ? undefined : `Reached maxRounds (${ctx.config.maxRounds}) with pending ledger items` })
  }
  ctx.patch({ aggregateOutput: lastOutput })
}
