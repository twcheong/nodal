// ── 오버레이 · 가드레일 팝업 IPC (main.ts 에서 이동) ────────────────────────
//
// 사이드탭/컴포저/테스트 오버레이의 상태 미러링과 사용자 액션 전달, 가드레일 승인 팝업의
// 수명주기, 그리고 덮어쓰기 승인창의 "Save as…" 매핑. (Stage 4 슬라이스 5)
//
// 창 자체는 windows.ts 가 만들고 보관한다 — 여기서는 그 함수들을 import 해서 쓴다.
// 메인 창만 main.ts 소유라 thunk 으로 받는다.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './trustBoundary'
import type { WindowKind } from './windowEntry'
import {
  closeGuardrailWindow, createComposerWindow, createGuardrailWindow, createOverlayWindow,
  createTestOverlayWindow, exitMainFullScreenIfNeeded, getWindow, setOverlayOpacity,
} from './windows'

export interface OverlayIpcDeps {
  getMainWindow: () => BrowserWindow | null
  getWorkspace: () => string
  /** IPC 발신자 검증 — main 이 소유한다 (19곳이 쓴다). */
  senderBlocked: (e: IpcMainInvokeEvent, channel: string, kinds: WindowKind[]) => boolean
  /** 게이트웨이가 읽는 "Save as" 매핑 파일. 경로 상수는 main 소유(게이트웨이 env 로도 나간다). */
  overwriteRedirectFile: string
}
import type { BrowserWindow } from 'electron'

// 오버레이/팝업이 재오픈 시 즉시 최신 상태를 당겨갈 수 있게 보관하는 캐시.
let overlaySnapshot: unknown = null
let testOverlaySnapshot: unknown = null
let guardrailPopupState: unknown = null

