// @vitest-environment node
// 백엔드 API — Supabase 와 OpenRouter 를 가짜 fetch 로 바꿔 분기들을 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as getKey } from './api/openrouter-key'
import { POST as postUsage } from './api/openrouter-usage'
import { GET as getEntitlements } from './api/entitlements'
import { POST as recordUsage } from './api/entitlements/record'

const MONTH = `${new Date().toISOString().slice(0, 7)}-01`
const TODAY = new Date().toISOString().slice(0, 10)

type Db = {
  sub: Record<string, unknown> | null
  key: Record<string, unknown> | null
  markup: number
}
type Or = { keys: Record<string, { limit: number; usage_monthly: number; disabled?: boolean }>; minted: Array<Record<string, unknown>>; deleted: string[]; down?: boolean }

let db: Db
let or: Or
let validToken = 'good'

function res(body: unknown, status = 200) {
  // 204 는 본문을 가질 수 없다 (Response 생성자가 던진다) — PostgREST 의 return=minimal 과 같다.
  if (status === 204 || body === null) return new Response(null, { status })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://sb.test'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub'
  process.env.SUPABASE_SECRET_KEY = 'SECRET'
  process.env.OPENROUTER_PROVISIONING_KEY = 'PROV'
  db = { sub: { tier: 'free', current_period_end: null, usage_date: TODAY, messages_today: 0, tokens_today: 0, scheduled_runs_today: 0, searches_today: 0 }, key: null, markup: 1 }
  or = { keys: {}, minted: [], deleted: [] }
  vi.spyOn(console, 'error').mockImplementation(() => {})

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = init.body ? JSON.parse(String(init.body)) : undefined

    if (url === 'https://sb.test/auth/v1/user') {
      return headers.Authorization === `Bearer ${validToken}` ? res({ id: 'user-1234-5678', email: 'a@b.c' }) : res({}, 401)
    }
    if (url.startsWith('https://sb.test/rest/v1/')) {
      const path = url.slice('https://sb.test/rest/v1/'.length)
      const table = path.split('?')[0]
      if (table === 'pricing_config') return res([{ display_markup: db.markup }])
      if (table === 'rpc/record_usage') {
        expect(headers.Authorization).toBe(`Bearer ${validToken}`)   // auth.uid() 가 필요 — 사용자 토큰으로
        const s = db.sub as Record<string, number>
        if (body.p_kind === 'message') s.messages_today += body.p_amount
        return res([{ date: TODAY, messages: s.messages_today, tokens: 0, scheduled_runs: 0, searches: 0 }])
      }
      expect(headers.apikey).toBe('SECRET')                          // 그 밖의 DB 접근은 서버 권한
      const slot = table === 'user_subscriptions' ? 'sub' : 'key'
      if (method === 'GET') return res(db[slot] ? [db[slot]] : [])
      if (method === 'POST') { db[slot] = { ...(db[slot] ?? {}), ...body }; return res(null, 201) }
      if (method === 'PATCH') { if (db[slot]) db[slot] = { ...db[slot], ...body }; return res(null, 204) }
      if (method === 'DELETE') { db[slot] = null; return res(null, 204) }
    }
    if (url.startsWith('https://openrouter.ai/api/v1/keys')) {
      if (or.down) return res({}, 503)
      const hash = url.split('/keys/')[1]
      if (!hash && method === 'POST') {
        or.minted.push(body)
        const h = `hash${or.minted.length}`
        or.keys[h] = { limit: body.limit, usage_monthly: 0 }
        return res({ key: `sk-or-${h}`, data: { hash: h } })
      }
      if (method === 'DELETE') { or.deleted.push(hash); delete or.keys[hash]; return res({}) }
      if (method === 'PATCH') { if (or.keys[hash]) or.keys[hash].limit = body.limit; return res({}) }
      const k = or.keys[hash]
      return k ? res({ data: { limit: k.limit, usage_monthly: k.usage_monthly, byok_usage_monthly: 0, limit_remaining: k.limit - k.usage_monthly, disabled: !!k.disabled } }) : res({}, 404)
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`https://nodal.test${path}`, { ...init, headers: { authorization: `Bearer ${init.token ?? 'good'}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } })
const future = () => new Date(Date.now() + 20 * 86_400_000).toISOString()

describe('GET /api/openrouter-key', () => {
  it('rejects a bad token', async () => {
    expect((await getKey(call('/api/openrouter-key', { token: 'bad' }))).status).toBe(401)
  })

  it('mints a monthly-capped key for a new user and stores it server-side', async () => {
    const r = await getKey(call('/api/openrouter-key'))
    const body = await r.json()
    expect(body).toMatchObject({ ok: true, apiKey: 'sk-or-hash1', baseUrl: 'https://openrouter.ai/api/v1', reused: false, tier: 'free' })
    expect(or.minted[0]).toMatchObject({ limit: 2, limit_reset: 'monthly', include_byok_in_limit: true })
    expect(String(or.minted[0].name)).toMatch(/^nodal:user-123:/)
    expect(db.key).toMatchObject({ api_key: 'sk-or-hash1', key_hash: 'hash1', period_booked: 0 })
  })

  it('creates the key in the Nodal OpenRouter workspace when OPENROUTER_WORKSPACE_ID is set', async () => {
    await getKey(call('/api/openrouter-key'))
    expect(or.minted[0]).not.toHaveProperty('workspace_id')   // 미설정 → 조직 기본 워크스페이스
    process.env.OPENROUTER_WORKSPACE_ID = '11111111-2222-3333-4444-555555555555'
    try {
      db.key = null
      await getKey(call('/api/openrouter-key'))
      expect(or.minted[1]).toMatchObject({ workspace_id: '11111111-2222-3333-4444-555555555555' })
    } finally {
      delete process.env.OPENROUTER_WORKSPACE_ID
    }
  })

  it('divides the customer budget by the display markup', async () => {
    db.markup = 2
    await getKey(call('/api/openrouter-key'))
    expect(or.minted[0].limit).toBe(1)
  })

  it('reuses the stored key instead of minting on every launch', async () => {
    or.keys.h = { limit: 2, usage_monthly: 0.5 }
    db.key = { api_key: 'sk-or-h', key_hash: 'h', usd_limit: 2, expires_at: future() }
    const body = await (await getKey(call('/api/openrouter-key'))).json()
    expect(body).toMatchObject({ ok: true, apiKey: 'sk-or-h', reused: true })
    expect(or.minted).toHaveLength(0)
  })

  it('answers 402 rather than handing out an exhausted key', async () => {
    or.keys.h = { limit: 2, usage_monthly: 2 }
    db.key = { api_key: 'sk-or-h', key_hash: 'h', usd_limit: 2, expires_at: future() }
    const r = await getKey(call('/api/openrouter-key'))
    expect(r.status).toBe(402)
    expect(await r.json()).toMatchObject({ ok: false, error: 'limit_reached' })
  })

  it('raises the cap on the same key when the plan changes — a new key would reset this month’s spend', async () => {
    db.sub!.tier = 'pro'
    or.keys.h = { limit: 2, usage_monthly: 1.9 }
    db.key = { api_key: 'sk-or-h', key_hash: 'h', usd_limit: 2, expires_at: future() }
    const body = await (await getKey(call('/api/openrouter-key'))).json()
    expect(body).toMatchObject({ ok: true, apiKey: 'sk-or-h', reused: true, tier: 'pro' })
    expect(or.keys.h.limit).toBe(5)
    expect(or.minted).toHaveLength(0)
  })

  it('treats an expired pro subscription as free', async () => {
    db.sub = { ...db.sub, tier: 'pro', current_period_end: '2020-01-01T00:00:00Z' }
    await getKey(call('/api/openrouter-key'))
    expect(or.minted[0].limit).toBe(2)
  })

  it('re-mints when OpenRouter no longer has the key', async () => {
    db.key = { api_key: 'sk-or-gone', key_hash: 'gone', usd_limit: 2, expires_at: future() }
    const body = await (await getKey(call('/api/openrouter-key'))).json()
    expect(body).toMatchObject({ ok: true, apiKey: 'sk-or-hash1', reused: false })
  })

  it('keeps the existing key when OpenRouter is briefly unreachable', async () => {
    or.down = true
    db.key = { api_key: 'sk-or-h', key_hash: 'h', usd_limit: 2, expires_at: future() }
    expect(await (await getKey(call('/api/openrouter-key'))).json()).toMatchObject({ ok: true, apiKey: 'sk-or-h' })
  })

  it('never leaks the server secret in a response', async () => {
    const text = await (await getKey(call('/api/openrouter-key'))).text()
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('PROV')
  })
})

describe('POST /api/openrouter-usage', () => {
  const usage = (b: unknown) => postUsage(call('/api/openrouter-usage', { method: 'POST', body: JSON.stringify(b) }))

  it('books only the increase since the last sync, from OpenRouter’s own number', async () => {
    or.keys.h = { limit: 2, usage_monthly: 0.30 }
    db.key = { key_hash: 'h', period_booked: 0.10, period_month: MONTH }
    db.sub = { ...db.sub, openrouter_usage_date: MONTH, openrouter_usd_today: 0.10, openrouter_usd_total: 5 }
    // 클라이언트가 부풀린 금액을 보내도 무시한다.
    const body = await (await usage({ tokensIn: 100, tokensOut: 20, usdDelta: 999, usdActual: 999 })).json()
    expect(body.deltaUsd).toBeCloseTo(0.20)
    expect(Number(db.sub!.openrouter_usd_today)).toBeCloseTo(0.30)
    expect(Number(db.sub!.openrouter_usd_total)).toBeCloseTo(5.20)
    expect(db.sub!.openrouter_tokens_in_today).toBe(100)
    expect(db.key!.period_booked).toBe(0.30)
  })

  it('does not double-count when called twice with no new spend', async () => {
    or.keys.h = { limit: 2, usage_monthly: 0.30 }
    db.key = { key_hash: 'h', period_booked: 0, period_month: MONTH }
    await usage({}); const second = await (await usage({})).json()
    expect(second.deltaUsd).toBe(0)
    expect(Number(db.sub!.openrouter_usd_today)).toBeCloseTo(0.30)
  })

  it('starts the month from zero', async () => {
    or.keys.h = { limit: 2, usage_monthly: 0.05 }
    db.key = { key_hash: 'h', period_booked: 1.80, period_month: '2020-01-01' }
    db.sub = { ...db.sub, openrouter_usage_date: '2020-01-01', openrouter_usd_today: 1.80, openrouter_usd_total: 1.80 }
    const body = await (await usage({})).json()
    expect(body.deltaUsd).toBeCloseTo(0.05)
    expect(Number(db.sub!.openrouter_usd_today)).toBeCloseTo(0.05)   // 지난달 값을 이어 더하지 않는다
    expect(Number(db.sub!.openrouter_usd_total)).toBeCloseTo(1.85)
  })

  it('books nothing when OpenRouter cannot be read — the next sync catches up', async () => {
    or.down = true
    db.key = { key_hash: 'h', period_booked: 0.10, period_month: MONTH }
    const body = await (await usage({ tokensIn: 5 })).json()
    expect(body).toMatchObject({ ok: true, deltaUsd: 0 })
    expect(db.key!.period_booked).toBe(0.10)
  })

  it('accepts an empty body', async () => {
    const r = await postUsage(call('/api/openrouter-usage', { method: 'POST' }))
    expect(await r.json()).toMatchObject({ ok: true, skipped: true })
  })
})

describe('entitlements', () => {
  it('returns tier, limits and today’s usage, resetting a stale day', async () => {
    db.sub = { ...db.sub, usage_date: '2020-01-01', messages_today: 24 }
    const body = await (await getEntitlements(call('/api/entitlements'))).json()
    expect(body).toMatchObject({ tier: 'free', limits: { messagesPerDay: 25 }, usage: { date: TODAY, messages: 0 } })
  })

  it('records a message and blocks the one over the daily limit', async () => {
    db.sub!.messages_today = 24
    const rec = () => recordUsage(call('/api/entitlements/record', { method: 'POST', body: JSON.stringify({ kind: 'message' }) }))
    expect(await (await rec()).json()).toMatchObject({ allowed: true, usage: { messages: 25 } })
    expect(await (await rec()).json()).toMatchObject({ allowed: false, reason: 'limit_exceeded' })
    expect(db.sub!.messages_today).toBe(25)
  })

  it('rejects unknown kinds', async () => {
    const r = await recordUsage(call('/api/entitlements/record', { method: 'POST', body: JSON.stringify({ kind: 'gpu' }) }))
    expect(r.status).toBe(400)
  })

  it('lets the packaged app (Origin: null) call it, but not an arbitrary website', async () => {
    const ok = await getEntitlements(call('/api/entitlements', { headers: { origin: 'null' } }))
    expect(ok.headers.get('access-control-allow-origin')).toBe('null')
    const no = await getEntitlements(call('/api/entitlements', { headers: { origin: 'https://evil.example' } }))
    expect(no.headers.get('access-control-allow-origin')).toBeNull()
  })
})
