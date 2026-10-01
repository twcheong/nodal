// ── 자격증명 핸드아웃 (main.ts 에서 이동) ───────────────────────────────────
//
// Twixy 서버가 진짜 키를 쥐고, 데스크톱은 **사용자 앞으로 발급된 단기 자격증명**만
// 받아 게이트웨이에 주입한다. 이 모듈이 그 발급·캐시·갱신을 전부 소유한다.
//
//   · Tavily 프록시 토큰 (웹 검색)
//   · OpenRouter 사용자 전용 키 (Twixy 호스팅 모드)
//   · OpenRouter 사용량 동기화 타이머
//   · 세션 중 키 재발급 + openclaw.json 핫패치
//
// **상태 소유권**: 핸드아웃 캐시·복구 카운터·prevUsdActual 은 여기 있는 것이
// 유일한 저장소다. main.ts 는 아래 접근자로만 읽고 쓴다 (Stage 4 슬라이스 6).
// 캐시를 두 군데 두면 "로그아웃했는데 옛 키로 계속 청구된다" 가 된다.
//
// 게이트웨이 자식 프로세스는 반대로 **main.ts 소유**다 — 여기서는
// getGatewayProcess()/clearGatewayProcess() 로만 만진다.
import fs from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import type { StoredSession } from './authDeeplink'

// Single source for model catalog — main.ts 와 같은 파일을 읽는다.
const modelCatalog = require('../modelCatalog.json') as { models: unknown[] }

