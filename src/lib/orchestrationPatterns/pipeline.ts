// Pipeline (Sequential) — 멤버를 order 순으로 실행, 앞 출력을 다음 입력으로 전달.
// 초기 단계 실패는 전파(중단). 현재 Workflow 의 순차 실행을 L4 로 올린 형태.
import type { StrategyCtx } from './types'
import { memberLabel } from './util'

export async function runPipeline(ctx: StrategyCtx): Promise<void> {
  const ordered = [...ctx.members].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  let preamble = ''
  for (const m of ordered) {
    if (ctx.abort.aborted) break
    ctx.log(`Pipeline → ${memberLabel(ctx, m)}`)
    const r = await ctx.runMember(m, { preamble })
    if (r.status !== 'done') {
      ctx.log(`Pipeline stopped — ${memberLabel(ctx, m)} ${r.status}`)
      break   // abort-on-failure, like the sequential workflow runner
    }
    preamble = r.finalOutput   // 다음 멤버의 상류 컨텍스트
  }
  ctx.patch({ aggregateOutput: preamble })
}
