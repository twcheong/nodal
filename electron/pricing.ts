// ─────────────────────────────────────────────────────────────────────────────
// pricing.ts — display markup 가격 계산 (electron 메인 프로세스 전용).
//
// 핵심 보안 의도: markup 값(곱셈 비율) 이 renderer 번들, React state, DevTools,
// 메모리 인스펙터 어디에도 노출되지 않게 — main process 안에서만 캐시. renderer
// 는 IPC 로 "raw 보내면 marked-up 받음" 만 함. 비율 그 자체는 IPC 응답에 절대
// 포함되지 않음.
//
// 데이터 출처 & lookup 우선순위:
//   1) `user_pricing.markup_multiplier` for current user.id  (per-user override)
//   2) `pricing_config.display_markup`  단일 글로벌 행        (default)
//   3) 둘 다 없거나 fetch 실패  →  error 상태  (renderer 가 raw + "*" 폴백)
// 둘 다 사용자 access_token 으로 PostgREST 직접 호출. RLS 가 본인 행 / 인증된
// 사용자만 read 보장. 추후 회사별로 확장 시 user 보다 위 / pricing_config 보다
// 아래 layer 로 추가.
//
// 정책:
//   - 5분 TTL — 그 안엔 캐시 사용
//   - 행 없음 / fetch 실패 → 에러 상태. renderer 의 DisplayCost 가 raw cost
//     를 폴백 표시 + "* 부정확할 수 있음" 표시. multiplier 가 없을 때 가짜
//     markup 가격을 만들지 않는 게 원칙 — raw 만 보여줌.
//   - 마지막 fetch 가 실패였으면 60초 이상 후 다음 IPC 들어올 때 자동 재시도.
//   - 사용자 로그아웃 / 재로그인 시 `clearMarkupCache()` 호출 (auth 핸들러 측).
// ─────────────────────────────────────────────────────────────────────────────


// 단일 출처는 제품 프로필 (products/<id>/profile.ts) — 렌더러의 src/lib/supabase.ts 도
// 같은 값을 읽는다. anon 키는 공개 안전(실제 보안은 RLS).
import { PRODUCT } from '../shared/product/current.generated'

export const SUPABASE_URL      = PRODUCT.supabase.url
export const SUPABASE_ANON_KEY = PRODUCT.supabase.anonKey

// 세션 읽기는 main.ts 가 주입한다. 예전엔 여기서 직접 파일 경로를 갖고 있었는데
// (`~/.openclaw/session.json`, 평문), 세션 암호화(12718b8)가 저장 경로를
// `twixy-session.json.enc` 로 옮기면서 이 파일은 같이 안 고쳐졌다. 그래서 여기
// 읽기는 늘 실패했고 markup 이 항상 'not signed in' 으로 떨어져 UI 에 ⚠ pricing
// 이 떴다. 경로를 또 복제하면 같은 드리프트가 반복되므로, 복호화까지 아는
// main.ts 의 loadSession 을 주입받는다.
type SessionReader = () => { access_token?: string } | null
let readSession: SessionReader = () => null
/** main.ts 가 기동 시 1회 호출. 주입 전에는 '로그인 전' 으로 동작한다. */
export function setSessionReader(fn: SessionReader): void { readSession = fn }

const TTL_MS         = 5 * 60_000   // 캐시 유효
const RETRY_AFTER_MS = 60_000       // 직전 실패 후 재시도 최소 간격

type Session = { access_token?: string; user?: { id?: string } }

type CacheState =
  | { kind: 'unloaded' }
  | { kind: 'loading' }
  | { kind: 'ready'; multiplier: number; fetchedAt: number }
  | { kind: 'error'; message: string; lastTryAt: number }

let cache: CacheState = { kind: 'unloaded' }
// 동시 fetch 합치기 — IPC 가 빠르게 여러 번 들어올 수 있어 단일 in-flight 프로미스.
let inflight: Promise<void> | null = null

