// GET /api/openrouter-key — 사용자별 OpenRouter 키 발급/재사용 (docs/BACKEND_CONTRACT.md §2).
// 과금 한도의 실제 강제는 이 키의 limit 이다 (월 리셋).
import { json } from '../lib/http'
import { monthlyBudgetUsd } from '../lib/plans'
import { loadEntitlements } from '../lib/subscription'
import { displayMarkup, getAuthedUser, remove, selectOne, update, upsert } from '../lib/supabase'
import { deleteKey, lookupKey, mintKey, patchKeyLimit } from '../lib/openrouter'

const DAY_MS = 86_400_000
const KEY_TTL_DAYS = 31
const EXPIRY_BUFFER_MS = 10 * 60_000   // 만료가 이보다 가까우면 재사용하지 않는다
const BASE_URL = 'https://openrouter.ai/api/v1'

type KeyRow = { api_key: string; key_hash: string; usd_limit: number; expires_at: string | null }

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await getAuthedUser(req)
    if (!user) return json(req, { ok: false, error: 'unauthorized' }, 401)

    const { tier } = await loadEntitlements(user)
    const budget = monthlyBudgetUsd(tier)
    // 고객에게 보이는 예산 ÷ 표시 배율 = provider 에 실제로 나가는 비용의 상한.
    const limit = Number((budget / (await displayMarkup())).toFixed(6))
    if (limit <= 0) {
      return json(req, { ok: false, error: 'no_credit', message: 'This plan has no LLM budget.' }, 402)
    }

    const row = await selectOne<KeyRow>('user_openrouter_keys', user.id, 'api_key,key_hash,usd_limit,expires_at')
    const expiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : 0

    if (row && expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      const lookup = await lookupKey(row.key_hash)
      if (lookup.kind === 'ok') {
        // 요금제가 바뀌었으면 같은 키의 한도만 고친다 — 키를 새로 만들면 이번 달 누적 지출이
        // 0 으로 돌아가 한도를 두 번 쓰게 된다.
        if (Number(row.usd_limit) !== limit && await patchKeyLimit(row.key_hash, limit)) {
          await update('user_openrouter_keys', user.id, { usd_limit: limit, updated_at: new Date().toISOString() })
        }
        const spent = lookup.info.periodUsage ?? 0
        if (lookup.info.disabled || spent >= limit) {
          // 쓸 수 없는 키를 주지 않는다: 모든 요청이 원인 모를 provider 오류로 실패한다.
          return json(req, { ok: false, error: 'limit_reached', message: `This month's LLM budget ($${budget.toFixed(2)}) is used up.` }, 402)
        }
        return json(req, { ok: true, apiKey: row.api_key, baseUrl: BASE_URL, expiresAt, tier, monthlyBudgetUsd: budget, reused: true })
      }
      // OpenRouter 가 잠깐 답하지 않는 것만으로 키를 버리지 않는다 — 가진 키를 그대로 준다.
      if (lookup.kind === 'error') {
        return json(req, { ok: true, apiKey: row.api_key, baseUrl: BASE_URL, expiresAt, tier, monthlyBudgetUsd: budget, reused: true })
      }
      // not_found — OpenRouter 쪽에서 지워졌다. 아래에서 새로 만든다.
    } else if (row) {
      await deleteKey(row.key_hash)
    }

    const newExpiry = new Date(Date.now() + KEY_TTL_DAYS * DAY_MS)
    const minted = await mintKey({
      name: `nodal:${user.id.slice(0, 8)}:${new Date().toISOString().slice(0, 10)}`,
      limitUsd: limit,
      expiresAt: newExpiry,
    })
    if (row) await remove('user_openrouter_keys', user.id)
    await upsert('user_openrouter_keys', {
      user_id: user.id, api_key: minted.key, key_hash: minted.hash, usd_limit: limit,
      expires_at: newExpiry.toISOString(),
      // 새 키의 누적 지출은 0 에서 시작한다 — 워터마크도 같이 되돌린다.
      period_booked: 0, period_month: null,
      updated_at: new Date().toISOString(),
    })
    return json(req, { ok: true, apiKey: minted.key, baseUrl: BASE_URL, expiresAt: newExpiry.getTime(), tier, monthlyBudgetUsd: budget, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[openrouter-key]', message)
    return json(req, { ok: false, error: message }, message.startsWith('openrouter_') ? 502 : 500)
  }
}
