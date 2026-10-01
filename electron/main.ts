// ═════════════════════════════════════════════════════════════════════════════
// main.ts — Electron 메인 프로세스 (Node 런타임).
//
// Twixy 데스크톱 앱의 "서버 측" 전부. 역할:
//   1) 앱 라이프사이클·윈도우·트레이 관리
//   2) OpenClaw 로컬 에이전트 게이트웨이를 자식 프로세스로 띄우고 감시
//      (기본 포트 18789, WebSocket — 렌더러가 여기에 붙어 에이전트 세션 사용)
//   3) ~/.openclaw/workspace/twixy 아래의 워크스페이스 구조 준비,
//      config(openclaw.json) 주입·병합, SKILLS.md 자동 재생성
//   4) 렌더러가 window.twixy.* 로 호출하는 모든 IPC 채널의 핸들러 구현
//      (파일 I/O · 인증 · 스킬 · 세션 로그 · 사용량 · PDF 내보내기 등)
//   5) Supabase 딥링크(twixy://) 인증, OpenRouter 키 핸드아웃/갱신,
//      Tavily 검색 토큰 핸드아웃, OpenRouter 사용량 Supabase 동기화
//   6) Node 22 자동 감지/설치 (nvm, volta, fnm, homebrew, winget …)
//   7) 다운로드 폴더 감시 → 파일을 workspace/data/raw 로 정리
//   8) TSL(.tskill) 스킬 컴파일 및 감시
//
// 구조 순서 (섹션 배너 // ── X ── 로 구분되어 있음):
//   · Paths / Auth / Channels / Node22 / Workspace / TSL / Skills watcher
//   · Tavily / OpenRouter handout / usage / refresh
//   · OpenClaw gateway (spawn + health) / BrowserWindow / Tray
//   · IPC 핸들러 묶음들 (Auth, Channels, Mode, TSL, Session logs, Language …)
//   · Chrome 프로필 리브랜딩, 다운로드 후처리, 딥링크, Lifecycle, Setup
// ═════════════════════════════════════════════════════════════════════════════

import { app, BrowserWindow, ipcMain, shell, Tray, nativeImage, systemPreferences, dialog, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { spawn, execSync, ChildProcess } from 'child_process'
import https from 'https'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import * as MR from './mr'
import type { MRActor, MergeRequest, MRStatus, MRChangeInput } from './mr'
import * as Planning from './planning'
import type { Plan, PlanStatus, PlanPatch, StepEndPayload, StepCompactPayload, CreatePlanInput, Workflow, CreateWorkflowInput, WorkflowPatch, Orchestration, CreateOrchestrationInput, OrchestrationPatch, AiAgentRec, CreateAiAgentInput, AiAgentPatch } from './planning'
import { getCachedGuardrailConfig, registerGuardrailIpc } from './guardrail/ipc'
import { serializeForEnv as serializeGuardrailEnv } from './guardrail/config'
import { applyMarkup, fetchMarkup, clearMarkupCache, setSessionReader, SUPABASE_URL, SUPABASE_ANON_KEY } from './pricing'
// Single source for model catalog — kept at repo root so the renderer
// (src/lib/modelPricing.ts) and this file both consume the same prices.
// Prices are raw OpenRouter cost. End-user markup is applied separately
// at display time via electron/pricing.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const modelCatalog = require('../modelCatalog.json') as { models: unknown[] }
import { writePdf, type WritePdfPayload } from './tools/files/pdf'
import { readXlsx, writeXlsx, type WriteXlsxPayload } from './tools/files/xlsx'
import { extractFileText } from './tools/files/extractText'
import { writePptx, type WritePptxPayload } from './tools/files/pptx'
import { renderDeckSheet } from './tools/files/pptxPreview'
import { verifyWritten } from './tools/files/pptxVerify'
import { readPptx } from './tools/files/pptxRead'
import { editPptx, type PptxEditOp } from './tools/files/pptxEdit'
import { sketchDeck, shapesLabel } from './tools/files/pptxSketch'
import { renderDeckTrue, findSoffice } from './tools/files/pptxRender'
import { resolveInsideWorkspace } from './tools/files/safePath'
import { fetchToFile } from './tools/data/fetchToFile'
import { queryData } from './tools/data/queryData'
import {
  resolveFetchRequest, resolveQueryRequest,
  type FetchToFileRequest, type QueryDataRequest,
} from './tools/data/resolve'
import { resolveInsideDesignated, designatedError, setDesignatedPathsConfigResolver } from './tools/files/designatedPaths'
import {
  getCachedDesignatedPathsConfig,
  registerDesignatedPathsIpc,
} from './designated-paths/ipc'
import { serializeForEnv as serializeDesignatedPathsEnv } from './designated-paths/config'
import { buildMcpServersConfigBlock } from './connections/mcp-servers'
import { registerIntegrationsIpc } from './integrationsIpc'
import { startAgentToolBridge, type BridgeHandle } from './agent-tool-bridge'
import { postContextMarker, type LogbookMarker } from './logbook-bridge'
import {
  startExecutionPlanApi,
  parseExecutionPlan,
  type ExecutionPlanApiHandle,
  type ParsedExecutionPlan,
} from './execution-plan-api'
import { browserPreview, attachBrowserPreviewWindow, type BrowserPreviewInput } from './browserPreview'
import { isOpenable } from '../shared/fileTypes'
import { buildChannelsBlock } from './channelSecrets'
import { maskSecret, mergeSecret } from '../shared/secretMask'
import { PRODUCT } from '../shared/product/current.generated'
import { initProductIpc, runProductBeforeGateway, runProductQuit } from './product-ipc'
import { buildToolsBlock, resolveToolPermissions, type ToolsPolicy } from './toolPermissions'
import { clearActiveSessionFiles, registerSessionLogIpc } from './sessionLogs'
import { registerFileToolsIpc } from './fileToolsIpc'
import { registerDashboardIpc } from './dashboard'
import { registerLanguageCorrectionIpc } from './languageCorrection'
import { broadcastPlanChangeTo } from './planBroadcast'
import { createExecutionPlanDraft, registerPlanIpc } from './planIpc'
import { registerAiAgentIpc } from './aiAgentIpc'
import { registerOrchestrationIpc } from './orchestrationIpc'
import { registerWorkflowIpc } from './workflowIpc'
import { registerBrowserPreviewIpc } from './browserPreviewIpc'
import {
  initKeyHandout, fetchTavilyHandout, fetchOpenRouterHandout, refreshOpenRouterKey,
  patchOpenClawOpenRouterProvider, syncOpenRouterUsage, startUsageSyncTimer, stopUsageSyncTimer,
  getOpenRouterHandout, clearOpenRouterHandout, isOpenRouterKeyMissing, setOpenRouterKeyMissing,
  getOpenRouterRecoveryAttempts, setOpenRouterRecoveryAttempts, OPENROUTER_RECOVERY_MAX,
  getPrevUsdActual, setPrevUsdActual,
} from './keyHandout'
import { closeGuardrailWindow, createComposerWindow, createGuardrailWindow, createOverlayWindow, createTestOverlayWindow, closeSecondaryWindows, getWindow, initWindows, wireExternalLinks } from './windows'
import { registerOverlayIpc } from './overlayIpc'
import { registerAccountIpc } from './accountIpc'
import { registerMrIpc } from './mrIpc'
import { registerSetupIpc, getStartupErrorMsg, setStartupErrorMsg } from './setupIpc'
import { initDownloadWatcher, startDownloadWatcher } from './downloadWatcher'
import { registerEnterpriseIpc } from './enterpriseIpc'
import { registerMemoryIpc } from './memoryIpc'
import {
  initSkills, compileTskillFiles, regenerateSkillsIndex,
  startSkillsWatcher, stopSkillsWatcher, projectBundledSkills, registerSkillsIpc,
} from './skills'
import { findNode22, TWIXY_NODE_PATH } from './nodeRuntime'
import {
  initAuthSession, loadSession, saveSession, refreshStoredSession,
  fetchWithSessionRetry, handleAuthDeeplink,
} from './authSession'
import {
  initPaths, stateFile,
  OPENCLAW_DIR, CONFIG_PATH, CHANNELS_PATH, OVERWRITE_REDIRECT_FILE,
  SESSION_PATH, SESSION_PATH_LEGACY, WEB_URL,
  CHROME_PROFILE_DIR, CHROME_DISPLAY_NAME, OPENCLAW_DOWNLOADS_DIR,
  loadTwixyMode, saveTwixyMode, loadProjectDir, saveProjectDir, loadChannels, saveChannels,
  getProjectRoot, getWorkspace, getSharedDir, getTwixyMetaDir,
  executionPlanApiDiscoveryPath, loadProjectConfig, saveProjectConfig,
  loadCollabMode, generateProjectId,
  type TwixyMode, type CollabMode, type ProjectConfig,
} from './paths'

// 경로 모듈은 사용자별 워크스페이스를 정할 때 currentActor 가 필요하다 (아래 정의).
initPaths({ currentActor })
initAuthSession({ getMainWindow, chmod0600 })
initSkills({ getMainWindow, seedSharedFromBundle, projectSharedIntoUser })
initDownloadWatcher({ getMainWindow })
import {
  initGateway, startOpenClaw, stopOpenClaw, killGatewayIfRunning,
  getGatewayProcess, clearGatewayProcess, setAppQuitting,
  closeToolBridge, closeExecutionPlanApi,
} from './gateway'
import { buildTray } from './tray'
import { decodeJwtPayload, parseAuthDeeplink, type StoredSession } from './authDeeplink'
import { windowEntry, senderRejection, type EntryEnv, type WindowKind } from './windowEntry'
import { isAllowedExternalUrl, isInside, isSamePathAsAny, resolveCdpPort } from './trustBoundary'

const isDev    = process.env.NODE_ENV === 'development'

// ── 전역 런타임 상태 ────────────────────────────────────────────
let mainWindow:      BrowserWindow | null = null   // 앱 메인 윈도우 핸들

// Guardrail 팝업 윈도우용 캐시 상태. 메인 렌더러가 useGuardrail.current 변경 시
// `{ request, mode }` 를 push 하고, 우리는 최신 값을 보관 — 새로 spawn 된 팝업이
// 즉시 pull 할 수 있게 하기 위함(아니면 팝업이 빈 상태로 마운트되며 첫 요청을 놓침).
// ⚠ Stage 4 주의 — 이 참조는 main 에 **남아야** 한다. Electron 의 Tray 는 JS 쪽 참조가
// 사라지면 GC 되고 트레이 아이콘이 말없이 없어진다. 메뉴 구성은 tray.ts 로 뺐지만
// (leg 1) 참조만은 일부러 안 가져갔다. 창 모듈을 만들 때 같이 옮기고 싶어지는데,
// 증상이 "아이콘이 가끔 사라진다" 라 원인에 도달하기 어렵다.
// (docs/refactor/stage4-main-split-plan.md §5-2)
let tray:            Tray         | null = null   // 시스템 트레이 아이콘

// ── Sidetab overlay snapshot ───────────────────────────────────────
// 메인 렌더러가 채팅/플랜 상태가 변할 때마다 `overlay-sync-push` 로
// 최신 스냅샷을 보낸다. 새로 열린 overlay 윈도우는 다음 상태 변화를
// 기다리지 않고 `overlay-request-sync` 로 즉시 최신 상태를 가져갈 수 있다.
let overlaySnapshot: unknown = null

// OpenClaw stdout/stderr 롤링 로그. 터미널 없이도 UI에서 디버깅 로그를 볼 수 있게 한다.
// 메모리와 디스크 양쪽에 512KB 상한의 tail 만 유지.
const OPENCLAW_LOG_PATH = path.join(process.env.LOCALAPPDATA || os.homedir(), PRODUCT.appDataDirName, 'openclaw.log')
const MAX_LOG_BYTES = 512 * 1024  // 512 KB 롤링 상한
let openclawLogBuffer = ''

// 자격증명/토큰 파일을 소유자 전용(0600)으로 잠근다. best-effort — Windows 에서는
// chmod 가 읽기전용 비트만 반영하는 등 제한적이지만(그래도 크로스플랫폼 위생),
// 실패해도 앱 동작에는 지장이 없도록 삼켜버린다. 같은 유저로 도는 게이트웨이
// 자식 프로세스는 0600 파일도 그대로 읽을 수 있으므로 openclaw.json /
// auth-profiles.json 접근에는 영향이 없다.
function chmod0600(filePath: string) {
  try { fs.chmodSync(filePath, 0o600) } catch { /* best-effort; ignore */ }
}

// 로그에 남기기 전에 API 키·토큰류를 마스킹한다. 현재 Twixy 코드가 직접 키를
// 로깅하지는 않지만, 게이트웨이가 stdout/stderr 로 키를 흘리면 그게 openclaw.log
// 에 그대로 tee 되므로 예방적으로 접두사만 남기고 뒤를 *** 로 치환한다.
// 접두사를 남기는 이유: 어떤 provider 의 키였는지 디버깅 단서는 유지하기 위함.
const SECRET_LOG_PATTERNS: Array<{ re: RegExp; replace: (m: string) => string }> = [
  // OpenRouter (sk-or-...), Anthropic (sk-ant-...) — 접두사 보존
  { re: /sk-or-[A-Za-z0-9._-]+/g, replace: () => 'sk-or-***' },
  { re: /sk-ant-[A-Za-z0-9._-]+/g, replace: () => 'sk-ant-***' },
  // 일반 OpenAI 계열 sk-... (위 두 패턴이 먼저 소진되므로 여기선 잔여만 매칭).
  // sk-proj- / sk-svcacct- 같은 하이픈 포함 신형 포맷도 잡도록 [-_] 를 문자셋에
  // 포함하되, 오탐을 줄이려 전체 시크릿 본문이 최소 20자 이상일 때만 마스킹.
  { re: /sk-[A-Za-z0-9][A-Za-z0-9._-]{19,}/g, replace: () => 'sk-***' },
  // Slack bot/app 토큰
  { re: /xoxb-[A-Za-z0-9-]+/g, replace: () => 'xoxb-***' },
  { re: /xapp-[A-Za-z0-9-]+/g, replace: () => 'xapp-***' },
  // Authorization: Bearer <token>
  { re: /Bearer\s+[A-Za-z0-9._-]+/g, replace: () => 'Bearer ***' },
]
function maskSecrets(text: string): string {
  let out = text
  for (const { re, replace } of SECRET_LOG_PATTERNS) {
    out = out.replace(re, replace)
  }
  return out
}

// OpenClaw 출력 1줄을 받아 메모리 버퍼와 파일에 동시에 기록한다.
// 디스크 쓰기는 best-effort — 실패해도 메인 프로세스가 죽지 않도록 무시.
function appendOpenClawLog(text: string) {
  // 버퍼/디스크에 남기기 전에 시크릿 마스킹 (게이트웨이가 키를 뱉어도 파일엔 안 남게)
  openclawLogBuffer += maskSecrets(text)
  // 메모리에는 최근 MAX_LOG_BYTES 만 유지
  if (openclawLogBuffer.length > MAX_LOG_BYTES) {
    openclawLogBuffer = openclawLogBuffer.slice(-MAX_LOG_BYTES)
  }
  // 디스크에도 기록 (best-effort, 실패 무시)
  try {
    fs.mkdirSync(path.dirname(OPENCLAW_LOG_PATH), { recursive: true })
    fs.writeFileSync(OPENCLAW_LOG_PATH, openclawLogBuffer)
  } catch { /* ignore */ }
}

// 메인 프로세스 자체 콘솔 로깅에도 시크릿 마스킹을 건다 (회귀 방지).
// appendOpenClawLog 는 게이트웨이 자식 프로세스 stdout/stderr 만 마스킹하므로,
// main.ts 가 직접 찍는 console.* 는 지금까지 무마스킹이었다. 현재 코드가 apiKey 를
// 직접 로깅하진 않지만, 향후 실수로 키/토큰이 문자열 인자에 섞여 들어가도 stdout·
// stderr(및 tee 대상)로 평문이 새지 않도록 문자열 인자를 maskSecrets 로 감싼다.
// 문자열이 아닌 인자(객체/Error 등)는 포맷/색상을 바꾸지 않기 위해 그대로 통과시킨다.
function installConsoleSecretMasking() {
  const methods: Array<'log' | 'warn' | 'error' | 'info' | 'debug'> = ['log', 'warn', 'error', 'info', 'debug']
  for (const m of methods) {
    const original = console[m].bind(console)
    console[m] = (...args: unknown[]) => {
      original(...args.map(a => (typeof a === 'string' ? maskSecrets(a) : a)))
    }
  }
}
// ⚠ Stage 4 주의 — 이 호출은 **import 시점에** 일어나야 한다 (아래 즉시 호출).
// console.* 를 감싸는 시점이 곧 마스킹이 시작되는 시점이라, 모듈로 옮기거나 함수 안으로
// 미루면 그 사이에 찍힌 로그는 마스킹되지 않는다. "옮겼더니 로그에 키가 보인다" 는
// 원인을 찾기 어려운 실패라, 옮길 거면 **가장 먼저 import 되는 자리**를 보장할 것.
// (docs/refactor/stage4-main-split-plan.md §5-3)
installConsoleSecretMasking()


// Identity used as MR author / reviewer. In Phase 2 (local-only) we prefer a
// Supabase uid when the renderer has saved one on the session; otherwise we
// derive a stable machine-local id so solo/shared-folder mode still works
// offline. Phase 3 will swap this for the server-verified session.
function currentActor(): MRActor {
  const session = loadSession()
  const u = session?.user as { id?: string; email?: string } | undefined
  if (u?.id) return { uid: u.id, email: u.email }
  // Backwards compatibility: sessions saved before the parseAuthDeeplink
  // fix only contain access_token (no `user`). Decode the JWT lazily so
  // those users also get a stable Supabase-uid path without re-login.
  if (session?.access_token) {
    const claims = decodeJwtPayload(session.access_token)
    if (claims?.sub) return { uid: claims.sub, email: claims.email }
  }
  const cfg  = loadProjectConfig()
  const seed = `${os.hostname()}:${cfg?.projectId ?? 'nop'}`
  const uid  = 'local_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)
  return { uid }
}

// Copy a file using APFS clonefile (zero-byte COW) where supported, falling
// back cleanly on non-APFS filesystems (exFAT external drives, etc).
//
// Order: FICLONE_FORCE → FICLONE → plain copy. The `downgraded` flag on the
// return value lets callers log once if a whole pass falls off COW.
function safeCopyFile(src: string, dst: string): { ok: boolean; downgraded: boolean; err?: unknown } {
  // Fast path: APFS → HFS+/APFS clonefile.
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE_FORCE)
    return { ok: true, downgraded: false }
  } catch (e1) {
    // ENOTSUP / ENOSYS / EXDEV: filesystem doesn't support clonefile.
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE)
      return { ok: true, downgraded: true }
    } catch {
      try {
        fs.copyFileSync(src, dst)
        return { ok: true, downgraded: true }
      } catch (e3) {
        return { ok: false, downgraded: true, err: e3 ?? e1 }
      }
    }
  }
}


