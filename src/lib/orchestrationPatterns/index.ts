// 패턴 디스패처 — pattern 에 맞는 전략을 실행.
import type { StrategyCtx } from './types'
import { runPipeline } from './pipeline'
import { runParallel } from './parallel'
import { runResearch } from './research'
import { runRoundtable } from './roundtable'
import { runRelay } from './relay'
import { runConductor } from './conductor'

export * from './types'

// 현재 비활성 method — 선택 불가(전체에서 disable). 활성 3종: pipeline/parallel/specialist.
export const DISABLED_PATTERNS: OrchestrationPattern[] = ['conductor', 'roundtable']

// (코드상 'pattern'/'subPattern' 필드명은 유지하되, 사용자에게는 "method"로 표기)
// id 'relay' 는 유지(데이터/전략 호환), 표시 라벨만 'Specialist'.
export const PATTERN_META: Record<OrchestrationPattern, { label: string; origin: string; blurb: string }> = {
  pipeline:   { label: 'Pipeline',   origin: 'Sequential',  blurb: 'Each workflow’s output feeds the next. Linear chain.' },
  parallel:   { label: 'Parallel',   origin: 'Concurrent',  blurb: 'All workflows run on the same input. Each output stays independent — no merge.' },
  research:   { label: 'Parallel research', origin: 'Concurrent', blurb: 'All workflows run on the same input, then one synthesis node aggregates every output.' },
  relay:      { label: 'Specialist', origin: 'Handoff',     blurb: 'Criteria picks the single best-fit option; only that branch (with its sub-chain) runs.' },
  roundtable: { label: 'Roundtable', origin: 'Group chat',  blurb: 'Shared-thread discussion / maker-checker.' },
  conductor:  { label: 'Conductor',  origin: 'Magentic',    blurb: 'A manager dynamically directs a task ledger.' },
}

export async function runPattern(ctx: StrategyCtx): Promise<void> {
  switch (ctx.orchestration.pattern) {
    case 'parallel':   return runParallel(ctx)
    case 'research':   return runResearch(ctx)
    case 'roundtable': return runRoundtable(ctx)
    case 'relay':      return runRelay(ctx)
    case 'conductor':  return runConductor(ctx)
    case 'pipeline':
    default:           return runPipeline(ctx)
  }
}
