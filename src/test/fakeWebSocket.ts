// 네트워크 없이 게이트웨이 소켓을 흉내내는 테스트 더블. `vi.stubGlobal('WebSocket', FakeWebSocket)`
// 로 끼우면 transport 와 (이전 전의) 훅들이 똑같이 이 위에서 돈다.

type Handler = ((ev: { data?: unknown }) => void) | null

export interface SentReq { type: 'req'; id: string; method: string; params: Record<string, unknown> }
export interface FakeRes { ok: boolean; payload?: Record<string, unknown>; error?: { message?: string } }

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN       = 1
  static readonly CLOSING    = 2
  static readonly CLOSED     = 3
  static instances: FakeWebSocket[] = []
  // ── 자동조종 (opt-in) — 배경 RPC 가 많은 훅 테스트가 핸드셰이크·usage 응답을 일일이 쓰지 않게.
  /** true 면 소켓 생성 직후(핸들러가 붙은 뒤) challenge 를 스스로 보낸다. */
  static autoChallenge = false
  /** method → 응답 생성기. 등록된 method 의 요청은 send 즉시 응답한다 (null 을 돌려주면 그 요청은 응답 없이 둔다). */
  static auto: Record<string, (req: SentReq) => FakeRes | null> = {}
  static reset() {
    FakeWebSocket.instances = []
    FakeWebSocket.autoChallenge = false
    FakeWebSocket.auto = {}
  }
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error('no FakeWebSocket created yet')
    return ws
  }

  readyState = FakeWebSocket.CONNECTING
  onopen:    Handler = null
  onmessage: Handler = null
  onerror:   Handler = null
  onclose:   Handler = null
  sent: SentReq[] = []
  private answered = new Set<string>()

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.autoChallenge) queueMicrotask(() => { if (this.readyState === FakeWebSocket.CONNECTING) this.challenge() })
  }

  send(data: string) {
    // 닫힌 소켓으로 보낸 것은 나가지 않는다 — 기록도 하지 않는다.
    if (this.readyState === FakeWebSocket.CLOSED) return
    const req = JSON.parse(data) as SentReq
    this.sent.push(req)
    const res = FakeWebSocket.auto[req.method]?.(req)
    if (res) {
      this.answered.add(req.id)
      this.emit({ type: 'res', id: req.id, ...res })
    }
  }

  // 실제 소켓은 close 이벤트를 비동기로 내지만, 테스트 결정성을 위해 동기로 낸다.
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({})
  }

  // ── 테스트 드라이버 (게이트웨이 역할) ──────────────────────────────────────
  emit(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  challenge() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
    this.emit({ event: 'connect.challenge', payload: { nonce: 'n' } })
  }

  error() { this.onerror?.({}) }

  /** 아직 응답하지 않은 가장 오래된 `method` 요청. */
  pendingReq(method: string): SentReq | undefined {
    return this.sent.find(r => r.method === method && !this.answered.has(r.id))
  }

  respond(method: string, res: FakeRes) {
    const req = this.pendingReq(method)
    if (!req) throw new Error(`no pending "${method}" request to respond to`)
    this.answered.add(req.id)
    this.emit({ type: 'res', id: req.id, ...res })
  }
}

/**
 * 훅 테스트용 — challenge → connect → sessions.create → subscribe 를 게이트웨이 입장에서 통과시킨다.
 * `flush` 는 호출 측의 microtask/타이머 flush (fake timer + act 조합이 테스트마다 달라 주입).
 */
export async function acceptSession(ws: FakeWebSocket, flush: () => Promise<unknown>, key = 'sess-1') {
  ws.challenge()
  await flush()
  ws.respond('connect', { ok: true })
  await flush()
  ws.respond('sessions.create', { ok: true, payload: { key } })
  await flush()
  ws.respond('sessions.messages.subscribe', { ok: true })
  await flush()
}
