// ── OpenClaw 게이트웨이 수명주기 (main.ts 에서 이동) ─────────────────────────
//
// 에이전트 런타임(자식 프로세스 + 로컬 WS 게이트웨이)의 기동·감시·종료 전부.
//
// **상태 소유권**: `openclawProcess` 와 감시 상태(`gatewaySupervised` ·
// 재기동 카운터 · 타이머 2개 · `appQuitting`)의 유일한 저장소가 여기다.
// main.ts 를 포함해 밖에서는 아래 접근자로만 읽고 쓴다.
//
// 저장소가 둘로 갈라지면 안 되는 이유는 창 보관소(windows.ts)와 같다 —
// exit 핸들러의 `openclawProcess === proc` 비교가 "의도한 종료" 와 "예상 못 한
// 죽음" 을 가른다. 비교 대상이 다른 저장소를 읽으면 크래시 후 되살아나지
// 않거나(채팅이 영영 멈춤), 종료 후 되살아난다(좀비 게이트웨이가 포트를 문다).
// 그래서 그 비교는 이 모듈 안에서 **모듈 지역 변수**를 직접 읽는다 — 접근자를
// 거치지 않는다. gateway.contract.test.ts 가 그 모양을 고정한다.
//
// 반대로 startupErrorMsg 는 main.ts 소유다 (Setup 화면의 retry 가 같이 쓴다) —
// get/setStartupErrorMsg thunk 으로만 만진다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { PRODUCT } from '../shared/product/current.generated'
import { startAgentToolBridge, type BridgeHandle } from './agent-tool-bridge'
import { startExecutionPlanApi, parseExecutionPlan, type ExecutionPlanApiHandle } from './execution-plan-api'
import { getCachedDesignatedPathsConfig } from './designated-paths/ipc'
import { getCachedGuardrailConfig } from './guardrail/ipc'
import { serializeForEnv as serializeGuardrailEnv } from './guardrail/config'
import { createExecutionPlanDraft } from './planIpc'
import { app } from 'electron'
import { serializeForEnv as serializeDesignatedPathsEnv } from './designated-paths/config'
import { browserPreview } from './browserPreview'
import type { ChannelsConfig } from './channelSecrets'
import {
  fetchTavilyHandout, fetchOpenRouterHandout, patchOpenClawOpenRouterProvider,
  refreshOpenRouterKey, syncOpenRouterUsage, startUsageSyncTimer, stopUsageSyncTimer,
  setOpenRouterKeyMissing, setOpenRouterRecoveryAttempts,
} from './keyHandout'

