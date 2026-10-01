// ── 인증 세션 저장 (main.ts 에서 이동) ──────────────────────────────────────
//
// 웹 로그인 핸드오프(twixy:// 딥링크)로 받은 Supabase 세션의 저장·복호화·갱신과,
// 그 세션을 실어 보내는 fetch 재시도 래퍼.
//
// **가변 상태가 없다** — 세션의 단일 출처는 디스크 파일(paths.ts 의 SESSION_PATH)이고,
// 여기 있는 함수들은 매번 그 파일을 읽는다. 메모리에 캐시하지 않는 것이 의도다:
// 게이트웨이 재기동·토큰 갱신이 파일을 바꾸면 다음 읽기가 곧바로 새 값을 본다.
//
// 주입 2개: `getMainWindow` (갱신된 세션을 렌더러에 밀어 넣는다) 와 `chmod0600`
// (세션 파일 권한 잠금 — 로깅/보안 헬퍼라 main.ts 소유).
import fs from 'node:fs'
import { safeStorage, type BrowserWindow } from 'electron'
import { PRODUCT } from '../shared/product/current.generated'
import { decodeJwtPayload, parseAuthDeeplink, type StoredSession } from './authDeeplink'
import { OPENCLAW_DIR, SESSION_PATH, SESSION_PATH_LEGACY, WEB_URL } from './paths'
import { setSessionReader, SUPABASE_URL, SUPABASE_ANON_KEY } from './pricing'

export interface AuthSessionDeps {
  getMainWindow: () => BrowserWindow | null
  chmod0600: (filePath: string) => void
}

let deps: AuthSessionDeps | null = null

/** main.ts 가 기동 시 1회 호출한다. 안 부르면 첫 세션 저장에서 throw 한다. */
export function initAuthSession(d: AuthSessionDeps): void { deps = d }

function need(): AuthSessionDeps {
  if (!deps) throw new Error('authSession.ts: initAuthSession() 가 먼저 불려야 한다')
  return deps
}

// ── Auth session storage — 세션 저장/로딩 헬퍼 ────────────────────
// safeStorage 로 세션 JSON 을 복호화(암호문 우선, 실패 시 평문으로 읽기 시도).
// 평문 폴백은 (a) safeStorage 미지원 환경에서 우리가 평문으로 저장한 경우와
// (b) 아직 마이그레이션 전 예전 파일을 읽는 경우를 함께 커버한다.
function decodeSessionBuf(buf: Buffer): StoredSession | null {
  // 우선 암호문으로 복호화 시도
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const json = safeStorage.decryptString(buf)
      const parsed = JSON.parse(json) as StoredSession
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { /* 암호문이 아니거나 다른 키 — 평문 파싱으로 폴백 */ }
  }
  // 평문 폴백 (safeStorage 미지원 저장분 또는 예전 평문 파일)
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as StoredSession
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

export function loadSession(): StoredSession | null {
  // 1) 정규 경로(.enc)를 먼저 시도
  try {
    const buf = fs.readFileSync(SESSION_PATH)
    return decodeSessionBuf(buf)
  } catch { /* 없으면 레거시 마이그레이션 시도 */ }

  // 2) 예전 평문 파일이 있으면 읽어서 암호화 저장 후 평문 삭제 (일회성 마이그레이션)
  try {
    const legacyBuf = fs.readFileSync(SESSION_PATH_LEGACY)
    const parsed = decodeSessionBuf(legacyBuf)
    if (parsed) {
      try {
        saveSession(parsed)                       // .enc 로 (암호화) 재기록
        try { fs.unlinkSync(SESSION_PATH_LEGACY) } catch { /* best-effort */ }
      } catch { /* 저장 실패해도 최소한 세션 값은 반환 */ }
    }
    return parsed
  } catch { return null }
}

export function saveSession(s: StoredSession | null) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  if (!s) {
    // 로그아웃/삭제: 정규 파일과 (있으면) 레거시 평문 파일 모두 제거
    try { fs.unlinkSync(SESSION_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(SESSION_PATH_LEGACY) } catch { /* ignore */ }
    return
  }
  const json = JSON.stringify(s, null, 2)
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(json)
    fs.writeFileSync(SESSION_PATH, enc, { mode: 0o600 })
  } else {
    // safeStorage 미지원 폴백 — 평문이지만 소유자 전용 권한 유지
    fs.writeFileSync(SESSION_PATH, json, { mode: 0o600 })
  }
  need().chmod0600(SESSION_PATH)  // Windows 등에서 mode 옵션이 무시될 때 대비 재적용
  // 마이그레이션 이후 남아 있을 수 있는 예전 평문 파일을 정리
  try { fs.unlinkSync(SESSION_PATH_LEGACY) } catch { /* 없으면 무시 */ }
}

