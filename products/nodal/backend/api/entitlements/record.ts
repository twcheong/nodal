// POST /api/entitlements/record — 액션 전에 쿼터를 확인하고 기록한다 (계약 §4).
import { json, preflight } from '../../lib/http'
import { loadEntitlements } from '../../lib/subscription'
import { getAuthedUser, rpcAsUser } from '../../lib/supabase'

export const OPTIONS = preflight

const KINDS = ['message', 'tokens', 'scheduled', 'search'] as const
type Kind = (typeof KINDS)[number]
type UsageRow = { date: string; messages: number; tokens: number; scheduled_runs: number; searches: number }

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await getAuthedUser(req)
    if (!user) return json(req, { ok: false, error: 'unauthorized' }, 401)

    const body = (await req.json().catch(() => null)) as { kind?: string; amount?: number } | null
    if (!body) return json(req, { ok: false, error: 'invalid_json' }, 400)
    const kind = body.kind as Kind
    if (!KINDS.includes(kind)) return json(req, { ok: false, error: 'invalid_kind' }, 400)
    const amount = Math.max(1, Math.floor(Number(body.amount) || 1))

    const before = await loadEntitlements(user)
    const { limits, usage, tier } = before
    const over =
      (kind === 'message'   && usage.messages      + amount > limits.messagesPerDay) ||
      (kind === 'scheduled' && usage.scheduledRuns + amount > limits.scheduledJobs)  ||
      (kind === 'search'    && usage.searches      + amount > limits.searchesPerDay)
    if (over) return json(req, { ok: true, allowed: false, reason: 'limit_exceeded', tier, limits, usage })

    // 증가는 DB 함수가 원자적으로 한다 (auth.uid() 기준 — 사용자 토큰으로 호출).
    const rows = await rpcAsUser<UsageRow[]>(user, 'record_usage', { p_kind: kind, p_amount: amount })
    const r = rows[0]
    return json(req, {
      ok: true, allowed: true, tier, limits,
      usage: r ? { date: r.date, messages: r.messages, tokens: r.tokens, scheduledRuns: r.scheduled_runs, searches: r.searches } : usage,
    })
  } catch (err) {
    return json(req, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
}
