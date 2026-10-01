// ── 경로·프로젝트 설정 (main.ts 에서 이동) ──────────────────────────────────
//
// 앱이 쓰는 모든 영속 경로와, 그 경로를 결정하는 프로젝트 설정
// (.twixy/config.json · project.json · mode.json) 의 읽기/쓰기.
//
// **가변 상태가 없다.** 전부 파일을 그때그때 읽는 함수와 상수뿐이라 저장소 분기
// 문제가 아예 생기지 않는다 — 그래서 이 묶음은 접근자 없이 그대로 import 된다.
//
// 유일한 주입: `currentActor`. getWorkspace() 가 사용자별 폴더를 만들 때 쓰는데,
// currentActor 는 세션(authSession)과 프로젝트 설정(여기) 양쪽을 읽는 다리라서
// 어느 쪽 모듈에도 넣으면 순환이 된다. main.ts 에 남겨 두고 thunk 으로 받는다.
import fs from 'node:fs'
import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT } from '../shared/product/current.generated'
import type { ChannelsConfig } from './channelSecrets'
import type { MRActor } from './mr'

export interface PathsDeps {
  currentActor: () => MRActor
}

let deps: PathsDeps | null = null

/** main.ts 가 기동 시 1회 호출한다. 안 부르면 첫 getWorkspace() 에서 throw 한다. */
export function initPaths(d: PathsDeps): void { deps = d }

function need(): PathsDeps {
  if (!deps) throw new Error('paths.ts: initPaths() 가 먼저 불려야 한다')
  return deps
}

// ── Paths — 영속 저장 경로들 ──────────────────────────────────────
// NOTE: workspace 경로는 getWorkspace() 를 통해 사용자별 동적으로 결정된다 (per-user isolation).
// 하드코딩된 WORKSPACE 상수는 사용하지 않음.
// 제품마다 다른 폴더 — 같은 PC 에 두 제품이 나란히 떠도 설정·세션·Chrome 프로필이
// 섞이지 않는다. 게이트웨이 자식에도 OPENCLAW_STATE_DIR 로 같은 경로를 준다.
export const OPENCLAW_DIR = path.join(os.homedir(), PRODUCT.stateDirName)                // OpenClaw 전체 설정 폴더
/** 상태 폴더 안 제품 소유 파일 (`<prefix>-<name>`). */
export const stateFile = (name: string) => path.join(OPENCLAW_DIR, `${PRODUCT.stateFilePrefix}-${name}`)
/** 덮어쓰기 승인창의 "Save as…" 매핑 (<approval id> → 새 상대경로). 게이트웨이가
 *  TWIXY_OVERWRITE_REDIRECT_FILE 로 받아 읽는다. */
export const OVERWRITE_REDIRECT_FILE = stateFile('overwrite-redirect.json')
export const CONFIG_PATH  = path.join(OPENCLAW_DIR, 'openclaw.json')                     // OpenClaw 기동 설정
// Twixy 가 관리하는 모바일 채널 설정. 재시작 시 ensureWorkspace 가 openclaw.json 에 병합한다.
export const CHANNELS_PATH = stateFile('channels.json')

// ── Mobile channels — 모바일/메신저 채널 설정 ────────────────────
// 사용자가 SettingsPanel 에서 켠 채널(Telegram/Discord/Signal/BlueBubbles) 자격증명을
// ~/.openclaw/twixy-channels.json 에 저장하고, 매 기동 시 openclaw.json 에 병합한다.
// 읽기/쓰기는 loadTwixyMode/saveTwixyMode 와 같은 모양이고 같은 상태 폴더를 쓴다.
// 마스킹·openclaw.json 블록 조립은 channelSecrets.ts (순수 모듈) 쪽이다.
export function loadChannels(): ChannelsConfig {
  try { return JSON.parse(fs.readFileSync(CHANNELS_PATH, 'utf8')) } catch { return {} }
}
export function saveChannels(c: ChannelsConfig) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(c, null, 2))
}

// Twixy 모드 2가지:
//   'twixy' = 호스팅 LLM 프록시 사용 (API 키 불필요 — 서버가 실제 OPENAI_API_KEY 를 쥐고
//             사용자 쿼터로 과금). 신규 설치 후 바로 대화 가능.
//   'byok'  = Bring Your Own Key. 사용자가 Settings 에 본인 OpenAI/Anthropic 키를 넣는 경로.
// 기본값은 'twixy'. 재시작에도 유지되며 렌더러가 set-twixy-mode IPC 로 변경한다.
const TWIXY_MODE_PATH = stateFile('mode.json')
export type TwixyMode = 'twixy' | 'byok'
export function loadTwixyMode(): TwixyMode {
  try {
    const raw = JSON.parse(fs.readFileSync(TWIXY_MODE_PATH, 'utf8'))
    return raw?.mode === 'byok' ? 'byok' : 'twixy'
  } catch {
    return 'twixy'  // first launch default
  }
}
export function saveTwixyMode(mode: TwixyMode) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  fs.writeFileSync(TWIXY_MODE_PATH, JSON.stringify({ mode }, null, 2))
}

