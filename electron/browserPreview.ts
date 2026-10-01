// electron/browserPreview.ts
//
// Streams OpenClaw's Chrome via CDP into the Twixy app UI as JPEG frames per
// browser target (tab/popup). Chrome runs --headless=new (see openclaw.json
// browser.headless in ensureWorkspace()), so it never appears in the Dock or
// steals focus from the user. The React <LiveBrowserPreview> panel is the only
// way the user watches a workflow — thumbnails per target + a large frame view
// for the "active" target.
//
// MULTI-PORT: openclaw runs one Chrome per browser profile (openclaw@18800 for
// chat, wf-1..3 @18801-18803 for parallel workflow Test slots). The manager
// keeps one PreviewInstance per cdpPort, created lazily on first start(port).
// Every IPC call and event payload carries `cdpPort` so multiple panels can
// watch different Chromes simultaneously (chat panel ↔ workflow panel).
//
// Renderer contract (see preload.ts contextBridge):
//   ipc: browser-preview:start | :stop | :set-active | :set-viewport | :input
//        — all payloads include { cdpPort } (default 18800)
//   events: browser-preview-frame { cdpPort, targetId, base64, ts, meta }
//           browser-preview-target-list { cdpPort, targets: [...] }
//
// The preview is the user's ONLY interaction surface with the headless Chrome
// (there is no OS window). So besides streaming frames out, it accepts input
// (clicks / keys / scroll) back in and dispatches them to the active target
// via CDP Input. Frame `meta` (deviceWidth/Height, scrollOffset) lets the
// renderer normalise click coords against the displayed image.
//
// Chrome may not be up when a user opens the preview (OpenClaw launches Chrome
// lazily on the first browser-tool call). So `start()` polls CDP with backoff
// until the browser accepts connections, then subscribes to Target events.

import CDP from 'chrome-remote-interface'
import type { BrowserWindow } from 'electron'
import { PRODUCT } from '../shared/product/current.generated'

export const DEFAULT_CDP_PORT = PRODUCT.cdpPort
const RETRY_INTERVAL_MS = 500
const MAX_RETRY_ATTEMPTS = 240 // ~2min ceiling, plenty for cold-start
// Frame watchdog: after (re)starting the active target's screencast, a frame
// must arrive within this window or we hard-reset the connection (same as the
// user's manual ⟳). Catches every "connected but no frames" variant we can't
// enumerate — visibility lost, dead session, screencast silently stuck.
const WATCHDOG_MS = 4000
const WATCHDOG_MAX_RESETS = 3

// 진단용 타임스탬프 — openclaw 로그와 시간축을 맞출 수 있게 HH:mm:ss.SSS.
const ts = () => new Date().toISOString().slice(11, 23)

type TargetInfo = {
  targetId: string
  type: string
  title: string
  url: string
}

// Screencast frame metadata — CSS-pixel viewport size + scroll, used to map a
// click on the displayed image back to page coordinates.
export interface FrameMeta {
  deviceWidth: number
  deviceHeight: number
  pageScaleFactor: number
  offsetTop: number
  scrollOffsetX: number
  scrollOffsetY: number
}

