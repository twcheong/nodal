// OpenRouter 키 프로비저닝. 사용자마다 키를 하나 발급하고 limit 으로 월 지출을 하드 강제한다.
// 함정은 docs/CREDIT_LIMIT_INCIDENT_2026-08-08.md: limit 은 "기간 누적 지출 상한" 이고,
// usage(전 기간)와 usage_monthly(이번 달)는 다른 값이다.
const KEYS_URL = 'https://openrouter.ai/api/v1/keys'

function provisioningKey(): string {
  const k = process.env.OPENROUTER_PROVISIONING_KEY
  if (!k) throw new Error('server_misconfigured: OPENROUTER_PROVISIONING_KEY not set')
  return k
}
const auth = () => ({ Authorization: `Bearer ${provisioningKey()}`, 'content-type': 'application/json' })

// OpenRouter 워크스페이스 — Nodal 은 Twixy 와 같은 조직의 "nodal" 워크스페이스에 키를 만든다.
// 비워 두면 조직의 기본 워크스페이스(= Twixy 쪽)에 생겨 비용·키 목록이 섞인다.
const workspaceId = () => process.env.OPENROUTER_WORKSPACE_ID?.trim() || undefined

export type KeyInfo = {
  limit: number | null
  limitRemaining: number | null
  disabled: boolean
  /** limit_reset=monthly 키의 이번 달 누적 지출 (BYOK 분 포함). 읽지 못하면 null. */
  periodUsage: number | null
}
export type KeyLookup = { kind: 'ok'; info: KeyInfo } | { kind: 'not_found' } | { kind: 'error' }

export async function lookupKey(hash: string): Promise<KeyLookup> {
  try {
    const res = await fetch(`${KEYS_URL}/${hash}`, { headers: auth() })
    if (res.status === 404) return { kind: 'not_found' }
    if (!res.ok) return { kind: 'error' }
    const d = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {}
    const num = (v: unknown) => (typeof v === 'number' ? v : null)
    const base = num(d.usage_monthly), byok = num(d.byok_usage_monthly)
    return { kind: 'ok', info: {
      limit: num(d.limit),
      limitRemaining: num(d.limit_remaining),
      disabled: d.disabled === true,
      periodUsage: base === null && byok === null ? null : (base ?? 0) + (byok ?? 0),
    } }
  } catch { return { kind: 'error' } }
}

export async function mintKey(opts: { name: string; limitUsd: number; expiresAt: Date }): Promise<{ key: string; hash: string }> {
  const res = await fetch(KEYS_URL, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      name: opts.name, limit: opts.limitUsd, limit_reset: 'monthly',
      expires_at: opts.expiresAt.toISOString(), include_byok_in_limit: true,
      ...(workspaceId() ? { workspace_id: workspaceId() } : {}),
    }),
  })
  if (!res.ok) throw new Error(`openrouter_create_failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`)
  const body = (await res.json()) as { key?: string; data?: { hash?: string } }
  if (!body.key || !body.data?.hash) throw new Error('openrouter_no_key_in_response')
  return { key: body.key, hash: body.data.hash }
}

export async function patchKeyLimit(hash: string, limitUsd: number): Promise<boolean> {
  try {
    const res = await fetch(`${KEYS_URL}/${hash}`, {
      method: 'PATCH', headers: auth(),
      body: JSON.stringify({ limit: limitUsd, disabled: limitUsd <= 0, include_byok_in_limit: true }),
    })
    return res.ok
  } catch { return false }
}

export async function deleteKey(hash: string): Promise<void> {
  try { await fetch(`${KEYS_URL}/${hash}`, { method: 'DELETE', headers: auth() }) } catch { /* best-effort */ }
}
