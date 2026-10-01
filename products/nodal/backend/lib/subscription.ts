import { LIMITS, type Tier, type TierLimits } from './plans'
import { selectOne, upsert, type AuthedUser } from './supabase'

type SubRow = {
  tier: Tier; current_period_end: string | null; usage_date: string
  messages_today: number; tokens_today: number; scheduled_runs_today: number; searches_today: number
}

export type Entitlements = {
  tier: Tier
  currentPeriodEnd: string | null
  limits: TierLimits
  usage: { date: string; messages: number; tokens: number; scheduledRuns: number; searches: number }
}

/** 구독 행을 읽는다. 가입 트리거가 만들지만, 트리거 이전에 생긴 계정을 위해 없으면 만든다. */
export async function loadEntitlements(user: AuthedUser): Promise<Entitlements> {
  const cols = 'tier,current_period_end,usage_date,messages_today,tokens_today,scheduled_runs_today,searches_today'
  let row = await selectOne<SubRow>('user_subscriptions', user.id, cols)
  if (!row) {
    await upsert('user_subscriptions', { user_id: user.id })
    row = await selectOne<SubRow>('user_subscriptions', user.id, cols)
  }
  const today = new Date().toISOString().slice(0, 10)
  // 구독 기간이 끝난 pro 는 free 로 본다 (결제 웹훅이 늦거나 빠져도 과금 없이 pro 가 유지되지 않게).
  const expired = row?.current_period_end ? new Date(row.current_period_end).getTime() < Date.now() : false
  const tier: Tier = row?.tier === 'pro' && !expired ? 'pro' : 'free'
  const fresh = row?.usage_date === today
  return {
    tier,
    currentPeriodEnd: row?.current_period_end ?? null,
    limits: LIMITS[tier],
    usage: {
      date: today,
      messages:      fresh ? row!.messages_today : 0,
      tokens:        fresh ? row!.tokens_today : 0,
      scheduledRuns: fresh ? row!.scheduled_runs_today : 0,
      searches:      fresh ? row!.searches_today : 0,
    },
  }
}