// ── Workspace + config setup — 기동 전 워크스페이스/설정 준비 ────

/** If a project root still uses the flat pre-team-collab layout (data/, skills/,
 *  SOUL.md etc. directly at the root, no user/ sibling, no .twixy/), move those
 *  contents into a new user/ subdirectory. Idempotent: does nothing if already
 *  migrated. Runs before anything else in ensureWorkspace so the rest of the
 *  code can assume the new layout. */
function migrateLegacyLayoutIfNeeded() {
  const root     = getProjectRoot()
  const userDir  = path.join(root, 'user')
  const usersDir = path.join(root, 'users')
  const metaDir  = path.join(root, '.twixy')
  if (!fs.existsSync(root)) return
  // users/ means fully migrated; user/ means intermediate (will be handled by migrateUserToUsersIfNeeded)
  if (fs.existsSync(usersDir) || fs.existsSync(userDir) || fs.existsSync(metaDir)) return

  // Signals that this is a real Twixy workspace (not a user's unrelated folder).
  const legacyMarkers = ['data', 'skills', 'strategies', 'SOUL.md', 'AGENTS.md', 'SKILLS.md']
  const hasLegacy = legacyMarkers.some(m => fs.existsSync(path.join(root, m)))
  if (!hasLegacy) return

  fs.mkdirSync(userDir, { recursive: true })
  const movable = [
    'data', 'skills', 'strategies', 'campaigns', 'reports', 'logs', 'exports',
    'SOUL.md', 'AGENTS.md', 'SKILLS.md', 'openclaw.json',
  ]
  for (const name of movable) {
    const src = path.join(root, name)
    const dst = path.join(userDir, name)
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.renameSync(src, dst) }
      catch (e) { console.warn(`[twixy/migrate] rename ${name} failed:`, e) }
    }
  }
  console.log('[twixy/migrate] flat layout → user/ subdir done')
}

/** Migrate the single user/ directory → users/[uid]/ for per-user isolation.
 *  Runs after migrateLegacyLayoutIfNeeded so that flat → user/ is always done first.
 *  Idempotent: does nothing if users/ already exists or user/ is absent. */
function migrateUserToUsersIfNeeded() {
  const root     = getProjectRoot()
  const userDir  = path.join(root, 'user')
  const usersDir = path.join(root, 'users')
  if (!fs.existsSync(userDir)) return   // nothing to migrate
  if (fs.existsSync(usersDir)) return   // already done

  const uid       = currentActor().uid
  const targetDir = path.join(usersDir, uid)
  fs.mkdirSync(targetDir, { recursive: true })

  for (const entry of fs.readdirSync(userDir)) {
    const src = path.join(userDir, entry)
    const dst = path.join(targetDir, entry)
    if (!fs.existsSync(dst)) {
      try { fs.renameSync(src, dst) }
      catch (e) { console.warn(`[twixy/migrate-users] rename ${entry} failed:`, e) }
    }
  }

  try { fs.rmdirSync(userDir) } catch { /* non-empty if any rename failed — leave it */ }
  console.log(`[twixy/migrate] user/ → users/${uid}/ done`)
}

/** Seed shared/skills/ from the bundled app resources. Re-seeded every launch
 *  so built-in skill updates (shipped with app version bumps) land in shared.
 *  Returns the bundle's skill names — the built-in set that is safe to
 *  auto-project into user workspaces (unlike teammate-shared skills).
 *  Phase 3 will replace the bundle source with server-driven snapshots. */
function seedSharedFromBundle(): string[] {
  const sharedDir       = getSharedDir()
  const sharedSkillsDir = path.join(sharedDir, 'skills')
  fs.mkdirSync(sharedSkillsDir, { recursive: true })

  if (!PRODUCT.features.bundledSkills) return []
  const bundleSkills = isDev
    ? path.join(__dirname, '..', 'skills')
    : path.join(process.resourcesPath, 'skills')
  if (!fs.existsSync(bundleSkills)) return []

  const seeded: string[] = []
  for (const skill of fs.readdirSync(bundleSkills)) {
    const srcSkillDir = path.join(bundleSkills, skill)
    if (!fs.statSync(srcSkillDir).isDirectory()) continue
    const dstSkillDir = path.join(sharedSkillsDir, skill)
    fs.mkdirSync(dstSkillDir, { recursive: true })
    const tskill = path.join(srcSkillDir, `${skill}.tskill`)
    if (fs.existsSync(tskill)) safeCopyFile(tskill, path.join(dstSkillDir, `${skill}.tskill`))
    const md = path.join(srcSkillDir, 'SKILL.md')
    if (fs.existsSync(md)) safeCopyFile(md, path.join(dstSkillDir, 'SKILL.md'))
    seeded.push(skill)
  }
  return seeded
}

/** Project shared/skills/ into user/skills/ (APFS clonefile where available).
 *  판정·기록은 skills.ts 의 projectBundledSkills 가 한다 — 여기서는 경로만 정한다. */
function projectSharedIntoUser(only?: string[]) {
  projectBundledSkills(
    path.join(getSharedDir(), 'skills'),
    path.join(getWorkspace(), 'skills'),
    safeCopyFile,
    only,
  )
}

/** Ensure .twixy/ exists and config.json is initialized to a sensible default
 *  (solo mode) if this is the first time we see this project root. */
function ensureProjectConfig() {
  fs.mkdirSync(getTwixyMetaDir(), { recursive: true })
  fs.mkdirSync(path.join(getTwixyMetaDir(), 'snapshots'), { recursive: true })
  fs.mkdirSync(path.join(getTwixyMetaDir(), 'mr'),        { recursive: true })
  if (loadProjectConfig()) return
  saveProjectConfig({
    version:   1,
    projectId: generateProjectId(),
    mode:      'solo',
    createdAt: new Date().toISOString(),
  })
  console.log('[twixy/config] initialized .twixy/config.json (solo mode)')
}