// pricing.ts 는 markup 조회에 세션 토큰이 필요하지만 복호화를 모른다. 경로를
// 복제하는 대신 여기 loadSession 을 넘겨 단일 출처로 만든다.
setSessionReader(loadSession)

/**
 * 저장된 refresh_token 으로 새 access_token 을 받아 디스크에 반영한다.
 *
 * 토큰 갱신은 원래 렌더러 몫이다 — supabase-js 가 자동 갱신하고 useAuth 가
 * authSaveSession 으로 디스크에 미러링한다. 문제는 기동 순서다: app.whenReady
 * 는 createWindow 직후 startOpenClaw 를 부르고, 그 안에서 곧바로 디스크의
 * access_token 으로 핸드아웃(OpenRouter 키 / Tavily 토큰)을 받아온다. 렌더러가
 * 뜨고 갱신을 마치기 전이라 토큰이 이미 만료돼 있으면 401 이 떨어지고, 그
 * 결과 게이트웨이가 LLM 키 없이 뜬 채로 이후 모든 요청이 타임아웃한다.
 * 실측(2026-09-06): 19:44:40 기동 시 두 핸드아웃 모두 401, 세션 파일은
 * 19:49:31 에야 갱신됨 — 5분 늦었다. 그래서 main 이 렌더러를 기다리지 않고
 * 스스로 한 번 갱신한다.
 */
export async function refreshStoredSession(): Promise<StoredSession | null> {
  const cur = loadSession()
  if (!cur?.refresh_token) return null
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: cur.refresh_token }),
    })
    if (!res.ok) {
      console.warn(`[twixy/auth] session refresh failed: ${res.status}`)
      return null
    }
    const b = await res.json() as { access_token?: string; refresh_token?: string; expires_at?: number; user?: unknown }
    if (!b.access_token || !b.refresh_token) {
      console.warn('[twixy/auth] session refresh returned no tokens')
      return null
    }
    const next: StoredSession = {
      access_token:  b.access_token,
      refresh_token: b.refresh_token,
      expires_at:    b.expires_at ?? null,
      user:          b.user ?? cur.user,
    }
    saveSession(next)
    // 새 토큰을 렌더러에도 넘긴다. Supabase 는 refresh_token 을 회전시키므로,
    // main 이 갱신한 사실을 모르는 렌더러의 supabase-js 는 폐기된 옛
    // refresh_token 을 계속 들고 있게 된다 → 그쪽이 다음 갱신을 시도할 때
    // 실패해 사용자가 엉뚱하게 로그아웃된다. 딥링크 로그인이 쓰는 경로와
    // 같은 채널로 밀어넣어 supabase.auth.setSession 으로 채택시킨다.
    try { need().getMainWindow()?.webContents.send('auth-session', next) } catch { /* 창이 아직 없다 */ }
    console.log('[twixy/auth] stored session refreshed from main')
    return next
  } catch (err) {
    console.warn('[twixy/auth] session refresh threw:', err)
    return null
  }
}

/**
 * 세션 토큰을 실어 요청하되, 401 이면 토큰을 한 번 갱신해 재시도한다.
 * 세션이 아예 없으면 null (호출부가 "로그인 안 됨" 으로 처리).
 */
export async function fetchWithSessionRetry(
  url: string,
  tag: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response | null> {
  const session = loadSession()
  if (!session?.access_token) return null
  const send = (token: string) => fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  })
  const res = await send(session.access_token)
  if (res.status !== 401) return res
  console.warn(`[${tag}] 401 — 저장된 세션이 만료됐다. 갱신 후 1회 재시도한다.`)
  const next = await refreshStoredSession()
  if (!next) return res
  return await send(next.access_token)
}

// decodeJwtPayload · parseAuthDeeplink 는 authDeeplink.ts (순수 파싱, 테스트 있음).
export function handleAuthDeeplink(url: string) {
  const session = parseAuthDeeplink(url, PRODUCT.protocolScheme)
  if (!session) {
    console.warn('[twixy/auth] ignoring malformed deeplink')
    return
  }
  saveSession(session)
  console.log('[twixy/auth] received session via deeplink')
  // Bring the window forward and notify the renderer.
  const win = need().getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('auth-session', session)
  }
}
