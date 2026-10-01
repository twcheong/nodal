// ── 인증 딥링크·JWT 의 순수 파싱 (electron import 없음) ─────────────────────────
// main.ts 에서 옮겨 온 것 (동작 동일). 여기엔 **문자열 → 값** 만 둔다. 세션 암호화 저장,
// 토큰 갱신, IPC, OS 딥링크 등록(setAsDefaultProtocolClient / open-url / second-instance)은
// main.ts 에 남아 있다 — 그쪽은 B2(auth 서비스) 범위.
//
// 옮기면서 바뀐 것은 하나: 제품 스킴을 PRODUCT 전역에서 읽지 않고 인자로 받는다.
// 어느 제품으로 빌드됐는지와 무관하게 테스트할 수 있어야 해서다.

export type StoredSession = {
  access_token:  string
  refresh_token: string
  expires_at?:   number | null
  user?:         unknown
}

/** Decode the payload of a JWT (Supabase access_token). No signature
 *  verification — we only use this to extract `sub` / `email` for local
 *  identity. The token itself is already trusted (we accepted it via the
 *  loopback deeplink handler).
 *
 *  Returns null on any parse error so callers can fall back gracefully.
 */
export function decodeJwtPayload(token: string): { sub?: string; email?: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    // base64url → base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    const json = Buffer.from(b64, 'base64').toString('utf8')
    const payload = JSON.parse(json) as { sub?: string; email?: string }
    return { sub: payload.sub, email: payload.email }
  } catch {
    return null
  }
}

/**
 * Parse a `<scheme>://auth#access_token=...&refresh_token=...&expires_at=...`
 * deeplink. Returns null if the URL is malformed or missing required tokens.
 */
export function parseAuthDeeplink(url: string, protocolScheme: string): StoredSession | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${protocolScheme}:`) return null
    // Tokens live in the hash fragment so they don't get logged by HTTP servers.
    const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
    const params = new URLSearchParams(hash || u.search.replace(/^\?/, ''))
    const access  = params.get('access_token')
    const refresh = params.get('refresh_token')
    if (!access || !refresh) return null
    const expRaw = params.get('expires_at')
    const exp = expRaw && !isNaN(Number(expRaw)) ? Number(expRaw) : null
    // Decode the JWT immediately so currentActor() has a stable uid even if
    // os.hostname() later changes (Mac sleep/network/system-update can flip
    // it). Without this we fall back to a hostname-based hash and the user's
    // workspace directory silently moves.
    const claims = decodeJwtPayload(access)
    const user = claims?.sub ? { id: claims.sub, email: claims.email } : undefined
    return { access_token: access, refresh_token: refresh, expires_at: exp, user }
  } catch {
    return null
  }
}