export type MarkupResult =
  | { ok: true;  value: number }
  | { ok: false; error: string }

// 공통 helper — Supabase REST 호출 + numeric 정규화. row 없으면 undefined.
async function fetchMultiplier(
  url: string, accessToken: string,
): Promise<number | undefined> {
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`)
  }
  const rows = await res.json() as Array<Record<string, number | string>>
  if (rows.length === 0) return undefined
  // numeric 컬럼이 JSON string 으로 올 수도 있어 둘 다 처리. 첫 row 의 첫 컬럼만.
  const firstKey = Object.keys(rows[0])[0]
  const raw = rows[0][firstKey]
  const m = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN
  if (!Number.isFinite(m) || m <= 0) return undefined
  return m
}

// 2단계 lookup: user_pricing override → pricing_config default → error.
// HTTP 실패 (네트워크 / RLS) 는 곧바로 error. row 없음 (404 아님, 빈 배열) 은
// 다음 단계로 fallthrough.
async function doFetch(): Promise<void> {
  let session: Session | null = null
  try { session = readSession() } catch { /* 로그인 전 */ }
  if (!session?.access_token) {
    cache = { kind: 'error', message: 'not signed in', lastTryAt: Date.now() }
    return
  }
  const token = session.access_token

  try {
    // 1) per-user override. RLS 가 auth.uid() = user_id 만 통과시키므로 본인 row 만.
    const userM = await fetchMultiplier(
      `${SUPABASE_URL}/rest/v1/user_pricing?select=markup_multiplier&limit=1`,
      token,
    )
    if (userM !== undefined) {
      cache = { kind: 'ready', multiplier: userM, fetchedAt: Date.now() }
      return
    }
    // 2) global default.
    const defaultM = await fetchMultiplier(
      `${SUPABASE_URL}/rest/v1/pricing_config?select=display_markup&limit=1`,
      token,
    )
    if (defaultM !== undefined) {
      cache = { kind: 'ready', multiplier: defaultM, fetchedAt: Date.now() }
      return
    }
    // 3) 둘 다 비었음 — pricing_config 시드 누락 / RLS 차단 등. raw 폴백 신호.
    cache = { kind: 'error', message: 'no pricing rows', lastTryAt: Date.now() }
  } catch (e) {
    cache = { kind: 'error', message: (e as Error)?.message ?? 'fetch failed', lastTryAt: Date.now() }
  }
}

// 외부에서 직접 호출 가능 — App ready 시점 warmup, 또는 사용자가 명시적 재시도.
export async function fetchMarkup(force = false): Promise<void> {
  if (cache.kind === 'ready' && !force) {
    if (Date.now() - cache.fetchedAt < TTL_MS) return
  }
  if (inflight && !force) { await inflight; return }
  cache = { kind: 'loading' }
  inflight = doFetch()
  try { await inflight } finally { inflight = null }
}

// IPC 핸들러가 호출. raw 받아 marked-up 반환. multiplier 자체는 응답에 절대 X.
export async function applyMarkup(rawUsd: number): Promise<MarkupResult> {
  if (typeof rawUsd !== 'number' || !Number.isFinite(rawUsd) || rawUsd < 0) {
    return { ok: false, error: 'invalid input' }
  }
  const needsRefresh =
    cache.kind === 'unloaded' ||
    (cache.kind === 'error' && Date.now() - cache.lastTryAt > RETRY_AFTER_MS) ||
    (cache.kind === 'ready' && Date.now() - cache.fetchedAt > TTL_MS)
  if (needsRefresh) await fetchMarkup()
  if (cache.kind === 'ready') return { ok: true, value: rawUsd * cache.multiplier }
  return { ok: false, error: cache.kind === 'error' ? cache.message : 'pricing not ready' }
}

// auth 변경 시 호출 — 다른 사용자로 전환되면 캐시된 multiplier 가 오답이 됨.
export function clearMarkupCache(): void {
  cache = { kind: 'unloaded' }
  inflight = null
}
