// ── 라이브 브라우저 프리뷰 IPC (main.ts 에서 이동) ──────────────────────────
//
// 헤드리스 Chrome 의 화면을 앱 안으로 흘려 보내고(스크린캐스트), 패널의 클릭·키 입력을
// CDP 로 되돌려 보낸다. 실제 CDP 연결은 browserPreview.ts 가 한다 — 여기는 IPC 래퍼다.
// (Stage 4 슬라이스 4)
//
// 주입이 없다. 창도 워크스페이스도 게이트웨이 상태도 안 본다 — 필요한 건 제품 프로필의
// 허용 포트 목록뿐이고 그건 import 로 온다.
import { ipcMain } from 'electron'
import { browserPreview, type BrowserPreviewInput } from './browserPreview'
import { resolveCdpPort } from './trustBoundary'
import { PRODUCT } from '../shared/product/current.generated'

/** 브라우저 프리뷰 IPC 7개를 등록한다. import 시점 부작용 없음. */
export function registerBrowserPreviewIpc(): void {

  // ── Live browser preview (headless Chrome → in-app frames) ─────────
  // Renderer opens the preview panel → `browser-preview:start` → CDP client
  // connects to OpenClaw's Chrome on the requested cdpPort (default 18800 =
  // chat's Chrome; wf-1..3 slots live on 18801-18803), attaches to each page
  // target, and streams JPEG frames back via `browser-preview-frame` (payload
  // carries cdpPort so panels watching different Chromes can filter).
  // 렌더러가 붙을 수 있는 CDP 포트는 제품이 실제로 띄우는 것뿐 — 채팅용 + 워크플로 슬롯.
  // 제한이 없으면 아무 로컬 디버그 포트에나 붙을 수 있고, CDP 는 인증이 없어서 사용자가
  // 따로 띄워 둔 개인 브라우저의 화면을 긁고 입력까지 넣을 수 있다(browser-preview:input).
  const CDP_PORTS: readonly number[] = [PRODUCT.cdpPort, ...PRODUCT.workflowCdpPorts]
  const cdpPortOr = (requested: unknown) => resolveCdpPort(requested, PRODUCT.cdpPort, CDP_PORTS)
  const BAD_CDP_PORT = { ok: false as const, error: 'invalid_cdp_port' }

  ipcMain.handle('browser-preview:start', async (_e, opts?: { cdpPort?: number }) => {
    const port = cdpPortOr(opts?.cdpPort)
    if (port === null) return BAD_CDP_PORT
    try { await browserPreview.start(port); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('browser-preview:stop', async (_e, opts?: { cdpPort?: number }) => {
    const port = cdpPortOr(opts?.cdpPort)
    if (port === null) return BAD_CDP_PORT
    try { await browserPreview.stop(port); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  // 사용자 ⟳ — CDP 하드 재연결. "Waiting for first frame" 걸림(스크린캐스트가
  // 프레임을 안 뱉는 상태)을 처음부터 다시 attach 해서 푼다.
  ipcMain.handle('browser-preview:refresh', async (_e, opts?: { cdpPort?: number }) => {
    const port = cdpPortOr(opts?.cdpPort)
    if (port === null) return BAD_CDP_PORT
    try { await browserPreview.refresh(port); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('browser-preview:set-active', async (_e, payload: { targetId: string; cdpPort?: number } | string) => {
    try {
      // Back-compat: older callers passed a bare targetId string.
      const targetId = typeof payload === 'string' ? payload : payload.targetId
      const port     = cdpPortOr(typeof payload === 'string' ? undefined : payload.cdpPort)
      if (port === null) return BAD_CDP_PORT
      await browserPreview.setActive(port, targetId)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('browser-preview:set-viewport', async (_e, dims: { width: number; height: number; cdpPort?: number }) => {
    const port = cdpPortOr(dims.cdpPort)
    if (port === null) return BAD_CDP_PORT
    try { await browserPreview.setViewport(port, dims.width, dims.height); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('browser-preview:close-target', async (_e, payload: { targetId: string; cdpPort?: number }) => {
    const port = cdpPortOr(payload.cdpPort)
    if (port === null) return BAD_CDP_PORT
    try { await browserPreview.closeTarget(port, payload.targetId); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Live browser preview: input forwarding ─────────────────────────
  // The preview panel is the user's only interaction surface with the headless
  // Chrome. Clicks / keystrokes / scroll captured on the panel are forwarded
  // here and dispatched to the active target via CDP Input.
  ipcMain.handle('browser-preview:input', async (_e, payload: BrowserPreviewInput & { cdpPort?: number }) => {
    const port = cdpPortOr(payload.cdpPort)
    if (port === null) return BAD_CDP_PORT
    try { await browserPreview.dispatchInput(port, payload); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })
}
