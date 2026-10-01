// ── 계정·과금·모드 IPC (main.ts 에서 이동) ──────────────────────────────────
//
// Settings 화면과 로그인 흐름이 쓰는 IPC 16개를 한곳에 모은다. 네 묶음:
//   · Auth      — 세션 조회/저장/로그인/로그아웃 (auth-save-session 이 OpenRouter
//                 키 복구를 트리거한다)
//   · Pricing   — 표시 가격 markup (main 에서만 계산한다 — 렌더러에 배수를 안 준다)
//   · Channels  — 모바일/메신저 채널 설정 (렌더러로 나갈 때 시크릿 마스킹)
//   · Mode/Keys — 호스팅(Twixy) ↔ BYOK 전환, auth 프로필, 모델 선택, API 키 저장
//
// **가변 상태를 갖지 않는다.** 핸드아웃 캐시는 keyHandout.ts, 게이트웨이 프로세스는
// gateway.ts, 경로·설정은 paths.ts 가 소유하고 여기서는 그 접근자만 부른다.
// senderBlocked(발신자 검증)는 창 보관소에 묶여 있어 main.ts 소유 — 주입받는다.
import { BrowserWindow, app, ipcMain, shell, safeStorage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '../shared/product/current.generated'
import { applyMarkup, fetchMarkup, clearMarkupCache } from './pricing'
import { maskChannels, unmaskChannels, type ChannelsConfig } from './channelSecrets'
import { maskSecret, isMaskedSecret, mergeSecret } from '../shared/secretMask'
import {
  loadSession, saveSession,
} from './authSession'
import {
  loadTwixyMode, saveTwixyMode, getWorkspace, CONFIG_PATH, OPENCLAW_DIR, WEB_URL,
} from './paths'
import {
  clearOpenRouterHandout, fetchOpenRouterHandout, getOpenRouterHandout,
  getOpenRouterRecoveryAttempts, setOpenRouterRecoveryAttempts, OPENROUTER_RECOVERY_MAX,
  isOpenRouterKeyMissing, setOpenRouterKeyMissing, refreshOpenRouterKey,
  patchOpenClawOpenRouterProvider, startUsageSyncTimer,
  getPrevUsdActual, setPrevUsdActual,
} from './keyHandout'
import { killGatewayIfRunning, startOpenClaw } from './gateway'
import type { WindowKind } from './windowEntry'
import type { StoredSession } from './authDeeplink'
import type { TwixyMode } from './paths'

export interface AccountIpcDeps {
  getMainWindow: () => BrowserWindow | null
  chmod0600: (filePath: string) => void
  ensureWorkspace: () => void
  loadChannels: () => ChannelsConfig
  saveChannels: (c: ChannelsConfig) => void
  senderBlocked: (e: IpcMainInvokeEvent, channel: string, kinds: WindowKind[]) => boolean
  /** main.ts 가 기동 순서 때문에 따로 들고 있는 auth-profiles 경로. 아래 AUTH_PROFILES_PATH
   *  와 같은 파일을 가리키는 중복 상수다 — 한쪽으로 합치는 건 경로 묶음에서 따로 다룬다. */
  authProfilesPathEarly: string
}

/** 계정·과금·모드 IPC 16개를 등록한다. import 시점 부작용 없음. */
export function registerAccountIpc(deps: AccountIpcDeps): void {
  const { getMainWindow, chmod0600, ensureWorkspace, loadChannels, saveChannels, senderBlocked } = deps
  const AUTH_PROFILES_PATH_EARLY = deps.authProfilesPathEarly

  // ── Auth IPC — 인증 세션 조회/저장/로그인/로그아웃 ───────────────
  ipcMain.handle('auth-get-session', (e): StoredSession | null => {
    if (senderBlocked(e, 'auth-get-session', ['main'])) return null   // access + refresh 토큰
    return loadSession()
  })

  ipcMain.handle('auth-save-session', (_e, session: StoredSession | null) => {
    saveSession(session)
    // 사용자 전환 시 markup 캐시 무효화 — 다른 사람 multiplier 가 잠깐 흘러가지 않게.
    try { clearMarkupCache() } catch { /* loaded after this? unlikely */ }
    // 이번 기동이 키 없이 시작됐다면(만료 토큰으로 핸드아웃 401) 지금이 복구
    // 시점이다 — 렌더러의 supabase-js 가 방금 신선한 토큰을 넘겨줬다.
    // refreshOpenRouterKey 가 재발급 + openclaw.json 핫패치 + 게이트웨이 재시작을
    // 모두 처리한다. 이게 없으면 앱을 껐다 켜기 전까지 LLM 이 죽은 채로 남는다.
    if (session?.access_token && isOpenRouterKeyMissing() && loadTwixyMode() === 'twixy') {
      if (getOpenRouterRecoveryAttempts() >= OPENROUTER_RECOVERY_MAX) {
        // 더 시도해도 같은 결과다 (로그인 자체가 죽었거나 서버가 거절 중).
        // 여기서 멈추지 않으면 토큰이 갱신될 때마다 무한히 재시도한다.
        return { ok: true }
      }
      setOpenRouterRecoveryAttempts(getOpenRouterRecoveryAttempts() + 1)
      console.log(`[twixy/openrouter] 새 세션 토큰 도착 — 키 없이 뜬 게이트웨이를 복구한다 (${getOpenRouterRecoveryAttempts()}/${OPENROUTER_RECOVERY_MAX})`)
      void refreshOpenRouterKey()
    }
    return { ok: true }
  })

  ipcMain.handle('auth-sign-out', () => {
    saveSession(null)
    try { clearMarkupCache() } catch { /* noop */ }
    // 로그아웃 시 OpenRouter 키를 즉시 스크럽한다. saveSession(null) 은 세션 파일만
    // 지우므로, 메모리 캐시(openrouterHandoutCache)와 디스크 평문(openclaw.json 의
    // models.providers.openrouter.apiKey) 이 남으면 로그아웃 후에도 사용자-스코프 키가
    // 잔존한다. 캐시를 null 처리하고 디스크 블록을 제거해 잔존 평문 키를 없앤다.
    clearOpenRouterHandout()
    try { patchOpenClawOpenRouterProvider(null) } catch { /* best-effort scrub */ }
    return { ok: true }
  })

  // ── Pricing IPC — 표시 가격 계산 (main-only markup) ──────────────
  // renderer 는 raw $ 값을 보내고 marked-up 결과만 받는다. multiplier 자체는
  // 응답에 절대 포함 X — electron/pricing.ts 참고.
  ipcMain.handle('apply-display-markup', async (_e, rawUsd: number) => {
    return await applyMarkup(rawUsd)
  })
  ipcMain.handle('refresh-markup', async () => {
    await fetchMarkup(/* force */ true)
    return { ok: true }
  })

  ipcMain.handle('auth-sign-in', () => {
    // Open the desktop sign-in handoff page in the user's default browser.
    shell.openExternal(`${WEB_URL}/auth/desktop-callback`)
    return { ok: true }
  })

  // ── Mobile channels IPC — 채널 설정 조회/저장 ────────────────────
  // 저장 핸들러는 채널 설정을 파일에 쓴 뒤 OpenClaw 를 재시작해 새 자격증명을 반영.
  ipcMain.handle('get-channels', (e): ChannelsConfig => {
    if (senderBlocked(e, 'get-channels', ['main'])) return {}   // {} = loadChannels 의 "없음"
    return maskChannels(loadChannels())
  })

  ipcMain.handle('save-channels', async (_e, payload: ChannelsConfig) => {
    // 렌더러가 돌려준 마스크는 "그대로 둬라" 라는 뜻이다 — 그걸 저장하면 진짜 토큰이 날아간다.
    saveChannels(unmaskChannels(payload, loadChannels()))
    // Re-render ~/.openclaw/openclaw.json with the new channels block, then
    // hard-restart the gateway so the channel actually attaches.
    try {
      await ensureWorkspace()
    } catch (err) {
      return { ok: false, error: String(err) }
    }
    killGatewayIfRunning()
    try {
      await startOpenClaw()
    } catch (err) {
      return { ok: false, error: String(err) }
    }
    startUsageSyncTimer()
    getMainWindow()?.webContents.send('openclaw-ready')
    return { ok: true }
  })

  // ── Auth profiles — OpenClaw 내부 auth 프로필 파일 경로 ──────────
  // OpenClaw 가 에이전트별 LLM 인증 프로필(API 키/토큰 세트)을 저장하는 위치.
  // 아래 get-auth-profiles 핸들러가 이 JSON을 읽어 렌더러로 넘긴다.
  const AUTH_PROFILES_PATH = path.join(OPENCLAW_DIR, 'agents', 'main', 'agent', 'auth-profiles.json')

  // ── Twixy mode (hosted LLM proxy vs BYOK) — 호스팅/BYOK 전환 IPC ──
  // 모드 변경 시 openclaw.json 의 모델 지정과 API 키 주입 방식이 달라져
  // OpenClaw 재시작이 필요하다 (set-twixy-mode 핸들러에서 처리).
  ipcMain.handle('get-twixy-mode', (): TwixyMode => loadTwixyMode())

  ipcMain.handle('record-openrouter-usage', async (
    _e,
    delta: { tokensIn: number; tokensCacheIn: number; tokensOut: number; usdDelta: number }
  ) => {
    if (loadTwixyMode() !== 'twixy') return { ok: true, skipped: true }
    const session = loadSession()
    if (!session?.access_token) return { ok: false, error: 'no_session' }

    // Fetch the actual USD spent today from OpenRouter's key endpoint and compute
    // a delta from the last known value. This avoids relying on token-math pricing
    // (which drifts) AND avoids blindly SET-ing usdActual (which breaks when keys
    // rotate mid-day and usage resets to 0 for the new key).
    let usdActual: number | undefined
    let usdActualDelta: number | undefined
    try {
      const key = getOpenRouterHandout()?.apiKey
      if (key) {
        const r = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (r.ok) {
          const b = await r.json() as { data?: { usage?: number } }
          if (typeof b.data?.usage === 'number') {
            usdActual = b.data.usage
            // If usage went up, use the diff as the authoritative increment.
            // If it went down (new key provisioned), treat as 0 delta for now —
            // the new key's usage will accumulate from here.
            usdActualDelta = Math.max(0, usdActual - getPrevUsdActual())
            setPrevUsdActual(usdActual)
          }
        }
      }
    } catch { /* non-critical — fall back to calculated delta */ }

    // Prefer usdActualDelta (from real OpenRouter billing) over the token-math usdDelta.
    const effectiveUsdDelta = usdActualDelta ?? delta.usdDelta
    // Also send usdActual so the server can SET today's total authoritatively
    // rather than accumulating a computed delta with potentially-wrong prices.
    const payload: Record<string, unknown> = { ...delta, usdDelta: effectiveUsdDelta }
    if (usdActual !== undefined) payload.usdActual = usdActual

    try {
      const res = await fetch(`${WEB_URL}/api/openrouter-usage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.warn('[twixy/usage] record failed:', res.status, text.slice(0, 200))
        return { ok: false, error: `${res.status}` }
      }
      const json = await res.json()
      // Return usdActual so the renderer can update the UI immediately without
      // waiting for a full Supabase round-trip.
      return { ...(json as object), usdActual: usdActual ?? null }
    } catch (err) {
      console.warn('[twixy/usage] record error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('set-twixy-mode', async (e, mode: TwixyMode) => {
    if (senderBlocked(e, 'set-twixy-mode', ['main'])) return { ok: false, error: 'forbidden_sender' }
    if (mode !== 'twixy' && mode !== 'byok') {
      return { ok: false, error: 'invalid_mode' }
    }
    saveTwixyMode(mode)

    // Switching modes invalidates the cached OpenRouter handout so the next
    // gateway start re-fetches a fresh one.
    clearOpenRouterHandout()

    // If switching to BYOK and the current openai:default profile is the
    // twixy-managed one, scrub it so OpenClaw doesn't keep pointing at
    // our proxy with a now-irrelevant signed token.
    if (mode === 'byok') {
      try {
        const store = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH_EARLY, 'utf8')) as {
          profiles?: Record<string, { twixyManaged?: boolean }>
        }
        if (store.profiles?.['openai:default']?.twixyManaged) {
          delete store.profiles['openai:default']
          fs.writeFileSync(AUTH_PROFILES_PATH_EARLY, JSON.stringify(store, null, 2))
        }
      } catch { /* nothing to clean up */ }
    }

    // Re-render openclaw.json (model selection follows mode) and bounce
    // the gateway so the env-var injection takes effect.
    try {
      await ensureWorkspace()
    } catch (err) {
      return { ok: false, error: String(err) }
    }
    killGatewayIfRunning()
    try {
      await startOpenClaw()
    } catch (err) {
      return { ok: false, error: String(err) }
    }
    startUsageSyncTimer()
    getMainWindow()?.webContents.send('openclaw-ready')
    return { ok: true }
  })

  ipcMain.handle('get-auth-profiles', (e) => {
    if (senderBlocked(e, 'get-auth-profiles', ['main'])) return null
    try {
      const store = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, 'utf8'))
      const profiles = store?.profiles
      if (!profiles || typeof profiles !== 'object') return profiles ?? null
      // 설정 화면은 "키가 있나 / 어느 키인가" 만 알면 된다 — 평문은 렌더러로 내보내지 않는다.
      // 돌아온 마스크는 save-api-keys 에서 "안 바꿨다" 로 읽힌다.
      return Object.fromEntries(Object.entries(profiles as Record<string, unknown>).map(([id, p]) => {
        if (!p || typeof p !== 'object') return [id, p]
        const rec = p as Record<string, unknown>
        return [id, typeof rec.key === 'string' ? { ...rec, key: maskSecret(rec.key) } : rec]
      }))
    } catch {
      return null
    }
  })

  ipcMain.handle('get-agent-model', () => {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      return config?.agents?.defaults?.model ?? 'openai-codex/gpt-5.4'
    } catch {
      return null
    }
  })

  ipcMain.handle('get-subagent-model', () => {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      return config?.agents?.defaults?.subagents?.model ?? 'openai/gpt-5.4-mini'
    } catch {
      return null
    }
  })

  ipcMain.handle('save-subagent-model', (_e, model: string) => {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      config.agents = config.agents ?? {}
      config.agents.defaults = config.agents.defaults ?? {}
      config.agents.defaults.subagents = config.agents.defaults.subagents ?? {}
      config.agents.defaults.subagents.model = model
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
      chmod0600(CONFIG_PATH)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('save-api-keys', (_e, payload: {
    keys: { anthropic: string; openai: string }
    model: string
  }) => {
    // Update auth-profiles.json
    let store: Record<string, unknown> = { version: 1, profiles: {} }
    try {
      store = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, 'utf8'))
    } catch { /* start fresh */ }

    const profiles = (store.profiles ?? {}) as Record<string, unknown>

    // 마스크가 돌아오면 "안 바꿨다" — 디스크의 키를 그대로 둔다. 빈 값은 예전처럼 삭제.
    const keyOf = (id: string): string | undefined => {
      const p = profiles[id]
      return p && typeof p === 'object' && typeof (p as Record<string, unknown>).key === 'string'
        ? (p as Record<string, string>).key
        : undefined
    }
    const upsert = (id: string, provider: 'anthropic' | 'openai', incoming: unknown) => {
      const next = mergeSecret(incoming, keyOf(id))
      if (next) profiles[id] = { type: 'api_key', provider, key: next }
      else delete profiles[id]
    }
    upsert('anthropic:default', 'anthropic', payload.keys.anthropic)
    upsert('openai:default',    'openai',    payload.keys.openai)

    store.profiles = profiles
    fs.mkdirSync(path.dirname(AUTH_PROFILES_PATH), { recursive: true })
    fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(store, null, 2))
    chmod0600(AUTH_PROFILES_PATH)  // BYOK Anthropic/OpenAI 키 파일 권한 잠금

    // Update model in openclaw.json
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      config.agents = config.agents ?? {}
      config.agents.defaults = config.agents.defaults ?? {}
      config.agents.defaults.model = payload.model
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
      chmod0600(CONFIG_PATH)
    } catch { /* ignore */ }

    return { ok: true }
  })

}