// Input events forwarded from the preview panel. Coordinates are FRACTIONS
// (0..1) of the displayed frame so the renderer never needs to know the real
// viewport size — main maps them via the target's latest FrameMeta.
export type BrowserPreviewInput =
  | { targetId: string; kind: 'click'; xFrac: number; yFrac: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { targetId: string; kind: 'move';  xFrac: number; yFrac: number }
  | { targetId: string; kind: 'wheel'; xFrac: number; yFrac: number; deltaX: number; deltaY: number }
  | { targetId: string; kind: 'text';  text: string }
  | { targetId: string; kind: 'key';   action: 'down' | 'up'; key: string; code: string; keyCode: number; text?: string }

type Quality = 'active' | 'thumbnail'

// Chrome docs: "screencast" caps at ~15 fps and uses ack-driven backpressure —
// we won't overwhelm IPC as long as we ack every frame.
const PROFILE: Record<Quality, { format: 'jpeg'; quality: number; maxWidth: number; everyNthFrame: number }> = {
  active:    { format: 'jpeg', quality: 60, maxWidth: 1280, everyNthFrame: 2 },
  thumbnail: { format: 'jpeg', quality: 40, maxWidth: 240,  everyNthFrame: 10 },
}

// Viewport-sync: override the active target's device metrics so its rendered
// aspect ratio matches the preview panel — killing the letterbox black bars.
// Width is pinned to a desktop value (page layout stays desktop, and the
// automation the runner drives sees a stable width); only height varies to
// match the panel's aspect. Clamped so a very tall/narrow panel can't force an
// absurd viewport.
const VIEWPORT_WIDTH = 1280
const VIEWPORT_MIN_HEIGHT = 600
const VIEWPORT_MAX_HEIGHT = 4000

interface Session {
  targetId: string
  info: TargetInfo
  isActive: boolean
  client: CDP.Client | null
  streaming: boolean
  // Latest screencast metadata — needed to map fractional click coords to CSS
  // viewport pixels for input dispatch.
  lastMeta: FrameMeta | null
  // 진단: 다음 프레임 도착 시 한 번 로그 (screencast (재)시작마다 세팅).
  logNextFrame: boolean
}

// One Chrome (= one cdpPort = one openclaw browser profile) worth of preview
// state. The manager below owns one instance per port.
class PreviewInstance {
  private browserClient: CDP.Client | null = null
  private sessions = new Map<string, Session>()
  // "streaming" = renderer has asked for frames. Only when true do we hold CDP
  // connections open — idle apps pay nothing.
  private streaming = false
  private connecting = false
  // Auto-follow: when a new page target opens, switch the "active" target to
  // it (workflow typically drives the newest tab). Turned OFF once the user
  // manually clicks a thumbnail — respect the human choice.
  private autoFollow = true
  // How many preview panels currently want frames from THIS port. We only
  // pause frames when the last one closes.
  private refcount = 0
  // Serializes start()/stop() so a fast panel toggle can't run a teardown and
  // a setup concurrently against the same CDP sessions.
  private opChain: Promise<void> = Promise.resolve()
  // Preview panel aspect (height/width). Set by setViewport() from the
  // renderer's ResizeObserver; applied to the active target's device metrics.
  private viewportAspect: number | null = null
  // Per-target debounce for the navigation re-kick (see scheduleRekick).
  private rekickTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Frame watchdog state — see armFrameWatchdog().
  private lastFrameAt = 0
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogResets = 0
  // 진단: 직전 브로드캐스트한 타겟 목록 (변했을 때만 로그).
  private lastListJson = ''

  constructor(
    private readonly port: number,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  // 모든 로그를 타임스탬프 + 포트 프리픽스로 console.log 통일 — console.warn
  // 은 stderr 로 가서 사용자 터미널 캡처에서 자주 누락됐다 (disconnect 가 두
  // "connected" 사이에서 안 보이던 이유). 진단은 stdout 한 채널로 모은다.
  private log(...args: unknown[]): void {
    console.log(`[browser-preview:${this.port} ${ts()}]`, ...args)
  }

  async start(): Promise<void> {
    this.refcount++
    this.streaming = true
    this.log(`start() refcount=${this.refcount} hasClient=${!!this.browserClient} connecting=${this.connecting}`)
    // Serialize against any in-flight stop()/start() so a quick toggle can't
    // race a teardown against a setup. Each op waits for the previous to settle.
    this.opChain = this.opChain.then(() => this.doStart()).catch(() => {})
    await this.opChain
  }

  private async doStart(): Promise<void> {
    if (!this.streaming) return  // a stop() landed after us; nothing to do
    if (this.browserClient) {
      // Connection kept alive across a panel toggle — but it may be a zombie:
      // openclaw kills & relaunches Chrome when it mislabels a slow cold-start
      // as failed, and if that kill lands mid-setup the 'disconnect' event can
      // be missed. Probe liveness first; a dead client gets torn down and we
      // fall through to a fresh connect instead of resuming into nothing
      // (the "panel stays blank until manual refresh" bug).
      const alive = await this.browserClient.Target.getTargets()
        .then(() => true, () => false)
      if (!alive) {
        this.log('doStart: existing client is DEAD (probe failed) — tearing down + reconnecting')
        await this.disconnectAll()
      } else {
        // Resume: re-send the target list and restart each screencast so
        // Chrome emits a fresh current frame (screencast only auto-emits on
        // the first frame + on visual change, so a paused-then-resumed target
        // needs a kick).
        this.log(`doStart: resuming live client, sessions=${this.sessions.size}`)
        this.broadcastTargetList()
        await this.resumeAllScreencasts()
        this.armFrameWatchdog('resume')
        return
      }
    }
    this.autoFollow = true
    await this.connectBrowser()
  }

  async stop(): Promise<void> {
    this.refcount = Math.max(0, this.refcount - 1)
    this.log(`stop() refcount=${this.refcount}`)
    if (this.refcount > 0) return // another panel still wants frames
    this.streaming = false
    if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null }
    // PAUSE, don't tear down. Keep the CDP browserClient + per-target sessions
    // alive so re-opening the panel resumes instantly with a fresh frame — no
    // reconnect, no "waiting for first frame" hang. The connection is fully
    // dropped only on gateway restart (reset()) or app teardown. Idle cost is
    // one localhost WS with screencasts stopped (no frames flowing).
    this.opChain = this.opChain.then(() => this.pauseAllScreencasts()).catch(() => {})
    await this.opChain
    this.broadcastTargetList()
  }

  // Stop frame flow on every session but keep the CDP sessions attached.
  private async pauseAllScreencasts(): Promise<void> {
    for (const s of this.sessions.values()) {
      if (!s.client || !s.streaming) continue
      try { await s.client.Page.stopScreencast() } catch { /* ignore */ }
      s.streaming = false
    }
  }

  // Restart the screencast on every session (used on panel re-open) so Chrome
  // re-emits a current frame for both the active view and the thumbnails.
  private async resumeAllScreencasts(): Promise<void> {
    for (const s of this.sessions.values()) {
      await this.applyProfile(s, s.isActive ? 'active' : 'thumbnail')
    }
  }

  async setActive(targetId: string): Promise<void> {
    if (!this.sessions.has(targetId)) return
    this.autoFollow = false
    await this.promoteActive(targetId)
  }

  // 프리뷰에서 브라우저 탭 닫기 — CDP Target.closeTarget. Chrome 이 탭을 닫으면
  // targetDestroyed 이벤트가 detachTarget → 활성 승계/브로드캐스트까지 처리한다.
  async closeTarget(targetId: string): Promise<void> {
    if (!this.browserClient || !this.sessions.has(targetId)) return
    try {
      await this.browserClient.Target.closeTarget({ targetId })
    } catch (err) {
      this.log('closeTarget FAILED', targetId.slice(0, 8), String(err).slice(0, 120))
    }
  }

  // Renderer reports the preview panel's pixel size → sync the active target's
  // viewport aspect so the frame fills the panel (no letterbox). Width stays
  // desktop; only height tracks the panel's aspect ratio.
  async setViewport(cssW: number, cssH: number): Promise<void> {
    if (cssW <= 0 || cssH <= 0) return
    this.viewportAspect = cssH / cssW
    const active = [...this.sessions.values()].find(s => s.isActive)
    if (active) await this.applyViewport(active)
  }

  private async applyViewport(s: Session): Promise<void> {
    if (!s.client || this.viewportAspect == null) return
    const height = Math.round(Math.min(
      VIEWPORT_MAX_HEIGHT,
      Math.max(VIEWPORT_MIN_HEIGHT, VIEWPORT_WIDTH * this.viewportAspect),
    ))
    try {
      await s.client.Emulation.setDeviceMetricsOverride({
        width: VIEWPORT_WIDTH,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    } catch (err) {
      this.log('setDeviceMetricsOverride FAILED', s.targetId.slice(0, 8), String(err).slice(0, 120))
    }
  }

  // Forward a click / key / scroll from the preview panel to the target's page.
  // Fractional coords (0..1 of the displayed frame) are mapped to CSS viewport
  // pixels via the target's latest screencast metadata.
  async dispatchInput(ev: BrowserPreviewInput): Promise<void> {
    const s = this.sessions.get(ev.targetId)
    if (!s?.client) return
    const { Input } = s.client

    if (ev.kind === 'text') {
      await Input.insertText({ text: ev.text })
      return
    }
    if (ev.kind === 'key') {
      await Input.dispatchKeyEvent({
        type: ev.action === 'down' ? 'keyDown' : 'keyUp',
        key: ev.key,
        code: ev.code,
        windowsVirtualKeyCode: ev.keyCode,
        nativeVirtualKeyCode: ev.keyCode,
        text: ev.text,
      })
      return
    }

    // Pointer events need viewport-pixel coords. Without metadata yet, bail.
    const meta = s.lastMeta
    if (!meta) return
    const x = Math.round(ev.xFrac * meta.deviceWidth)
    const y = Math.round(ev.yFrac * meta.deviceHeight)

    if (ev.kind === 'move') {
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })
      return
    }
    if (ev.kind === 'wheel') {
      await Input.dispatchMouseEvent({
        type: 'mouseWheel', x, y, deltaX: ev.deltaX, deltaY: ev.deltaY,
      })
      return
    }
    // click = press + release
    const button = ev.button ?? 'left'
    const clickCount = ev.clickCount ?? 1
    await Input.dispatchMouseEvent({ type: 'mousePressed',  x, y, button, clickCount, buttons: 1 })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button, clickCount, buttons: 0 })
  }

  // ── Frame watchdog — "connected but no frames" 자동 복구 ────────────────
  // 활성 타겟의 screencast 를 (재)시작할 때마다 무장한다. WATCHDOG_MS 안에
  // 프레임이 한 장도 안 오면 수동 ⟳ 과 동일한 하드 리셋을 자동 실행.
  // 프레임이 흐르기 시작하면 리셋 카운터가 풀리고, 연속 3회 실패하면 로그만
  // 남기고 포기한다 (Chrome 자체가 죽은 케이스에서 무한 리셋 방지).
  private armFrameWatchdog(why: string): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer)
    if (!this.streaming) return
    const armedAt = Date.now()
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      if (!this.streaming) return
      const active = [...this.sessions.values()].find(s => s.isActive)
      if (!active) { this.log(`watchdog(${why}): no active session yet — waiting for targetCreated`); return }
      if (this.lastFrameAt >= armedAt) { this.watchdogResets = 0; return }  // frames flowing — all good
      if (this.watchdogResets >= WATCHDOG_MAX_RESETS) {
        this.log(`watchdog(${why}): STILL no frames after ${WATCHDOG_MAX_RESETS} resets — giving up (active=${active.info.url})`)
        return
      }
      this.watchdogResets++
      this.log(`watchdog(${why}): no frame within ${WATCHDOG_MS}ms — auto hard-reset ${this.watchdogResets}/${WATCHDOG_MAX_RESETS} (active=${active.info.url})`)
      // 수동 refresh 와 같은 경로 (opChain 직렬화 포함).
      this.opChain = this.opChain.then(() => this.reset()).catch(() => {})
    }, WATCHDOG_MS)
  }

  // Called when OpenClaw restarts — best-effort teardown so start() reconnects
  // clean on the next user gesture.
  async reset(): Promise<void> {
    this.log('reset(): full CDP teardown + reconnect')
    await this.disconnectAll()
    // 재연결 후엔 러너의 실제 페이지를 다시 따라가야 한다 (죽기 전의 활성
    // 기억은 무의미) — auto-follow 재무장.
    this.autoFollow = true
    if (this.streaming) {
      // If the panel is still open, kick off reconnect in the background.
      void this.connectBrowser()
    }
  }

  // 사용자 새로고침 (⟳) — "Waiting for first frame" 류 걸림 해소용 하드 리셋.
  // stop()은 pause(연결 유지)라 고장난 연결을 못 살린다; 여기선 CDP 를 완전히
  // 끊고 다시 붙어 attach → forceVisible → startScreencast 를 처음부터 다시 탄다.
  async refresh(): Promise<void> {
    this.opChain = this.opChain.then(() => this.reset()).catch(() => {})
    await this.opChain
  }

  private async connectBrowser(): Promise<void> {
    if (this.connecting || this.browserClient) {
      this.log(`connectBrowser: skipped (connecting=${this.connecting} hasClient=${!!this.browserClient})`)
      return
    }
    this.connecting = true
    let client: CDP.Client | null = null
    let attemptsUsed = 0
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS && this.streaming; attempt++) {
      attemptsUsed = attempt + 1
      try {
        // Connect at the BROWSER level (not a page target). A default
        // `CDP({ port })` attaches to the first page target and throws
        // "No inspectable targets" when Chrome has zero tabs — which is
        // exactly the case for a freshly launched headless Chrome before
        // OpenClaw opens a page. Resolving the browser websocketDebuggerUrl
        // from /json/version and connecting to it lets the Target domain work
        // regardless of how many pages exist.
        const version = await CDP.Version({ port: this.port })
        const browserWsUrl = version.webSocketDebuggerUrl
        client = await CDP({ target: browserWsUrl })
        break
      } catch (err) {
        // attempt 0 + 이후 10초마다 — "얼마나 오래 기다리는 중인지" 가 보이게.
        if (attempt % 20 === 0) {
          this.log(`waiting for CDP (attempt ${attempt + 1}) — ${String(err).slice(0, 120)}`)
        }
        await sleep(RETRY_INTERVAL_MS)
      }
    }
    this.connecting = false
    if (!client || !this.streaming) {
      // stop() was called mid-retry, or we gave up.
      this.log(`connectBrowser: aborted (client=${!!client} streaming=${this.streaming} attempts=${attemptsUsed})`)
      try { await client?.close() } catch { /* ignore */ }
      return
    }
    this.browserClient = client
    this.log(`CDP connected (attempts=${attemptsUsed})`)

    // Register the disconnect handler FIRST, before any post-connect awaits.
    // openclaw can kill this Chrome instants after we connect (it mislabels a
    // slow cold-start as failed and relaunches — observed as "Failed to start
    // Chrome CDP" followed by a working pid). If the kill lands while the
    // setup awaits below are in flight and the handler isn't registered yet,
    // browserClient stays a zombie forever and the panel is blank until a
    // manual refresh.
    client.on('disconnect', () => {
      if (this.browserClient !== client) return  // stale client's event
      this.log('CDP browser DISCONNECTED — sessions cleared, will reconnect if panel open')
      this.browserClient = null
      this.sessions.clear()
      // Chrome 재기동(콜드스타트 실패→재시도 포함) 후엔 러너의 새 페이지를 다시
      // 따라가야 하므로 auto-follow 를 켠다 — 죽은 Chrome 의 마지막 new-tab 에
      // 프리뷰가 갇히지 않게.
      this.autoFollow = true
      this.broadcastTargetList()
      if (this.streaming) {
        setTimeout(() => { void this.connectBrowser() }, RETRY_INTERVAL_MS)
      }
    })

    const { Target } = client

    // Target 이벤트 리스너는 setDiscoverTargets 를 포함한 모든 await 보다 먼저
    // 등록한다. 리스너 등록 전에 도착한 이벤트는 그냥 버려지는데, openclaw
    // 러너는 프리뷰가 연결되는 것과 거의 동시에 탭을 만들므로(콜드스타트:
    // Chrome 기동 → 즉시 open) bootstrap attach 가 도는 ~1초 틈에 생긴 탭의
    // targetCreated 가 유실됐다 — 프리뷰가 그 탭의 존재를 모른 채 프레임 안
    // 나오는 newtab 만 쳐다보던 "빈 화면" 의 근본 원인. attachTarget 은
    // sessions.has 로 동기 dedupe 하므로 이벤트와 bootstrap 이 같은 탭을 겹쳐
    // 불러도 안전하다.
    Target.targetCreated(({ targetInfo }) => {
      if (isPage(targetInfo)) {
        this.log(`targetCreated: ${targetInfo.targetId.slice(0, 8)} ${targetInfo.url}`)
        void this.attachTarget(targetInfo as TargetInfo)
      }
    })
    Target.targetDestroyed(({ targetId }) => {
      if (this.sessions.has(targetId)) this.log(`targetDestroyed: ${targetId.slice(0, 8)}`)
      void this.detachTarget(targetId)
    })
    Target.targetInfoChanged(({ targetInfo }) => {
      const s = this.sessions.get(targetInfo.targetId)
      if (!s) return
      const prevUrl = s.info.url
      s.info = {
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        title: targetInfo.title,
        url: targetInfo.url,
      }
      // 러너가 탭을 실제 페이지로 네비게이트하면(예: new tab → youtube) auto-follow
      // 중엔 그 탭으로 활성 전환 — 프리뷰가 러너가 보는 화면을 따라간다. 이게 없으면
      // 활성이 빈 new-tab 에 머물러 "new tab 만 보이는" 증상이 난다.
      if (this.autoFollow && !s.isActive && isRealPage(targetInfo.url)) {
        void this.promoteActive(targetInfo.targetId)
        return  // promoteActive 가 broadcast
      }
      // 이미 attach 된 탭이 다른 URL 로 네비게이트한 경우 재킥. cross-origin
      // 네비게이션은 렌더러 프로세스를 교체하는데, forceVisible 로 준
      // visibility 오버라이드는 프로세스에 귀속이라 함께 날아간다 — 새 렌더러는
      // headless 기본(hidden, 페인트 스로틀)으로 돌아가 screencast 프레임이 0장.
      // (첫 탭은 attach 시점부터 active 라 promoteActive 재킥 경로도 안 탄다 —
      // "연결은 됐는데 수동 새로고침 전까지 Waiting for first frame" 의 원인.)
      if (targetInfo.url !== prevUrl) this.scheduleRekick(targetInfo.targetId)
      this.broadcastTargetList()
    })

    try {
      await Target.setDiscoverTargets({ discover: true })
    } catch (err) {
      // Chrome died during setup — treat like a disconnect: drop the client
      // and let the retry loop attach to the relaunched Chrome.
      this.log('setup FAILED (Chrome died mid-connect?):', String(err).slice(0, 120))
      try { await client.close() } catch { /* ignore */ }
      if (this.browserClient === client) {
        this.browserClient = null
        if (this.streaming) {
          setTimeout(() => { void this.connectBrowser() }, RETRY_INTERVAL_MS)
        }
      }
      return
    }

    // Bootstrap: attach to all page targets already open. (Chrome 은
    // setDiscoverTargets 시점에 기존 타겟들의 targetCreated 도 쏴주지만,
    // 버전별 편차가 있어 명시 스냅샷을 벨트로 유지 — dedupe 가 겹침을 흡수.)
    try {
      const { targetInfos } = await Target.getTargets()
      const pages = targetInfos.filter(isPage)
      this.log(`bootstrap: ${pages.length} page target(s):`, pages.map(t => t.url).join(', ') || '(none)')
      for (const info of pages) {
        await this.attachTarget(info as TargetInfo)
      }
    } catch (err) {
      this.log('bootstrap getTargets FAILED:', String(err).slice(0, 120))
    }

    this.broadcastTargetList()
  }

  private async attachTarget(info: TargetInfo): Promise<void> {
    if (this.sessions.has(info.targetId)) return
    // 활성 선택: 첫 타겟은 무조건 활성. auto-follow 면 새 타겟을 활성으로 하되,
    // 이미 실제 페이지(러너가 보던 youtube 등)가 활성인데 새 타겟이 빈 탭이면
    // 뺏지 않는다 — 늦게 뜬 about:blank/new-tab 이 러너 화면을 가리는 걸 방지.
    // (그 빈 탭이 나중에 실제 페이지로 네비게이트하면 targetInfoChanged 가 전환.)
    const existingActive = [...this.sessions.values()].find(s => s.isActive)
    const existingActiveIsReal = !!existingActive && isRealPage(existingActive.info.url)
    const shouldBeActive = this.sessions.size === 0
      || (this.autoFollow && (isRealPage(info.url) || !existingActiveIsReal))
    const session: Session = {
      targetId: info.targetId,
      info,
      isActive: false, // set via promoteActive below to keep the "one active" invariant
      client: null,
      streaming: false,
      lastMeta: null,
      logNextFrame: false,
    }
    this.sessions.set(info.targetId, session)
    this.log(`attach: ${info.targetId.slice(0, 8)} url=${info.url || '(blank)'} active=${shouldBeActive}`)

    try {
      const client = await CDP({ port: this.port, target: info.targetId })
      session.client = client
      await client.Page.enable()

      // Ack-driven backpressure: Chrome pauses the next frame until we ack.
      client.Page.screencastFrame(async (params: {
        data: string
        sessionId: number
        metadata: {
          deviceWidth: number; deviceHeight: number; pageScaleFactor: number
          offsetTop: number; scrollOffsetX: number; scrollOffsetY: number
        }
      }) => {
        const m = params.metadata
        const meta: FrameMeta = {
          deviceWidth: m.deviceWidth,
          deviceHeight: m.deviceHeight,
          pageScaleFactor: m.pageScaleFactor,
          offsetTop: m.offsetTop,
          scrollOffsetX: m.scrollOffsetX,
          scrollOffsetY: m.scrollOffsetY,
        }
        session.lastMeta = meta
        this.lastFrameAt = Date.now()
        if (this.watchdogResets > 0) {
          this.log(`frames recovered after ${this.watchdogResets} watchdog reset(s)`)
          this.watchdogResets = 0
        }
        if (session.logNextFrame) {
          session.logNextFrame = false
          this.log(`first frame: ${info.targetId.slice(0, 8)} ${m.deviceWidth}x${m.deviceHeight} url=${session.info.url}`)
        }
        const win = this.getWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('browser-preview-frame', {
            cdpPort: this.port,
            targetId: info.targetId,
            base64: params.data,
            ts: Date.now(),
            meta,
          })
        }
        try {
          await client.Page.screencastFrameAck({ sessionId: params.sessionId })
        } catch { /* target likely gone; ignore */ }
      })

      // 메인 프레임 네비게이션 커밋 시 재킥 — targetInfoChanged 는 URL 이 안
      // 바뀌는 리로드나, attach 가 네비게이션과 경합해 URL 이 이미 최종값인
      // 케이스를 놓친다. 이 세션 WS 는 프로세스 교체를 넘어 살아 있으므로
      // 여기서 잡는 게 가장 확실하다.
      client.Page.frameNavigated((p: { frame: { parentId?: string } }) => {
        if (!p.frame.parentId) this.scheduleRekick(info.targetId)
      })

      client.on('disconnect', () => { void this.detachTarget(info.targetId) })
    } catch (err) {
      this.log(`attach FAILED ${info.targetId.slice(0, 8)}:`, String(err).slice(0, 160))
      this.sessions.delete(info.targetId)
      this.broadcastTargetList()
      return
    }

    if (shouldBeActive) {
      await this.promoteActive(info.targetId)
    } else {
      await this.applyProfile(session, 'thumbnail')
    }
    this.broadcastTargetList()
  }

  // 네비게이션 후 visibility 오버라이드 + screencast 를 다시 세팅한다.
  // 리다이렉트 체인이 targetInfoChanged 를 연달아 쏘므로 300ms trailing debounce.
  // applyProfile 이 forceVisible → stop → startScreencast 순서를 다 처리한다.
  private scheduleRekick(targetId: string): void {
    const existing = this.rekickTimers.get(targetId)
    if (existing) clearTimeout(existing)
    this.rekickTimers.set(targetId, setTimeout(() => {
      this.rekickTimers.delete(targetId)
      const s = this.sessions.get(targetId)
      if (!s?.client || !this.streaming) return
      this.log(`rekick after navigation: ${targetId.slice(0, 8)} url=${s.info.url}`)
      void (async () => {
        if (s.isActive) await this.applyViewport(s)  // metrics override 도 프로세스 교체로 소실
        await this.applyProfile(s, s.isActive ? 'active' : 'thumbnail')
      })().catch(() => { /* target mid-navigation — 다음 change 가 다시 킥 */ })
    }, 300))
  }

  private async detachTarget(targetId: string): Promise<void> {
    const s = this.sessions.get(targetId)
    if (!s) return
    this.sessions.delete(targetId)
    const timer = this.rekickTimers.get(targetId)
    if (timer) { clearTimeout(timer); this.rekickTimers.delete(targetId) }
    if (s.client) {
      try { if (s.streaming) await s.client.Page.stopScreencast() } catch { /* ignore */ }
      try { await s.client.close() } catch { /* ignore */ }
    }
    // Promote another target if the active one just closed.
    if (s.isActive && this.sessions.size > 0) {
      const next = [...this.sessions.keys()][0]
      await this.promoteActive(next)
    }
    this.broadcastTargetList()
  }

  private async promoteActive(targetId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.targetId === targetId) {
        if (!s.isActive) {
          s.isActive = true
          await this.applyViewport(s)
          await this.applyProfile(s, 'active')
        }
      } else if (s.isActive) {
        s.isActive = false
        await this.applyProfile(s, 'thumbnail')
      }
    }
    this.broadcastTargetList()
  }

  private async applyProfile(s: Session, quality: Quality): Promise<void> {
    if (!s.client) return
    // Paused (no panel open): track the target's active/quality state but do
    // NOT push frames. A target that opens while paused stays silent until the
    // panel re-opens and resumeAllScreencasts() kicks it. Prevents wasted
    // frames flowing to a closed panel.
    if (!this.streaming) return
    // Wake the compositor BEFORE starting the screencast. In `--headless=new`
    // a tab the runner drove purely over CDP (navigate / snapshot / get_page_
    // text) never becomes "visible", so Chrome throttles painting and
    // startScreencast emits ZERO frames → the panel is stuck on "Waiting for
    // first frame" even though the DOM scrape succeeded. Forcing the page's own
    // visibilityState to 'visible' resumes compositing so frames flow. Applied
    // per-page (not a browser-level foreground switch), so it never steals
    // focus from whichever tab the runner is currently scraping.
    await this.forceVisible(s)
    const opts = PROFILE[quality]
    try {
      if (s.streaming) {
        // startScreencast twice on the same target is a protocol error on some
        // Chrome versions — cleanly stop first.
        try { await s.client.Page.stopScreencast() } catch { /* ignore */ }
      }
      await s.client.Page.startScreencast(opts)
      s.streaming = true
      s.logNextFrame = true
      this.log(`screencast started: ${s.targetId.slice(0, 8)} quality=${quality} url=${s.info.url || '(blank)'}`)
      // 활성 타겟이면 프레임 도착 감시 — WATCHDOG_MS 안에 안 오면 자동 리셋.
      if (s.isActive) this.armFrameWatchdog(`screencast:${s.targetId.slice(0, 8)}`)
    } catch (err) {
      this.log(`startScreencast FAILED ${s.targetId.slice(0, 8)}:`, String(err).slice(0, 160))
    }
  }

  // headless 탭을 visible 로 표시해 컴포지터가 페인트하도록 만든다. 두 경로를
  // 모두 시도한다: Emulation.setVisibilityState(구·현행 대다수) 와, 없는 빌드를
  // 위한 Page.setWebLifecycleState('active'). 둘 다 실패해도 무해 (프레임이 안
  // 올 뿐 크래시 없음).
  private async forceVisible(s: Session): Promise<void> {
    if (!s.client) return
    let ok = false
    const emu = s.client.Emulation as { setVisibilityState?: (p: { visibility: string }) => Promise<unknown> }
    try { await emu.setVisibilityState?.({ visibility: 'visible' }); ok = true } catch { /* try next */ }
    const page = s.client.Page as { setWebLifecycleState?: (p: { state: string }) => Promise<unknown> }
    try { await page.setWebLifecycleState?.({ state: 'active' }); ok = true } catch { /* both failed */ }
    // 둘 다 실패 = 이 탭은 hidden 으로 남아 프레임이 안 나올 가능성 큼 — 로그.
    if (!ok) this.log(`forceVisible: BOTH paths failed for ${s.targetId.slice(0, 8)} — frames may not flow`)
  }

  private broadcastTargetList(): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    const targets = [...this.sessions.values()].map(s => ({
      targetId: s.targetId,
      title: s.info.title,
      url: s.info.url,
      isActive: s.isActive,
    }))
    // 진단: 목록 구성이 실제로 변했을 때만 (title 변경 스팸 제외 위해 url/active 만 비교).
    const json = JSON.stringify(targets.map(t => [t.targetId, t.url, t.isActive]))
    if (json !== this.lastListJson) {
      this.lastListJson = json
      this.log(`target list → renderer: ${targets.length} target(s)`,
        targets.map(t => `${t.isActive ? '*' : ''}${t.url || '(blank)'}`).join(' | ') || '(empty)')
    }
    win.webContents.send('browser-preview-target-list', { cdpPort: this.port, targets })
  }

  private async disconnectAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.detachTarget(id)
    }
    if (this.browserClient) {
      try { await this.browserClient.close() } catch { /* ignore */ }
      this.browserClient = null
    }
  }
}

