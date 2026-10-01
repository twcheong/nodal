// Specialist (원본 Handoff) — criteria(LLM)가 후보 분기들을 보고 "가장 적합한 1개"를 고르고,
// 그 분기 하나만 실행한다. N개 중 1개만 동작(나머지는 실행 안 됨). 선택된 분기가 하위 체인
// (예: wf1 → wf4 pipeline 서브그룹)이면 그 체인 전체가 실행된다 — runMember 가 재귀 처리.
// (이전의 "1명씩 순차 인계" 개념이 아니라, 처음에 1개를 선택해 그것만 실행.)
import type { StrategyCtx } from './types'
import { memberLabel, parseJsonLoose } from './util'

export async function runRelay(ctx: StrategyCtx): Promise<void> {
  const members = ctx.members
  if (members.length === 0) { ctx.patch({ aggregateOutput: '' }); return }

  // 기본값(criteria 실패/단일 후보 시) = 첫 분기.
  let chosen = members[0]

  if (members.length > 1) {
    const roster = members.map(m => `${m.id}: ${memberLabel(ctx, m)}`).join('\n')
    const criteria = ctx.config.managerInstructions ? `Selection criteria (follow these):\n${ctx.config.managerInstructions}\n\n` : ''
    const context  = ctx.orchestration.prompt ? `Task / input context:\n${ctx.orchestration.prompt}\n\n` : ''
    ctx.log('Specialist — choosing the best-fit option')
    const decision = await ctx.llm(
      `Choose the SINGLE most appropriate option to handle this task — exactly one runs, the others do NOT.\n\n` +
      `${criteria}${context}Options:\n${roster}\n\nReply JSON only: {"choice":"<id>"}`)
    const picked = members.find(m => m.id === parseJsonLoose<{ choice?: string }>(decision)?.choice)
    if (picked) chosen = picked
  }

  // 선택된 분기 1개만 실행(분기가 서브그룹이면 그 체인 전체가 runMember 로 재귀 실행).
  ctx.patch({ handoffPath: [chosen.id] })
  ctx.log(`Specialist → ${memberLabel(ctx, chosen)}`)
  const r = await ctx.runMember(chosen)
  ctx.patch({ aggregateOutput: r.finalOutput })
}