export interface GatewayDeps {
  isDev: boolean
  configPath: string
  openclawDir: string
  gatewayPort: number
  gatewayPidFile: string
  authProfilesPathEarly: string
  getMainWindow: () => { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null
  getStartupErrorMsg: () => string | null
  setStartupErrorMsg: (v: string | null) => void
  getWorkspace: () => string
  getTwixyMetaDir: () => string
  appendOpenClawLog: (line: string) => void
  chmod0600: (filePath: string) => void
  executionPlanApiDiscoveryPath: () => string
  findNode22: () => string
  killLingeringManagedChrome: () => void
  listenersOn: (port: number) => number[]
  loadChannels: () => ChannelsConfig
  loadTwixyMode: () => 'twixy' | 'byok'
  reclaimOrphanGateway: () => void
  /** 늦게 정의되는 main 상수·객체는 thunk 으로 받는다 (module-scope TDZ 회피). */
  getBrowserSlotsFile: () => string
  overwriteRedirectFile: string
  setOpenClawLogBuffer: (v: string) => void
  /** planIpc 의 createExecutionPlanDraft 에 넘길 deps — main 이 조립한 그 객체 그대로. */
  getPlanIpcDeps: () => Parameters<typeof createExecutionPlanDraft>[0]
}

let deps: GatewayDeps | null = null

/** main.ts 가 기동 시 1회 호출한다. 안 부르면 첫 기동에서 throw 한다. */
export function initGateway(d: GatewayDeps): void { deps = d }

function need(): GatewayDeps {
  if (!deps) throw new Error('gateway.ts: initGateway() 가 먼저 불려야 한다')
  return deps
}

let openclawProcess: ChildProcess | null = null   // OpenClaw 자식 프로세스(게이트웨이)
// ── 게이트웨이 감시 ────────────────────────────────────────────────────────
// 게이트웨이가 **가동 중에** 죽으면(크래시, OOM, 외부 kill) 앱 창은 멀쩡한데 채팅·워크플로가
// 전부 멈춘다. 예전에는 exit 을 로그로만 남겨서, 사용자가 앱을 껐다 켜기 전까지 복구가
// 없었고 무엇이 잘못됐는지 알려주지도 않았다 (실측: 게이트웨이 PID 를 죽이고 60초 뒤에도
// 포트가 다시 열리지 않았다).
//
// 의도한 종료와 구분하는 기준: 일부러 끄는 경로는 어디든 kill() 직후 openclawProcess 를
// null 로 비운다(stopOpenClaw · respawnGateway · 모드 변경 · 설정 변경). 그래서 exit 시점에
// openclawProcess 가 **아직 그 프로세스**면 예상치 못한 죽음이다. 기동 실패는 여기서 다루지
// 않는다 — 그건 startOpenClaw 의 reject 와 Setup 화면의 재시도가 이미 담당한다.
let gatewaySupervised = false                        // startOpenClaw 가 성공해 실제로 떠 있는가
let gatewayRestartAttempts = 0                       // 연속 재기동 횟수 (크래시 루프 차단)
let gatewayRestartTimer: NodeJS.Timeout | null = null
let gatewayUptimeTimer:  NodeJS.Timeout | null = null
let appQuitting = false

/**
 * 의도한 종료: 게이트웨이가 살아 있으면 죽이고 참조를 비운다.
 *
 * 같은 4줄이 6곳에 복붙돼 있었다. openclawProcess 는 이 파일에서 가장 많이 쓰이는 가변
 * 상태이고, 그 쓰기가 흩어져 있는 것이 게이트웨이를 모듈로 빼지 못하게 막는 실질적인
 * 장애물이라 한곳으로 모은다 (docs/refactor/stage4-main-split-plan.md §3-2).
 *
 * **여기서 하는 일은 딱 상태 정리까지다.** 재기동(startOpenClaw)과 그 실패 처리는 일부러
 * 호출부에 남긴다 — 호출부마다 실패 계약이 다르기 때문이다:
 *   · save-channels · set-twixy-mode · retry-openclaw → try/catch 로 { ok:false, error } 반환
 *   · respawnGateway · guardrail/designated-paths onChange → 그대로 throw
 * 이걸 한 헬퍼로 합치면 반환하던 쪽이 조용히 throw 로 바뀐다. 렌더러가 그 반환값을 읽지
 * 않아서 증상이 안 보인다 — 그래서 합치지 않는다.
 *
 * null 을 비우는 것이 중요한 이유: exit 핸들러가 `openclawProcess === proc` 로 "의도한 종료"
 * 와 "예상 못 한 죽음" 을 가른다. 비우지 않으면 감시가 우리가 죽인 프로세스를 크래시로 보고
 * 재기동한다.
 */
export function killGatewayIfRunning(): void {
  if (openclawProcess && !openclawProcess.killed) {
    openclawProcess.kill()
    openclawProcess = null
  }
}
let toolBridge:      BridgeHandle | null = null   // OpenClaw → Twixy IPC bridge (file-io / Google tools)
let executionPlanApi: ExecutionPlanApiHandle | null = null   // inbound Execution Plan HTTP API (Clovex → Twixy)
// ── OpenClaw gateway — 핵심: 에이전트 런타임 기동 ────────────────
// OpenClaw CLI 를 spawn 으로 띄워 로컬 게이트웨이(HTTP + WebSocket, 기본 18789)를 올린다.
// 환경변수 주입(키들), stdout/stderr 를 파일+버퍼로 tee 하고 health 폴러 시작까지 담당.
// 실패 시 startupErrorMsg 에 이유 기록 + 렌더러에 openclaw-error 이벤트 방송.
// Resolve the local openclaw.mjs entry path (installed as npm dep in dev,
// bundled under app.asar.unpacked in prod). Used by startOpenClaw (gateway
// spawn). In prod
// openclaw + all transitive deps live under app.asar.unpacked/ — a spawned
// `node openclaw.mjs` walks UP from this path looking for `tslog` etc., so the
// parent must contain the full deps tree.
function getOpenClawMjsPath(): string {
  return need().isDev
    ? path.join(__dirname, '..', 'node_modules', 'openclaw', 'openclaw.mjs')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'openclaw', 'openclaw.mjs')
}

