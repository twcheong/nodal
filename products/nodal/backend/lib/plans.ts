// 요금제의 단일 출처 (서버). 데스크톱의 src/lib/entitlements.ts 에 있는 LIMITS 는 UI 가
// 왕복 없이 바를 그리려고 미러링한 표시용 값이다 — 실제 강제는 여기와 OpenRouter 키의 limit.
export type Tier = 'free' | 'pro'

export type TierLimits = {
  messagesPerDay: number
  scheduledJobs:  number
  searchesPerDay: number
  tokensPerDay:   number
}

export const LIMITS: Record<Tier, TierLimits> = {
  free: { messagesPerDay: 25,   scheduledJobs: 0, searchesPerDay: 0, tokensPerDay: 1_780_000 },
  pro:  { messagesPerDay: 2000, scheduledJobs: 0, searchesPerDay: 0, tokensPerDay: 5_000_000 },
}

/** 월 LLM 예산 (고객에게 보이는 USD). OpenRouter 키의 limit 으로 하드 강제된다. */
export function monthlyBudgetUsd(tier: Tier): number {
  const env = tier === 'pro' ? process.env.NODAL_PRO_BUDGET_USD : process.env.NODAL_FREE_BUDGET_USD
  const n = env ? Number(env) : NaN
  return Number.isFinite(n) && n >= 0 ? n : tier === 'pro' ? 5 : 2
}
