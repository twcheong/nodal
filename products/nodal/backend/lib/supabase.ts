// Supabase 접근 — SDK 없이 REST 로. 함수가 작고 콜드스타트가 빠르며 의존성이 없다.
//
//   사용자 권한  apikey = publishable 키, Authorization = 사용자의 access_token → RLS 적용
//   서버 권한    apikey = secret(service role) 키 → RLS 우회. 절대 응답에 싣지 않는다.
function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`server_misconfigured: ${name} not set`)
  return v
}
const url = () => env('SUPABASE_URL').replace(/\/$/, '')

export type AuthedUser = { id: string; email: string | null; token: string }

/** Authorization: Bearer <access_token> 을 Supabase 에 물어 검증한다. 실패하면 null. */
export async function getAuthedUser(req: Request): Promise<AuthedUser | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  if (!m) return null
  const res = await fetch(`${url()}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_PUBLISHABLE_KEY'), Authorization: `Bearer ${m[1]}` },
  })
  if (!res.ok) return null
  const u = (await res.json()) as { id?: string; email?: string | null }
  return u.id ? { id: u.id, email: u.email ?? null, token: m[1] } : null
}

async function rest(path: string, init: RequestInit & { asUser?: AuthedUser }): Promise<Response> {
  const { asUser, headers, ...rest } = init
  return fetch(`${url()}/rest/v1/${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(asUser
        ? { apikey: env('SUPABASE_PUBLISHABLE_KEY'), Authorization: `Bearer ${asUser.token}` }
        : { apikey: env('SUPABASE_SECRET_KEY') }),
      ...(headers as Record<string, string> | undefined),
    },
  })
}

async function must(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`)
  return res
}

const eq = (v: string) => `eq.${encodeURIComponent(v)}`

/** 서버 권한으로 한 행 읽기. 없으면 null. */
export async function selectOne<T>(table: string, userId: string, columns = '*'): Promise<T | null> {
  const res = await must(await rest(`${table}?user_id=${eq(userId)}&select=${columns}&limit=1`, { method: 'GET' }), `select ${table}`)
  const rows = (await res.json()) as T[]
  return rows[0] ?? null
}

/** 서버 권한으로 upsert (user_id 가 PK 인 테이블). */
export async function upsert(table: string, row: Record<string, unknown>): Promise<void> {
  await must(await rest(`${table}?on_conflict=user_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  }), `upsert ${table}`)
}

export async function update(table: string, userId: string, patch: Record<string, unknown>): Promise<void> {
  await must(await rest(`${table}?user_id=${eq(userId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  }), `update ${table}`)
}

export async function remove(table: string, userId: string): Promise<void> {
  await must(await rest(`${table}?user_id=${eq(userId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }), `delete ${table}`)
}

/** 전역 표시 배율 (pricing_config). 고객 예산 ÷ 배율 = 실제 provider 비용 한도. */
export async function displayMarkup(): Promise<number> {
  const res = await rest('pricing_config?select=display_markup&limit=1', { method: 'GET' })
  if (!res.ok) return 1
  const rows = (await res.json()) as Array<{ display_markup?: number }>
  const n = Number(rows[0]?.display_markup)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** 사용자 권한으로 RPC — auth.uid() 가 필요한 함수(record_usage)용. */
export async function rpcAsUser<T>(user: AuthedUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await must(await rest(`rpc/${fn}`, { method: 'POST', asUser: user, body: JSON.stringify(args) }), `rpc ${fn}`)
  return (await res.json()) as T
}