// 매 기동 시 호출되는 ensureWorkspace 의 수행 내용:
//   1) flat 레이아웃 → user/ → users/[uid]/ 마이그레이션 + .twixy/config.json 초기화
//   2) shared/skills 시드 + user 워크스페이스로 클론 프로젝션
//   3) 과거 data/scraps → data/saved 1회성 마이그레이션
//   4) openclaw.json 을 "기존값 보존 + Twixy 강제값" 형태로 병합 작성
//      (Twixy/BYOK 모드에 따라 main/sub-agent 모델 강제, tools profile 'coding' 등)
//   5) 모바일 채널 블록 주입
//   6) SOUL.md / AGENTS.md / 기본 스킬들을 워크스페이스로 복사
//   7) 모든 .tskill 을 SKILL.md 로 컴파일, SKILLS.md 재생성
async function ensureWorkspace() {
  // Step 0a: Migrate flat pre-team-collab layout → user/.
  migrateLegacyLayoutIfNeeded()

  // Step 1: Establish the new 3-part project layout.
  // ensureProjectConfig must run before migrateUserToUsersIfNeeded so that
  // currentActor() has a stable projectId when deriving the local uid.
  fs.mkdirSync(getProjectRoot(), { recursive: true })
  ensureProjectConfig()

  // Step 0b: Migrate user/ → users/[uid]/ — runs after config is seeded.
  migrateUserToUsersIfNeeded()
  // Built-in skills auto-project into the user workspace: 없으면 넣고, 우리가 넣어 준
  // 그대로면 새 번들로 갱신하고, 사용자가 고친 파일은 건드리지 않는다(skills.ts
  // projectBundledSkills). Teammate-shared skills are NOT auto-projected — those
  // still require the explicit pull-shared IPC. Without this filter-projection
  // a new built-in (e.g. skills/pptx) sat in shared/ forever and the executor
  // never saw it in SKILLS.md (2026-08-12 incident).
  projectSharedIntoUser(seedSharedFromBundle())

  const dirs = [
    // 제품별 작업 폴더 (마케팅 데이터 vs 영상 입출력) — products/<id>/profile.ts
    ...PRODUCT.workspaceDirs,
    'logs',
    // 메인 채팅 스크롤백 + 게이트웨이 세션키 영속 (main-chat.jsonl / main-session.json)
    'chat',
    // 장기 기억: 일일 노트(memory/날짜.md) 디렉토리 + per-user 검색 인덱스(.memory) 디렉토리.
    'memory',
    '.memory',
  ]
  for (const d of dirs) fs.mkdirSync(path.join(getWorkspace(), d), { recursive: true })

  // ── 장기 기억(MEMORY.md) 시딩 ──────────────────────────────────────
  // OpenClaw 의 memory_search / memory_get 도구는 워크스페이스 루트의
  // MEMORY.md 와 memory/**/*.md 를 자동 인덱싱한다. 최초 1회만 빈 템플릿을
  // 깔아주고, 이미 존재하면(=사용자 기억 누적분) 절대 덮어쓰지 않는다.
  const memoryFile = path.join(getWorkspace(), 'MEMORY.md')
  if (!fs.existsSync(memoryFile)) {
    const memoryTemplate = [
      '# 장기 기억 (Long-term Memory)',
      '',
      '이 파일은 매 세션 시작 시 자동으로 로드되고, 대화가 길어지면 핵심 내용이 자동으로 여기 저장됩니다. 날짜별 메모는 `memory/<날짜>.md` 에 쌓입니다.',
      '',
      '## 사용자 선호',
      '',
      '## 진행 중 작업',
      '',
      '## 참고',
      '',
    ].join('\n')
    try {
      fs.writeFileSync(memoryFile, memoryTemplate, 'utf8')
    } catch (err) {
      console.warn('[twixy] MEMORY.md 시딩 실패:', err)
    }
  }

  // Migrate any pre-existing data/scraps content into data/saved (one-time
  // rename — the old folder name was retired for clarity).
  const legacy = path.join(getWorkspace(), 'data', 'scraps')
  const moved  = path.join(getWorkspace(), 'data', 'saved')
  if (fs.existsSync(legacy)) {
    try {
      for (const entry of fs.readdirSync(legacy)) {
        const from = path.join(legacy, entry)
        const to   = path.join(moved, entry)
        if (!fs.existsSync(to)) fs.renameSync(from, to)
      }
      // Remove the old folder if empty.
      if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy)
    } catch (err) {
      console.warn('[twixy] migration data/scraps → data/saved failed:', err)
    }
  }

  // Merge openclaw.json — preserve user settings (model, etc.) on every launch
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  let existingConfig: Record<string, unknown> = {}
  try {
    existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch { /* first launch or corrupted — start fresh */ }

  // Preserve the user's chosen model; fall back to default only if unset
  const existingModel = (existingConfig as { agents?: { defaults?: { model?: string } } })
    ?.agents?.defaults?.model

  // Strip out any OAuth-based model on startup — API key only.
  // In Twixy mode BOTH the main and sub-agent run on gpt-5.4-mini via
  // OpenRouter (openrouter/openai/gpt-5.4-mini). OpenRouter enforces a
  // per-key daily USD budget server-side, so we don't need to proxy
  // anything — the desktop app talks to openrouter.ai directly. We
  // override any saved model unconditionally so a user who toggles
  // BYOK→Twixy can't keep paying for the bigger gpt-5.4 against the
  // hosted budget.
  const twixyMode = loadTwixyMode()
  // NOTE: 게이트웨이 로그의 `startup model warmup failed ... Unknown model:
  // openrouter/minimax/minimax-m3` 는 무해한 경고다 — 재조사 금지.
  // openclaw 의 startup warmup 은 static model resolver 만 돌려 내장 목록
  // (MiniMax-M2.7 등)에 없는 슬러그를 못 찾고 warn 을 남긴다. 실제 추론은
  // `openrouter/` prefix 로 OpenRouter passthrough 를 타서 raw 슬러그
  // (minimax/minimax-m3)를 openrouter.ai 로 넘기므로 정상 동작한다(워크플로우
  // 테스트로 확인). modelCatalog.json 은 Twixy 전용이라 openclaw 이 안 읽는다.
  const safeModel = twixyMode === 'twixy'
    ? 'openrouter/minimax/minimax-m3'
    : (!existingModel || existingModel.startsWith('openai-codex'))
      ? 'openai/gpt-5.4'
      : existingModel

  // Sub-agent model: a smaller / cheaper / higher-TPM model used for any
  // sub-agent that the orchestrator spawns. Browser snapshots, scraping,
  // file parsing, and other "mechanical" work are delegated to sub-agents
  // so the heavy a11y trees never enter the main agent's context window.
  // Resolution: respect existing user override → otherwise gpt-5.4-mini.
  const existingSubagentModel = (existingConfig as {
    agents?: { defaults?: { subagents?: { model?: string } } }
  })?.agents?.defaults?.subagents?.model
  const safeSubagentModel = twixyMode === 'twixy'
    ? 'openrouter/google/gemini-2.5-flash-lite'
    : (!existingSubagentModel || existingSubagentModel.startsWith('openai-codex'))
      ? 'openai/gpt-5.4-mini'
      : existingSubagentModel

  // Inject mobile channels block from Twixy-managed store
  const channelsBlock = PRODUCT.features.channels ? buildChannelsBlock(loadChannels()) : {}

  // MCP client servers (Settings → 연동 → MCP 서버). Async: OAuth-brokered
  // servers may refresh a near-expiry access token here before injecting it.
  const mcpServersBlock = await buildMcpServersConfigBlock(() => app.getPath('userData'), PRODUCT.features.builtinMcp)

  // Per-agent roster. `main` is the default full-capability executor (chat,
  // workflow Test runs, orchestration members). `builder` is the Workflow /
  // Orchestration BUILDER chat persona: it designs specs, never executes —
  // `tools.deny: ["*"]` blocks every tool at the policy layer, so even if
  // the LLM ignores the SOUL "never call tools" rule (observed: it browsed
  // profiles and wrote files when the user said "update the workflow"), the
  // gateway rejects the call. Existing non-managed entries are preserved.
  // `workflow-runner` executes workflow Test nodes and orchestration members.
  // It keeps the full file/browser toolset but DENIES sub-agent spawning
  // (subagents / sessions_spawn / sessions_yield): a node is only "done" when
  // sendAndAwaitFinal returns, so any work delegated to a child session would
  // still be running while the runner moves on to the next node — observed as
  // "nodes 3-4 fired with empty outputs while the crawl sub-agent was still
  // going". Forcing inline execution makes node completion === work completion.
  // IMPORTANT: non-default agents MUST declare `workspace` explicitly.
  // openclaw's resolveAgentWorkspaceDir gives agents WITHOUT one a private
  // `~/.openclaw/workspace-<id>` dir (agents.defaults.workspace only applies
  // to the default agent). Observed: workflow-runner sessions advertised
  // workspace-workflow-runner to the LLM, it wrote absolute paths there, and
  // every file write got blocked by the designated guard.
  const existingAgentsList = ((existingConfig as { agents?: { list?: Array<Record<string, unknown>> } })
    .agents?.list ?? []).filter(e => e?.id !== 'main' && e?.id !== 'builder' && e?.id !== 'workflow-runner')
  // `reasoningDefault: 'off'` — thinking 을 off 로 내리면 openclaw 는 reasoning
  // *가시성* 기본값을 카탈로그의 reasoning 플래그에서 다시 끌어온다(reply.ts:
  // 에이전트에 reasoningDefault 가 없고 think 레벨이 off 일 때 resolveDefault
  // ReasoningLevel → 'on'). effort:'none' 이 먹으면 보여줄 추론이 아예 없어서
  // 무해하지만, 프로바이더가 이를 무시하는 날엔 채팅에 `Reasoning:` 메시지가
  // 그대로 노출된다. 명시적으로 off 를 박아 그 경로를 닫는다.
  const agentsList = [
    { id: 'main', default: true, reasoningDefault: 'off' },
    { id: 'builder', name: 'Twixy Builder', workspace: getWorkspace(), reasoningDefault: 'off', tools: { deny: ['*'] } },
    { id: 'workflow-runner', name: 'Twixy Workflow Runner', workspace: getWorkspace(), reasoningDefault: 'off', tools: { deny: ['subagents', 'sessions_spawn', 'sessions_yield'] } },
    ...existingAgentsList,
  ]

  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    ...existingConfig,          // keep anything else OpenClaw wrote (auth token, etc.)
    agents: {
      ...((existingConfig as { agents?: Record<string, unknown> }).agents ?? {}),
      list: agentsList,
      defaults: {
        ...((existingConfig as { agents?: { defaults?: Record<string, unknown> } }).agents?.defaults ?? {}),
        workspace: getWorkspace(),   // always point at Twixy workspace
        model: safeModel,       // preserve saved model selection (API key only)
        // Per-model params. OpenClaw forwards agents.defaults.models[<ref>].params
        // .provider straight into OpenRouter's provider-routing field (OpenClaw
        // #17148). The catalog entry's schema rejects `params`, so it must live
        // here, keyed by the canonical model ref (provider/model →
        // "openrouter/minimax/minimax-m3"). Sub-agent model (gemini) is unpinned.
        //
        // 2026-08: migrated MiniMax M2.7 → M3 (Fireworks is deprecating M2.7
        // serverless on 08/27). M3 is NOT served by Fireworks on OpenRouter, so
        // the old `provider.only:['fireworks']` pin is dropped — OpenRouter now
        // routes M3 to any available provider with fallbacks. All M3 providers
        // price the same ($0.30 in / $1.20 out). If provider-variance becomes a
        // problem, re-pin to a specific one (e.g. provider.only:['<slug>']).
        models: {
          ...((existingConfig as { agents?: { defaults?: { models?: Record<string, unknown> } } })
            .agents?.defaults?.models ?? {}),
          ...(twixyMode === 'twixy'
            ? {
                'openrouter/minimax/minimax-m3': {
                  // `thinking: 'off'` 는 resolveThinkingDefault 가 읽는 per-model
                  // 오버라이드다(model-selection). 이게 없으면 "추론 가능 모델"의
                  // 폴백이 `low` 라서 오히려 reasoning.effort=low 가 나간다.
                  //
                  // ⚠️ 이 값은 modelCatalog.json 의 `"reasoning": true` 와 반드시
                  // 짝으로 움직인다. openclaw 의 openai-completions 요청 빌더는
                  // `thinkingFormat === 'openrouter' && model.reasoning` 일 때만
                  // reasoning 필드를 싣고, 그때 thinking 레벨이 off 면
                  // `reasoning: { effort: 'none' }` — OpenRouter 문서상 "추론 완전
                  // 비활성화" — 를 보낸다. 카탈로그가 `reasoning: false` 면 분기가
                  // 통째로 스킵돼 아무것도 안 보내고, MiniMax 기본값(thinking ON)이
                  // 그대로 적용된다. 실제로 M2.7 시절 내내 그 상태였다(세션 jsonl
                  // 10,405개 thinking 블록 / thinkingLevel 은 전부 off).
                  // 즉 `reasoning: false` 는 "끔"이 아니라 "이 모델은 추론 기능이
                  // 없음" 선언이다 — 되돌리지 말 것.
                  params: { provider: { allow_fallbacks: true }, thinking: 'off' },
                },
              }
            : {}),
        },
        subagents: {
          ...((existingConfig as { agents?: { defaults?: { subagents?: Record<string, unknown> } } })
            .agents?.defaults?.subagents ?? {}),
          model: safeSubagentModel, // hybrid: cheap/high-TPM model for spawned sub-agents
        },
        llm: {
          ...((existingConfig as { agents?: { defaults?: { llm?: Record<string, unknown> } } })
            .agents?.defaults?.llm ?? {}),
          // 120s LLM idle timeout (default 60s). 무거운 브라우저 워크로드에서
          // tool 결과 누적 후 첫 토큰까지 60초를 넘기는 케이스가 있어서 상향.
          idleTimeoutSeconds: 120,
        },
        // Heartbeat 끄기. openclaw 는 heartbeat 설정이 없는 기본 에이전트를 30분마다 깨워
        // "HEARTBEAT.md 를 읽고 따르라" 고 시킨다 — 사용자 입력 없이 에이전트가 혼자 돌고
        // (크레딧 소모), 서브에이전트까지 띄우던 원인이었다. 개발 PC 의 openclaw.json 만
        // 손으로 고쳐져 있었고, 새로 설치한 사용자·새 상태 폴더에서는 다시 켜진 채로 떴다.
        // every:"0" → everyMs null → 비활성.
        heartbeat: {
          ...((existingConfig as { agents?: { defaults?: { heartbeat?: Record<string, unknown> } } })
            .agents?.defaults?.heartbeat ?? {}),
          every: '0',
        },
        // ── 메모리 검색 인덱스 per-user 격리 ───────────────────────────
        // OpenClaw 기본값은 `~/.openclaw/memory/{agentId}.sqlite` 인데
        // (docs/reference/memory-config.md "Index storage" 표, store.path 행),
        // 우리는 agentId 를 'main' 으로 고정 사용하므로 이 전역 경로를 그대로
        // 두면 같은 머신의 여러 사용자가 하나의 SQLite 인덱스를 공유해 키워드
        // FTS 결과가 서로 섞인다. 인덱스를 사용자 워크스페이스 하위(.memory)로
        // 옮겨 격리한다. {agentId} 토큰은 그대로 둬서 멀티 에이전트도 안전.
        // store.fts.tokenizer 는 같은 문서의 "Index storage" 표에 정의 — 한국어는
        // unicode61 로는 BM25 매칭이 약하므로 trigram 으로 지정(CJK 권장값).
        memorySearch: {
          ...((existingConfig as { agents?: { defaults?: { memorySearch?: Record<string, unknown> } } })
            .agents?.defaults?.memorySearch ?? {}),
          store: {
            ...((existingConfig as { agents?: { defaults?: { memorySearch?: { store?: Record<string, unknown> } } } })
              .agents?.defaults?.memorySearch?.store ?? {}),
            path: path.join(getWorkspace(), '.memory', '{agentId}.sqlite'),
            fts: {
              ...((existingConfig as { agents?: { defaults?: { memorySearch?: { store?: { fts?: Record<string, unknown> } } } } })
                .agents?.defaults?.memorySearch?.store?.fts ?? {}),
              tokenizer: 'trigram',
            },
          },
        },
      },
    },
    // Always write `channels` explicitly (even empty) so disabling a channel
    // in the UI actually removes it. Without this, stale `channels.discord`
    // from a previous ON state would survive the `...existingConfig` spread
    // above and keep the gateway demanding DISCORD_BOT_TOKEN on startup.
    channels: channelsBlock ?? {},
    // Tool policy — must use the "coding" profile so that the `subagents` tool
    // (and sessions_spawn / sessions_yield) are exposed to the main agent.
    // Without this, OpenClaw's default profile omits subagents entirely, so
    // delegation in SOUL.md silently does nothing and the main model just
    // does the heavy work itself (blowing the TPM budget).
    // Tool policy — 계산은 electron/toolPermissions.ts 의 buildToolsBlock 하나가 한다.
    // 렌더러가 읽는 get-tool-permissions 도 **여기서 쓴 결과물**(openclaw.json 의 tools)을
    // 되읽어 해석하므로, 프롬프트 쪽이 PRODUCT.features 로 따로 추론할 일이 없다.
    //
    // profile:'coding' 이어야 subagents / sessions_spawn / sessions_yield 가 노출된다.
    // 기본 프로필은 subagents 를 빼 버려서 SOUL.md 의 위임이 조용히 무력화되고 메인 모델이
    // 직접 다 하게 된다(TPM 폭발). fs.workspaceOnly 로 네이티브 read/write/edit 를
    // 워크스페이스 루트에 가둔다 — designated-path 가드(어느 하위 폴더냐)보다 강한 경계다.
    tools: buildToolsBlock(
      PRODUCT.features,
      (existingConfig as { tools?: Parameters<typeof buildToolsBlock>[1] }).tools,
    ),
    gateway: {
      // 기존 openclaw.json 의 gateway 블록을 보존한다 — 특히 gateway.auth.token.
      // 이 스프레드가 없으면 아래 리터럴이 gateway 를 통째로 덮어써 매 rewrite 마다
      // auth.token 이 사라지고, 게이트웨이가 "token missing" 으로 재생성하며 config
      // 의 gateway.auth 가 바뀐다 → openclaw 가 gateway 재시작(restart) → Windows
      // in-process 재시작 불안정 → 렌더러 WS 끊김/로그인 흔들림. 로그인 때 uid 가
      // 바뀌어 ensureWorkspace 가 재실행되면 매번 이 사이클이 돌았다. (다른 블록
      // agents/tools/mcp 와 동일한 read-modify-write 패턴.)
      ...((existingConfig as { gateway?: Record<string, unknown> }).gateway ?? {}),
      port: GATEWAY_PORT,
      mode: 'local',
      controlUi: {
        // 보안: 게이트웨이는 loopback(127.0.0.1:18789) 전용 + 토큰 인증. control-ui
        // 는 항상 insecureAuth 를 허용한다(=device identity 없이 토큰만으로 연결).
        //
        // ⚠ 왜 isDev 가 아니라 항상 true 인가:
        // openclaw 의 control-ui device-identity 게이트(evaluateMissingDeviceIdentity)
        // 는 토큰 검사보다 *먼저* 발동한다. 렌더러는 getGatewayToken() 토큰만 보내고
        // device identity(SubtleCrypto 키쌍)는 만들지 않으므로, allowInsecureAuth 가
        // false 면 이 게이트가 handshake 를 1008 "control ui requires device identity"
        // 로 즉시 끊는다 — 토큰이 있어도 소용없다. 그래서 예전 `isDev` 값은 패키징
        // 빌드에서 UI 가 게이트웨이에 아예 못 붙게 만들었다(스모크테스트에서 확인).
        // loopback 전용(isLocalClient 항상 true) + 토큰이라 openclaw 자체 audit 도 이
        // 조합을 warn(=허용가능)으로 본다. 진짜 device identity 를 심으려면 렌더러를
        // secure context(커스텀 secure 스킴 or http://localhost)로 서빙하고 키쌍을
        // mint 해야 하는데, 그건 별도 큰 작업이라 후속 과제.
        allowInsecureAuth: true,
        // production 빌드의 BrowserWindow 는 `loadFile()` 로 띄워져 WS
        // 핸드셰이크의 Origin 헤더가 `file://` 로 박힌다. openclaw 의
        // origin check 는 `new URL(origin).origin` 으로 정규화하는데
        // Node 의 URL 파서는 `file://` 를 → `"null"` (HTML opaque-origin
        // spec) 으로 만든다. 그래서 allowlist 에 `"null"` 이 들어가 있어야
        // 매칭된다. 없으면 1008 "origin not allowed" 로 reject → UI offline.
        // dev (vite) 는 `http://localhost:5173` origin 이라 같이 등록.
        allowedOrigins: ['null', 'file://', 'http://localhost:5173', 'http://127.0.0.1:5173'],
      },
    },
    browser: !PRODUCT.features.browser ? { enabled: false } : {
      enabled: true,
      // ALWAYS headless. Chrome never opens an OS window, so it can never steal
      // focus or jump in front of whatever the user is doing. The user watches
      // AND drives the browser entirely through the in-app LiveBrowserPreview
      // panel (frames via CDP screencast, clicks/keys forwarded via CDP Input).
      // This is the same model as Browser Use / Manus.
      //
      // We do NOT toggle this at runtime: OpenClaw reads browser.* from an
      // in-memory config snapshot (getRuntimeConfigSnapshot), so a disk rewrite
      // is ignored without a full gateway reload. Keeping it permanently
      // headless sidesteps that entirely — no reload, no window, ever.
      headless: true,
      // NOTE: profile key MUST be "openclaw" — OpenClaw bakes that as the
      // default browser profile name and silently injects it back if missing.
      // The Chrome display name is rebranded separately by
      // patchChromeProfileDisplayName() below.
      // driver: 'openclaw' (local-managed) — OpenClaw owns Chrome launch and
      // connects via CDP JSON endpoints. (existing-session was tried and
      // rejected: it uses the Chrome-MCP attach path that needs a
      // DevToolsActivePort file + pre-existing tabs, which doesn't fit an
      // automation-launched Chrome.)
      profiles: {
        openclaw: {
          driver: 'openclaw',
          cdpPort: PRODUCT.cdpPort,
          color: '#7C3AED',
        },
        // "twixy" alias — same underlying Chrome instance, lets the model
        // pass profile: "twixy" without falling back to the openclaw key.
        twixy: {
          driver: 'openclaw',
          cdpPort: PRODUCT.cdpPort,
          color: '#7C3AED',
        },
        // ── Workflow Test slot pool (parallel runs, max 3) ─────────────
        // Each slot is an INDEPENDENT Chrome instance: own cdpPort + own
        // user-data-dir (~/.openclaw/browser/wf-N/user-data, auto-derived).
        // A running workflow Test leases one slot; the openclaw hook patch
        // force-overrides `params.profile` for that run's session so its
        // browser calls always land on its own Chrome (see
        // TWIXY_BROWSER_SLOTS_FILE + patches/openclaw+*.patch). Chat keeps
        // using the default `openclaw` profile @18800 — fully separate.
        ...Object.fromEntries(PRODUCT.workflowCdpPorts.map((cdpPort, i) => [
          `wf-${i + 1}`,
          { driver: 'openclaw', cdpPort, color: WF_SLOT_COLORS[i % WF_SLOT_COLORS.length] },
        ])),
      },
    },
    // MCP client servers (Settings → 연동 → MCP 서버). OpenClaw's embedded Pi
    // runtime reads cfg.mcp.servers and auto-materializes each server's tools
    // (exposed as <safeServerName>__<toolName>) — no tools.profile/allow edits
    // needed. Always write the block (even empty {}) so removing the last
    // server in the UI actually clears stale mcp.servers that would otherwise
    // survive the ...existingConfig spread above and keep the gateway trying to
    // reach a server the user deleted.
    mcp: {
      ...((existingConfig as { mcp?: Record<string, unknown> }).mcp ?? {}),
      servers: mcpServersBlock,
    },
    // Cron — Gateway 내장 스케줄러. Twixy 의 "예약 작업" 기능이 렌더러 WS 로
    // 잡을 CRUD 하려면 cron.enabled=true 여야 한다. 기존 cron 설정(store/retry 등)
    // 은 보존하고 enabled 만 보장한다. 이 값은 다음 startOpenClaw spawn 부터 반영
    // 되므로 신규 설치/첫 기동에서 자연히 켜진다(잡 스토어 자체는 핫리로드).
    cron: {
      ...((existingConfig as { cron?: Record<string, unknown> }).cron ?? {}),
      enabled: PRODUCT.features.cron,
    },
  }, null, 2))
  // openclaw.json 은 OpenRouter apiKey 등 자격증명을 담으므로 소유자 전용 권한.
  chmod0600(CONFIG_PATH)

  // Copy SOUL.md + AGENTS.md into user/ — these are personal per Open Question #9
  // (docs/TEAM_COLLAB_OPEN_QUESTIONS.md). Phase 2 may relocate to shared/ with MR flow.
  // 어떤 SOUL/AGENTS 를 심을지는 제품이 정한다. 패키징 때는 electron-builder 설정이 그
  // 폴더의 두 파일을 resources 루트로 복사하므로 패키지 안 경로는 제품과 무관하다.
  const resDir = isDev ? path.join(__dirname, '..', PRODUCT.workspaceSeedDir) : process.resourcesPath
  for (const f of ['SOUL.md', 'AGENTS.md']) {
    const src = path.join(resDir, f)
    if (fs.existsSync(src)) safeCopyFile(src, path.join(getWorkspace(), f))
  }

  // Built-in skills were projected into user/skills/ above (missing-only APFS
  // clone from shared/skills/). Compile any .tskill → SKILL.md in user/skills/.
  compileTskillFiles(path.join(getWorkspace(), 'skills'))

  // Migrate custom skills from skills/custom/<name>/ → skills/<name>/ (one-time, idempotent)
  const legacyCustomDir = path.join(getWorkspace(), 'skills', 'custom')
  if (fs.existsSync(legacyCustomDir)) {
    for (const name of fs.readdirSync(legacyCustomDir)) {
      const src  = path.join(legacyCustomDir, name)
      const dest = path.join(getWorkspace(), 'skills', name)
      if (!fs.statSync(src).isDirectory()) continue
      if (!fs.existsSync(dest)) {
        fs.renameSync(src, dest)
        // Mark as user-created
        fs.writeFileSync(path.join(dest, '.twixy-custom'), '', 'utf8')
        console.log(`[skills] Migrated custom skill: ${name}`)
      }
    }
    // Remove legacy dir if empty
    try {
      if (fs.readdirSync(legacyCustomDir).length === 0) fs.rmdirSync(legacyCustomDir)
    } catch { /* ignore */ }
  }

  // Always regenerate SKILLS.md on startup so the agent has the latest index
  regenerateSkillsIndex()
}