// ── Manager — one PreviewInstance per cdpPort, created lazily ───────────────
class BrowserPreviewManager {
  private mainWindow: BrowserWindow | null = null
  private instances = new Map<number, PreviewInstance>()

  attach(win: BrowserWindow) {
    this.mainWindow = win
  }

  private instanceFor(port: number): PreviewInstance {
    const p = Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_CDP_PORT
    let inst = this.instances.get(p)
    if (!inst) {
      inst = new PreviewInstance(p, () => this.mainWindow)
      this.instances.set(p, inst)
    }
    return inst
  }

  start(port = DEFAULT_CDP_PORT)  { return this.instanceFor(port).start() }
  stop(port = DEFAULT_CDP_PORT)   { return this.instanceFor(port).stop() }
  refresh(port = DEFAULT_CDP_PORT) { return this.instanceFor(port).refresh() }
  setActive(port: number, targetId: string) { return this.instanceFor(port).setActive(targetId) }
  closeTarget(port: number, targetId: string) { return this.instanceFor(port).closeTarget(targetId) }
  setViewport(port: number, w: number, h: number) { return this.instanceFor(port).setViewport(w, h) }
  dispatchInput(port: number, ev: BrowserPreviewInput) { return this.instanceFor(port).dispatchInput(ev) }

  // Gateway restart — reset every port's connection (wf Chromes die with it).
  async reset(): Promise<void> {
    for (const inst of this.instances.values()) {
      await inst.reset()
    }
  }
}

function isPage(info: { type?: string }): boolean {
  return info.type === 'page'
}

// 실제 콘텐츠 페이지(러너가 몰고 있는 URL)인지 — chrome://newtab, about:blank,
// 빈 문자열 같은 "빈 탭" 은 제외. auto-follow 가 빈 탭에 갇히지 않고 러너가 실제로
// 보는 페이지를 따라가게 하는 판정.
function isRealPage(url?: string): boolean {
  return !!url && /^https?:\/\//i.test(url)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const browserPreview = new BrowserPreviewManager()

export function attachBrowserPreviewWindow(win: BrowserWindow): void {
  browserPreview.attach(win)
}