export interface KeyHandoutDeps {
  webUrl: string
  configPath: string
  loadSession: () => StoredSession | null
  loadTwixyMode: () => 'twixy' | 'byok'
  fetchWithSessionRetry: (
    url: string,
    tag: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<Response | null>
  chmod0600: (filePath: string) => void
  /** 게이트웨이 기동 — 키 재발급 뒤 env 동기화를 위해 재시작한다. */
  startOpenClaw: () => Promise<unknown>
  getGatewayProcess: () => ChildProcess | null
  clearGatewayProcess: () => void
}

let deps: KeyHandoutDeps | null = null

/** main.ts 가 기동 시 1회 호출한다. 안 부르면 첫 핸드아웃에서 throw 한다. */
export function initKeyHandout(d: KeyHandoutDeps): void { deps = d }

function need(): KeyHandoutDeps {
  if (!deps) throw new Error('keyHandout.ts: initKeyHandout() 가 먼저 불려야 한다')
  return deps
}

let usageSyncTimer:  ReturnType<typeof setInterval> | null = null   // OpenRouter 사용량 동기화 타이머
// OpenRouter 키 엔드포인트의 usdActual(실결제 누적액) 마지막 값.
// 토큰 연산이 아닌 "실제 청구 증분" 델타를 Supabase 에 기록하기 위해 필요.
let prevUsdActual: number = 0

// ── Tavily proxy-token handout — 웹 검색 토큰 발급 ───────────────
// Twixy 서버가 공식 Tavily 검색 키를 소유하고, 클라이언트는 사용자 쿠키/토큰으로
// 단기 프록시 토큰을 받아 OpenClaw 의 webSearch 툴에 주입한다.
// 이 토큰은 사용량 쿼터를 서버 측에서 강제하기 위해 단기 만료로 발급됨.
// We intentionally do NOT ship the real Tavily API key inside the desktop
// build. Instead, the main process asks the web app for a SIGNED PROXY
// TOKEN right before spawning OpenClaw, using the signed-in user's
// Supabase bearer token. We then inject:
//
//   TAVILY_API_KEY  = <signed proxy token>      (NOT the real key)
//   TAVILY_BASE_URL = https://twixy.dev/api/tavily-proxy
//
// into the gateway subprocess env. OpenClaw's tavily provider sends the
// proxy token as `Authorization: Bearer <token>` to our proxy URL. The
// proxy verifies the token, applies daily quota, then forwards to the
// real api.tavily.com using the master key that lives only in server env.
//
// Security wins:
//   - Real Tavily key never touches the user's machine (disk OR memory).
//   - Even if a malicious user dumps the Electron main process, all they
//     get is a 24h, user-scoped, quota-bound proxy token — useless to
//     anyone outside their own account.
//   - Compromised proxy tokens can be invalidated en masse by rotating
//     TAVILY_PROXY_SECRET in Vercel env vars.
type TavilyHandout = { apiKey: string; baseUrl: string; expiresAt: number }
let tavilyHandoutCache: TavilyHandout | null = null

export async function fetchTavilyHandout(): Promise<TavilyHandout | null> {
  // Reuse cached handout if still fresh (5-min safety margin so we don't
  // get caught mid-call by an expiry boundary).
  if (tavilyHandoutCache && tavilyHandoutCache.expiresAt > Date.now() + 5 * 60_000) {
    return tavilyHandoutCache
  }
  try {
    const res = await need().fetchWithSessionRetry(`${need().webUrl}/api/tavily-token`, 'twixy/tavily')
    if (!res) {
      console.warn('[twixy/tavily] no Supabase session — web_search will be disabled')
      return null
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[twixy/tavily] handout fetch failed: ${res.status} ${body}`)
      return null
    }
    const body = await res.json() as {
      ok: boolean
      apiKey?: string
      baseUrl?: string
      expiresAt?: number
      error?: string
    }
    if (!body.ok || !body.apiKey || !body.baseUrl) {
      console.warn(`[twixy/tavily] handout rejected: ${body.error ?? 'unknown'}`)
      return null
    }
    tavilyHandoutCache = {
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : Date.now() + 23 * 60 * 60_000,
    }
    console.log('[twixy/tavily] proxy handout acquired, expires in',
      Math.round((tavilyHandoutCache.expiresAt - Date.now()) / 3_600_000), 'h')
    return tavilyHandoutCache
  } catch (err) {
    console.warn('[twixy/tavily] handout fetch error:', err)
    return null
  }
}

// ── OpenRouter key handout (Twixy mode) — LLM 키 발급 ────────────
// Twixy 호스팅 모드에서 서버가 관리하는 OpenRouter 키 중 사용자 앞으로 할당된
// 전용 키(일일 USD 예산 내장)를 가져온다. BYOK 모드에서는 이 함수를 호출하지 않음.
// Twixy mode routes all LLM traffic CLIENT → openrouter.ai DIRECTLY.
// There's no per-request server proxy — we ask the web app to mint a
// user-scoped OpenRouter API key (via their provisioning endpoint with
// our master key) and inject it as OPENROUTER_API_KEY into the OpenClaw
// subprocess. OpenClaw's built-in openrouter provider then talks to
// openrouter.ai directly, so round-trip latency matches native BYOK.
//
// Quota enforcement is server-side at OpenRouter: the created key has a
// `limit` (USD/day) + `limit_reset: daily` + `expires_at` (24h), so the
// worst a compromised key can do is burn the user's daily budget for
// the next 24h. Rotating TTL + budget cap = key leak blast radius is
// bounded without us having to proxy anything.
//
// BYOK mode skips this block — the user's own OpenAI/Anthropic key in
// auth-profiles.json hits api.openai.com / api.anthropic.com directly.
type OpenRouterHandout = { apiKey: string; baseUrl: string; expiresAt: number }
let openrouterHandoutCache: OpenRouterHandout | null = null

/** 이번 기동이 OpenRouter 키 없이 시작됐나. 세션 토큰이 만료된 채 앱을 켜면
 *  핸드아웃이 401 로 죽고 게이트웨이가 키 없이 뜬다 — 그 상태를 기억해 뒀다가
 *  렌더러가 토큰을 갱신해 저장하는 순간(auth-save-session) 복구한다. */
let openrouterKeyMissing = false
/** 복구가 겹쳐 돌지 않게 하는 가드 (refreshOpenRouterKey 는 게이트웨이를 재시작한다). */
let openrouterRecovering = false
/** 복구 시도 횟수 (앱 기동 1회 기준). 상한이 없으면 세션이 저장될 때마다 —
 *  그리고 갱신 자체가 또 저장을 부르므로 — 영원히 재시도한다. 실측으로 확인. */
let openrouterRecoveryAttempts = 0
export const OPENROUTER_RECOVERY_MAX = 3

export async function fetchOpenRouterHandout(): Promise<OpenRouterHandout | null> {
  // Reuse the cached key until 5 minutes before expiry so we never get
  // caught mid-stream by a rotation. The web app creates fresh keys on
  // every call, so this cache is the ONLY thing preventing key churn
  // inside a single desktop session.
  if (openrouterHandoutCache && openrouterHandoutCache.expiresAt > Date.now() + 5 * 60_000) {
    return openrouterHandoutCache
  }
  try {
    const res = await need().fetchWithSessionRetry(`${need().webUrl}/api/openrouter-key`, 'twixy/openrouter')
    if (!res) {
      console.warn('[twixy/openrouter] no Supabase session — Twixy-mode LLM disabled')
      return null
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      // 402 = the server deliberately refused to mint because the key would be
      // unusable (empty company pool, or no allocation for this member). It
      // used to hand back a 0-limit key that failed every request with a
      // generic provider error, which was near-impossible to diagnose from the
      // app side. Surface the actual reason.
      let reason = ''
      try {
        const j = JSON.parse(raw) as { error?: string; message?: string }
        if (j.message || j.error) reason = ` — ${j.message ?? ''} [${j.error ?? ''}]`
      } catch { /* not JSON — fall back to the raw body below */ }
      if (res.status === 402) {
        console.warn(`[twixy/openrouter] no usable key can be issued${reason}`)
      } else {
        console.warn(`[twixy/openrouter] handout fetch failed: ${res.status} ${raw}`)
      }
      return null
    }
    const body = await res.json() as {
      ok: boolean
      apiKey?: string
      baseUrl?: string
      expiresAt?: number
      error?: string
    }
    if (!body.ok || !body.apiKey || !body.baseUrl) {
      console.warn(`[twixy/openrouter] handout rejected: ${body.error ?? 'unknown'}`)
      return null
    }
    const isNewKey = openrouterHandoutCache?.apiKey !== body.apiKey
    openrouterHandoutCache = {
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : Date.now() + 23 * 60 * 60_000,
    }
    // Seed prevUsdActual from the key's current usage so that the first
    // record-openrouter-usage call after startup (or key rotation) doesn't
    // double-count usage that was already synced before the restart.
    try {
      const r = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${body.apiKey}` },
      })
      if (r.ok) {
        const b2 = await r.json() as { data?: { usage?: number } }
        if (typeof b2.data?.usage === 'number') {
          prevUsdActual = isNewKey ? 0 : b2.data.usage
          console.log(`[twixy/openrouter] prevUsdActual seeded: $${prevUsdActual.toFixed(6)} (${isNewKey ? 'new key' : 'same key'})`)
        }
      }
    } catch { /* non-critical */ }
    console.log('[twixy/openrouter] key acquired, expires in',
      Math.round((openrouterHandoutCache.expiresAt - Date.now()) / 3_600_000), 'h')
    return openrouterHandoutCache
  } catch (err) {
    console.warn('[twixy/openrouter] handout fetch error:', err)
    return null
  }
}