const AUTH_PROFILES_PATH_EARLY = path.join(OPENCLAW_DIR, 'agents', 'main', 'agent', 'auth-profiles.json')


// Kill any leftover Chrome instances that OpenClaw launched in a previous run.
// Rationale: Chrome flags (--headless=new above all) apply only at launch. If a
// prior headful Chrome is still alive with our user-data-dir, OpenClaw attaches
// to it via CDP and the new `browser.headless: true` config has zero effect.
// This is scoped to Twixy's own user-data-dir tree (~/.openclaw/browser/*/
// user-data), so the user's personal Chrome is never touched.
function killLingeringManagedChrome(): void {
  if (!PRODUCT.features.browser) return
  const marker = path.join(OPENCLAW_DIR, 'browser') // matches every profile subdir
  try {
    if (process.platform === 'win32') {
      // PowerShell — Stop-Process by matching command line substring.
      execSync(
        `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { timeout: 5000, stdio: 'ignore' },
      )
    } else {
      // pkill returns exit 1 when nothing matched — expected, swallow it.
      execSync(`pkill -f "${marker}" || true`, { timeout: 5000, stdio: 'ignore', shell: '/bin/sh' })
    }
  } catch (err) {
    // Never fatal — worst case the user gets the old headful Chrome for this
    // session and has to restart once more.
    console.warn('[twixy] killLingeringManagedChrome failed:', err)
  }
}

const GATEWAY_PORT = PRODUCT.gatewayPort
const WF_SLOT_COLORS = ['#10B981', '#F59E0B', '#3B82F6']
/** Handoff file: the PID of the gateway WE spawned, so the next launch can tell
 *  our orphan apart from a gateway the user runs themselves. */
const GATEWAY_PID_FILE = stateFile('gateway.pid')

/** PIDs currently LISTENING on `port`. Empty on any failure — the caller must
 *  treat "unknown" as "do not kill". */
function listenersOn(port: number): number[] {
  try {
    const out = process.platform === 'win32'
      ? execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, { timeout: 5000, windowsHide: true }).toString()
      : execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { timeout: 5000, shell: '/bin/sh' }).toString()
    return [...out.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 1)
  } catch {
    return []   // nothing listening (lsof exits 1) — or the probe itself failed
  }
}

/**
 * Kill the gateway left behind by a PREVIOUS run of this app.
 *
 * before-quit → stopOpenClaw() already kills the child on a normal exit, but an
 * ABNORMAL death never runs it: on 2026-08-16 a Pango abort inside the deck-QA
 * rasterizer took electron main down with SIGABRT, its gateway child was
 * reparented to PID 1, and it kept holding :18789. Every later launch then sat
 * in openclaw's lock-conflict retry loop ("already running…; waiting 5000ms")
 * forever — a crash that permanently broke startup, surviving app restarts.
 * Same class of problem as killLingeringManagedChrome(), so it gets the same
 * treatment: sweep at startup, right before spawning.
 *
 * 두 갈래로 회수한다. ① spawn 때 기록한 PID 이고 지금도 우리 포트를 LISTEN
 * 중일 때 — 재활용된 PID 는 두 번째 조건에서, 유저가 직접 띄운 게이트웨이는
 * 첫 번째 조건에서 걸러진다. ② PID 파일이 없거나 안 맞는데 포트는 잡혀 있고,
 * 그 점유자가 ppid=1 인 openclaw gateway 일 때 — ①만 있던 원래 버전은 종료
 * 훅이 PID 파일을 먼저 지운 경우를 못 잡아 같은 무한 루프가 재발했다.
 * 어느 쪽도 "모르는 프로세스" 는 죽이지 않는다.
 */
function reclaimOrphanGateway(): void {
  // ① 우리가 spawn 때 적어둔 PID — 정상 경로.
  let pid = 0
  try { pid = Number(fs.readFileSync(GATEWAY_PID_FILE, 'utf8').trim()) } catch { pid = 0 }
  if (Number.isInteger(pid) && pid > 1) {
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    if (!alive) {
      fs.rmSync(GATEWAY_PID_FILE, { force: true })
    } else if (listenersOn(GATEWAY_PORT).includes(pid)) {
      console.log(`[twixy] reclaiming orphaned gateway pid=${pid} (pid file — previous run died without cleanup)`)
      killGatewayPid(pid)
      fs.rmSync(GATEWAY_PID_FILE, { force: true })
      // 일부러 return 하지 않는다 — ①을 치우자마자 다른 고아가 그 포트를 낚아채는
      // 걸 실측했다(재시도 루프에 갇혀 있던 옛 게이트웨이). ②까지 마저 쓸어야
      // 이번 spawn 이 빈 포트로 들어간다.
    }
  }

  // ② PID 파일이 없는데 포트는 잡혀 있는 경우. 이 구멍이 남아 있어서 2026-08-16
  //    수정 이후에도 같은 무한 재시도 루프가 재발했다 — 게이트웨이가 스스로
  //    새 PID 로 재시작하거나(OPENCLAW_NO_RESPAWN 으로 이제 막았다) 종료 훅이
  //    먼저 돌아 파일을 지우면, 정작 포트를 쥔 프로세스의 PID 를 아무도 모른다.
  //    그래서 포트에서 역추적하되 "고아인 openclaw 게이트웨이" 임이 증명될 때만
  //    죽인다: ppid=1 (부모가 이미 죽음) + argv 가 openclaw gateway.
  //    유저가 자기 터미널에서 띄운 게이트웨이는 ppid 가 그 셸이라 살아남는다.
  for (const holder of listenersOn(GATEWAY_PORT)) {
    if (holder === process.pid) continue
    const facts = processFacts(holder)
    if (!facts) continue                                   // 알 수 없으면 건드리지 않는다
    if (facts.ppid !== 1) continue                         // 살아있는 부모가 있다 = 고아 아님
    if (!/openclaw/i.test(facts.command)) continue
    if (!/\bgateway\b/.test(facts.command)) continue
    console.log(`[twixy] reclaiming orphaned gateway pid=${holder} (ppid=1) — ${facts.command.slice(0, 100)}`)
    killGatewayPid(holder)
  }
}

/** ps 로 본 프로세스 사실. 실패하면 null — 호출부는 "모르면 안 죽인다". */
function processFacts(pid: number): { ppid: number; command: string } | null {
  if (process.platform === 'win32') return null   // ②는 posix 전용 (ppid 재양육 개념이 없다)
  try {
    const out = execSync(`ps -p ${pid} -o ppid=,command=`, { timeout: 5000, shell: '/bin/sh' }).toString().trim()
    const m = /^(\d+)\s+([\s\S]*)$/.exec(out)
    return m ? { ppid: Number(m[1]), command: m[2] } : null
  } catch {
    return null
  }
}

/** SIGTERM → 포트가 풀릴 때까지 대기 → 안 풀리면 SIGKILL.
 *  일부러 블로킹한다: startOpenClaw 이 아직 점유된 포트로 spawn 하면 안 된다.
 *  `sleep` 서브프로세스 대신 Atomics.wait — 이 경로는 Windows 에서도 돈다. */
function killGatewayPid(pid: number): void {
  try { process.kill(pid, 'SIGTERM') } catch { /* raced with its own exit */ }
  const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  for (let i = 0; i < 20 && listenersOn(GATEWAY_PORT).includes(pid); i++) {
    sleepSync(250)
    if (i === 8) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
}

// ── 창 진입 페이지 ───────────────────────────────────────────────
// 각 창이 무엇을 로드하는지는 windowEntry() 한 곳에서 정한다 (dev = Vite URL, 패키지 = dist 파일).
// IPC 발신자 검증도 같은 함수로 "이 창의 페이지가 맞는가" 를 본다 — 로더와 검증기가 따로
// 계산하면 언젠가 어긋나고, 어긋나면 정상 창의 호출이 거부된다.
const entryEnv = (): EntryEnv => ({ isDev, distDir: path.join(__dirname, '..', 'dist'), mainHtmlEntry: PRODUCT.htmlEntry })

function loadWindowEntry(win: BrowserWindow, kind: WindowKind) {
  const entry = windowEntry(kind, entryEnv())
  return entry.type === 'url' ? win.loadURL(entry.url) : win.loadFile(entry.path)
}
// ── IPC 발신자 검증 ──────────────────────────────────────────────
// 5개 창이 같은 preload 를 쓰므로 어느 창이든 모든 채널을 부를 수 있다. 민감한 채널은 핸들러
// 첫 줄에서 senderBlocked() 로 "그 채널을 실제로 쓰는 창" 만 통과시킨다. 판정 로직은 순수 모듈
// windowEntry.ts (표 기반 테스트) — 여기는 Electron 이벤트에서 사실을 뽑아 넘기는 어댑터일 뿐.
// 창 조회는 windows.ts 의 getWindow() 하나뿐이다 — 창을 만드는 코드와 **같은 보관소**를
// 읽는다. 여기서 별도 목록을 들고 있으면 어긋나는 순간 정상 창이 거부되고, 증상은
// "게이트웨이에 안 붙는다" 로만 보인다 (windows.contract.test.ts 가 이 성질을 지킨다).
const windowOf = getWindow

let blockedSenderLogged = 0   // 기동당 파일 로그에 남긴 거부 횟수 (아래 상한 참고)

/** 허용된 창이 자기 페이지의 메인 프레임에서 부른 게 아니면 true (+ 로그 한 줄: 채널·사유만,
 *  payload·URL 없음). 호출부는 그 핸들러의 기존 실패 반환 형태로 돌려준다. */
function senderBlocked(e: IpcMainInvokeEvent, channel: string, kinds: WindowKind[]): boolean {
  let reason: string | null
  try {
    const allowed = kinds.flatMap(kind => {
      const w = windowOf(kind)
      return w && !w.isDestroyed() ? [{ kind, webContentsId: w.webContents.id, entry: windowEntry(kind, entryEnv()) }] : []
    })
    const f = e.senderFrame
    reason = senderRejection(
      { webContentsId: e.sender.id, frame: f ? { isMainFrame: f.parent === null, url: f.url } : undefined },
      allowed,
    )
  } catch {
    reason = 'sender could not be inspected'   // 프레임이 폐기되는 중 등 — 확인 못 하면 거부
  }
  if (reason) {
    const line = `[twixy/ipc] blocked ${channel}: ${reason}`
    console.warn(line)
    // 패키지 앱에서는 main 의 console 을 볼 방법이 없다. 이 검증이 **정상 창을** 거부하면 증상이
    // "게이트웨이에 안 붙는다 / 승인이 안 눌린다" 로만 보이므로, 사용자가 꺼낼 수 있는 로그
    // (Setup 화면의 Open log)에도 남긴다. appendOpenClawLog 는 호출마다 파일을 통째로 다시 쓰므로
    // 적대적인 창이 연타해도 디스크를 두들기지 못하게 기동당 횟수를 제한한다.
    if (blockedSenderLogged < 20) { blockedSenderLogged++; appendOpenClawLog(line + '\n') }
  }
  return reason !== null
}


// ── BrowserWindow — 메인 윈도우 생성 ─────────────────────────────
// 프레임리스 윈도우 + preload.ts 연결. 개발 모드면 Vite dev 서버,
// 프로덕션이면 dist/index.html 을 로드한다.
// 창 모듈에 필요한 것을 건넨다. **창을 만들기 전에** 불려야 한다 — 안 부르면 창 생성이
// throw 한다(조용히 어긋나는 것보다 낫다). __dirname 해석을 여기서 하는 이유는 번들
// 레이아웃을 아는 쪽이 main 이라서다.
initWindows({
  isDev,
  preloadPath: path.join(__dirname, 'preload.js'),
  loadWindowEntry,
  getMainWindow: () => mainWindow,
})

// 자격증명 핸드아웃은 게이트웨이 기동 전에 준비돼 있어야 한다 (기동이 키를 가져간다).
initKeyHandout({
  webUrl:     WEB_URL,
  configPath: CONFIG_PATH,
  loadSession,
  loadTwixyMode,
  fetchWithSessionRetry,
  chmod0600,
  startOpenClaw,
  getGatewayProcess,
  clearGatewayProcess,
})

// 게이트웨이 수명주기는 gateway.ts 가 소유한다 — openclawProcess 와 감시 상태의
// 저장소가 거기다. 이 호출이 빠지면 첫 기동에서 throw 한다.
initGateway({
  isDev,
  configPath:  CONFIG_PATH,
  openclawDir: OPENCLAW_DIR,
  gatewayPort: GATEWAY_PORT,
  gatewayPidFile: GATEWAY_PID_FILE,
  authProfilesPathEarly: AUTH_PROFILES_PATH_EARLY,
  overwriteRedirectFile: OVERWRITE_REDIRECT_FILE,
  getBrowserSlotsFile: () => BROWSER_SLOTS_FILE,
  getPlanIpcDeps:      () => planIpcDeps,
  getMainWindow,
  getStartupErrorMsg,
  setStartupErrorMsg,
  setOpenClawLogBuffer: (v) => { openclawLogBuffer = v },
  getWorkspace,
  getTwixyMetaDir,
  appendOpenClawLog,
  chmod0600,
  executionPlanApiDiscoveryPath,
  findNode22,
  killLingeringManagedChrome,
  listenersOn,
  loadChannels,
  loadTwixyMode,
  reclaimOrphanGateway,
})

/** 메인 창 참조. windows.ts 와 overlayIpc.ts 가 이 thunk 으로만 메인 창을 본다. */
function getMainWindow(): BrowserWindow | null { return mainWindow }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#fafaf6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,        // preload 는 electron API 만 사용 → sandbox 안전. 렌더러 격리 강화.
      devTools: isDev,      // 프로덕션에선 DevTools 비활성 (콘솔 조작 문턱 상향)
    },
  })

  loadWindowEntry(mainWindow, 'main')

  wireExternalLinks(mainWindow)
  // Live-preview panel streams headless-Chrome frames to this window via IPC.
  // Handle registration lives near the other test-overlay handlers below.
  attachBrowserPreviewWindow(mainWindow)
  mainWindow.on('closed', () => { mainWindow = null })

  // Push fullscreen state into the renderer so it can drop the macOS traffic-
  // light padding from the custom titlebar. Without this the title text
  // ends up offset by 80px of empty space when the native buttons are gone.
  // We push on every transition AND on focus/show, because macOS sometimes
  // swallows leave-full-screen when the window is forced out of its Space
  // by a sibling window opening — without the re-push the renderer would
  // be stuck thinking we're still fullscreen and keep the titlebar hidden.
  const pushFs = () => {
    try { mainWindow?.webContents.send('main-fullscreen-changed', mainWindow.isFullScreen()) }
    catch { /* window may already be torn down */ }
  }
  mainWindow.on('enter-full-screen', pushFs)
  mainWindow.on('leave-full-screen', pushFs)
  mainWindow.on('focus',  pushFs)
  mainWindow.on('show',   pushFs)
  mainWindow.webContents.on('did-finish-load', pushFs)
}


// ── Tray — 시스템 트레이 아이콘/메뉴 ─────────────────────────────
function appIcon() {
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.icns'
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', iconFile)
    : path.join(__dirname, '..', 'assets', iconFile)
  return nativeImage.createFromPath(iconPath)
}

// 메뉴·클릭 구성은 tray.ts. 콜백은 여기서 클로저로 넘긴다 — mainWindow 는 창을 닫았다 열면
// 바뀌는 값이라, 만들 때의 창이 아니라 **클릭 시점의** 창을 봐야 한다 (옮기기 전과 동일).
function createTray() {
  tray = buildTray({
    icon:        appIcon(),
    displayName: PRODUCT.displayName,
    onOpen:   () => mainWindow?.show(),
    onToggle: () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show(),
    onQuit:   () => app.quit(),
  })
}

// ═════════════════════════════════════════════════════════════════
// ── IPC 핸들러들 ─────────────────────────────────────────────────
// 여기서부터가 preload.ts 의 window.twixy.* API 실제 구현.
// 채널명(첫 번째 인자)은 preload.ts 와 정확히 일치해야 한다.
// ═════════════════════════════════════════════════════════════════
ipcMain.handle('get-workspace',       () => getWorkspace())
ipcMain.handle('get-openclaw-status', () => { const p = getGatewayProcess(); return !!(p && !p.killed) })

// TWIX-26: 앱 업데이트 알림의 기반 — 현재 실행 중인 앱 버전을 렌더러에 노출한다.
// electron-updater/publish provider 가 아직 없어 실제 자동 업데이트 로직은 미구현.
// 이 핸들러는 UI에 "현재 vX.Y.Z" 표시 및 향후 원격 최신 버전과 비교하는 데 쓰인다.
ipcMain.handle('get-app-version',     () => app.getVersion())

// Enterprise Guardrail — mode + allowlist handlers. The actual approval
// flow runs entirely over the gateway WS (plugin.approval.requested /
// .resolve); this IPC only manages the persisted config.
//
// On mode change we respawn the OpenClaw gateway so the new
// TWIXY_GUARDRAIL_MODE env reaches the patched runBeforeToolCallHook.
// User accepted the in-flight-session interruption tradeoff.
registerGuardrailIpc(
  () => mainWindow,
  async () => {
    killGatewayIfRunning()
    await startOpenClaw()
    mainWindow?.webContents.send('openclaw-ready')
  },
  (e, channel) => senderBlocked(e, channel, ['main']),
)

// ── Designated-paths config ───────────────────────────────────────────
// SettingsPanel-editable list of workspace roots LLM file-writes may target.
// Both the in-process resolveInsideDesignated() guard AND the OpenClaw
// subprocess read the same config — the subprocess via TWIXY_DESIGNATED_ROOTS/
// TWIXY_ALLOWED_SUBDIRS env vars seeded at spawn time, so a saved change
// requires a gateway respawn (same tradeoff guardrail-mode change makes).
setDesignatedPathsConfigResolver(() => getCachedDesignatedPathsConfig(getTwixyMetaDir))
registerDesignatedPathsIpc({
  getMainWindow:   () => mainWindow,
  getTwixyMetaDir: getTwixyMetaDir,
  isSenderBlocked: (e, channel) => senderBlocked(e, channel, ['main']),
  onChange: async () => {
    killGatewayIfRunning()
    await startOpenClaw()
    mainWindow?.webContents.send('openclaw-ready')
  },
})

// ── Project directory ─────────────────────────────────────────────
ipcMain.handle('get-project-dir', () => loadProjectDir())

// ── Team collaboration (Phase 1: layout + config only) ────────────
ipcMain.handle('get-project-root',   () => getProjectRoot())
ipcMain.handle('get-collab-mode',    () => loadCollabMode())
ipcMain.handle('get-project-config', () => loadProjectConfig())

// Patch the project config. Accepts a partial and merges — the renderer
// never needs to know the full schema. `projectId`, `version`, `createdAt`
// are immutable (silently discarded).
ipcMain.handle('set-project-config', (_e, patch: Partial<ProjectConfig>
): { ok: boolean; error?: string; config?: ProjectConfig } => {
  const current = loadProjectConfig()
  if (!current) return { ok: false, error: 'project_config_missing' }
  const next: ProjectConfig = {
    ...current,
    ...patch,
    version:   current.version,
    projectId: current.projectId,
    createdAt: current.createdAt,
  }
  if (!['solo', 'shared-folder', 'server'].includes(next.mode)) {
    return { ok: false, error: 'invalid_mode' }
  }
  if (next.requiredApprovals !== undefined && next.requiredApprovals < 0) {
    return { ok: false, error: 'invalid_approvals' }
  }
  saveProjectConfig(next)
  return { ok: true, config: next }
})

// Let the user claim ownership of the current project (no-op if already owned
// by someone else — server will enforce in Phase 3, but locally we just refuse
// to overwrite an existing ownerUid unless it matches the current actor).
ipcMain.handle('claim-project-ownership', (
): { ok: boolean; error?: string; config?: ProjectConfig } => {
  const current = loadProjectConfig()
  if (!current) return { ok: false, error: 'project_config_missing' }
  const actor = currentActor()
  if (current.ownerUid && current.ownerUid !== actor.uid) {
    return { ok: false, error: 'already_owned' }
  }
  const next: ProjectConfig = {
    ...current,
    ownerUid:   actor.uid,
    ownerEmail: actor.email,
  }
  saveProjectConfig(next)
  return { ok: true, config: next }
})

// ── Merge Request · Admin 통계 IPC ─────────────────────────────
registerMrIpc({ getMainWindow, currentActor, safeCopyFile, looksBinary, decodeTextFile })

// ── 오버레이 · 가드레일 팝업 IPC ───────────────────────────────
// 구현은 electron/overlayIpc.ts (Stage 4 슬라이스 5).
registerOverlayIpc({
  getMainWindow, getWorkspace, senderBlocked,
  overwriteRedirectFile: OVERWRITE_REDIRECT_FILE,
})
// ── 라이브 브라우저 프리뷰 IPC ──────────────────────────────────
// 구현은 electron/browserPreviewIpc.ts (Stage 4 슬라이스 4). 주입 없음.
registerBrowserPreviewIpc()

// ── Planning Mode IPC ──────────────────────────────────────────────
// All plans live under <projectRoot>/users/[uid]/plans/<planId>/. The LLM round-trip
// for plan generation and step execution happens in the renderer (it already
// owns the gateway WS + chat session). These handlers are pure disk IO for
// plan.json / plan.md / run.md, plus lifecycle transitions.
// 구현은 electron/planBroadcast.ts (슬라이스 3 seam). 창 전역은 여기서만 읽는다 —
// 플랜 IPC 가 모듈로 나갈 때 이 함수를 thunk 으로 주입받으면 창을 몰라도 된다.
function broadcastPlanChange(id: string, kind: string) {
  broadcastPlanChangeTo({ main: mainWindow, overlay: getWindow('sidetab'), composer: getWindow('composer') }, id, kind)
}

// ── 플랜 IPC ───────────────────────────────────────────────────
// 구현은 electron/planIpc.ts (Stage 4 슬라이스 3-1).
const planIpcDeps = { getWorkspace, broadcastPlanChange, currentActor, loadProjectConfig }
registerPlanIpc(planIpcDeps)

// ── Workflow Test browser slots (parallel Chrome, max 3) ────────────────
// A running workflow Test leases a browser profile slot (wf-1..3). The
// renderer registers the run's gateway sessionKey → profile here; we mirror
// the map to a JSON file the openclaw subprocess polls per browser-tool call
// (runBeforeToolCallHook patch reads TWIXY_BROWSER_SLOTS_FILE and force-sets
// `params.profile`). This is the tool-policy-layer enforcement — prompt
// instructions alone are not reliable.
const BROWSER_SLOTS_FILE = stateFile('browser-slots.json')
const browserSlotMap = new Map<string, string>()  // sessionKey → profile (wf-N)

function persistBrowserSlots(): void {
  try {
    if (browserSlotMap.size === 0) {
      if (fs.existsSync(BROWSER_SLOTS_FILE)) fs.unlinkSync(BROWSER_SLOTS_FILE)
      return
    }
    fs.writeFileSync(BROWSER_SLOTS_FILE, JSON.stringify(Object.fromEntries(browserSlotMap)), 'utf8')
  } catch (err) {
    console.warn('[browser-slots] persist failed:', err)
  }
}

ipcMain.handle('browser-slot-set', (_e, payload: { sessionKey?: string; profile?: string | null }) => {
  const key = payload?.sessionKey?.trim()
  if (!key) return { ok: false, error: 'sessionKey required' }
  const profile = payload?.profile?.trim()
  if (profile) browserSlotMap.set(key, profile)
  else browserSlotMap.delete(key)
  persistBrowserSlots()
  return { ok: true }
})

// ── 워크플로 슬롯 전역 lease — 렌더러 훅 인스턴스 공용 장부 ─────────────
// 슬롯(wf-1..3)=Chrome 은 전역 자원인데 lease 장부가 useWorkflowTest 인스턴스
// (Copilot 탭/Workflow 탭)별 로컬이면 두 탭이 같은 슬롯을 동시에 잡아 서로의
// Chrome 을 몰게 된다 (관측된 버그). 장부를 main 으로 승격 — workflowId 키라
// 같은 워크플로의 탭 간 이중 실행도 함께 차단된다. 동시 실행 상한 3(전역).
const WF_SLOT_PROFILES = ['wf-1', 'wf-2', 'wf-3'] as const
const wfSlotLeases = new Map<string, string>()  // workflowId → profile

ipcMain.handle('wf-slot-lease', (_e, payload: { workflowId?: string }) => {
  const wfId = payload?.workflowId?.trim()
  if (!wfId) return { ok: false, reason: 'invalid' }
  if (wfSlotLeases.has(wfId)) return { ok: false, reason: 'already_running' }
  const inUse = new Set(wfSlotLeases.values())
  const profile = WF_SLOT_PROFILES.find(p => !inUse.has(p))
  if (!profile) return { ok: false, reason: 'max_concurrent' }
  wfSlotLeases.set(wfId, profile)
  return { ok: true, profile }
})

ipcMain.handle('wf-slot-release', (_e, payload: { workflowId?: string }) => {
  const wfId = payload?.workflowId?.trim()
  if (wfId) wfSlotLeases.delete(wfId)
  return { ok: true }
})

// 렌더러 리로드/재로그인 시 stale lease 정리 — 훅이 사라지면 run 도 죽으므로
// 남은 lease 는 전부 유령이다. AuthedApp 마운트 시 1회 호출.
ipcMain.handle('wf-slot-clear-all', () => {
  wfSlotLeases.clear()
  return { ok: true }
})

// ── 워크플로 IPC ───────────────────────────────────────────────
// 구현은 electron/workflowIpc.ts (Stage 4 슬라이스 3-2). 목록 캐시도 그 안에 있다.
registerWorkflowIpc({ getWorkspace, currentActor })
// ── Main chat persistence ─────────────────────────────────────────────
// One main-chat.jsonl + main-session.json per workspace. Renderer
// (useOpenClaw) hydrates on mount, appends per message, clears on New Chat.
// Scrollback survives restart; gateway session key resume is best-effort.
ipcMain.handle('main-chat-load', () => {
  try { return { ok: true, lines: Planning.readMainChat(getWorkspace()) } }
  catch (err) { return { ok: false, error: (err as Error).message } }
})
ipcMain.handle('main-chat-append', (_e, line: Planning.MainChatLine) => {
  try { Planning.appendMainChat(getWorkspace(), line); return { ok: true } }
  catch (err) { return { ok: false, error: (err as Error).message } }
})
ipcMain.handle('main-chat-clear', () => {
  try { Planning.clearMainChat(getWorkspace()); return { ok: true } }
  catch (err) { return { ok: false, error: (err as Error).message } }
})
ipcMain.handle('main-session-get', () => {
  try { return { ok: true, sessionKey: Planning.readMainSession(getWorkspace()).sessionKey } }
  catch { return { ok: true, sessionKey: null } }
})
ipcMain.handle('main-session-set', (_e, payload: { sessionKey: string | null }) => {
  try { Planning.writeMainSession(getWorkspace(), { sessionKey: payload?.sessionKey ?? null }); return { ok: true } }
  catch (err) { return { ok: false, error: (err as Error).message } }
})

// ── 오케스트레이션 IPC ──────────────────────────────────────────
// 구현은 electron/orchestrationIpc.ts (Stage 4 슬라이스 3-3).
registerOrchestrationIpc({ getWorkspace, currentActor })

// ── AI 에이전트 IPC ────────────────────────────────────────────
// 구현은 electron/aiAgentIpc.ts (Stage 4 슬라이스 3-4).
registerAiAgentIpc({ getWorkspace, currentActor })

// ── logbook 작업 마커 ───────────────────────────────────────────
// plan 실행 중 L6/L7/L8 작업 마커를 로컬 logbook(127.0.0.1:8765)으로 중계.
// 렌더러는 CSP 때문에 직접 fetch 하지 않고 이 IPC 를 쓴다. fire-and-forget:
// await 하지 않고 즉시 반환 — logbook 미연결이 일반 상태이며 plan 실행을
// 절대 지연/실패시키지 않는다 (백오프는 logbook-bridge.ts 내부에서 처리).
ipcMain.handle('logbook-context', (_e, marker: LogbookMarker): { ok: boolean } => {
  void postContextMarker(marker)
  return { ok: true }
})

// ── 프로젝트 폴더는 "우리가 띄운 다이얼로그가 돌려준 경로" 만 받는다 ─────────────
// set-project-dir 는 샌드박스 루트를 바꾼다. 이 값이 바뀌면 나머지 모든 경로 검사가
// "공격자가 고른 폴더" 기준이 되므로, 경로의 **출처**를 렌더러에서 떼어 낸다:
// 다이얼로그가 돌려준 값을 main 이 기억하고, 그 값으로 되돌아온 것만 수락한다.
// 세션 동안 고른 것을 모두 담는 이유 — 폴더를 고른 뒤 set 이 실패(권한·디스크)해서
// 사용자가 다시 시도하는 흐름을 막지 않기 위해. 전부 사용자가 직접 고른 경로다.
const userPickedProjectDirs = new Set<string>()

ipcMain.handle('set-project-dir', async (e, dir: string) => {
  // 샌드박스 경계를 바꾸는 설정 채널들(set-project-dir, set-twixy-mode, guardrail-set-config,
  // designated-paths-set-config)은 설정 화면이 있는 메인 창만 부를 수 있다.
  if (senderBlocked(e, 'set-project-dir', ['main'])) return { ok: false, error: 'forbidden_sender' }
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: 'invalid_path' }
  // 출처 검사: 사용자가 다이얼로그로 고른 경로이거나, 지금 값 그대로(no-op)여야 한다.
  // 아래 forbidden 목록은 남겨 둔다 — 사용자가 실수로 시스템 폴더를 고르는 것도 막아야 하고,
  // 그건 이 검사와 목적이 다르다(오조작 방지 vs 출처 위조 방지).
  if (!isSamePathAsAny(dir, [loadProjectDir(), ...userPickedProjectDirs])) {
    console.warn('[twixy/ipc] set-project-dir: 다이얼로그로 고르지 않은 경로 — 거부')
    return { ok: false, error: 'not_user_picked' }
  }

  // Block system-level and OpenClaw config paths to prevent accidental or
  // malicious redirection of workspace writes into sensitive locations.
  const forbidden = [
    '/', '/etc', '/bin', '/sbin', '/usr', '/var', '/dev', '/sys', '/proc',
    '/System', '/Library', '/private',
    OPENCLAW_DIR,
    path.join(os.homedir(), 'Library'),
  ]
  const normalized = path.normalize(dir)
  if (forbidden.some(f => normalized === f || normalized.startsWith(f + path.sep))) {
    return { ok: false, error: 'path_forbidden' }
  }
  // 위 목록은 문자열 비교라 Windows 에서 대소문자만 바꾸거나(`…\.OPENCLAW`) 링크를 거치면
  // 상태 폴더(토큰·세션이 있는 곳)를 그대로 통과한다. 앱 소유 폴더만은 실제 경로로 다시 본다.
  // POSIX 리터럴('/', '/dev' …)은 옮기지 않는다 — Windows 에서 `C:\dev` 같은 흔한 개발
  // 폴더로 풀려 정상 선택을 막게 된다. 목록 자체의 한계는 p1-file-ipc-inventory.md §7-D1.
  if (isInside(OPENCLAW_DIR, dir, { allowRoot: true })) {
    return { ok: false, error: 'path_forbidden' }
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    saveProjectDir(dir)
    await ensureWorkspace()
    // Clear the session-file map so log appends don't accidentally write to
    // the previous workspace after the directory change.
    clearActiveSessionFiles()
    stopSkillsWatcher()
    killGatewayIfRunning()
    await startOpenClaw()
    startUsageSyncTimer()
    startSkillsWatcher(getWorkspace())
    mainWindow?.webContents.send('project-dir-changed', dir)
    mainWindow?.webContents.send('openclaw-ready')
    return { ok: true }
  } catch (err) { return { ok: false, error: String(err) } }
})


ipcMain.handle('pick-project-dir', async (e) => {
  // 다이얼로그가 곧 인가 수단이다 — 띄우는 것도 설정 화면이 있는 창만.
  // 취소와 같은 모양으로 돌려준다(렌더러는 '사용자가 취소했다' 로 처리).
  if (senderBlocked(e, 'pick-project-dir', ['main'])) return { ok: false, canceled: true }
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose Project Folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return { ok: false, canceled: true }
  userPickedProjectDirs.add(filePaths[0])
  return { ok: true, dir: filePaths[0] }
})
// http · https · mailto 만. 이 채널로 오는 URL 의 절반은 앱이 쓴 게 아니다 — 채팅/파일 미리보기의
// a.href(LLM·스크랩 텍스트), 업데이트 배너의 download_url(원격 DB), 라이브 프리뷰의 현재 탭 URL.
// 패키지 앱에서는 마크다운의 **상대 링크**가 file:///…/dist/… 로 풀려 그대로 여기 도착한다.
// 거부는 조용히: 호출부가 전부 반환값을 안 보고, reject 하면 unhandled rejection 만 남는다.
ipcMain.handle('open-external', (_e, url: string) => {
  if (!isAllowedExternalUrl(url)) {
    console.warn('[twixy] open-external: blocked non-http(s)/mailto URL')
    return
  }
  return shell.openExternal(url)
})
initProductIpc({
  getWorkspace,
  paths: {
    // getter — app.setName(PRODUCT.appDataDirName) 이 이 줄보다 뒤에 있어 지금 읽으면 이름이 틀린다.
    get userData() { return app.getPath('userData') },
    resources:  isDev ? path.join(__dirname, '..') : process.resourcesPath,
    appRoot:    app.getAppPath(),
    isPackaged: app.isPackaged,
  },
  // 제품이 자기 MCP 서버를 재시작했을 때 — 세션의 MCP 툴 목록은 세션 시작 때 고정되므로
  // 게이트웨이를 다시 띄워야 새 툴이 보인다 (integrationsIpc 의 respawnGateway 와 같은 순서).
  restartGateway: async () => {
    await ensureWorkspace()
    killGatewayIfRunning()
    await startOpenClaw()
    mainWindow?.webContents.send('openclaw-ready')
  },
})
ipcMain.handle('recent-files', (_e, payload?: { limit?: number; dirs?: string[] }) => {
  const limit = payload?.limit ?? 30
  const dirs  = payload?.dirs ?? ['data/raw', 'data/saved', 'data/insights', 'exports']
  type R = { name: string; path: string; mtime: number; dir: string }
  const out: R[] = []
  const walk = (rel: string) => {
    const abs = path.resolve(getWorkspace(), rel)
    if (!isInside(getWorkspace(), abs, { allowRoot: true }) || !fs.existsSync(abs)) return
    let entries: string[] = []
    try { entries = fs.readdirSync(abs) } catch { return }
    for (const name of entries) {
      const full = path.join(abs, name)
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        walk(path.join(rel, name))
      } else {
        out.push({
          name,
          path: path.relative(getWorkspace(), full),
          mtime: stat.mtimeMs,
          dir:   (() => { const parts = rel.split(path.sep); return parts[0] === 'data' ? parts.slice(0, 2).join('/') : parts[0] })(),
        })
      }
    }
  }
  for (const d of dirs) walk(d)
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
})

ipcMain.handle('delete-file', (_e, filePath: string) => {
  try {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(getWorkspace(), filePath)
    // 루트 자체는 거부 (isInside 기본값). 폴더면 아래에서 재귀 삭제하므로, 예전엔
    // delete-file('.') 한 번에 워크스페이스 전체가 지워졌다.
    if (!isInside(getWorkspace(), abs)) return { ok: false }
    if (!fs.existsSync(abs)) return { ok: false }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true })
    } else {
      fs.unlinkSync(abs)
    }
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('write-watch-file', (_e, payload: { name: string; content: string }) => {
  try {
    if (!/^[A-Za-z0-9._-]+$/.test(payload.name)) return { ok: false }
    const target = path.resolve(getWorkspace(), 'data', 'watches', `${payload.name}.json`)
    if (!isInside(path.resolve(getWorkspace(), 'data', 'watches'), target)) return { ok: false }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, payload.content)
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

// Import a file dropped onto the chat by COPYING its bytes into the Twixy
// workspace under data/raw/. We never reference the original outside-of-
// workspace path so the agent stays sandboxed inside ~/.openclaw/workspace/twixy.
ipcMain.handle('import-dropped-file', (_e, payload: { name: string; bytes: ArrayBuffer | Uint8Array }) => {
  try {
    // 이름을 지키는 것이 안전보다 덜 중요하지 않다.
    //
    // 예전 규칙(`[^A-Za-z0-9._-]` → '_')은 ASCII 가 아닌 글자를 전부 밑줄로
    // 바꿨다. '지난번.png' 는 '___.png', '라이팅엔무드.png' 는 '______.png' 가
    // 됐고, 한국어 파일 여섯 장을 첨부하면 모델에게는 구분 불가능한 밑줄
    // 뭉치가 도착했다 — 사용자가 "지난번.png 를 2페이지에" 라고 지시해도 그게
    // 어느 파일인지 알 방법이 없다. 이미지가 아무 데나 배치된 진짜 원인이다.
    //
    // 위험한 건 글자가 아니라 **경로 구분자와 예약 문자**다. 그것만 걷어내고
    // 글자는 지킨다. 공백은 '_' 로 — 경로가 `@data/raw/…` 토큰으로 메시지에
    // 실리므로 공백이 있으면 거기서 잘린다.
    const safeBase = path.basename(payload.name)
      .replace(/[\u0000-\u001f\u007f<>:"\/\\|?*]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 80)
    if (!safeBase) return { ok: false }
    const dest = path.resolve(getWorkspace(), 'data', 'raw')
    fs.mkdirSync(dest, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const finalName = `${stamp}-${safeBase}`
    const target = path.join(dest, finalName)
    if (!isInside(dest, target)) return { ok: false }
    const buf = Buffer.from(payload.bytes as ArrayBuffer)
    fs.writeFileSync(target, buf)
    console.log(`[twixy/import] dropped → data/raw/${finalName} (${buf.length} bytes)`)
    const relPath = path.relative(getWorkspace(), target)
    return { ok: true, path: target, relPath, name: finalName }
  } catch (err) {
    console.warn('[twixy/import] failed:', err)
    return { ok: false }
  }
})

ipcMain.handle('move-file', (_e, payload: { from: string; toDir: string }) => {
  try {
    const fromAbs = path.isAbsolute(payload.from)
      ? payload.from
      : path.resolve(getWorkspace(), payload.from)
    const toDirAbs = path.isAbsolute(payload.toDir)
      ? payload.toDir
      : path.resolve(getWorkspace(), payload.toDir)
    // 옮기는 대상이 루트면 거부 — 워크스페이스를 통째로 다른 이름으로 옮기는 셈이다.
    // 목적지는 루트여도 된다 (파일을 워크스페이스 최상위로 옮기는 건 정상).
    if (!isInside(getWorkspace(), fromAbs) || !isInside(getWorkspace(), toDirAbs, { allowRoot: true })) return { ok: false }
    if (!fs.existsSync(fromAbs)) return { ok: false }
    fs.mkdirSync(toDirAbs, { recursive: true })

    const base = path.basename(fromAbs)
    let target = path.join(toDirAbs, base)
    // Avoid overwriting — append _2, _3, … on collision.
    if (fs.existsSync(target)) {
      const ext  = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let n = 2
      while (fs.existsSync(path.join(toDirAbs, `${stem}_${n}${ext}`))) n++
      target = path.join(toDirAbs, `${stem}_${n}${ext}`)
    }
    fs.renameSync(fromAbs, target)
    return { ok: true, to: path.relative(getWorkspace(), target) }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('reveal-in-finder', (_e, filePath: string) => {
  try {
    // Accept either workspace-relative ("data/saved/foo.csv") or absolute paths.
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(getWorkspace(), filePath)
    if (!isInside(getWorkspace(), abs, { allowRoot: true })) return false
    if (!fs.existsSync(abs)) return false
    shell.showItemInFolder(abs)
    return true
  } catch {
    return false
  }
})

// ── 엔진이 실제로 허용하는 툴 (읽기 전용) ────────────────────────────────────
// 프롬프트가 "이 툴 써라" 라고 이름을 불러 주는 목록과, 엔진이 게이트웨이에 넘기는 실제
// tool policy 가 각자 계산돼 왔다 — 그래서 제품이 끈 툴을 프롬프트가 부르는 조합이 나온다.
// 여기서는 **게이트웨이에 실제로 넘어간 tools 블록을 그대로 읽어** 해석 결과만 돌려준다.
// PRODUCT.features 를 렌더러에 뿌리고 다시 추론하게 두지 않는 것이 요점이다 (그 재추론이
// 지금의 불일치를 만들었다). 해석 규칙은 electron/toolPermissions.ts.
//
// openclaw.json 은 createWindow 보다 먼저 ensureWorkspace 가 쓰므로, 렌더러가 부를 시점엔
// 항상 존재한다. 없다면 그건 경쟁이 아니라 진짜 고장이라 ok:false 로 알린다 (조용히
// 기본값을 지어내면 이 채널을 만든 이유가 없어진다).
ipcMain.handle('get-tool-permissions', () => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const tools = (config as { tools?: ToolsPolicy })?.tools
    if (!tools || typeof tools !== 'object') return { ok: false as const, error: 'tools_block_missing' }
    return { ok: true as const, ...resolveToolPermissions(tools) }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
})

// Read auth token from openclaw.json after gateway starts
// 비밀을 돌려주는 채널은 그걸 실제로 쓰는 창에만 연다 — 게이트웨이 훅 7개는 전부 메인 창(App.tsx)
// 에서만 돈다. 사이드탭 번들에 useOpenClaw 가 보이는 건 `import type` 뿐이다.
ipcMain.handle('get-gateway-token', (e) => {
  if (senderBlocked(e, 'get-gateway-token', ['main'])) return null
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return config?.gateway?.auth?.token ?? null
  } catch {
    return null
  }
})

ipcMain.handle('read-file', (_e, filePath: string) => {
  const safe = path.resolve(getWorkspace(), filePath)
  if (!isInside(getWorkspace(), safe) || !fs.existsSync(safe)) return null
  if (fs.statSync(safe).isDirectory()) return null
  const buf = fs.readFileSync(safe)
  if (looksBinary(buf)) return null
  return decodeTextFile(buf)
})

// Raw byte read for MR creation — bypasses the text/binary sniff and returns
// the file's exact bytes as a Uint8Array. Used when proposing arbitrary files
// (images, PDFs, etc.) to shared/ via a Merge Request.
ipcMain.handle('read-file-bytes', (_e, filePath: string): Uint8Array | null => {
  const safe = path.resolve(getWorkspace(), filePath)
  if (!isInside(getWorkspace(), safe) || !fs.existsSync(safe)) return null
  if (fs.statSync(safe).isDirectory()) return null
  const buf = fs.readFileSync(safe)
  return new Uint8Array(buf)
})

ipcMain.handle('write-file', (_e, payload: { filePath: string; content: string }) => {
  const safe = path.resolve(getWorkspace(), payload.filePath)
  if (!isInside(getWorkspace(), safe)) return { ok: false, error: 'path outside workspace' }
  fs.mkdirSync(path.dirname(safe), { recursive: true })
  const BOM = '\uFEFF'
  const isCSV = safe.toLowerCase().endsWith('.csv')
  const content = isCSV && !payload.content.startsWith(BOM) ? BOM + payload.content : payload.content
  fs.writeFileSync(safe, content, 'utf8')
  return { ok: true }
})

// 마크다운에서 뽑은 HTML → PDF 버퍼. 다이얼로그로 내보내는 export-pdf 와
// 원본 옆에 굽는 export-pdf-to 가 같은 인쇄 스타일을 쓰도록 분리해 둔다.
async function htmlToPdfBuffer(bodyHtml: string): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.7; color: #1a1a1a; max-width: 760px; margin: 40px auto; padding: 0 40px; }
    h1,h2,h3 { font-weight: 700; margin: 1.2em 0 0.4em; }
    h1 { font-size: 22px; border-bottom: 2px solid #e5e5e5; padding-bottom: 6px; }
    h2 { font-size: 18px; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; }
    h3 { font-size: 15px; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th { background: #f5f5f5; font-weight: 600; padding: 7px 12px; text-align: left; border-bottom: 2px solid #ddd; }
    td { padding: 6px 12px; border-bottom: 1px solid #eee; }
    code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; font-family: monospace; font-size: 12px; }
    pre  { background: #f5f5f5; padding: 14px; border-radius: 6px; overflow-x: auto; }
    blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 16px; color: #666; }
    strong { font-weight: 600; }
    a { color: #5b4fcf; }
  </style></head><body>${bodyHtml}</body></html>`
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml))
    return await win.webContents.printToPDF({ printBackground: true })
  } finally {
    win.close()
  }
}

