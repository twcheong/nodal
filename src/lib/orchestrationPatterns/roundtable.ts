// Roundtable (Group chat) — 멤버들이 공유 스레드에 기여, 매니저(LLM)가 발언 순서
// 관리. maker/checker 역할이 있으면 maker-checker 루프(생성→검수→재생성)를 돈다.
// 루프 캡: config.maxRounds. 멤버는 토론·검수 목적(읽기 위주)으로 안내한다.
import type { StrategyCtx, ThreadEntry } from './types'
import { memberLabel, parseJsonLoose } from './util'

export async function runRoundtable(ctx: StrategyCtx): Promise<void> {
  const mgr = ctx.config.managerInstructions ? `\nManager instructions (follow these): ${ctx.config.managerInstructions}\n` : ''
  const thread: ThreadEntry[] = []
  const pushThread = (e: ThreadEntry) => { thread.push(e); ctx.patch({ thread: [...thread] }) }
  const renderThread = () => thread.map(t => `${t.speaker}${t.role ? ` (${t.role})` : ''}: ${t.text}`).join('\n\n')

  const maker   = ctx.members.find(m => m.role === 'maker')
  const checker = ctx.members.find(m => m.role === 'checker')

  // ── Maker-checker 루프 ──────────────────────────────────────────────────
  if (maker && checker) {
    ctx.log('Roundtable — maker-checker loop')
    for (let round = 0; round < ctx.config.maxRounds; round++) {
      if (ctx.abort.aborted) break
      const makeR = await ctx.runMember(maker, { preamble: renderThread(), reviewMode: 'auto-approve' })
      pushThread({ speaker: memberLabel(ctx, maker), role: 'maker', text: makeR.finalOutput, ts: Date.now() })
      if (makeR.status !== 'done' || ctx.abort.aborted) break

      const checkR = await ctx.runMember(checker, { preamble: renderThread(), reviewMode: 'auto-approve' })
      pushThread({ speaker: memberLabel(ctx, checker), role: 'checker', text: checkR.finalOutput, ts: Date.now() })
      if (checkR.status !== 'done') break

      // 매니저가 합격 판정 — checker 출력이 승인인지 평가.
      const verdict = await ctx.llm(
        `A checker reviewed a maker's output. Decide if it PASSES acceptance.\n\nChecker said:\n${checkR.finalOutput}\n\n` +
        `Reply with JSON only: {"pass": true|false}`)
      const v = parseJsonLoose<{ pass?: boolean }>(verdict)
      if (v?.pass) { ctx.log(`Approved in round ${round + 1}`); ctx.patch({ aggregateOutput: makeR.finalOutput }); return }
    }
    ctx.patch({ aggregateOutput: thread.filter(t => t.role === 'maker').pop()?.text ?? '', warning: `Reached maxRounds (${ctx.config.maxRounds}) without checker approval` })
    return
  }

  // ── 매니저 주도 라운드테이블 ─────────────────────────────────────────────
  ctx.log('Roundtable — manager-led discussion')
  const roster = ctx.members.map(m => `${m.id}: ${memberLabel(ctx, m)}`).join('\n')
  for (let round = 0; round < ctx.config.maxRounds; round++) {
    if (ctx.abort.aborted) break
    const decision = await ctx.llm(
      `You are the manager of a roundtable. Goal:\n${ctx.orchestration.prompt || ctx.orchestration.title}\n${mgr}\n` +
      `Participants:\n${roster}\n\nConversation so far:\n${renderThread() || '(empty)'}\n\n` +
      `Pick who speaks next, or end if the goal is met. Reply JSON only: {"next":"<memberId>"} or {"done":true,"summary":"..."}`)
    const d = parseJsonLoose<{ next?: string; done?: boolean; summary?: string }>(decision)
    if (d?.done) { ctx.patch({ aggregateOutput: d.summary || renderThread() }); return }
    const next = ctx.members.find(m => m.id === d?.next) ?? ctx.members[round % ctx.members.length]
    const r = await ctx.runMember(next, { preamble: renderThread(), reviewMode: 'auto-approve' })
    pushThread({ speaker: memberLabel(ctx, next), role: next.role, text: r.finalOutput, ts: Date.now() })
    if (r.status !== 'done') break
  }
  ctx.patch({ aggregateOutput: renderThread(), warning: thread.length ? undefined : 'No contributions' })
}
