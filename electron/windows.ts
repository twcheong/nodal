// ── 창 5종의 수명주기 (main.ts 에서 이동) ───────────────────────────────────
//
// 사이드탭·컴포저·테스트 오버레이·가드레일 팝업 창을 만들고 닫는다. 메인 창 **생성**은
// main.ts 에 남아 있다 (앱 기동 순서에 묶여 있어서) — 여기서는 참조만 thunk 으로 받는다.
// (Stage 4 슬라이스 5)
//
// ⚠ **창의 저장소는 여기 하나뿐이다.** 아래 네 개의 let 이 유일한 보관소이고,
// getWindow() 가 그것을 그대로 읽는다. IPC 발신자 검증(main.ts 의 senderBlocked)도
// 같은 getWindow() 를 쓴다 — 창 목록을 두 군데서 따로 들고 있으면 어긋나는 순간
// **정상 창이 거부되고**, 증상은 "게이트웨이에 안 붙는다" 로만 보인다.
// 이 단일 출처 성질은 windows.contract.test.ts 가 소스 모양으로 지킨다.
import { BrowserWindow, screen, shell } from 'electron'
import { isAllowedExternalUrl } from './trustBoundary'
import type { WindowKind } from './windowEntry'

export interface WindowDeps {
  isDev: boolean
  /** dist-electron 안의 preload.js 절대경로. __dirname 해석을 main 에 맡긴다. */
  preloadPath: string
  /** 창에 진입 페이지를 로드한다 (main 의 loadWindowEntry). */
  loadWindowEntry: (win: BrowserWindow, kind: WindowKind) => void
  /** 메인 창 — 생성은 main 이 하므로 참조만 받는다. */
  getMainWindow: () => BrowserWindow | null
}

let deps: WindowDeps | null = null
/** 기동 시 한 번. 창 생성 함수를 쓰기 전에 불러야 한다. */
export function initWindows(d: WindowDeps): void { deps = d }
function need(): WindowDeps {
  if (!deps) throw new Error('windows.ts: initWindows() 가 먼저 불려야 한다')
  return deps
}

// ── 창 보관소 — 이 네 개가 전부다 ──────────────────────────────────────────
let overlayWindow:     BrowserWindow | null = null   // Sidetab overlay 윈도우
let composerWindow:    BrowserWindow | null = null   // Composer floating 윈도우
let testOverlayWindow: BrowserWindow | null = null   // Workflow Test 진행 overlay
let guardrailWindow:   BrowserWindow | null = null   // Guardrail 팝업 윈도우 (Enterprise)
let overlayOpacity:    number = 1                    // overlay 투명도

/**
 * 종류로 창을 찾는다. **senderBlocked 와 창 생성 코드가 같이 쓰는 유일한 조회 지점.**
 * 원본 main.ts 의 windowOf() 를 그대로 옮긴 것이고, 'main' 만 thunk 으로 위임한다.
 */
export function getWindow(kind: WindowKind): BrowserWindow | null {
  switch (kind) {
    case 'main':        return need().getMainWindow()
    case 'sidetab':     return overlayWindow
    case 'composer':    return composerWindow
    case 'testOverlay': return testOverlayWindow
    case 'guardrail':   return guardrailWindow
  }
}

/**
 * 오버레이 투명도를 기억한다. **창에 적용하는 것은 호출부 몫** — 원본 main.ts 의
 * overlay-set-opacity 핸들러가 값을 저장한 뒤 두 창에 직접 setOpacity 를 불렀고,
 * 그 순서를 그대로 둔다. 여기서 같이 적용하면 이중 호출이 된다.
 */
export function setOverlayOpacity(v: number): void { overlayOpacity = v }

// ── External link guard ──────────────────────────────────────────
// 내부 Twixy 윈도우는 모두 앱 UI 이지 브라우저가 아니다. markdown 안에 하이퍼링크가
// 있을 경우(예: tool 결과에 들어있는 YouTube URL), 클릭 시 시스템 브라우저에서 열어야
// 하며 팝업을 탭으로 바꾸면 안 된다.
export function wireExternalLinks(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL()
    try {
      const u = new URL(url), c = new URL(current)
      if (u.origin === c.origin && u.pathname === c.pathname) return
    } catch { /* fall through to block */ }
    e.preventDefault()
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {})
  })
}

// Safely leave macOS native fullscreen and wait for the transition animation
// to finish before resolving. Used when something is about to spawn a sibling
// BrowserWindow — opening a window inside a fullscreen Space breaks the
// Space, leaving the main window stranded on the regular desktop with no
// titlebar to drag. We avoid that by exiting fullscreen first, deterministically.
export async function exitMainFullScreenIfNeeded(): Promise<void> {
  const mainWindow = need().getMainWindow()
  if (!mainWindow || !mainWindow.isFullScreen()) return
  await new Promise<void>(resolve => {
    const done = () => { mainWindow?.removeListener('leave-full-screen', done); resolve() }
    mainWindow!.once('leave-full-screen', done)
    mainWindow!.setFullScreen(false)
    // Safety timeout in case the event never fires on some macOS versions.
    setTimeout(done, 1200)
  })
}