// ── OpenRouter usage sync — 사용량을 Supabase 로 주기 동기화 ─────
// OpenRouter 키 엔드포인트의 usdActual(실제 청구 누적)을 1분마다 폴링해
// 이전 측정값 대비 델타를 Supabase usage 테이블에 upsert 한다.
// 이렇게 해야 토큰 개수로 역산한 추정치가 아닌 "실제 청구 금액"이 쿼터 기준이 된다.
// Posts to /api/openrouter-usage so the server can update Supabase
// with the authoritative USD figure from OpenRouter. Passes usdActual
// fetched directly from the key endpoint so the server can SET the
// value rather than accumulate deltas (which drift over time).
// Fire-and-forget — errors are logged but never surface to the user.
export async function syncOpenRouterUsage(): Promise<void> {
  if (need().loadTwixyMode() !== 'twixy') return
  if (!need().loadSession()?.access_token) return

  // Fetch the authoritative USD-spent figure from OpenRouter's key endpoint.
  let usdActual: number | undefined
  try {
    const key = openrouterHandoutCache?.apiKey
    if (key) {
      const r = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (r.ok) {
        const b = await r.json() as { data?: { usage?: number } }
        if (typeof b.data?.usage === 'number') {
          usdActual = b.data.usage
        }
      }
    }
  } catch { /* non-critical */ }

  try {
    // Always send a JSON body. Omitting it made the server's req.json() throw
    // and return 400 invalid_json, so whenever the key read above failed the
    // sync silently did nothing. The server re-reads authoritative usage from
    // OpenRouter anyway — usdActual is only a hint — so an empty object is a
    // perfectly good payload and still triggers reconciliation.
    // 만료 토큰으로 보내면 401 이 나고 사용량이 서버에 영영 안 올라간다 —
    // 크레딧이 실제 사용보다 적게 잡히고 일일 상한도 안 걸린다. 핸드아웃과
    // 같은 재시도 경로를 태워 만료 시 한 번 갱신하고 다시 보낸다.
    const res = await need().fetchWithSessionRetry(`${need().webUrl}/api/openrouter-usage`, 'twixy/openrouter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(usdActual !== undefined ? { usdActual } : {}),
    })
    if (!res) return
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn('[twixy/openrouter] usage sync failed:', res.status, text.slice(0, 200))
    } else {
      const body = await res.json() as { ok: boolean; deltaUsd?: number }
      if (body.deltaUsd && body.deltaUsd > 0) {
        console.log(`[twixy/openrouter] usage synced: +$${body.deltaUsd.toFixed(6)}${usdActual !== undefined ? ` (usdActual=$${usdActual.toFixed(6)})` : ''}`)
      }
    }
  } catch (err) {
    console.warn('[twixy/openrouter] usage sync error:', err)
  }
}