// 재기동 간격. 즉시 다시 띄우면 포트가 아직 안 풀렸거나 같은 이유로 또 죽는다.
// 세 번을 다 쓰면 포기한다 — 크래시 루프를 도는 것보다 사용자에게 넘기는 편이 낫다.
const GATEWAY_RESTART_DELAYS_MS = [2_000, 5_000, 15_000]
// 이만큼 살아 있으면 회복된 것으로 보고 연속 실패 카운터를 푼다. 이게 없으면 재기동할
// 때마다 카운터가 0 으로 돌아가 영원히 되살리기만 한다.
const GATEWAY_STABLE_MS = 60_000

function clearGatewayTimers() {
  if (gatewayRestartTimer) { clearTimeout(gatewayRestartTimer); gatewayRestartTimer = null }
  if (gatewayUptimeTimer)  { clearTimeout(gatewayUptimeTimer);  gatewayUptimeTimer  = null }
}

function markGatewayUp() {
  gatewaySupervised = true
  clearGatewayTimers()
  gatewayUptimeTimer = setTimeout(() => { gatewayRestartAttempts = 0; gatewayUptimeTimer = null }, GATEWAY_STABLE_MS)
  gatewayUptimeTimer.unref?.()   // 이 타이머가 앱 종료를 붙잡지 않게
}

/** 가동 중이던 게이트웨이가 죽었다 — 간격을 두고 되살리고, 다 쓰면 사용자에게 알린다. */
function handleGatewayDied(reason: string) {
  gatewaySupervised = false
  clearGatewayTimers()
  if (appQuitting) return
  const delay = GATEWAY_RESTART_DELAYS_MS[gatewayRestartAttempts]
  if (delay === undefined) {
    // 같은 이유로 계속 죽는 중. 더 시도해도 로그만 쌓이므로 복구 화면으로 넘긴다.
    need().setStartupErrorMsg(`OpenClaw 게이트웨이가 반복해서 종료됐습니다 (${reason}). 다시 시도하거나 앱을 재시작해 주세요.`)
    console.error('[twixy] gateway supervisor giving up:', reason)
    need().appendOpenClawLog(`[supervisor] giving up after ${gatewayRestartAttempts} restarts: ${reason}\n`)
    need().getMainWindow()?.webContents.send('openclaw-error', need().getStartupErrorMsg())
    return
  }
  gatewayRestartAttempts++
  console.warn(`[twixy] gateway died (${reason}) — restarting in ${delay}ms (attempt ${gatewayRestartAttempts})`)
  need().appendOpenClawLog(`[supervisor] gateway died (${reason}); restart #${gatewayRestartAttempts} in ${delay}ms\n`)
  gatewayRestartTimer = setTimeout(() => {
    gatewayRestartTimer = null
    if (appQuitting) return
    void startOpenClaw()
      .then(() => {
        need().setStartupErrorMsg(null)
        // 훅들이 이 이벤트로 새 토큰을 받아 다시 붙는다 — 설정 변경 시 재기동과 같은 경로.
        need().getMainWindow()?.webContents.send('openclaw-ready')
      })
      .catch((err) => handleGatewayDied(String(err)))
  }, delay)
  gatewayRestartTimer.unref?.()
}