// ── Sidetab overlay window ────────────────────────────────────────
// A small always-on-top floating window that mirrors the current
// plan / chat state. Users keep it visible while working in other
// apps so they can watch Twixy's progress without keeping the main
// Twixy window in focus.
export function createOverlayWindow() {
  if (overlayWindow) {
    if (overlayWindow.isMinimized()) overlayWindow.restore()
    overlayWindow.show()
    overlayWindow.focus()
    return
  }

  // Position to the top-right of the primary display with a small margin.
  const display = screen.getPrimaryDisplay().workArea
  const W = 440, H = 720, MARGIN = 24

  overlayWindow = new BrowserWindow({
    width: W,
    height: H,
    x: display.x + display.width - W - MARGIN,
    y: display.y + MARGIN,
    minWidth: 280,
    minHeight: 320,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(process.platform === 'darwin'
      ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const }
      : {}),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: need().preloadPath,
      // preload 가 이 창에 줄 표면을 고르는 근거 (electron/preload.ts 의 PER_WINDOW).
      additionalArguments: ['--twixy-window=sidetab'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,        // preload 는 electron API 만 사용 → sandbox 안전
      devTools: need().isDev,      // 프로덕션 DevTools 비활성
    },
  })

  // 'floating' level keeps the overlay following the user across Spaces
  // (Cmd+→). Higher levels like 'screen-saver' float above fullscreen but
  // get pinned to a single Space on some macOS versions, breaking that.
  // The visibleOnAllWorkspaces+visibleOnFullScreen flags below carry the
  // popout into fullscreen Spaces without needing the higher level.
  if (process.platform === 'darwin') {
    overlayWindow.setAlwaysOnTop(true, 'floating')
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  } else {
    overlayWindow.setAlwaysOnTop(true)
  }
  wireExternalLinks(overlayWindow)

  need().loadWindowEntry(overlayWindow, 'sidetab')

  overlayWindow.setOpacity(overlayOpacity)
  overlayWindow.on('closed', () => {
    overlayWindow = null
    // If the user closes the side panel, also dismiss the floating
    // composer — they belong to the same "sidetab mode" UI.
    composerWindow?.removeAllListeners('closed')
    composerWindow?.close()
    composerWindow = null
  })
}

// ── Sidetab composer window ───────────────────────────────────────
// A second, wider+shorter always-on-top window that sits at the bottom
// of the screen. It hosts only the composer + Stop/Start/Send button
// so the user can always type/interrupt without reaching for the
// taller side panel above. Both windows subscribe to the same
// overlay-sync state and forward user actions through the same IPC.
export function createComposerWindow() {
  if (composerWindow) {
    if (composerWindow.isMinimized()) composerWindow.restore()
    composerWindow.show()
    return
  }

  const display = screen.getPrimaryDisplay().workArea
  const W = 560, H = 72, MARGIN = 24

  composerWindow = new BrowserWindow({
    width: W,
    height: H,
    x: display.x + Math.round((display.width - W) / 2),
    y: display.y + display.height - H - MARGIN,
    minWidth: 360,
    minHeight: 56,
    maxHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(process.platform === 'darwin'
      ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const }
      : {}),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: need().preloadPath,
      // preload 가 이 창에 줄 표면을 고르는 근거 (electron/preload.ts 의 PER_WINDOW).
      additionalArguments: ['--twixy-window=composer'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,        // preload 는 electron API 만 사용 → sandbox 안전
      devTools: need().isDev,      // 프로덕션 DevTools 비활성
    },
  })

  if (process.platform === 'darwin') {
    composerWindow.setAlwaysOnTop(true, 'floating')
    composerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  } else {
    composerWindow.setAlwaysOnTop(true)
  }
  wireExternalLinks(composerWindow)

  need().loadWindowEntry(composerWindow, 'composer')

  composerWindow.setOpacity(overlayOpacity)
  composerWindow.on('closed', () => {
    composerWindow = null
    // Closing the composer alone also tears down the side panel —
    // the two always appear together.
    overlayWindow?.removeAllListeners('closed')
    overlayWindow?.close()
    overlayWindow = null
  })
}

