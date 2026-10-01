// ─────────────────────────────────────────────────────────────────────────────
// planLimits.ts — 플랜 한도·Free 플랜 단가 상수. **부작용 없는 모듈로 유지할 것.**
//
// entitlements.ts 에 있던 것을 그대로 옮겼다. entitlements.ts 는 최상위에서 supabase.ts 를
// import 하고, supabase.ts 는 import 되는 순간 createClient({ persistSession, autoRefreshToken })
// 를 실행한다. modelPricing 이 FREE_PLAN 상수 하나 때문에 entitlements 를 import 해서
//   TestOverlay → useDisplayUsd → modelPricing → entitlements → supabase → SDK 전체
// 로 이어졌고, 워크플로 테스트 overlay 창이 비용 문자열을 찍으려고 **두 번째 Supabase auth
// 클라이언트** 를 만들고 있었다 (메인 창과 같은 저장소의 refresh token 을 두고 경합할 수 있다).
//
// ⚠ 여기에 supabase / window.twixy / fetch 를 쓰는 코드를 넣지 말 것 — 보조 창들이 다시 묶인다.
//   확인: node scripts/measure-initial-js.mjs --contains GoTrueClient
// 기존 import 경로 호환을 위해 entitlements.ts 가 전부 재-export 한다.
// ─────────────────────────────────────────────────────────────────────────────

export type Tier = 'free' | 'pro'

export type TierLimits = {
  messagesPerDay: number
  scheduledJobs:  number
  searchesPerDay: number
  // Twixy-mode only: per-day cap on tokens billed through the hosted
  // OpenAI proxy. BYOK mode bypasses this entirely.
  tokensPerDay:   number
}

// ── Twixy 호스팅 Free 플랜 설정 (클라 전용, 쉽게 수정) ──
// 현재 모델: openai/gpt-5.4-mini (OpenRouter 경유)
//   Input:  $0.75 / M tokens
//   Output: $4.50 / M tokens
//
// tokensPerMonth(심볼명은 legacy — 실제로는 "일일" 토큰 상한) 은 monthlyBudgetUsd
// (= 일일 USD 캡, 아래 참조) 에서 역산 — 입력 90% / 출력 10% 비율 가정.
// (시스템 프롬프트 + 대화 히스토리가 토큰 지출의 대부분을 차지하는 컨텍스트 중심 챗 기준)
//   blended = (0.9 × $0.75 + 0.1 × $4.50) / 1M = $1.125 / 1M
//   $2.00 / ($1.125/1M) ≈ 1,777,778  →  1만 단위 반올림 = 1,780,000
//
// 실제 쿼터 강제는 OpenRouter 키의 USD 캡($2/day, limit_reset: daily + 24h TTL) 이 담당 — 여기 수치는 표시용.
// (근거: electron/main.ts 의 fetchOpenRouterHandout 주석 "limit (USD/day) + limit_reset: daily".)
// (프로그레스바 상한을 합리적으로 잡기 위함)
// LIMITS 보다 먼저 선언해야 LIMITS.free.tokensPerDay 가 참조 가능.
export const FREE_PLAN = (() => {
  const model               = 'openai/gpt-5.4-mini'
  const inputPricePerMTok   = 0.75   // $ per million input tokens
  const outputPricePerMTok  = 4.50   // $ per million output tokens
  const monthlyBudgetUsd    = 2.00   // hard limit enforced by OpenRouter key cap — DAILY (limit_reset: daily + 24h TTL, per electron/main.ts:1472-1476). NOTE: 심볼명은 "monthly" 지만 실제 캡은 일일이다 — UI(StatusBar/SettingsPanel)가 usdToday 를 이 값으로 나눠 예산 바를 그린다. 렌더러 전역 rename 을 피하려 레거시 이름 유지(리네임은 renderer 후속 작업으로 플래그).
  // Cached tokens (cacheRead in sessions.usage) are billed at 25% of the
  // normal input price — OpenAI charges 75% off for cache hits.
  const cacheReadDiscount   = 0.25
  const blendedPricePerTok  = (0.9 * inputPricePerMTok + 0.1 * outputPricePerMTok) / 1_000_000
  const tokensPerMonth      = Math.round(monthlyBudgetUsd / blendedPricePerTok / 10_000) * 10_000
  return { model, inputPricePerMTok, outputPricePerMTok, cacheReadDiscount, monthlyBudgetUsd, tokensPerMonth }
})()

export const LIMITS: Record<Tier, TierLimits> = {
  free: { messagesPerDay: 25,   scheduledJobs: 2,  searchesPerDay: 25,  tokensPerDay: FREE_PLAN.tokensPerMonth },
  pro:  { messagesPerDay: 2000, scheduledJobs: 50, searchesPerDay: 500, tokensPerDay: 5_000_000               },
}