export function startOpenClaw(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Force a clean Chrome launch so browser.headless from openclaw.json takes
    // effect. See killLingeringManagedChrome() for the "why".
    need().killLingeringManagedChrome()
    // …and the same for a gateway orphaned by an abnormal exit, which would
    // otherwise hold :18789 and park every later launch in openclaw's
    // lock-conflict retry loop. See reclaimOrphanGateway() for the "why".
    need().reclaimOrphanGateway()
    const node22 = need().findNode22()

    const openclawMjs = getOpenClawMjsPath()

    if (!fs.existsSync(openclawMjs)) {
      return reject(new Error(`openclaw.mjs not found at ${openclawMjs}`))
    }

    console.log(`[twixy] Starting: ${node22} ${openclawMjs} gateway`)

    // Channel secrets that ride along as env vars (Discord uses env-source token)
    const channels = need().loadChannels()
    const channelEnv: Record<string, string> = {}
    if (channels.discord?.enabled && channels.discord.token) {
      channelEnv.DISCORD_BOT_TOKEN = channels.discord.token
    }

    let resolved = false
    // 게이트웨이가 실제로 리스닝했다는 유일한 증거. 이게 없으면 12초 타임아웃이
    // 성공으로 resolve 해버려 "gateway ready" 를 거짓말한다 (실측: 락 충돌로
    // 게이트웨이가 아예 안 떴는데도 ready 가 찍혔다).
    let sawListening = false
    let sawLockConflict = false
    const done = (err?: Error) => {
      if (resolved) return
      resolved = true
      if (err) { reject(err); return }
      markGatewayUp()   // 여기부터 감시 대상 — 이 뒤의 exit 은 예상치 못한 죽음이다
      resolve()
    }

    // Fetch the Tavily proxy handout (signed token + proxy base URL) and
    // inject both as env vars so OpenClaw routes Tavily calls through our
    // server. If the fetch fails (no session, quota blown, server down)
    // we still spawn — the agent just won't have web_search until the
    // next restart, but the rest of the app keeps working.
    void (async () => {
      const handout = PRODUCT.features.webSearch ? await fetchTavilyHandout() : null
      const searchEnv: Record<string, string> = {}
      if (handout) {
        searchEnv.TAVILY_API_KEY  = handout.apiKey
        searchEnv.TAVILY_BASE_URL = handout.baseUrl
      }

      // Twixy mode: fetch the user-scoped OpenRouter key and inject it
      // via OPENROUTER_API_KEY env. Also patch openclaw.json to register
      // gpt-5.4-mini under the openrouter provider so OpenClaw's model
      // loader recognises `openrouter/openai/gpt-5.4-mini` as a valid
      // agent model. All LLM traffic then goes CLIENT → openrouter.ai
      // directly, no server proxy hop.
      const llmEnv: Record<string, string> = {}
      if (need().loadTwixyMode() === 'twixy') {
        const or = await fetchOpenRouterHandout()
        if (or) {
          // Inject the key into the OpenClaw config directly. We also
          // set OPENROUTER_API_KEY as an env var for any OpenClaw code
          // path that checks env before config (harmless redundancy).
          llmEnv.OPENROUTER_API_KEY = or.apiKey
          setOpenRouterKeyMissing(false)
          setOpenRouterRecoveryAttempts(0)
          try {
            patchOpenClawOpenRouterProvider(or.apiKey)
          } catch (err) {
            console.warn('[twixy/openrouter] failed to patch openclaw.json:', err)
          }
        } else {
          // 키 없이 그냥 띄우면 게이트웨이는 "ready" 인데 모든 요청이 조용히
          // 타임아웃한다 (openclaw.json 에 남은 이전 세션 키로 시도하다 죽는다).
          // 원인을 알 수 없는 실패라 반드시 크게 남기고 렌더러에도 알린다.
          setOpenRouterKeyMissing(true)
          console.error('[twixy/openrouter] NO KEY — 게이트웨이가 LLM 키 없이 뜬다. '
            + '로그인 세션이 만료됐고 갱신도 실패했다. 이 상태로는 모든 에이전트 요청이 타임아웃한다.')
          need().getMainWindow()?.webContents.send('openrouter-key-missing')
        }
        // Scrub any stale openai:default auth profile from the earlier
        // proxy-based design so OpenClaw doesn't try to use a leftover
        // bearer token against the new model provider.
        try {
          const store = JSON.parse(fs.readFileSync(need().authProfilesPathEarly, 'utf8')) as {
            profiles?: Record<string, unknown>
          }
          if (store.profiles && 'openai:default' in store.profiles) {
            delete store.profiles['openai:default']
            fs.writeFileSync(need().authProfilesPathEarly, JSON.stringify(store, null, 2))
            need().chmod0600(need().authProfilesPathEarly)  // BYOK 키 파일 권한 잠금
          }
        } catch { /* nothing to clean up */ }
      } else {
        // BYOK mode: remove the openrouter provider override so the
        // user's own OpenAI/Anthropic key (in auth-profiles.json) runs
        // against api.openai.com / api.anthropic.com directly.
        try { patchOpenClawOpenRouterProvider(null) } catch { /* ignore */ }
      }
      // Defensively scrub the local handle once we've copied the values
      // into the subprocess env. The cache (tavilyHandoutCache) is the
      // single canonical store from here on; this just avoids leaving an
      // extra reference to the token string in the closure.
      // (V8 may still keep the string interned in the heap, but at least
      // there's only one live reference, which makes any future
      // safeStorage migration trivial.)

      // Scrub any inherited OpenAI / Anthropic env vars. The user's shell
      // profile (~/.zshrc etc.) frequently exports OPENAI_API_KEY for CLI
      // work, and OpenClaw's provider apiKey resolver checks env BEFORE
      // the models.providers.openai.apiKey we configure — so an inherited
      // sk-... would completely override our signed proxy token and land
      // on our /api/openai-proxy as an unverifiable bearer. Stripping the
      // inherited vars unconditionally is safe because the desktop app
      // gets its provider credentials from auth-profiles.json (BYOK) or
      // models.providers.openai.apiKey (Twixy mode), never from env.
      const scrubbedEnv = { ...process.env }
      delete scrubbedEnv.OPENAI_API_KEY
      delete scrubbedEnv.OPENAI_API_BASE
      delete scrubbedEnv.OPENAI_BASE_URL
      delete scrubbedEnv.OPENAI_ORGANIZATION
      delete scrubbedEnv.OPENAI_ORG_ID
      delete scrubbedEnv.ANTHROPIC_API_KEY
      delete scrubbedEnv.OPENROUTER_API_KEY

      // macOS launchd 오탐 차단. openclaw 의 detectRespawnSupervisor() 는
      // XPC_SERVICE_NAME 등이 "비어있지 않으면" launchd 로 판정하는데, macOS 는
      // 사실상 모든 프로세스에 XPC_SERVICE_NAME=0 을 넣는다. 우리 게이트웨이는
      // launchd 잡이 아닌데도 "supervised" 로 오인되어 두 가지가 망가진다:
      //   ① 락 충돌 시 즉시 실패하는 대신 "already running under launchd;
      //      waiting 5000ms" 를 무한 반복한다 (영구 착륙 — 실측 버그)
      //   ② 게이트웨이 재시작이 launchd 핸드오프로 넘어가는데 plist 가 없어
      //      launchctl 이 조용히 실패 → 게이트웨이가 죽고 안 돌아온다
      // 힌트 변수를 빼면 supervisor=null 이 되어 락 충돌이 진짜 에러로 뜬다.
      for (const k of ['XPC_SERVICE_NAME', 'LAUNCH_JOB_LABEL', 'LAUNCH_JOB_NAME', 'OPENCLAW_LAUNCHD_LABEL']) {
        delete scrubbedEnv[k]
      }

      // Start (or reuse) the loopback HTTP bridge that exposes our
      // Electron-side tool handlers (write-pdf / write-xlsx / write-pptx /
      // read-xlsx / google-* / send-email) to the openclaw subprocess. The
      // patched createOpenClawTools() reads TWIXY_TOOL_BRIDGE_PORT/TOKEN
      // from env and registers 12 thin tools whose execute() POSTs JSON here.
      if (!toolBridge) {
        try {
          toolBridge = await startAgentToolBridge({ getWorkspace: need().getWorkspace, getTwixyMetaDir: need().getTwixyMetaDir })
          console.log(`[twixy] tool-bridge listening on 127.0.0.1:${toolBridge.port}`)
        } catch (err) {
          console.error('[twixy] tool-bridge failed to start:', err)
        }
      }

      // Inbound Execution Plan API (external Clovex AI → Twixy). Started once,
      // independent of gateway restarts. The API path AUTO-RUNS the plan by
      // signalling the renderer (the UI-import IPC path does not).
      if (!executionPlanApi) {
        try {
          executionPlanApi = await startExecutionPlanApi({
            onSubmit: (parsed) => {
              const r = createExecutionPlanDraft(need().getPlanIpcDeps(), parsed)
              if (!r.ok || !r.plan) return { ok: false, error: r.error ?? 'create_failed' }
              need().getMainWindow()?.webContents.send('execution-plan-run', { planId: r.plan.id })
              return { ok: true, planId: r.plan.id }
            },
          })
          // Publish {port, token} to a file so the local Clovex AI process can
          // discover and authenticate to the API. Lives under userData — NOT
          // the project's .twixy/ folder, which can end up in git or a shared
          // drive and leak the Bearer token. Per-launch only; deleted on quit
          // (see the before-quit handler).
          try {
            fs.mkdirSync(app.getPath('userData'), { recursive: true })
            fs.writeFileSync(
              need().executionPlanApiDiscoveryPath(),
              JSON.stringify({ port: executionPlanApi.port, token: executionPlanApi.token }, null, 2),
              'utf8',
            )
          } catch (err) {
            console.warn('[twixy] could not write execution-plan-api.json:', err)
          }
          console.log(`[twixy] execution-plan API listening on 127.0.0.1:${executionPlanApi.port}`)
        } catch (err) {
          console.error('[twixy] execution-plan API failed to start:', err)
        }
      }
      const bridgeEnv: Record<string, string> = toolBridge
        ? { TWIXY_TOOL_BRIDGE_PORT: String(toolBridge.port), TWIXY_TOOL_BRIDGE_TOKEN: toolBridge.token }
        : {}

      const proc = spawn(node22, [openclawMjs, 'gateway', '--port', String(need().gatewayPort), '--allow-unconfigured'], {
        env: {
          ...scrubbedEnv,
          // OpenClaw (v2026.4.2) reads OPENCLAW_CONFIG_PATH, not OPENCLAW_CONFIG.
          // CONFIG_PATH happens to equal the default ~/.openclaw/openclaw.json so
          // the gateway loads it regardless, but set the real var so config
          // injection (mcp.servers, guardrail, models…) stays correct if the path
          // ever moves. OPENCLAW_CONFIG kept for back-compat; harmless if unread.
          OPENCLAW_CONFIG: need().configPath,
          OPENCLAW_CONFIG_PATH: need().configPath,
          // 상태 폴더(agents/·browser/·auth-profiles)도 제품별로 — 기본값 ~/.openclaw 와
          // 같은 제품(Twixy)에서는 동작이 그대로고, 다른 제품은 여기서 갈라진다.
          OPENCLAW_STATE_DIR: need().openclawDir,
          // 프로세스 수명은 Twixy 가 관리한다. 이걸 안 주면 openclaw 가 재시작
          // 때 detached 로 자기 자신을 새 PID 로 띄우는데(restartGatewayProcess-
          // WithFreshPid), 그 손자 프로세스는 우리 자식이 아니라서 stopOpenClaw()
          // 의 kill 도, twixy-gateway.pid 기반 회수도 전부 빗나간다 → 앱을 꺼도
          // :18789 를 물고 남는 고아. 끄면 같은 PID 로 in-process 재시작한다.
          OPENCLAW_NO_RESPAWN: '1',
          PATH: `${path.dirname(node22)}${path.delimiter}${process.env.PATH}`,
          ...channelEnv,
          ...searchEnv,
          ...llmEnv,
          ...serializeGuardrailEnv(getCachedGuardrailConfig()),
          ...serializeDesignatedPathsEnv(getCachedDesignatedPathsConfig(need().getTwixyMetaDir)),
          // Workflow Test browser slots — the runBeforeToolCallHook patch reads
          // this file per browser-tool call and force-sets params.profile for
          // sessions that have a leased slot. See 'browser-slot-set' IPC.
          TWIXY_BROWSER_SLOTS_FILE: need().getBrowserSlotsFile(),
          // 덮어쓰기 승인창의 "Save as…" — 유저가 새 파일명을 고르면 그 매핑을
          // 이 파일에 적어두고 승인(allow-once)한다. 훅 패치가 승인 직후 이걸
          // 읽어 write 계열 툴의 경로 파라미터를 새 이름으로 갈아끼운다.
          TWIXY_OVERWRITE_REDIRECT_FILE: need().overwriteRedirectFile,
          ...bridgeEnv,
        },
        stdio: 'pipe',
        cwd: need().getWorkspace(),
      })
      openclawProcess = proc
      // Record the PID so the NEXT launch can reclaim this process if we die
      // without running before-quit (crash, SIGKILL, power loss).
      try {
        if (proc.pid) fs.writeFileSync(need().gatewayPidFile, String(proc.pid))
      } catch (err) {
        console.warn('[twixy] could not write gateway pid file:', err)
      }
      // Only clear the file if it still names THIS process: a respawn (mode
      // change) writes the new pid before the old child's exit event fires,
      // and an unconditional delete there would silently drop the new run's
      // orphan protection.
      proc.on('exit', () => {
        try {
          if (fs.readFileSync(need().gatewayPidFile, 'utf8').trim() === String(proc.pid)) {
            fs.rmSync(need().gatewayPidFile, { force: true })
          }
        } catch { /* already gone */ }
      })

      // Clear log at each fresh start so the file reflects the latest run
      need().setOpenClawLogBuffer(`[twixy] Starting openclaw: ${node22} ${openclawMjs}\n`)

      proc.stdout?.on('data', (data: Buffer) => {
        const out = data.toString()
        console.log('[openclaw]', out.trimEnd())
        need().appendOpenClawLog(out)
        // Gateway is ready when it starts listening
        if (out.includes('listening on ws://')) {
          sawListening = true
          // Small delay to let token be written to config
          setTimeout(() => done(), 300)
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString()
        console.error('[openclaw err]', msg.trimEnd())
        need().appendOpenClawLog('[stderr] ' + msg)

        // openclaw 의 게이트웨이 로그는 stderr 로 나온다 — 준비 완료 신호를
        // stdout 에서만 보던 탓에 정상 기동조차 12초 타임아웃으로 resolve 됐다.
        if (msg.includes('listening on ws://')) {
          sawListening = true
          setTimeout(() => done(), 300)
        }
        // 락 충돌. 원인을 기억해 뒀다가 타임아웃 메시지에 그대로 싣는다.
        if (msg.includes('gateway already running') || msg.includes('already running under')) {
          sawLockConflict = true
        }

        if (msg.includes('Node.js') && msg.includes('required')) {
          const ver = msg.match(/current: (v[\d.]+)/)?.[1] ?? 'unknown'
          done(new Error(`Node 22+ required (current: ${ver})`))
        }
        if (msg.includes('Config invalid')) {
          done(new Error('openclaw.json config error'))
        }
        // Detect OpenRouter auth failure mid-session and hot-refresh the key.
        // The error text is "No API key found for provider "openrouter"" which
        // appears when the stored key has expired or been revoked.
        if (
          need().loadTwixyMode() === 'twixy' &&
          msg.includes('No API key found for provider "openrouter"')
        ) {
          void refreshOpenRouterKey()
        }
        // Detect daily budget exhaustion. OpenRouter returns 403 "Key limit
        // exceeded" when the user's daily USD cap is hit. The key is still
        // valid — it just needs a daily reset — so refreshing it won't help.
        // Notify the renderer so it can surface a clear message instead of
        // leaving the user stuck on an infinite spinner.
        if (
          need().loadTwixyMode() === 'twixy' &&
          msg.includes('Key limit exceeded')
        ) {
          need().getMainWindow()?.webContents.send('openrouter-limit-exceeded')
        }
      })

      proc.on('error', (err) => {
        need().appendOpenClawLog(`[process error] ${err}\n`)
        done(err)
      })
      proc.on('exit', (code, signal) => {
        need().appendOpenClawLog(`[exit] code=${code} signal=${signal}\n`)
        // Any exit before the gateway emitted "listening on ws://" is a failure,
        // even exit code 0 (openclaw printed help text and quit, wrong invocation, etc.)
        done(new Error(`OpenClaw exited early: code=${code} signal=${signal}`))
        // 기동에 성공한 뒤의 종료라면 감시가 맡는다. 의도한 종료는 openclawProcess 가
        // 이미 null(또는 새 프로세스)이라 여기 걸리지 않는다.
        if (openclawProcess === proc && gatewaySupervised) {
          openclawProcess = null
          handleGatewayDied(`code=${code} signal=${signal}`)
        }
      })
    })()

    // 기동 예산. 예전엔 12초 뒤 무조건 done() 이라 실패한 기동도 "ready" 로
    // 넘어갔다 — 락 충돌로 게이트웨이가 아예 안 떴는데도. 그렇다고 12초에
    // 실패로 못 박으면 정상 기동을 죽인다(실측: config 덮어쓰기 + 워밍업까지
    // 14초). 그래서 리스닝 증거가 나올 때까지 기다리고, 예산을 다 써야 실패로
    // 본다. 자식이 먼저 죽는 경우는 proc.on('exit') 가 이미 reject 한다.
    // 폴링은 플래그만 본다 — lsof(execSync) 는 메인 스레드를 막으므로 마지막에
    // 딱 한 번, 예산이 끝났을 때만 돌린다.
    const START_BUDGET_MS = 45000
    const startedAt = Date.now()
    const tick = setInterval(() => {
      if (resolved) { clearInterval(tick); return }
      if (sawListening) { clearInterval(tick); done(); return }
      if (Date.now() - startedAt < START_BUDGET_MS) return
      clearInterval(tick)
      // 로그 한 줄을 놓쳤을 뿐 실제로는 떠 있을 수 있다 — 포트로 최종 확인.
      const pid = openclawProcess?.pid ?? 0
      if (pid && need().listenersOn(need().gatewayPort).includes(pid)) return done()
      const holder = need().listenersOn(need().gatewayPort).find((n) => n !== pid)
      done(new Error(
        sawLockConflict || holder
          ? `gateway lock conflict: :${need().gatewayPort} is held by pid ${holder ?? 'unknown'} (another ${PRODUCT.displayName}, or a leftover gateway). Quit it, then retry.`
          : `gateway did not start within ${START_BUDGET_MS / 1000}s (nothing listening on :${need().gatewayPort})`,
      ))
    }, 500)
  })
}

