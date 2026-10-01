// Parallel (Concurrent) — 모든 멤버를 같은 입력으로 동시 실행 후 종합.
// 종합 방식(config.aggregation): concat / vote / synthesize(기본).
// 상충 결과는 숨기지 않고 종합 단계에서 드러낸다.
import type { StrategyCtx } from './types'
import { memberLabel, firstLine } from './util'

export async function runParallel(ctx: StrategyCtx): Promise<void> {
  ctx.log(`Parallel — ${ctx.members.length} members concurrently`)
  // 동시 실행. 한 멤버가 throw 해도 전체는 계속 (null 로 수거).
  const results = await Promise.all(
    ctx.members.map(m => ctx.runMember(m).catch(() => null)),
  )
  // 모든 분기를 실행(배리어)하되, 그룹 output 종합은 선택된 멤버(outputFrom)만 — 미지정이면 전체.
  const sel = ctx.config.outputFrom?.length ? new Set(ctx.config.outputFrom) : null
  const outs = ctx.members
    .map((m, i) => ({ id: m.id, label: memberLabel(ctx, m), text: results[i]?.finalOutput ?? '' }))
    .filter(o => o.text.trim() && (!sel || sel.has(o.id)))

  if (outs.length === 0) { ctx.patch({ aggregateOutput: '' }); return }

  const mode = ctx.config.aggregation
  let aggregate = ''
  if (mode === 'concat') {
    aggregate = outs.map(o => `## ${o.label}\n${o.text}`).join('\n\n')
  } else if (mode === 'vote') {
    // 각 출력의 첫 줄을 표로 집계 — 분류/판정형 작업의 다수결.
    const tally = new Map<string, number>()
    for (const o of outs) {
      const k = firstLine(o.text).toLowerCase()
      tally.set(k, (tally.get(k) ?? 0) + 1)
    }
    const winner = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    aggregate = `Majority verdict: ${winner[0]} (${winner[1]}/${outs.length})\n\n` +
      outs.map(o => `- ${o.label}: ${firstLine(o.text)}`).join('\n')
  } else {
    // synthesize — 한 번의 LLM 호출로 상충까지 짚어 일관된 종합문 작성.
    const prompt = [
      `You are aggregating independent analyses of the same task from ${outs.length} specialist workflows.`,
      `Synthesize them into one coherent result. Where they CONTRADICT, surface the conflict explicitly rather than hiding it.`,
      '',
      ...outs.map(o => `### ${o.label}\n${o.text}`),
    ].join('\n')
    aggregate = await ctx.llm(prompt)
  }
  ctx.patch({ aggregateOutput: aggregate })
}
