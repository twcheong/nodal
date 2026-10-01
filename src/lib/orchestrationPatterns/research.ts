// Parallel research — 모든 멤버를 같은 입력으로 동시 실행한 뒤, 끝점의 "종합(aggregate)
// 노드"가 모든 output 을 하나로 합친다. plain Parallel(분기별 독립 output, 합류 없음)과
// 달리 research 는 의도적으로 하나의 종합 결과를 만든다(끝점 노드 = specialist 의 criteria
// 노드를 시작점이 아닌 끝점에 둔 형태). 종합 기준은 그룹의 managerInstructions.
import type { StrategyCtx } from './types'
import { memberLabel } from './util'

export async function runResearch(ctx: StrategyCtx): Promise<void> {
  ctx.log(`Parallel research — ${ctx.members.length} members concurrently → synthesize`)
  // 동시 실행(배리어) — 모든 분기가 끝나야 종합 노드 실행.
  const results = await Promise.all(ctx.members.map(m => ctx.runMember(m).catch(() => null)))
  const outs = ctx.members
    .map((m, i) => ({ label: memberLabel(ctx, m), text: results[i]?.finalOutput ?? '' }))
    .filter(o => o.text.trim())

  if (outs.length === 0) { ctx.patch({ aggregateOutput: '' }); return }

  const guidance = ctx.config.managerInstructions?.trim()
  const prompt = [
    `You are the research synthesizer. Aggregate ${outs.length} parallel research workflows that all ran on the same task.`,
    guidance ? `Synthesis criteria: ${guidance}` : 'Produce one coherent, well-structured research synthesis.',
    'Where the sources CONTRADICT, surface the conflict explicitly rather than hiding it. Attribute findings to the workflow they came from.',
    '',
    ...outs.map(o => `### ${o.label}\n${o.text}`),
  ].join('\n')
  const aggregate = await ctx.llm(prompt)
  // LLM 실패 시 최소한 concat 으로라도 종합 결과를 남긴다.
  ctx.patch({ aggregateOutput: aggregate.trim() || outs.map(o => `## ${o.label}\n${o.text}`).join('\n\n') })
}
