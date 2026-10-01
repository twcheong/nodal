// ─────────────────────────────────────────────────────────────────────────────
// controlUiTransport — 게이트웨이 control-UI WebSocket 의 공통 전송 계층.
//
// 게이트웨이 훅 7개가 각자 복사해 갖고 있던 "전부 동일한 부분" 만 소유한다
// (docs/refactor/baseline/gateway-hooks-contract.md):
//   · WS 수명주기 + connect.challenge → connect rpc 핸드셰이크
//   · RPC id / pending map / timeout, 응답 demux
//   · raw 이벤트 fan-out, connect lock, 명시적 dispose
//
// 일부러 하지 않는 것 — 전부 훅의 결정이다:
//   세션 생성, SOUL 주입, turn 완료 판정, 영속화, 자동 재연결.
//
// 전역 싱글턴이 아니다. 훅 인스턴스마다 하나씩 만들어 소켓·세션 수를 예전과
// 같게 유지한다. React 와 window.twixy 를 모른다 (토큰·엔드포인트는 주입) —
// 렌더러 바인딩은 rendererTransport.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface RpcFrame {
  id:       string
  ok:       boolean
  payload?: Record<string, unknown>
  error?:   { code?: string; message?: string }
}

/**
 * RPC 가 거절된 이유. 훅이 거절을 **분류**해야 할 때 쓴다 (문자열 매칭 대신).
 *  · `ws_closed`     — 소켓이 사라졌다 (원격 close / 핸드셰이크 실패 / dispose).
 *  · `timeout`       — 그 호출의 제한시간이 지났다.
 *  · `ws_not_open`   — 아직(또는 이미) 연결되지 않았다.
 *  · `auth_rejected` — 게이트웨이가 핸드셰이크를 거절했다 (ensureConnected 거절에만 붙는다).
 *                      재시도해도 같은 결과라, 소켓이 그냥 끊긴 것과 구분해서 다뤄야 한다.
 */
export type GatewayErrorCode = 'ws_closed' | 'timeout' | 'ws_not_open' | 'auth_rejected'

export interface GatewayError extends Error { code?: GatewayErrorCode }

const codedError = (message: string, code: GatewayErrorCode): GatewayError =>
  Object.assign(new Error(message), { code })

export interface GatewayEventFrame {
  event?:   string
  payload?: Record<string, unknown>
  [k: string]: unknown
}

// raw 는 파싱 전 원문 — 프레임을 그대로 로그에 남기는 소비자(useOpenClaw)용.
export type GatewayEventListener = (frame: GatewayEventFrame, raw: string) => void

export interface ControlUiTransportOptions {
  url:            string
  displayName:    string
  platform:       string
  // 핸드셰이크 전에 소켓이 error 로 죽었을 때의 메시지 — 훅마다 문구가 달라 UI 에 그대로 뜬다.
  wsErrorMessage: string
  // connect 시도마다 새로 호출한다. 시도 간에 캐시하면 게이트웨이 재시작(토큰 교체)
  // 뒤로 영영 못 붙는다.
  getToken:       () => Promise<string | null>
  /**
   * 핸드셰이크에서 선언할 클라이언트 capability. 기본 `[]`.
   *
   * 지금 쓰는 건 `'tool-events'` 하나다 — 이게 없으면 게이트웨이가 tool 스트림 `agent`
   * 프레임을 **아예 보내지 않는다** (수신자 등록이 이 cap 으로만 이뤄진다).
   * 훅마다 opt-in 이다: 툴 활동을 그리는 훅만 선언해 필요 없는 소켓에 프레임을 늘리지 않는다.
   */
  caps?:          readonly string[]
}