ipcMain.handle('export-pdf', async (_e, payload: { html: string; filename: string }) => {
  try {
    const defaultName = payload.filename.replace(/\.md$/i, '') + '.pdf'
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, {
      title:       'Export as PDF',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters:     [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    fs.writeFileSync(filePath, await htmlToPdfBuffer(payload.html))
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// 워크플로 write 노드의 .md 산출물을 저장 다이얼로그 없이 같은 폴더에
// `<basename>.pdf` 로 굽는다 (노드 칩의 "Save as PDF & open"). 이미 그 이름의
// 파일이 있으면 덮어쓰지 않고 exists 로 돌려주고, renderer 가 확인을 받은 뒤
// overwrite: true 로 다시 부른다.
ipcMain.handle('export-pdf-to', async (_e, payload: { html: string; srcPath: string; overwrite?: boolean }) => {
  try {
    const ws  = getWorkspace()
    const src = path.isAbsolute(payload.srcPath) ? payload.srcPath : path.resolve(ws, payload.srcPath)
    const out = src.replace(/\.[^./\\]+$/, '') + '.pdf'
    // 실제로 쓰는 건 out 이다 — src 만 보면 `<이름>.pdf` 가 밖을 가리키는 링크일 때 놓친다.
    if (!isInside(ws, src) || !isInside(ws, out)) return { ok: false, error: 'path outside workspace' }
    if (fs.existsSync(out) && !payload.overwrite) return { ok: false, exists: true, path: out }

    fs.writeFileSync(out, await htmlToPdfBuffer(payload.html))
    return { ok: true, path: out }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('export-md', async (_e, payload: { content: string; filename: string }) => {
  try {
    const defaultName = payload.filename.endsWith('.md') ? payload.filename : payload.filename + '.md'
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, {
      title:       'Export as Markdown',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters:     [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    fs.writeFileSync(filePath, payload.content, 'utf8')
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// ── 계정·과금·모드 IPC ─────────────────────────────────────────
registerAccountIpc({
  getMainWindow, chmod0600, ensureWorkspace, loadChannels, saveChannels, senderBlocked,
  authProfilesPathEarly: AUTH_PROFILES_PATH_EARLY,
})

// ── 문서·데이터 툴 IPC ───────────────────────────────────────────
// 구현은 electron/fileToolsIpc.ts (Stage 4 슬라이스 2). 워크스페이스 경로만 주입한다.
registerFileToolsIpc({ getWorkspace })

// ── 외부 연동 IPC — Google Workspace · Gmail · Connections · MCP ─
// 구현은 electron/integrationsIpc.ts (Stage 4 슬라이스 15). 게이트웨이 재기동은
// 그쪽이 gateway.ts 에서 직접 가져온다 — 여기서 주는 것은 창 참조뿐이다.
registerIntegrationsIpc({ getMainWindow })

// ── Cron scheduled tasks (Settings → 예약 작업) ───────────────────
// 잡 CRUD 는 이제 렌더러(useOpenClaw)가 이미 인증된 게이트웨이 WS 연결로 cron.*
// RPC 를 직접 호출한다. 과거의 `node openclaw.mjs cron ...` CLI execFile 경로는
// 게이트웨이가 client.id:"cli" 를 페어링 미승인으로 1008 거부해 제거됐다.
// (게이트웨이 내장 스케줄러 자체는 여전히 필요 — openclaw.json 의 cron.enabled
//  병합은 config 머지 단계에서 유지된다.)

// ── 대시보드 스냅샷 ─────────────────────────────────────────────
// 구현은 electron/dashboard.ts (Stage 4 슬라이스 2).
registerDashboardIpc({ getWorkspace, getTwixyMetaDir })

// Magic-byte sniff so we can refuse to "preview" binary files like .xlsx,
// .zip, .pdf, images, etc. — they would otherwise come back as garbled text.
function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false
  // Well-known signatures
  if (buf[0] === 0x50 && buf[1] === 0x4B) return true                       // PK..  → zip / xlsx / docx / pptx
  if (buf.slice(0, 4).toString('ascii') === '%PDF') return true             // PDF
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('ascii') === 'PNG') return true
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true    // JPEG
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return true
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return true             // WAV/WEBP
  if (buf[0] === 0x1F && buf[1] === 0x8B) return true                       // gzip
  if (buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) return true // OLE2 (old .xls/.doc)
  // Heuristic: lots of NUL bytes in the first 4KB ⇒ binary
  const head = buf.slice(0, Math.min(4096, buf.length))
  let nulls = 0
  for (let i = 0; i < head.length; i++) if (head[i] === 0) nulls++
  return nulls / head.length > 0.01
}

// Decode a text file buffer with best-effort encoding detection so Korean
// (CP949 / EUC-KR), Japanese (Shift_JIS), and Chinese (GBK) CSVs exported
// from Excel render correctly instead of as mojibake.
function decodeTextFile(buf: Buffer): string {
  // 1. BOM sniffing — UTF-8 / UTF-16 LE / UTF-16 BE
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    try { return new TextDecoder('utf-16le').decode(buf.slice(2)) } catch { /* fall through */ }
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    try { return new TextDecoder('utf-16be').decode(buf.slice(2)) } catch { /* fall through */ }
  }

  // 2. Strict UTF-8 — succeeds for ASCII, English, and any valid UTF-8.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch { /* not valid UTF-8 → legacy Asian codepage likely */ }

  // 3. Try common Asian codepages (Electron ships full-icu, so these are
  //    available via TextDecoder). EUC-KR is the canonical Korean encoding;
  //    Excel-on-Korean-Windows exports use it almost exclusively.
  for (const enc of ['euc-kr', 'shift_jis', 'gbk', 'big5']) {
    try {
      const out = new TextDecoder(enc, { fatal: true }).decode(buf)
      return out
    } catch { /* try next */ }
  }

  // 4. Last resort — utf-8 lossy (replaces invalid bytes with U+FFFD).
  return buf.toString('utf8')
}

ipcMain.handle('read-image', (_e, filePath: string) => {
  const safe = path.resolve(getWorkspace(), filePath)
  if (!isInside(getWorkspace(), safe) || !fs.existsSync(safe)) return null
  if (fs.statSync(safe).isDirectory()) return null
  const ext = path.extname(safe).toLowerCase().slice(1)
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
             : ext === 'png'  ? 'image/png'
             : ext === 'gif'  ? 'image/gif'
             : ext === 'webp' ? 'image/webp'
             : ext === 'svg'  ? 'image/svg+xml'
             : 'image/jpeg'
  const b64 = fs.readFileSync(safe).toString('base64')
  return `data:${mime};base64,${b64}`
})

// ── TSL IPC — 스킬 CRUD & 컴파일 ─────────────────────────────────
// 구현은 electron/skills.ts (Stage 4 슬라이스 16). 워처·컴파일과 같은 파일에 둔다 —
// 스킬 폴더를 쓰는 주체가 둘로 갈라지면 워처가 자기 쓰기를 되먹는다.
registerSkillsIpc()

// ── 세션 로그 · 스킬 통계 · 요약 ────────────────────────────────
// 구현은 electron/sessionLogs.ts (Stage 4 슬라이스 1 에서 이동). 워크스페이스 경로만 주입한다.
registerSessionLogIpc({ getWorkspace })

ipcMain.handle('list-dir', (_e, dirPath: string) => {
  const safe = path.resolve(getWorkspace(), dirPath)
  if (!isInside(getWorkspace(), safe, { allowRoot: true }) || !fs.existsSync(safe)) return []
  // Return entries with type + mtime: { name, isDir, mtimeMs } (mtime 로 최신순 정렬).
  return fs.readdirSync(safe).map(name => {
    const fullPath = path.join(safe, name)
    const st = fs.statSync(fullPath)
    return { name, isDir: st.isDirectory(), mtimeMs: st.mtimeMs }
  })
})

// FilesPanel (Marketing IDE) — team workspace browser. Mirrors list-dir but
// scoped to the shared/ root, which lives outside getWorkspace() and so
// can't go through the per-user handler above.
ipcMain.handle('list-shared-dir', (_e, dirPath: string) => {
  const sharedRoot = getSharedDir()
  const safe = path.resolve(sharedRoot, dirPath || '.')
  if (!isInside(sharedRoot, safe, { allowRoot: true }) || !fs.existsSync(safe)) return []
  return fs.readdirSync(safe).map(name => {
    const fullPath = path.join(safe, name)
    const isDir = fs.statSync(fullPath).isDirectory()
    return { name, isDir }
  })
})

// ── 언어 교정 ──────────────────────────────────────────────────
// 구현은 electron/languageCorrection.ts (Stage 4 슬라이스 2b).
// 핸드아웃 캐시는 **여기가 계속 소유한다** — 모듈은 매 호출 getApiKey() 로 물어본다.
// 사본을 모듈에 두면 키 갱신 후에도 옛 키를 쓰게 되고 증상이 "가끔 401" 이라 추적이 어렵다.
registerLanguageCorrectionIpc({
  isTwixyMode:   () => loadTwixyMode() === 'twixy',
  getApiKey:     async () => (getOpenRouterHandout() ?? await fetchOpenRouterHandout())?.apiKey,
  getConfigPath: () => CONFIG_PATH,
})
// ── Chrome profile rebranding — Chrome 프로필 이름 교체 ──────────
// OpenClaw 가 쓰는 embedded Chrome 프로필의 Preferences JSON 에서
// profile.name / user.name 을 "Twixy" 로 덮어쓴다. 매 기동 시 멱등 실행.
/**
 * OpenClaw seeds Chrome's profile display name as "openclaw" the first time
 * it spawns the browser. Chrome then persists that string into:
 *   - <user-data>/Local State          → profile.info_cache.<id>.name
 *   - <user-data>/Default/Preferences  → profile.name
 *
 * This helper rewrites both files in place so Chrome's profile picker shows
 * "twixy" instead. Idempotent — runs every Twixy launch in case Chrome (or
 * a future OpenClaw upgrade) clobbers it.
 */
function patchChromeProfileDisplayName() {
  if (!PRODUCT.features.browser) return
  const targets = [
    path.join(CHROME_PROFILE_DIR, 'Local State'),
    path.join(CHROME_PROFILE_DIR, 'Default', 'Preferences'),
  ]
  for (const file of targets) {
    if (!fs.existsSync(file)) continue
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const json = JSON.parse(raw) as Record<string, unknown>

      // Walk the profile.info_cache map (Local State) and any nested .name
      // (Preferences). Both shapes have a string "name" field somewhere
      // under profile.* — we touch every one set to "openclaw".
      let mutated = false
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === 'name' && v === 'openclaw') {
            ;(node as Record<string, unknown>)[k] = CHROME_DISPLAY_NAME
            mutated = true
          } else if (typeof v === 'object') {
            walk(v)
          }
        }
      }
      walk(json.profile)

      if (mutated) {
        fs.writeFileSync(file, JSON.stringify(json), 'utf8')
        console.log(`[twixy] Rebranded Chrome profile name in ${path.basename(file)}`)
      }
    } catch (err) {
      console.warn(`[twixy] Failed to patch ${file}:`, err)
    }
  }
}

// ── Deeplink (twixy://) — 커스텀 프로토콜 핸들러 ─────────────────
// 웹에서 로그인 완료 시 브라우저가 `twixy://auth#access_token=...` URL 로
// 데스크톱 앱을 불러오고, 여기서 세션 토큰을 파싱해 저장한다.
// Windows 는 argv 에 URL 이 들어오고, macOS 는 open-url 이벤트로 들어온다.
// Register Twixy as the default handler for the twixy:// scheme so that
// `twixy://auth#access_token=...` URLs from the web sign-in page get
// routed back to this process.
if (process.defaultApp) {
  // In dev (electron .) we have to spell out the entry script for the
  // OS to know which command to run when twixy:// is clicked.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PRODUCT.protocolScheme, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(PRODUCT.protocolScheme)
}

// Single-instance lock — when the OS launches a second copy of Twixy in
// response to a twixy:// click, forward the URL into the original process.
app.setName(PRODUCT.appDataDirName)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows / Linux: deeplink arrives as the last argv element.
    const deeplink = argv.find(a => a.startsWith(`${PRODUCT.protocolScheme}://`))
    if (deeplink) handleAuthDeeplink(deeplink)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// macOS: deeplinks arrive via the open-url event (no argv).
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthDeeplink(url)
})

// ── Lifecycle — 앱 라이프사이클 훅 ───────────────────────────────
// whenReady: 워크스페이스 준비 → OpenClaw 기동 → 창/트레이/워처 시작.
// window-all-closed / activate / before-quit: 창 전부 닫히거나 종료 시 정리 작업.
// Probe macOS privacy permissions on startup. We can't request Screen
// Recording or Accessibility programmatically — they have to be flipped by
// the user in System Settings — but we can detect their state and surface a
// one-tap dialog that opens the right pane. Without this users hit silent
// failures the first time the agent tries to take a screenshot.
function probeMacPermissionsOnce() {
  if (process.platform !== 'darwin') return
  // 화면 기록·손쓰기 권한은 관리형 브라우저를 조작하는 제품만 필요하다. 권한이 없으면 아래
  // 안내 대화상자가 뜨는데, macOS 에서 창 없이 띄운 이 대화상자가 닫힐 때까지 부팅(게이트웨이
  // 시작)이 멈춘다 — 브라우저를 안 쓰는 제품에서 그걸 물을 이유가 없다.
  if (!PRODUCT.features.browser) return

  const screenStatus = systemPreferences.getMediaAccessStatus('screen')
  console.log('[twixy] screen-recording permission:', screenStatus)
  if (screenStatus === 'denied' || screenStatus === 'restricted') {
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Open System Settings', 'Later'],
      defaultId: 0,
      cancelId:  1,
      title:    'Screen Recording permission needed',
      message:  'Twixy needs Screen Recording permission to read the pages it controls in your browser.',
      detail:   'Open System Settings → Privacy & Security → Screen Recording, then enable Twixy. You only have to do this once.',
    }).then(res => {
      if (res.response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      }
    }).catch(() => { /* ignore */ })
  }

  // Apple Events / Automation — needed for the browser tool to drive Chrome.
  // isTrustedAccessibilityClient(false) just queries (no prompt); pass true
  // exactly once if you want the system to surface its own dialog.
  const a11yTrusted = systemPreferences.isTrustedAccessibilityClient(false)
  console.log('[twixy] accessibility-trusted:', a11yTrusted)
}

/** 사용자 메시지가 없는 빈 세션 로그를 정리한다 (틱/빈 세션 잔재 청소). */
function purgeEmptySessionLogs() {
  const dir = path.join(getWorkspace(), 'logs', 'sessions')
  if (!fs.existsSync(dir)) return
  let deleted = 0
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const filePath = path.join(dir, file)
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
      const hasUserMessage = lines.some(line => {
        try {
          const frame = JSON.parse(line)
          if (frame.event !== 'session.message') return false
          const msg = frame.payload?.message
          if (msg?.role !== 'user') return false
          const content = msg.content
          const text = Array.isArray(content)
            ? content.find((b: Record<string,unknown>) => b.type === 'text')?.text ?? ''
            : typeof content === 'string' ? content : ''
          return String(text).trim().length > 0
        } catch { return false }
      })
      if (!hasUserMessage) {
        fs.unlinkSync(filePath)
        deleted++
      }
    } catch { /* skip unreadable files */ }
  }
  if (deleted > 0) console.log(`[session-logs] purged ${deleted} empty session file(s)`)
}