export function stopOpenClaw() {
  // 의도한 종료 — 감시가 죽음으로 오해해 되살리지 않도록 먼저 끈다.
  gatewaySupervised = false
  clearGatewayTimers()
  stopUsageSyncTimer()
  // Final usage sync before the process dies.
  void syncOpenRouterUsage()
  // Live-preview holds a CDP WebSocket to the same Chrome — kill it before the
  // gateway goes down so we don't sit on a dead socket. If the panel is still
  // open on the renderer side, reset() will re-start the streams on the fresh
  // Chrome after startOpenClaw runs again.
  void browserPreview.reset()
  openclawProcess?.kill()
  openclawProcess = null
  // Sweep the headless Chrome the agent launched so quitting leaves nothing
  // behind (otherwise it lingers until the next launch reaps it). This is the
  // same marker-scoped kill we run at startup — it only matches processes whose
  // --user-data-dir lives under ~/.openclaw/browser/*, i.e. OUR managed Chrome,
  // never the user's personal Chrome.
  need().killLingeringManagedChrome()
}


// ── main.ts 가 쓰는 상태 접근자 ─────────────────────────────────────────────
// 저장소는 이 모듈 하나. 밖에서는 직접 대입하지 않는다.

/** 현재 게이트웨이 자식 프로세스 (없으면 null). */
export function getGatewayProcess(): ChildProcess | null { return openclawProcess }
/** 참조만 비운다 — 이미 죽인 프로세스를 감시가 크래시로 오해하지 않게. */
export function clearGatewayProcess(): void { openclawProcess = null }

/** 종료 중 표시. 켜지면 감시가 게이트웨이를 되살리지 않는다. */
export function setAppQuitting(v: boolean): void { appQuitting = v }

/** 게이트웨이와 함께 뜬 사이드카 정리 (before-quit 전용). */
export function closeToolBridge(): void {
  if (toolBridge) { void toolBridge.close(); toolBridge = null }
}
export function closeExecutionPlanApi(): void {
  if (executionPlanApi) { void executionPlanApi.close(); executionPlanApi = null }
}