export function startUsageSyncTimer() {
  stopUsageSyncTimer()
  syncOpenRouterUsage()
  usageSyncTimer = setInterval(() => syncOpenRouterUsage(), 5 * 60_000)
}

export function stopUsageSyncTimer() {
  if (usageSyncTimer) { clearInterval(usageSyncTimer); usageSyncTimer = null }
}

// ── OpenRouter mid-session key refresh — 세션 중 키 재발급 ───────
// 장시간 실행되는 세션에서 키가 만료·교체될 경우 새 키를 받아 적용한다.
// Called when OpenClaw reports an auth error for the openrouter provider.
//
// IMPORTANT: openclaw.json 패치만으로는 부족하다. 이유 ─ OpenClaw 가
// main-agent 용 per-agent models.json 을 생성할 때 openrouter.apiKey 를
// 실제 키 대신 "OPENROUTER_API_KEY" env-var 마커로 sanitize 해서 박는다.
// 그래서 main agent 는 매 호출마다 subprocess env 의 OPENROUTER_API_KEY
// 값을 읽고, sub-agent 는 openclaw.json 의 apiKey 를 직접 읽는다.
// 디스크만 패치하면 sub 는 새 키, main 은 spawn 시점에 박힌 옛 env 값
// 그대로 — 두 개가 서로 다른 OpenRouter 계정으로 청구되는 분기 발생.
// 따라서 디스크 패치 후 OpenClaw subprocess 도 재시작해 env 를 동기화.
export async function refreshOpenRouterKey(): Promise<void> {
  // 이 함수는 게이트웨이를 재시작한다. 겹쳐 돌면 재시작이 중첩되므로 가드한다.
  if (openrouterRecovering) {
    console.log('[twixy/openrouter] refresh already in flight — skipping')
    return
  }
  openrouterRecovering = true
  try {
  console.log('[twixy/openrouter] refreshing key mid-session')
  openrouterHandoutCache = null   // force re-fetch
  const or = await fetchOpenRouterHandout()
  if (!or) {
    console.warn('[twixy/openrouter] mid-session refresh failed — no key returned')
    return
  }
  openrouterKeyMissing = false
  openrouterRecoveryAttempts = 0
  try {
    patchOpenClawOpenRouterProvider(or.apiKey)
    console.log('[twixy/openrouter] hot-patched openclaw.json with new key')
  } catch (err) {
    console.warn('[twixy/openrouter] hot-patch failed:', err)
  }
  // Restart gateway so OPENROUTER_API_KEY env (used by main agent via
  // the models.json marker) matches the freshly-patched disk apiKey
  // (used by sub-agents). Without this, main and sub diverge to two
  // different OpenRouter accounts after a key rotation.
  const proc = need().getGatewayProcess()
  if (proc && !proc.killed) {
    console.log('[twixy/openrouter] restarting OpenClaw subprocess to sync env')
    try {
      proc.kill()
    } catch (err) {
      console.warn('[twixy/openrouter] kill failed:', err)
    }
    need().clearGatewayProcess()
    try {
      await need().startOpenClaw()
      console.log('[twixy/openrouter] subprocess restarted with new env')
    } catch (err) {
      console.warn('[twixy/openrouter] gateway restart failed:', err)
    }
  }
  } finally {
    openrouterRecovering = false
  }
}