// ── Setup 화면 — Node 설치 · 기동 재시도 IPC ───────────────────
registerSetupIpc({
  getMainWindow,
  getOpenClawLog: () => openclawLogBuffer,
  twixyNodePath:   TWIXY_NODE_PATH,
  openclawLogPath: OPENCLAW_LOG_PATH,
  ensureWorkspace,
  findNode22,
  patchChromeProfileDisplayName,
})

// ── 파일 열기 (Setup 묶음과 함께 움직이지 않는다 — 신뢰 경계 핸들러다) ──
ipcMain.handle('open-file', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'empty path' }
    const ws = getWorkspace()
    const abs = path.isAbsolute(p) ? p : path.resolve(ws, p)
    // 보안: workspace 바깥 거부. (루트는 아래 'is a directory' 로 걸러진다 — 기존 오류 문구 유지)
    if (!isInside(ws, abs, { allowRoot: true })) {
      return { ok: false, error: 'path outside workspace' }
    }
    if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' }
    if (fs.statSync(abs).isDirectory()) return { ok: false, error: 'is a directory' }
    // 경로가 워크스페이스 안이어도 "열기" 는 별개 문제다 — 워크스페이스 내용물은 에이전트가
    // 쓴 것이고, 이 핸들러의 호출부 하나는 LLM 출력에서 뽑은 경로를 그대로 넘긴다.
    // shell.openPath 는 OS 연결을 타므로 .lnk/.bat/.js 는 클릭 한 번에 실행된다.
    // 문구는 사용자에게 그대로 보인다 (호출부가 alert / 패널 메시지로 띄운다) — 왜 안 열리는지,
    // 대신 무엇을 하면 되는지까지 적는다.
    if (!isOpenable(abs)) {
      const ext = path.extname(abs) || '(none)'
      return { ok: false, error: `this file type can't be opened from ${PRODUCT.displayName} (${ext}). Use "${process.platform === 'win32' ? 'Show in Explorer' : 'Reveal in Finder'}" and open it yourself if you trust it.` }
    }
    const err = await shell.openPath(abs)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'open failed' }
  }
})

