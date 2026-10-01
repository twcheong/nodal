import { supabase } from './supabase'
import { PRODUCT } from './product'

/**
 * entitlements.ts — Twixy 구독/쿼터 클라이언트 (순수 HTTP + Supabase).
 *
 * Twixy 웹앱의 /api/entitlements, /api/entitlements/record 엔드포인트와 통신.
 * 해당 웹 API 가 Supabase access token 을 검증하고 user_subscriptions, usage_daily
 * 테이블을 읽고 쓴다. Tier/일일 한도의 진리 원본은 웹앱 내부의 limits.ts.
 * 여기서는 라운드트립 없이 UI 에 바/뱃지를 바로 그릴 수 있도록 한도값을 미러링한다.
 *
 * 외부에 노출되는 핵심 함수:
 *   · fetchEntitlements()         — tier/limits/오늘 사용량 조회
 *   · fetchOpenRouterUsageToday() — Supabase 에 직접 질의 (오늘 누적 토큰/USD)
 *   · recordUsage(kind, amount)   — 액션 실행 전 쿼터 선검증 + 기록
 */

// Tier · TierLimits · FREE_PLAN · LIMITS 의 본체는 planLimits.ts (부작용 없는 모듈).
// 이 파일은 supabase 를 import 하므로, 상수만 필요한 쪽(modelPricing 등)은 planLimits 를 직접 import 한다.
import type { Tier, TierLimits } from './planLimits'
export { FREE_PLAN, LIMITS, type Tier, type TierLimits } from './planLimits'

export type OpenRouterUsage = {
  tokensIn:  number
  tokensOut: number
  usdToday:  number
}

// OpenRouter 일일 사용량을 Supabase user_subscriptions 테이블에서 직접 조회.
// 웹 API 경유 없이 RLS 로 보호된 컬럼만 뽑아 바로 사용 — 상태바 즉시 갱신에 유리.
// tokensIn 은 일반 입력 + 캐시 입력을 합산해 "총 프롬프트 토큰" 기준으로 표시.
export async function fetchOpenRouterUsageToday(): Promise<OpenRouterUsage> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { tokensIn: 0, tokensOut: 0, usdToday: 0 }
  const { data } = await supabase
    .from('user_subscriptions')
    .select('openrouter_tokens_in_today, openrouter_tokens_cache_in_today, openrouter_tokens_out_today, openrouter_usd_today')
    .eq('user_id', user.id)
    .maybeSingle()
  return {
    // tokensIn = new (non-cached) + cached — full prompt tokens for display
    tokensIn:  Number(data?.openrouter_tokens_in_today       ?? 0)
             + Number(data?.openrouter_tokens_cache_in_today ?? 0),
    tokensOut: Number(data?.openrouter_tokens_out_today ?? 0),
    usdToday:  Number(data?.openrouter_usd_today        ?? 0),
  }
}

export type UsageSnapshot = {
  date:          string
  messages:      number
  tokens:        number
  scheduledRuns: number
  searches:      number
}

export type Entitlements = {
  tier:             Tier
  currentPeriodEnd: string | null
  limits:           TierLimits
  usage:            UsageSnapshot
}

export type RecordKind = 'message' | 'tokens' | 'scheduled' | 'search'

export type RecordResult =
  | { allowed: true;  tier: Tier; limits: TierLimits; usage: UsageSnapshot }
  | { allowed: false; tier: Tier; limits: TierLimits; usage: UsageSnapshot; reason: string }

const WEB_URL = (typeof window !== 'undefined' && (window as unknown as { TWIXY_WEB_URL?: string }).TWIXY_WEB_URL)
  ?? PRODUCT.webUrl

// Supabase 세션의 access_token 을 Bearer 헤더로 자동 주입하는 fetch 래퍼.
// 세션이 없으면 즉시 throw — 호출자가 로그인 플로우로 유도해야 함.
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('not_authenticated')
  return fetch(`${WEB_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  })
}

export async function fetchEntitlements(): Promise<Entitlements> {
  const res = await authedFetch('/api/entitlements')
  if (!res.ok) {
    throw new Error(`entitlements fetch failed: ${res.status}`)
  }
  const body = await res.json()
  if (!body.ok) throw new Error(body.error ?? 'unknown')
  return {
    tier:             body.tier,
    currentPeriodEnd: body.currentPeriodEnd ?? null,
    limits:           body.limits,
    usage:            body.usage,
  }
}

// 과금성 액션 전 호출. 서버가 "허용 가능 여부 + 갱신된 한도/사용량" 을 응답.
// allowed=false 면 호출자가 UpgradeModal 을 띄우고 액션을 취소해야 한다 (App.tsx 참조).
export async function recordUsage(kind: RecordKind, amount = 1): Promise<RecordResult> {
  const res = await authedFetch('/api/entitlements/record', {
    method: 'POST',
    body: JSON.stringify({ kind, amount }),
  })
  if (!res.ok) {
    throw new Error(`record failed: ${res.status}`)
  }
  const body = await res.json()
  if (!body.ok) throw new Error(body.error ?? 'unknown')
  return body.allowed
    ? { allowed: true,  tier: body.tier, limits: body.limits, usage: body.usage }
    : { allowed: false, tier: body.tier, limits: body.limits, usage: body.usage, reason: body.reason }
}
