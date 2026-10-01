// ── 창의 진입 페이지 + IPC 발신자 검증 (순수 모듈: electron import 없음) ─────────────
//
// 5개 BrowserWindow 가 전부 같은 preload.js 를 쓴다. 그래서 어느 창의 렌더러든
// window.twixy.* 전체를 부를 수 있고, ipcMain.handle 은 누가 불렀는지 보지 않았다.
// 사이드탭은 LLM 이 쓴 마크다운을 그리는 창이다 — 거기서 guardrail 승인을 위조하거나
// 게이트웨이 토큰을 꺼낼 수 있으면 안 된다.
//
// 검증은 세 가지를 본다: (1) event.sender 가 그 채널에 허용된 창의 webContents 인가,
// (2) 메인 프레임인가, (3) 프레임 URL 이 **그 창이 원래 로드한 페이지**인가.
//
// (3) 이 핵심 설계 제약이다: "창이 로드한 페이지" 를 두 군데서 따로 계산하면 언젠가 어긋나고,
// 어긋나면 정상 창이 거부된다 — 패키지 앱에서 guardrail 승인이 안 눌리는 건 구멍보다 나쁘다.
// 그래서 windowEntry() 하나를 **로더와 검증기가 같이** 쓴다. main.ts 의 loadURL/loadFile 도
// 이 함수의 결과로 연다.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type WindowKind = 'main' | 'sidetab' | 'composer' | 'testOverlay' | 'guardrail'

/** dev 는 Vite 서버 URL(loadURL), 패키지는 dist 안의 파일(loadFile). */
export type WindowEntry =
  | { type: 'url';  url: string }
  | { type: 'file'; path: string }

export interface EntryEnv {
  isDev: boolean
  /** 패키지 빌드의 렌더러 산출물 폴더 — main 의 `path.join(__dirname, '..', 'dist')`. */
  distDir: string
  /** `PRODUCT.htmlEntry`. 제품마다 다르다: 'index.html' · 'twixy-enterprise.html' ·
   *  'products/nodal/index.html' (Vite 는 html 입력의 상대경로를 dist 안에 그대로 유지한다). */
  mainHtmlEntry: string
}

const DEV_ORIGIN = 'http://localhost:5173'

const SECONDARY_HTML: Record<Exclude<WindowKind, 'main'>, string> = {
  sidetab:     'sidetab.html',
  composer:    'composer.html',
  testOverlay: 'test-overlay.html',
  guardrail:   'guardrail.html',
}

/**
 * 그 창이 로드하는 대상. 로더와 검증기의 단일 출처.
 * `platform` 은 테스트용 (기본값이면 `path.join` 과 동일) — macOS 형태의 경로도 Windows 에서 검증하려고.
 */
export function windowEntry(kind: WindowKind, env: EntryEnv, platform: NodeJS.Platform = process.platform): WindowEntry {
  const html = kind === 'main' ? env.mainHtmlEntry : SECONDARY_HTML[kind]
  if (env.isDev) {
    // 기본 제품(index.html)의 메인 창은 dev 서버 루트로 연다 — 옮기기 전 동작 그대로.
    return { type: 'url', url: kind === 'main' && html === 'index.html' ? DEV_ORIGIN : `${DEV_ORIGIN}/${html}` }
  }
  return { type: 'file', path: (platform === 'win32' ? path.win32 : path.posix).join(env.distDir, html) }
}

/**
 * 프레임 URL 이 그 진입 페이지인가. query·hash 는 무시한다 (같은 문서다).
 *
 * file: 은 URL 문자열끼리 비교하지 않고 **경로로 되돌려서** 비교한다. Chromium 과 Node 는
 * 공백·한글·`#` 등을 percent-encode 하는 규칙이 조금씩 달라서, 사용자 이름이 한글이거나 앱
 * 이름에 공백이 있으면(`Twixy Enterprise.app`) 문자열 비교는 정상 창을 거부한다.
 * Windows 는 드라이브 문자·경로의 대소문자가 다를 수 있어 대소문자를 무시하고, macOS 의
 * NFC/NFD 차이를 피하려 유니코드 정규화도 맞춘다.
 *
 * `platform` 은 테스트용 — 어느 OS 에서 돌려도 Windows 형태(`file:///C:/…`)를 검증할 수 있게.
 */
export function frameMatchesEntry(
  frameUrl: string,
  entry: WindowEntry,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let u: URL
  try { u = new URL(frameUrl) } catch { return false }

  if (entry.type === 'url') {
    const e = new URL(entry.url)
    return u.origin === e.origin && u.pathname === e.pathname
  }

  if (u.protocol !== 'file:') return false
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  let actual: string
  try { actual = fileURLToPath(u, { windows: win }) } catch { return false }   // 예: POSIX 에서 host 가 붙은 file://
  const norm = (s: string) => {
    const n = p.normalize(s).normalize('NFC')
    return win ? n.toLowerCase() : n
  }
  return norm(actual) === norm(entry.path)
}

/** IPC 이벤트에서 뽑은, 발신자에 대한 사실. main.ts 가 채워서 넘긴다. */
export interface SenderFacts {
  webContentsId: number
  /** `event.senderFrame` 이 null(프레임이 이미 사라짐)이면 undefined. */
  frame?: { isMainFrame: boolean; url: string }
}

/** 지금 떠 있는, 그 채널에 허용된 창. */
export interface AllowedWindow {
  kind: WindowKind
  webContentsId: number
  entry: WindowEntry
}

/**
 * 통과면 null, 아니면 거부 사유. 사유는 로그에 그대로 찍히므로 payload·URL 전체를 담지 않는다
 * (file: URL 에는 사용자 홈 경로가 들어 있다).
 */
export function senderRejection(
  sender: SenderFacts,
  allowed: AllowedWindow[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const win = allowed.find(w => w.webContentsId === sender.webContentsId)
  if (!win) return `sender is not an allowed window (${allowed.map(w => w.kind).join('|') || 'none open'})`
  if (!sender.frame) return 'sender frame is gone'
  if (!sender.frame.isMainFrame) return 'sender is a subframe'
  if (!frameMatchesEntry(sender.frame.url, win.entry, platform)) return `frame is not the ${win.kind} entry page`
  return null
}
