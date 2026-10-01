// POST /api/openrouter-usage — 사용량을 장부(user_subscriptions)에 올린다 (계약 §3).
//
// 금액은 클라이언트가 보낸 값을 믿지 않는다. OpenRouter 에서 그 키의 이번 달 누적 지출을
// 직접 읽고, 지난번에 올린 지점(period_booked)과의 차이만 더한다. 클라이언트의 토큰 수는
// 표시용 카운터에만 쓴다.
import { json } from '../lib/http'
import { getAuthedUser, selectOne, update, upsert } from '../lib/supabase'
import { lookupKey } from '../lib/openrouter'

type KeyRow = { key_hash: string; period_booked: number; period_month: string | null }
type SubRow = {
  openrouter_usage_date: string | null
  openrouter_tokens_in_today: number; openrouter_tokens_cache_in_today: number; openrouter_tokens_out_today: number
  openrouter_usd_today: number
  openrouter_tokens_in_total: number; openrouter_tokens_cache_in_total: number; openrouter_tokens_out_total: number
  openrouter_usd_total: number
}
const SUB_COLS = 'openrouter_usage_date,openrouter_tokens_in_today,openrouter_tokens_cache_in_today,openrouter_tokens_out_today,openrouter_usd_today,openrouter_tokens_in_total,openrouter_tokens_cache_in_total,openrouter_tokens_out_total,openrouter_usd_total'

const count = (v: unknown) => Math.max(0, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : 0))

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await getAuthedUser(req)
    if (!user) return json(req, { ok: false, error: 'unauthorized' }, 401)

    // 본문이 없거나 JSON 이 아니어도 된다 — 주기 동기화는 {} 로 온다.
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const tokensIn = count(body.tokensIn), tokensCacheIn = count(body.tokensCacheIn), tokensOut = count(body.tokensOut)

    const key = await selectOne<KeyRow>('user_openrouter_keys', user.id, 'key_hash,period_booked,period_month')
    if (!key && tokensIn + tokensCacheIn + tokensOut === 0) return json(req, { ok: true, skipped: true, deltaUsd: 0 })

    const monthDate = `${new Date().toISOString().slice(0, 7)}-01`
    let deltaUsd = 0
    if (key) {
      const lookup = await lookupKey(key.key_hash)
      const periodUsage = lookup.kind === 'ok' ? lookup.info.periodUsage : null
      if (periodUsage !== null) {
        // 달이 바뀌면 OpenRouter 의 월 누적이 0 에서 다시 시작한다.
        const bookedPrev = key.period_month === monthDate ? Number(key.period_booked) || 0 : 0
        deltaUsd = Math.max(0, periodUsage - bookedPrev)
        await update('user_openrouter_keys', user.id, { period_booked: periodUsage, period_month: monthDate })
      }
      // 읽지 못했으면 이번에는 금액을 올리지 않는다 — 다음 동기화가 누적값으로 따라잡는다.
    }

    let sub = await selectOne<SubRow>('user_subscriptions', user.id, SUB_COLS)
    if (!sub) { await upsert('user_subscriptions', { user_id: user.id }); sub = await selectOne<SubRow>('user_subscriptions', user.id, SUB_COLS) }
    const n = (v: unknown) => Number(v) || 0
    // "_today" 컬럼은 이름과 달리 이번 달 누적이다 (키의 limit 이 월 단위라서) — Twixy 와 같은 규약.
    const sameMonth = (sub?.openrouter_usage_date ?? '').slice(0, 7) === monthDate.slice(0, 7)
    const prev = (v: unknown) => (sameMonth ? n(v) : 0)

    await update('user_subscriptions', user.id, {
      openrouter_usage_date:            monthDate,
      openrouter_tokens_in_today:       prev(sub?.openrouter_tokens_in_today) + tokensIn,
      openrouter_tokens_cache_in_today: prev(sub?.openrouter_tokens_cache_in_today) + tokensCacheIn,
      openrouter_tokens_out_today:      prev(sub?.openrouter_tokens_out_today) + tokensOut,
      openrouter_usd_today:             prev(sub?.openrouter_usd_today) + deltaUsd,
      openrouter_tokens_in_total:       n(sub?.openrouter_tokens_in_total) + tokensIn,
      openrouter_tokens_cache_in_total: n(sub?.openrouter_tokens_cache_in_total) + tokensCacheIn,
      openrouter_tokens_out_total:      n(sub?.openrouter_tokens_out_total) + tokensOut,
      openrouter_usd_total:             n(sub?.openrouter_usd_total) + deltaUsd,
      openrouter_synced_at:             new Date().toISOString(),
    })
    return json(req, { ok: true, deltaUsd })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[openrouter-usage]', message)
    return json(req, { ok: false, error: message }, 500)
  }
}