export interface ControlUiTransport {
  /** WS 오픈 + 핸드셰이크까지 보장. 동시 호출은 connect 한 번을 공유한다. */
  ensureConnected: () => Promise<void>
  /** 핸드셰이크가 끝났고 소켓이 열려 있는가. */
  isConnected:     () => boolean
  rpc:             (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<RpcFrame>
  /** challenge·RPC 응답을 뺀 모든 프레임. 반환값은 구독 해제. */
  onEvent:         (fn: GatewayEventListener) => () => void
  /** 소켓이 사라질 때마다 (원격 close, connect 실패 포함). dispose 로 닫을 땐 부르지 않는다. */
  onClose:         (fn: () => void) => () => void
  /** 소켓을 닫고 pending·타이머·구독자를 전부 정리한다. 이후 재사용 불가 — 새로 만들 것. */
  dispose:         () => void
}

const DEFAULT_RPC_TIMEOUT_MS = 15_000

interface PendingRpc {
  resolve: (r: RpcFrame) => void
  reject:  (e: Error) => void
  timer:   ReturnType<typeof setTimeout>
}

export function createControlUiTransport(opts: ControlUiTransportOptions): ControlUiTransport {
  let socket:      WebSocket | null = null
  let connected    = false
  let disposed     = false
  let connecting:  Promise<void> | null = null
  // 진행 중인 connect 시도의 reject. 핸드셰이크 전에 소켓이 죽으면 이걸로 깨운다 —
  // 예전 훅들은 이 경우 connect promise 가 영영 settle 되지 않았다.
  let failConnect: ((err: Error) => void) | null = null
  const pending        = new Map<string, PendingRpc>()
  const eventListeners = new Set<GatewayEventListener>()
  const closeListeners = new Set<() => void>()

  const isConnected = () => connected && socket?.readyState === WebSocket.OPEN

  function rpc(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<RpcFrame> {
    return new Promise((resolve, reject) => {
      const ws = socket
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(codedError('WS not open', 'ws_not_open'))
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(codedError(`RPC timeout: ${method}`, 'timeout'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  // 소켓을 버리는 유일한 경로 — 원격 close, 핸드셰이크 실패, dispose 가 전부 여기로 온다.
  // pending RPC 를 timeout 까지 방치하지 않고 즉시 reject 하고, 죽은 소켓의 핸들러를 떼어
  // 늦게 도착한 프레임이 다음 연결에 섞이지 않게 한다.
  function dropSocket(ws: WebSocket, reason: Error) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
    try { ws.close() } catch { /* 이미 닫힘 */ }
    if (socket !== ws) return
    socket    = null
    connected = false
    // 떠 있던 RPC 는 "소켓이 사라져서" 실패한 것 — 메시지는 사유 그대로 두되 코드로 분류한다.
    // useOpenClaw 는 이걸로 "close 시 pending RPC 는 에러 프레임으로 resolve" 계약을 유지한다.
    const closed = codedError(reason.message, 'ws_closed')
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(closed) }
    pending.clear()
    // 반면 connect 실패 사유는 원본 그대로 넘긴다 — 인증 거절인지 단순 끊김인지 구분돼야 한다.
    failConnect?.(reason)
    for (const fn of [...closeListeners]) { try { fn() } catch { /* 구독자 예외가 정리를 막지 않게 */ } }
  }

  async function handshake(ws: WebSocket, token: string | null, done: () => void) {
    try {
      const auth = await rpc('connect', {
        minProtocol: 3, maxProtocol: 3,
        client: {
          id: 'openclaw-control-ui',
          displayName: opts.displayName,
          version: '0.1.0',
          platform: opts.platform,
          mode: 'ui',
        },
        caps: opts.caps ?? [],
        auth: token ? { token } : undefined,
        role: 'operator',
        scopes: ['operator.admin', 'operator.write', 'operator.read'],
      })
      if (ws !== socket) return
      if (!auth.ok) { dropSocket(ws, codedError(auth.error?.message ?? 'Auth rejected', 'auth_rejected')); return }
      connected = true
      done()
    } catch (err) { dropSocket(ws, err as Error) }
  }

  async function connect(): Promise<void> {
    let token: string | null = null
    try { token = await opts.getToken() } catch { /* optional — 토큰 없이 연결로 degrade */ }
    if (disposed) throw new Error('Transport disposed')
    // 닫히는 중(CLOSING)인 이전 소켓이 남아 있을 수 있다 — 새 소켓과 pending map 을 공유하지 않게 먼저 버린다.
    if (socket) dropSocket(socket, new Error('Connection closed'))

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(opts.url)
      socket      = ws
      failConnect = reject

      // 핸드셰이크 뒤의 error 는 무시 — 곧 close 가 따라오고 정리는 거기서 한다.
      ws.onerror = () => { if (!connected) dropSocket(ws, new Error(opts.wsErrorMessage)) }
      ws.onclose = () => dropSocket(ws, new Error('Connection closed'))

      ws.onmessage = (event) => {
        if (ws !== socket) return
        let frame: (GatewayEventFrame & Partial<RpcFrame>) | null
        try { frame = JSON.parse(event.data as string) } catch { return }
        if (!frame || typeof frame !== 'object') return

        if (frame.event === 'connect.challenge') {
          if (!connected) void handshake(ws, token, resolve)
          return
        }

        if (frame.id && typeof frame.ok === 'boolean') {
          const p = pending.get(frame.id)
          if (p) { pending.delete(frame.id); clearTimeout(p.timer); p.resolve(frame as RpcFrame) }
          return
        }

        // 구독자 하나의 예외가 다른 구독자나 소켓을 죽이지 않게 — 예전 onmessage 전체 try/catch 와 같은 보장.
        for (const fn of [...eventListeners]) { try { fn(frame, event.data as string) } catch { /* ignore */ } }
      }
    }).finally(() => { failConnect = null })
  }

  function ensureConnected(): Promise<void> {
    if (disposed) return Promise.reject(new Error('Transport disposed'))
    if (isConnected()) return Promise.resolve()
    // finally 가 성공·실패 양쪽에서 lock 을 푼다. 예전 관용구는 await 뒤에서만 풀어서,
    // connect 가 거절되면 그 promise 가 남아 이후 호출이 같은 거절을 재-await 했다 (계약표 #1).
    connecting ??= connect().finally(() => { connecting = null })
    return connecting
  }

  function dispose() {
    disposed = true
    // 구독자를 먼저 비운다 — dispose 이후엔 어떤 콜백도 불리지 않는다 (언마운트된 컴포넌트 setState 방지).
    eventListeners.clear()
    closeListeners.clear()
    if (socket) dropSocket(socket, new Error('Transport disposed'))
  }

  return {
    ensureConnected,
    isConnected,
    rpc,
    onEvent: (fn) => { eventListeners.add(fn); return () => { eventListeners.delete(fn) } },
    onClose: (fn) => { closeListeners.add(fn); return () => { closeListeners.delete(fn) } },
    dispose,
  }
}