// Check whether Node 22+ is available right now.
app.whenReady().then(async () => {
  await ensureWorkspace()
  // Stale browser-slot mappings from a previous app run would misroute this
  // run's browser calls (gateway sessions don't survive a restart anyway).
  try { if (fs.existsSync(BROWSER_SLOTS_FILE)) fs.unlinkSync(BROWSER_SLOTS_FILE) } catch { /* non-fatal */ }
  purgeEmptySessionLogs()
  patchChromeProfileDisplayName()
  if (process.platform === 'darwin') app.dock?.setIcon(appIcon())
  // 어떤 렌더러가 잡혔는지 남긴다 — "왜 근사본이 나오냐" 는 문의의 첫 확인 지점.
  console.log('[twixy/pptx] deck renderer:', findSoffice() ?? 'none — wireframe fallback')
  startDownloadWatcher()
  createTray()
  createWindow()
  probeMacPermissionsOnce()
  // Display-markup warmup — fetch once at boot so the first cost render hits
  // cache. fire-and-forget; errors surface in the UI as `⚠ pricing`.
  void fetchMarkup().catch(() => { /* IPC retry takes over */ })

  try {
    // 제품이 게이트웨이보다 먼저 띄워야 하는 것 (예: Nodal 의 로컬 엔진 = 에이전트의 MCP 서버).
    await runProductBeforeGateway()
    await startOpenClaw()
    console.log('[twixy] OpenClaw gateway ready')
    mainWindow?.webContents.send('openclaw-ready')
    // Patch again after gateway start — Chrome may have just created its
    // profile files for the first time, so the earlier patch (before
    // startOpenClaw) would have been a no-op.
    patchChromeProfileDisplayName()
    startSkillsWatcher(getWorkspace())
  } catch (err) {
    setStartupErrorMsg(String(err))
    console.error('[twixy] OpenClaw failed:', getStartupErrorMsg())
    mainWindow?.webContents.send('openclaw-error', getStartupErrorMsg())
  }
})