// Project directory — user-selected folder that is the ROOT of a Twixy project.
// Persisted across restarts; must be set before chatting.
//
// Layout inside the project root (Git-style team collaboration structure):
//   <project_root>/
//     .twixy/            metadata (config, snapshots, MRs) — think .git
//     shared/            team-shared snapshot (read-only to individual users)
//     users/             per-user personal workspaces
//       [user_id]/       personal OpenClaw workspace (this is what getWorkspace returns)
//
// Legacy (pre-team-collab) installs had data/ and skills/ directly at the root.
// ensureWorkspace() detects and migrates those: flat → user/ → users/[uid]/ on first run.
const PROJECT_DIR_CONFIG = stateFile('project.json')
export function loadProjectDir(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECT_DIR_CONFIG, 'utf8'))
    const dir = raw?.projectDir
    return typeof dir === 'string' && dir ? dir : null
  } catch { return null }
}
export function saveProjectDir(dir: string) {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true })
  fs.writeFileSync(PROJECT_DIR_CONFIG, JSON.stringify({ projectDir: dir }, null, 2))
}
/** Root of the current Twixy project (user-picked folder, or default). */
export function getProjectRoot(): string {
  return loadProjectDir() ?? path.join(OPENCLAW_DIR, 'workspace', PRODUCT.defaultWorkspaceName)
}
/** Personal workspace — where the OpenClaw agent reads/writes by default.
 *  Always <project_root>/users/[user_id] — isolated per Supabase/local uid. */
export function getWorkspace(): string {
  return path.join(getProjectRoot(), 'users', need().currentActor().uid)
}
export function getSharedDir(): string   { return path.join(getProjectRoot(), 'shared') }
export function getTwixyMetaDir(): string { return path.join(getProjectRoot(), '.twixy') }
/** Execution Plan API discovery file ({port, token} for the local Clovex AI).
 *  Under userData — never the project folder, which can be committed/shared
 *  and would leak the Bearer token. Written on API start, deleted on quit. */
export function executionPlanApiDiscoveryPath(): string {
  return path.join(app.getPath('userData'), 'execution-plan-api.json')
}

// ── Team collaboration: project config (.twixy/config.json) ─────
// The "project config" lives INSIDE the project root at .twixy/config.json
// (versus the global PROJECT_DIR_CONFIG which just remembers which folder the
// user picked). It declares team mode: solo / shared-folder / server.
//
// Phase 1 only reads/writes these minimally — MR, owner, reviewers come in Phase 2.
export type CollabMode = 'solo' | 'shared-folder' | 'server'
export type ProjectConfig = {
  version:       1
  projectId:     string                       // random id, stable across syncs
  mode:          CollabMode
  ownerUid?:     string                       // Supabase uid of project owner
  ownerEmail?:   string                       // UI-friendly label for ownerUid
  serverUrl?:    string                       // B2B: central LAN server base URL
  reviewers?:    { uid: string; email?: string }[]  // default reviewers for new MRs
  requiredApprovals?: number                  // Phase 2 default: 1
  createdAt:     string                       // ISO timestamp
  // Phase 3+ fields (lastSnapshot) added lazily.
}
function projectConfigPath(): string {
  return path.join(getTwixyMetaDir(), 'config.json')
}
export function loadProjectConfig(): ProjectConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(projectConfigPath(), 'utf8'))
    if (raw?.version !== 1 || typeof raw?.projectId !== 'string') return null
    return raw as ProjectConfig
  } catch { return null }
}
export function saveProjectConfig(cfg: ProjectConfig) {
  fs.mkdirSync(getTwixyMetaDir(), { recursive: true })
  fs.writeFileSync(projectConfigPath(), JSON.stringify(cfg, null, 2))
}
export function loadCollabMode(): CollabMode {
  return loadProjectConfig()?.mode ?? 'solo'
}
export function generateProjectId(): string {
  // 16 bytes hex, prefixed — matches the MR id style we'll use in Phase 2.
  return 'proj_' + Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')
}
// 웹 로그인 핸드오프(twixy:// 딥링크)로 받은 Supabase 세션 저장 경로.
// 이 파일은 게이트웨이 자식 프로세스가 읽지 않고 Twixy main 만 읽으므로
// safeStorage(OS 키체인/자격증명 저장소)로 at-rest 암호화한다. 파일명은
// `.enc` 접미사를 붙였고, 예전 평문 `twixy-session.json` 이 남아 있으면
// loadSession() 이 최초 접근 시 읽어 암호화 저장 후 평문을 삭제한다(마이그레이션).
// safeStorage 미지원 환경에서는 평문 0600 으로 폴백한다.
export const SESSION_PATH        = stateFile('session.json.enc')
export const SESSION_PATH_LEGACY = stateFile('session.json')

// Twixy 웹앱 루트 URL. 환경변수 TWIXY_WEB_URL 로 오버라이드 가능(로컬 개발 시 등).
// 실제 로그인 트리거는 /auth/desktop-callback 경로를 외부 브라우저로 여는 방식.
export const WEB_URL = process.env.TWIXY_WEB_URL ?? PRODUCT.webUrl

// OpenClaw 는 "openclaw" 라는 프로필 키를 기본으로 내장하고 있어 Chrome user-data 경로가 고정.
// 매 기동마다 이 프로필의 Preferences 내 display name 만 "Twixy" 로 덮어써 브랜딩을 교체한다.
export const CHROME_PROFILE_DIR = path.join(OPENCLAW_DIR, 'browser', 'openclaw', 'user-data')
export const CHROME_DISPLAY_NAME = PRODUCT.chromeDisplayName

// OpenClaw 는 브라우저 다운로드를 ~/Downloads 가 아닌 이 임시 경로로 저장한다.
// 우리는 이 폴더를 감시하다가 파일이 떨어지면 내용을 sniff 해 적절한 확장자로
// workspace/data/raw/ 로 이동시킨다 (startDownloadWatcher 참조).
export const OPENCLAW_DOWNLOADS_DIR = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'openclaw', 'downloads')
  : '/tmp/openclaw/downloads'