/** 오버레이·가드레일 IPC 15개를 등록한다. import 시점 부작용 없음. */
export function registerOverlayIpc(deps: OverlayIpcDeps): void {
  const { getMainWindow, getWorkspace, senderBlocked } = deps
  const OVERWRITE_REDIRECT_FILE = deps.overwriteRedirectFile

  // ── Sidetab overlay IPC ────────────────────────────────────────────
  // mainWindow owns the chat/plan state (WebSocket + React hooks). The
  // overlay window is a pure mirror: it pulls the latest snapshot on
  // mount and receives pushes on every state change. User actions taken
  // inside the overlay (Stop, Send) are forwarded here and re-dispatched
  // to mainWindow so there is only one session talking to the gateway.
  ipcMain.handle('open-sidetab', async () => {
    // Main window is forced out of macOS native fullscreen before spawning
    // the popout. We explored keeping main in fullscreen (show:false + early
    // visibleOnFullScreen) but macOS still placed the popout incorrectly on
    // the test environment, so the deterministic exit is the behavior we
    // ship — predictable on every macOS version we've tried.
    await exitMainFullScreenIfNeeded()
    createOverlayWindow()
    createComposerWindow()
    return { ok: true }
  })
  ipcMain.handle('close-sidetab', () => {
    // Close both — listeners above will null out refs.
    getWindow('sidetab')?.close()
    getWindow('composer')?.close()
    return { ok: true }
  })

  // Live transparency for the overlay windows. Slider in the side panel
  // drives this; we persist the value in memory so a newly-opened window
  // inherits the last setting.
  ipcMain.handle('overlay-set-opacity', (_e, value: number) => {
    const v = Math.max(0.3, Math.min(1, Number(value)))
    setOverlayOpacity(v)
    getWindow('sidetab')?.setOpacity(v)
    getWindow('composer')?.setOpacity(v)
    return { ok: true, value: v }
  })

  // Renderer → main: mainWindow pushes its current snapshot (messages,
  // isThinking, toolActivity, activePlanId, planMode). We cache it so a
  // freshly-opened overlay can pull the current state immediately, and
  // forward to overlayWindow when it exists.
  ipcMain.handle('overlay-sync-push', (_e, snapshot: unknown) => {
    overlaySnapshot = snapshot
    getWindow('sidetab')?.webContents.send('overlay-sync', snapshot)
    getWindow('composer')?.webContents.send('overlay-sync', snapshot)
    return { ok: true }
  })

  // Overlay → main: freshly-mounted overlay requests the latest cached
  // snapshot. No re-compute; just replays whatever mainWindow last pushed.
  ipcMain.handle('overlay-request-sync', () => overlaySnapshot)

  // Overlay → main → mainWindow. The main renderer owns the chat/plan
  // hooks, so we just forward the user intent and let React handle it.
  //
  // 이 5개는 에이전트 세션에 **사용자 의도를 주입**한다 (메시지 전송·실행 시작/재개·중단·
  // 플랜모드 토글). 그래서 사이드탭 쌍(사이드탭 패널 + 컴포저)만 보낼 수 있게 한다 — 둘은
  // 함께 뜨고 함께 닫히는 한 벌의 UI 라 채널별로 한쪽만 허용하지 않는다(버튼이 두 패널
  // 사이를 오가도 안 깨지게). 메인·guardrail·테스트 오버레이 창은 이 경로로 메시지를 넣을 수 없다.
  ipcMain.handle('overlay-stop', (e) => {
    if (senderBlocked(e, 'overlay-stop', ['sidetab', 'composer'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('overlay-stop')
    return { ok: true }
  })
  ipcMain.handle('overlay-send', (e, text: string) => {
    if (senderBlocked(e, 'overlay-send', ['sidetab', 'composer'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('overlay-send', String(text ?? ''))
    return { ok: true }
  })
  ipcMain.handle('overlay-start', (e) => {
    if (senderBlocked(e, 'overlay-start', ['sidetab', 'composer'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('overlay-start')
    return { ok: true }
  })
  ipcMain.handle('overlay-resume', (e) => {
    if (senderBlocked(e, 'overlay-resume', ['sidetab', 'composer'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('overlay-resume')
    return { ok: true }
  })
  ipcMain.handle('overlay-toggle-plan-mode', (e) => {
    if (senderBlocked(e, 'overlay-toggle-plan-mode', ['sidetab', 'composer'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('overlay-toggle-plan-mode')
    return { ok: true }
  })

  // ── Test Progress overlay IPC ──────────────────────────────────────
  // 메인 윈도우가 워크플로 테스트를 시작할 때 open-test-overlay 호출 → spawn.
  // 매 testState 변경마다 test-overlay-sync-push 로 스냅샷 전달 → overlay 미러링.
  // overlay 의 Stop 버튼은 test-overlay-stop 으로 메인에 다시 forward.
  ipcMain.handle('open-test-overlay', () => {
    // Sidetab 과 동일하게 fullscreen Space 충돌을 피하기 위해 메인이 native
    // fullscreen 이라면 먼저 나오게 한 뒤 overlay 생성.
    return (async () => {
      await exitMainFullScreenIfNeeded()
      createTestOverlayWindow()
      return { ok: true }
    })()
  })
  ipcMain.handle('close-test-overlay', () => {
    getWindow('testOverlay')?.close()
    return { ok: true }
  })
  ipcMain.handle('test-overlay-sync-push', (_e, snapshot: unknown) => {
    testOverlaySnapshot = snapshot
    getWindow('testOverlay')?.webContents.send('test-overlay-sync', snapshot)
    return { ok: true }
  })
  ipcMain.handle('test-overlay-request-sync', () => testOverlaySnapshot)
  ipcMain.handle('test-overlay-stop', () => {
    getMainWindow()?.webContents.send('test-overlay-stop')
    return { ok: true }
  })
  ipcMain.handle('test-overlay-focus-main', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return { ok: false }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return { ok: true }
  })
  // overlay 가 Human Review 결정 (approve / note / skip) 을 보내면 메인 윈도우의
  // WorkflowView 가 받아 useWorkflowTest.resumeReview 로 전달.
  ipcMain.handle('test-overlay-review-decision', (e, payload: { nodeId: string; action: 'approve' | 'note' | 'skip'; comment?: string }) => {
    // Human Review 결정(approve/skip)은 그 프롬프트를 띄운 테스트 오버레이 창만 보낼 수 있다.
    if (senderBlocked(e, 'test-overlay-review-decision', ['testOverlay'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('test-overlay-review-decision', payload)
    return { ok: true }
  })


  // ── Guardrail popup IPC ────────────────────────────────────────────
  // The main renderer drives popup lifecycle: when `useGuardrail.current`
  // becomes non-null it calls `guardrail-popup-show` to spawn the window
  // and push the request; when it clears it calls `guardrail-popup-close`.
  // The popup itself reads state via `guardrail-popup-request-sync` (pull
  // on mount) and `guardrail-popup-sync` (push for subsequent updates),
  // and forwards button clicks back through `guardrail-popup-decide`.
  ipcMain.handle('guardrail-popup-show', (_e, payload: unknown) => {
    guardrailPopupState = payload
    createGuardrailWindow()
    // Push to popup immediately if it already exists (subsequent requests).
    getWindow('guardrail')?.webContents.send('guardrail-popup-sync', payload)
    return { ok: true }
  })

  ipcMain.handle('guardrail-popup-close', () => {
    guardrailPopupState = null
    closeGuardrailWindow()
    return { ok: true }
  })

  ipcMain.handle('guardrail-popup-request-sync', () => guardrailPopupState)

  // 승인 결정은 **승인창만** 보낼 수 있다. 예전엔 어느 창이든 { action: 'approve' } 를 보내면
  // 메인 렌더러가 그대로 게이트웨이에 승인을 넣었다 — 사이드탭은 LLM 마크다운을 그리는 창이다.
  ipcMain.handle('guardrail-popup-decide', (e, payload: { id: string; action: 'approve' | 'session' | 'remember' | 'deny' | 'save-as'; params?: Record<string, unknown>; saveAsName?: string }) => {
    if (senderBlocked(e, 'guardrail-popup-decide', ['guardrail'])) return { ok: false, error: 'forbidden_sender' }
    getMainWindow()?.webContents.send('guardrail-popup-decide', payload)
    return { ok: true }
  })

  // ── 덮어쓰기 승인창의 "Save as…" ───────────────────────────────────
  // 유저가 "덮어쓰지 말고 다른 이름으로" 를 고르면 <승인 id> → <새 상대경로>
  // 매핑을 OVERWRITE_REDIRECT_FILE 에 적는다. 게이트웨이(패치된
  // runBeforeToolCallHook)가 승인 직후 이 파일을 읽어 write 툴의 경로
  // 파라미터를 갈아끼우므로, 기존 파일은 그대로 남고 새 산출물만 새 이름으로
  // 저장된다. 렌더러는 이 핸들러가 ok 를 준 뒤에만 approve 를 보낸다
  // (실패했는데 승인하면 원본을 날리므로 fail-closed).
  //
  // 이름만 바꾼다 — 폴더는 원본 그대로. 경로 이동을 허용하면 designated-paths
  // 버킷 밖으로 나갈 수 있어서 basename 만 받는다.
  ipcMain.handle('guardrail-overwrite-redirect', (e, payload: { id: string; originalRel: string; fileName: string }) => {
    // "Save as…" 매핑은 메인 창의 useGuardrail 만 쓴다 (승인창의 결정을 메인이 받아서 호출).
    if (senderBlocked(e, 'guardrail-overwrite-redirect', ['main'])) return { ok: false, error: 'forbidden_sender' }
    try {
      const id = String(payload?.id ?? '').trim()
      const originalRel = String(payload?.originalRel ?? '').trim()
      let name = String(payload?.fileName ?? '').trim()
      if (!id || !originalRel || !name) return { ok: false, error: 'id / path / name required' }
      if (/[\\/]/.test(name) || name === '.' || name === '..') return { ok: false, error: 'file name only (no folders)' }
      // 원본 확장자 유지 — 유저가 확장자를 지웠으면 되붙인다 (.pptx 를 잃으면
      // 뒤따르는 툴이 파일을 못 연다).
      const ext = path.extname(originalRel)
      if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext

      const workspace = getWorkspace()
      const originalAbs = path.isAbsolute(originalRel) ? originalRel : path.join(workspace, originalRel)
      const dirAbs = path.dirname(originalAbs)
      let targetAbs = path.join(dirAbs, name)
      if (path.dirname(targetAbs) !== dirAbs) return { ok: false, error: 'invalid file name' }
      // fileName 은 basename 으로 묶었지만 originalRel 은 절대경로·`..` 를 그대로 받았다 →
      // 게이트웨이가 읽는 매핑에 `..\..\x` 를 적을 수 있었다. 위 주석의 의도("버킷 밖으로
      // 못 나가게")대로 새 경로가 워크스페이스 안일 때만 매핑을 쓴다 (fail-closed: 렌더러는
      // ok 를 받아야만 approve 를 보낸다).
      if (!isInside(workspace, targetAbs)) return { ok: false, error: 'path outside workspace' }

      // 이미 있는 이름이면 -2, -3… 으로 비켜간다. "다른 이름으로 저장"이 다른
      // 파일을 덮어쓰면 그거야말로 이 창의 존재 이유를 배신하는 것.
      const base = path.basename(targetAbs, path.extname(targetAbs))
      const tExt = path.extname(targetAbs)
      for (let n = 2; fs.existsSync(targetAbs) && n < 1000; n++) targetAbs = path.join(dirAbs, `${base}-${n}${tExt}`)

      const map: Record<string, { path: string; ts: number }> = (() => {
        try { return JSON.parse(fs.readFileSync(OVERWRITE_REDIRECT_FILE, 'utf8')) } catch { return {} }
      })()
      // 오래된 항목 청소 — 승인 대기 타임아웃이 5분이라 15분이면 충분히 죽은 것.
      const cutoff = Date.now() - 15 * 60 * 1000
      for (const [k, v] of Object.entries(map)) if (!v?.ts || v.ts < cutoff) delete map[k]

      // 게이트웨이가 읽는 값은 게이트웨이 cwd(=workspace) 기준 상대경로.
      const relOut = path.relative(workspace, targetAbs)
      map[id] = { path: relOut, ts: Date.now() }
      fs.mkdirSync(path.dirname(OVERWRITE_REDIRECT_FILE), { recursive: true })
      fs.writeFileSync(OVERWRITE_REDIRECT_FILE, JSON.stringify(map))
      return { ok: true, relPath: relOut }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })
}