// ── 슬라이스 14 에서 옮긴 모듈의 등록 호출 ──────────────────────────────────
// enterpriseIpc · memoryIpc 는 import 만 되고 **호출되지 않았다** — 채널 8개가
// 죽은 채로 머지됐다(렌더러 invoke 가 "No handler registered" 로 거부).
// 미사용 import 는 lint 경고도 아니라 조용히 통과했다.
registerEnterpriseIpc({ getMainWindow, safeCopyFile })
registerMemoryIpc()

ipcMain.handle('pick-folder', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select a folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return canceled ? null : (filePaths[0] ?? null)
})

// Output-folder picker for workflows — MUST resolve inside the workspace
// (all workflow writes are workspace-jailed; an outside folder would just be
// blocked at run time). Opens in the workspace, and if the user navigates
// out and picks an external folder, we reject with a reason so the renderer
// can explain. Returns a WORKSPACE-RELATIVE path (e.g. "data/reports") — the
// portable form outputDir is stored/displayed as.
ipcMain.handle('pick-output-dir', async (): Promise<
  { ok: true; relPath: string } | { ok: false; reason: string } | null
> => {
  const ws = getWorkspace()
  // 출력 폴더는 workspace 전체가 아니라 data/ 내부로만 제한한다.
  const dataRoot = path.join(ws, 'data')
  try { fs.mkdirSync(dataRoot, { recursive: true }) } catch { /* ignore */ }
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select an output folder (inside data/)',
    defaultPath: dataRoot,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return null
  const picked = path.resolve(filePaths[0])
  if (!isInside(dataRoot, picked, { allowRoot: true })) {
    return { ok: false, reason: 'outside-data' }
  }
  // relPath 는 workspace 기준 (예: "data/reports").
  const rel = path.relative(ws, picked).split(path.sep).join('/')
  return { ok: true, relPath: rel }
})

app.on('window-all-closed', () => {
  // macOS 표준 관례는 창 닫기 시 dock 상주(앱 살아있음)이지만, Twixy 는
  // 백그라운드에서 openclaw 자식 프로세스 + WS 게이트웨이(:18789) 를
  // 들고 있어서 좀비 상태가 다음 launch 와 port 충돌을 일으킨다. 또
  // 사용자가 dmg 를 재설치한 직후 옛 instance 가 이전 PATH 캐시로 떠있어
  // 새 환경을 못 받는 케이스도 발생. 모든 플랫폼에서 종료해 cleanup.
  app.quit()
})

app.on('activate', () => { if (!mainWindow) createWindow() })
app.on('before-quit', () => {
  setAppQuitting(true)   // 종료 중에는 게이트웨이를 되살리지 않는다
  stopSkillsWatcher()
  stopOpenClaw()
  runProductQuit()
  closeToolBridge()
  closeExecutionPlanApi()
  // The discovery file holds this launch's Bearer token — remove it so a stale
  // token never outlives the process. force:true makes a missing file a no-op.
  try { fs.rmSync(executionPlanApiDiscoveryPath(), { force: true }) } catch { /* best-effort */ }
  closeSecondaryWindows()   // 창 정리는 windows.ts 가 한다 (보관소가 거기라서)
})