/**
 * Patch ~/.openclaw/openclaw.json with a `models.providers.openrouter`
 * block that registers `openai/gpt-5.4-mini` under OpenClaw's built-in
 * openrouter provider and supplies the user-scoped OpenRouter API key.
 *
 * OpenClaw ships with a hard-coded openrouter catalog that only lists
 * three models (auto, hunter-alpha, healer-alpha) — none of which is
 * what we want. We add gpt-5.4-mini via the models config (merge mode)
 * so the built-in catalog stays intact but our model becomes selectable.
 *
 * apiKey is written directly into the file rather than relying on the
 * OPENROUTER_API_KEY env var. OpenClaw's provider-apikey resolver does
 * check env first, but that code path only fires when the config has
 * NO apiKey AND no profile — in practice we got "No API key found for
 * provider openrouter" errors trying to rely on env alone, so we just
 * put it in the config. The file sits under ~/.openclaw with 0600-ish
 * semantics already (OpenClaw writes gateway tokens and other secrets
 * here), so this isn't a meaningful downgrade in secrecy.
 *
 * Pass `apiKey: null` to scrub the block (used when switching to BYOK).
 */
export function patchOpenClawOpenRouterProvider(apiKey: string | null) {
  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(fs.readFileSync(need().configPath, 'utf8'))
  } catch {
    return  // ensureWorkspace hasn't run yet — nothing to patch
  }
  const models = ((cfg.models as Record<string, unknown>) ?? {}) as Record<string, unknown>
  const providers = ((models.providers as Record<string, unknown>) ?? {}) as Record<string, unknown>

  // Always scrub any stale openai proxy block from the earlier design —
  // we no longer use a server-side proxy for OpenAI, so if the user
  // upgrades across that change we don't want dead providers hanging
  // around in their config.
  delete providers.openai

  if (!apiKey) {
    delete providers.openrouter
  } else {
    providers.openrouter = {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey,
      // The built-in openrouter provider already declares
      // api: "openai-completions" at the provider level, so each model
      // entry inherits it. Omit the per-model `api` field to avoid any
      // chance of a schema / enum mismatch across OpenClaw versions.
      //
      // Catalog data sourced from /modelCatalog.json at repo root — same
      // file is read by src/lib/modelPricing.ts (renderer). MiniMax M3
      // provider-routing lives separately under
      // agents.defaults.models[<ref>].params.provider — schema rejects a
      // per-model `params` key here.
      models: modelCatalog.models,
    }
  }
  models.providers = providers
  models.mode = 'merge'
  cfg.models = models
  fs.writeFileSync(need().configPath, JSON.stringify(cfg, null, 2))
  need().chmod0600(need().configPath)  // 방금 apiKey 를 박았으므로 권한 잠금
}

// ── main.ts 가 쓰는 상태 접근자 ─────────────────────────────────────────────
// 캐시·카운터의 저장소는 이 모듈 하나. 밖에서는 직접 대입하지 않는다.

/** 현재 캐시된 OpenRouter 핸드아웃 (재발급하지 않는다). */
export function getOpenRouterHandout(): OpenRouterHandout | null { return openrouterHandoutCache }
/** 캐시를 버린다 — 로그아웃·모드 전환처럼 옛 키가 남으면 안 되는 지점에서 부른다. */
export function clearOpenRouterHandout(): void { openrouterHandoutCache = null }

export function isOpenRouterKeyMissing(): boolean { return openrouterKeyMissing }
export function setOpenRouterKeyMissing(v: boolean): void { openrouterKeyMissing = v }

export function getOpenRouterRecoveryAttempts(): number { return openrouterRecoveryAttempts }
export function setOpenRouterRecoveryAttempts(n: number): void { openrouterRecoveryAttempts = n }

export function getPrevUsdActual(): number { return prevUsdActual }
export function setPrevUsdActual(v: number): void { prevUsdActual = v }