// ── Workflow Test progress overlay ────────────────────────────────
// 메인 윈도우의 WorkflowView 가 Test Mode 를 시작하면 자동으로 spawn.
// 사이드탭 패턴과 동일하게 floating + visibleOnFullScreen — 사용자가 다른
// 앱에서 작업 중에도 진행상황(노드별 status/duration/cost)을 작은 창으로 확인.
// 메인은 testState 가 바뀔 때마다 test-overlay-sync-push 로 스냅샷 전달.
export function createTestOverlayWindow() {
  if (testOverlayWindow) {
    if (testOverlayWindow.isMinimized()) testOverlayWindow.restore()
    testOverlayWindow.show()
    testOverlayWindow.focus()
    return
  }

  const display = screen.getPrimaryDisplay().workArea
  const W = 360, H = 540, MARGIN = 24

  testOverlayWindow = new BrowserWindow({
    width: W,
    height: H,
    x: display.x + display.width - W - MARGIN,
    y: display.y + MARGIN,
    minWidth: 280,
    minHeight: 320,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(process.platform === 'darwin'
      ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const }
      : {}),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: need().preloadPath,
      // preload 가 이 창에 줄 표면을 고르는 근거 (electron/preload.ts 의 PER_WINDOW).
      additionalArguments: ['--twixy-window=testOverlay'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,        // preload 는 electron API 만 사용 → sandbox 안전
      devTools: need().isDev,      // 프로덕션 DevTools 비활성
    },
  })

  if (process.platform === 'darwin') {
    testOverlayWindow.setAlwaysOnTop(true, 'floating')
    testOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  } else {
    testOverlayWindow.setAlwaysOnTop(true)
  }
  wireExternalLinks(testOverlayWindow)

  need().loadWindowEntry(testOverlayWindow, 'testOverlay')

  testOverlayWindow.setOpacity(overlayOpacity)
  testOverlayWindow.on('closed', () => {
    testOverlayWindow = null
  })
}

// ── Guardrail popup window ────────────────────────────────────────
// 메인 렌더러의 useGuardrail.current 가 non-null 일 때만 spawn 되는 작은 modal-style
// always-on-top 윈도우. 자체 BrowserWindow 로 두면 사용자가 현재 어떤 앱에 있든
// 프롬프트가 그 위로 노출 — 메인 Twixy 윈도우/사이드탭 안에 갇히지 않는다.
export function createGuardrailWindow() {
  if (guardrailWindow) {
    if (guardrailWindow.isMinimized()) guardrailWindow.restore()
    guardrailWindow.show()
    guardrailWindow.focus()
    return
  }

  const display = screen.getPrimaryDisplay().workArea
  const W = 520, H = 520

  guardrailWindow = new BrowserWindow({
    width: W,
    height: H,
    x: display.x + Math.round((display.width - W) / 2),
    y: display.y + Math.round((display.height - H) / 2),
    minWidth: 360,
    minHeight: 360,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    // visibleOnAllWorkspaces 는 생성자 옵션으로 주면 skipTransformProcessType 를
    // 못 넘겨 메인 윈도우가 fullscreen Space 에서 튕겨나온다 — 아래 setter 로만 적용.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const }
      : {}),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: need().preloadPath,
      // preload 가 이 창에 줄 표면을 고르는 근거 (electron/preload.ts 의 PER_WINDOW).
      additionalArguments: ['--twixy-window=guardrail'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,        // preload 는 electron API 만 사용 → sandbox 안전
      devTools: need().isDev,      // 프로덕션 DevTools 비활성
    },
  })

  // 'screen-saver' 레벨을 써서 팝업이 fullscreen 앱 위로도 floating 되게 한다 —
  // tool 호출이 진행되기 전에 사용자가 반드시 보아야 하는 보안 프롬프트.
  if (process.platform === 'darwin') {
    guardrailWindow.setAlwaysOnTop(true, 'screen-saver')
    // skipTransformProcessType 이 없으면 이 호출이 앱 activation policy 를 건드려
    // fullscreen 중인 메인 윈도우가 Space 에서 쫓겨난다 (전체화면 크기인데
    // 전체화면이 아닌 상태로 데스크탑 위에 남음).
    guardrailWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  } else {
    guardrailWindow.setAlwaysOnTop(true)
  }

  need().loadWindowEntry(guardrailWindow, 'guardrail')

  wireExternalLinks(guardrailWindow)
  guardrailWindow.on('closed', () => {
    guardrailWindow = null
  })
}

export function closeGuardrailWindow() {
  if (!guardrailWindow) return
  guardrailWindow.removeAllListeners('closed')
  guardrailWindow.close()
  guardrailWindow = null
}


/**
 * 앱 종료 시 보조 창을 전부 닫는다 (before-quit).
 * 'closed' 리스너를 먼저 떼는 이유: 사이드탭과 컴포저는 서로의 closed 에서 상대를 닫는다 —
 * 종료 중에 그 연쇄가 돌면 이미 파괴된 창을 건드린다. 원본 main.ts 의 순서를 그대로 옮겼다.
 */
export function closeSecondaryWindows(): void {
  overlayWindow?.removeAllListeners('closed')
  overlayWindow?.close()
  overlayWindow = null
  composerWindow?.removeAllListeners('closed')
  composerWindow?.close()
  composerWindow = null
  guardrailWindow?.removeAllListeners('closed')
  guardrailWindow?.close()
  guardrailWindow = null
}
