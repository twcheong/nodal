// useOpenClaw 특성화 테스트 — 계약표(gateway-hooks-contract.md)의 이 훅 열을 고정한다.
// transport 이전 전/후 구현이 같은 테스트를 통과해야 한다.
//
// 이 훅은 7개 중 유일하게 자동 재연결·디스크 세션 복원·전역 sessions.subscribe·raw 프레임
// 로깅을 갖고 있다. 여기서 고정하는 건 **transport 가 건드리는 표면**(연결·핸드셰이크·RPC·
// 이벤트 라우팅·close/재연결)이며, 서브에이전트 상태기계나 usage 회계까지는 다루지 않는다.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../test/fakeWebSocket'

// isElectron 가드가 모듈 로드 시점에 평가되므로 import 보다 먼저 심는다.
const twixy = vi.hoisted(() => {
  /** 구독 IPC 의 모양: 콜백을 받고 해제 함수를 돌려준다. */
  const sub = <A extends unknown[]>() => vi.fn((_cb: (...a: A) => void) => () => { /* unsubscribe */ })
  const twixy = {
    platform: 'win32',
    getGatewayToken: vi.fn(async (): Promise<string | null> => 'tok'),
    // 디스크 복원 — 기본은 "저장된 세션 없음".
    mainSessionGet:  vi.fn(async (): Promise<{ sessionKey?: string } | null> => null),
    mainSessionSet:  vi.fn(async () => ({ ok: true })),
    mainChatLoad:    vi.fn(async (): Promise<unknown[]> => []),
    mainChatAppend:  vi.fn(async () => ({ ok: true })),
    mainChatClear:   vi.fn(async () => ({ ok: true })),
    planGet:         vi.fn(async () => null),
    appendSessionLog: vi.fn(async () => ({ ok: true })),
    recordOpenRouterUsage: vi.fn(async () => ({ ok: true })),
    generateSessionSummary: vi.fn(async () => ({ ok: true })),
    correctLanguage: vi.fn(async () => ({ ok: false })),
    // IPC 구독 — 해제 함수를 돌려준다. 테스트가 콜백을 붙잡아 직접 발화한다.
    onOpenClawReady: sub(),
    onOpenClawError: sub<[string]>(),
    onOpenRouterKeyMissing: sub(),
    onOpenRouterLimitExceeded: sub(),
  }
  Object.assign(window, { twixy })
  return twixy
})

import { useOpenClaw } from './useOpenClaw'

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))
/** 마운트 뒤 연결은 800ms 지연된다 — 그 타이머를 넘긴다. */
const CONNECT_DELAY = 800

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useOpenClaw>, unknown>>

function mount(): Hook {
  return renderHook(() => useOpenClaw())
}

/** 마운트 → 800ms → challenge → connect ok 까지. */
async function mountReady() {
  const hook = mount()
  await flush()                                    // hydrate (세션키/스크롤백)
  await act(() => vi.advanceTimersByTimeAsync(CONNECT_DELAY))
  const ws = FakeWebSocket.last
  ws.challenge()
  await flush()
  ws.respond('connect', { ok: true })
  await flush()
  return { hook, ws }
}

/** 첫 send 가 만드는 세션 수립 RPC 들에 응답한다. */
async function acceptSession(ws: FakeWebSocket, key = 'sess-1') {
  ws.respond('sessions.create', { ok: true, payload: { key } })
  await flush()
  ws.respond('sessions.messages.subscribe', { ok: true })
  await flush()
  if (ws.pendingReq('sessions.subscribe')) { ws.respond('sessions.subscribe', { ok: true }); await flush() }
  if (ws.pendingReq('sessions.usage')) { ws.respond('sessions.usage', { ok: true, payload: {} }); await flush() }
}

async function send(hook: Hook, text: string) {
  act(() => { void hook.result.current.sendMessage(text) })
  await flush()
}

const sent = (ws: FakeWebSocket, method: string) => ws.sent.filter(r => r.method === method).map(r => r.params)
const assistantMsg = (text: string) =>
  ({ event: 'session.message', payload: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.clearAllMocks()
  localStorage.clear()
  twixy.getGatewayToken.mockResolvedValue('tok')
  twixy.mainSessionGet.mockResolvedValue(null)
  twixy.mainChatLoad.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useOpenClaw — 연결·핸드셰이크', () => {
  it('마운트 직후엔 연결하지 않고, 800ms 뒤에 연결한다', async () => {
    const hook = mount()
    await flush()
    expect(hook.result.current.status).toBe('connecting')
    expect(FakeWebSocket.instances).toHaveLength(0)

    await act(() => vi.advanceTimersByTimeAsync(CONNECT_DELAY - 1))
    expect(FakeWebSocket.instances).toHaveLength(0)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('challenge 에 displayName Twixy 로 응답하고 ready 가 된다 — 세션은 만들지 않는다', async () => {
    const { hook, ws } = await mountReady()
    expect(ws.sent.map(r => r.method)).toEqual(['connect'])
    expect((ws.sent[0].params.client as Record<string, unknown>).displayName).toBe('Twixy')
    expect(ws.sent[0].params.auth).toEqual({ token: 'tok' })
    expect(ws.sent[0].params).toMatchObject({
      minProtocol: 3, maxProtocol: 3, caps: [], role: 'operator',
      scopes: ['operator.admin', 'operator.write', 'operator.read'],
    })
    expect(hook.result.current.status).toBe('ready')
  })

  it('connect 가 거절되면 error + 메시지, 소켓을 닫는다', async () => {
    const hook = mount()
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(CONNECT_DELAY))
    const ws = FakeWebSocket.last
    ws.challenge()
    await flush()
    ws.respond('connect', { ok: false, error: { message: 'device identity required' } })
    await flush()
    expect(hook.result.current.errorMsg).toBe('device identity required')
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })
})

describe('useOpenClaw — 세션', () => {
  it('첫 send 에서 세션 생성 → 구독 → 전역 sessions.subscribe, 키를 디스크에 저장', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')

    expect(ws.pendingReq('sessions.create')?.params).toEqual({})   // agentId 없음 = 기본 에이전트
    await acceptSession(ws)
    expect(twixy.mainSessionSet).toHaveBeenCalledWith({ sessionKey: 'sess-1' })
    expect(sent(ws, 'sessions.messages.subscribe')).toEqual([{ key: 'sess-1' }])
    expect(sent(ws, 'sessions.subscribe')).toEqual([{}])
    expect(hook.result.current.getSessionKey()).toBe('sess-1')

    expect(sent(ws, 'sessions.send')).toEqual([{ key: 'sess-1', message: 'hello' }])
    expect(hook.result.current.isThinking).toBe(true)
    expect(hook.result.current.messages.map(m => [m.role, m.content])).toEqual([['user', 'hello']])
  })

  it('디스크에 저장된 세션키가 있으면 그 키로 재개를 시도한다', async () => {
    twixy.mainSessionGet.mockResolvedValue({ sessionKey: 'disk-key' })
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    expect(ws.pendingReq('sessions.create')?.params).toEqual({ key: 'disk-key' })
  })

  it('세션 생성이 실패하면 안내 메시지 + thinking 해제', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    ws.respond('sessions.create', { ok: false, error: { message: 'nope' } })
    await flush()
    expect(hook.result.current.isThinking).toBe(false)
    expect(hook.result.current.messages.at(-1)?.content).toContain('Failed to create session')
  })

  it('두 번째 send 는 같은 세션을 재사용한다', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'one')
    await acceptSession(ws)
    ws.respond('sessions.send', { ok: true })
    await send(hook, 'two')
    expect(sent(ws, 'sessions.create')).toHaveLength(1)
    expect(sent(ws, 'sessions.send')).toEqual([
      { key: 'sess-1', message: 'one' }, { key: 'sess-1', message: 'two' },
    ])
  })
})

describe('useOpenClaw — 전송·수신', () => {
  it('ready 가 아니면 보내지 않고 안내만 남긴다', async () => {
    const hook = mount()
    await flush()
    await send(hook, 'too early')
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(hook.result.current.messages.map(m => m.role)).toEqual(['system'])
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('URL 로 시작하는 메시지에는 패딩 프리앰블을 붙인다 (게이트웨이 hang 우회)', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'https://example.com 요약해줘')
    await acceptSession(ws)
    const msg = (ws.pendingReq('sessions.send')?.params as { message: string }).message
    expect(msg.startsWith('[system: the following line is internal padding')).toBe(true)
    expect(msg.endsWith('https://example.com 요약해줘')).toBe(true)
    // 화면에는 원문만 보인다.
    expect(hook.result.current.messages[0].content).toBe('https://example.com 요약해줘')
  })

  it('assistant session.message 를 대화에 붙인다', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    await acceptSession(ws)
    ws.respond('sessions.send', { ok: true })
    await flush()

    act(() => { ws.emit(assistantMsg('hi there')) })
    await flush()
    expect(hook.result.current.messages.map(m => [m.role, m.content]))
      .toEqual([['user', 'hello'], ['assistant', 'hi there']])
  })

  it('raw 이벤트 프레임을 세션 로그에 남긴다 — RPC 응답은 제외', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    await acceptSession(ws)
    twixy.appendSessionLog.mockClear()

    const frame = { event: 'chat', payload: { sessionKey: 'sess-1', state: 'final' } }
    act(() => { ws.emit(frame) })
    await flush()
    expect(twixy.appendSessionLog).toHaveBeenCalledWith({ sessionId: 'sess-1', line: JSON.stringify(frame) })

    // RPC 응답(type:'res')은 로그에 남지 않는다.
    twixy.appendSessionLog.mockClear()
    act(() => { ws.emit({ type: 'res', id: 'zzz', ok: true }) })
    await flush()
    expect(twixy.appendSessionLog).not.toHaveBeenCalled()
  })

  it('abortMessage — 세션에 sessions.abort, 실패해도 thinking 은 내린다', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    await acceptSession(ws)
    act(() => { void hook.result.current.abortMessage() })
    await flush()
    expect(ws.pendingReq('sessions.abort')?.params).toMatchObject({ key: 'sess-1' })
    ws.respond('sessions.abort', { ok: false, error: { message: 'gone' } })
    await flush()
    expect(hook.result.current.isThinking).toBe(false)
  })
})

describe('useOpenClaw — 툴 이벤트 출처 (중복 렌더 방지)', () => {
  it("caps 를 선언하지 않는다 — 툴 활동은 전역 sessions.subscribe 의 session.tool 로 받는다", async () => {
    const { ws } = await mountReady()
    // 이 훅만 전역 구독을 한다. 거기로 session.tool 이 오므로 tool-events cap 은 필요 없고,
    // 선언하면 같은 턴의 툴을 agent 스트림으로 한 번 더 받아 두 번 그릴 위험이 생긴다.
    expect((ws.sent[0].params as { caps: string[] }).caps).toEqual([])
  })

  it('tool 스트림 agent 프레임이 와도 무시한다 (lifecycle 만 처리)', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    await acceptSession(ws)
    ws.respond('sessions.send', { ok: true })
    await flush()
    const before = hook.result.current.toolActivity

    act(() => {
      ws.emit({ event: 'agent', payload: {
        sessionKey: 'sess-1', stream: 'tool', runId: 'run-1',
        data: { phase: 'start', name: 'exec', toolCallId: 'call-1' },
      } })
    })
    await flush()
    // 이 훅의 agent 핸들러는 stream==='lifecycle' 만 본다 → 상태가 움직이지 않는다.
    expect(hook.result.current.toolActivity).toBe(before)
    expect(hook.result.current.messages.filter(m => m.role === 'assistant')).toHaveLength(0)
  })
})

describe('useOpenClaw — close·재연결', () => {
  it('소켓이 닫히면 backoff 로 자동 재연결한다 (1.5s → 3s)', async () => {
    const { hook, ws } = await mountReady()
    act(() => { ws.close() })
    await flush()
    expect(hook.result.current.status).toBe('connecting')
    expect(hook.result.current.isThinking).toBe(false)

    await act(() => vi.advanceTimersByTimeAsync(1499))
    expect(FakeWebSocket.instances).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(FakeWebSocket.instances).toHaveLength(2)

    // 두 번째 실패 → 3s
    act(() => { FakeWebSocket.last.close() })
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(2999))
    expect(FakeWebSocket.instances).toHaveLength(2)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('자동 재시도 상한(8회)을 넘기면 재연결을 포기하고 disconnected 가 된다', async () => {
    const { hook, ws } = await mountReady()
    act(() => { ws.close() })
    await flush()

    // 열리는 족족 닫아 상한까지 소진시킨다 (backoff 상한 12s).
    for (let i = 0; i < 12; i++) {
      await act(() => vi.advanceTimersByTimeAsync(12_000))
      const latest = FakeWebSocket.instances.at(-1)!
      if (latest.readyState !== FakeWebSocket.CLOSED) {
        act(() => { latest.close() })
        await flush()
      }
    }

    expect(hook.result.current.status).toBe('disconnected')
    // 8회 상한 — 무한 루프가 아니다.
    expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(9)
    // 포기한 뒤에는 새 타이머도 남지 않는다.
    const before = FakeWebSocket.instances.length
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(FakeWebSocket.instances).toHaveLength(before)
  })

  it('close 는 대기 중 RPC 를 에러 프레임으로 resolve 한다 (reject 가 아니다)', async () => {
    const { hook, ws } = await mountReady()
    // cron.list 는 결과 프레임을 그대로 돌려주는 얇은 래퍼다.
    let settled: unknown = null
    let threw = false
    act(() => { void hook.result.current.cronList().then(r => { settled = r }, () => { threw = true }) })
    await flush()
    expect(ws.pendingReq('cron.list')).toBeDefined()

    act(() => { ws.close() })
    await flush()
    expect(threw).toBe(false)
    expect(settled).toMatchObject({ ok: false, error: { code: 'ws_closed' } })
  })

  it('reconnect() — 즉시 새 소켓을 연다', async () => {
    const { hook, ws } = await mountReady()
    act(() => { hook.result.current.reconnect() })
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('openclaw-ready IPC — 낡은 소켓을 버리고 다시 연결한다', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    await acceptSession(ws)
    const onReady = twixy.onOpenClawReady.mock.calls[0][0]

    act(() => { onReady() })
    await flush()
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect(hook.result.current.isThinking).toBe(false)
    expect(hook.result.current.status).toBe('connecting')
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
  })

  it('언마운트 — 턴이 걸어둔 타이머(usage sync / final fallback)도 남기지 않는다 (#7)', async () => {
    const { hook, ws } = await mountReady()
    await send(hook, 'hello')
    await acceptSession(ws)
    ws.respond('sessions.send', { ok: true })
    await flush()

    // assistant 응답 → usage sync 디바운스(2s), chat final → final fallback 유예(400ms)
    act(() => { ws.emit(assistantMsg('hi there')) })
    act(() => { ws.emit({ event: 'chat', payload: { sessionKey: 'sess-1', state: 'final' } }) })
    await flush()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    hook.unmount()
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('언마운트 — 소켓을 닫고 IPC 구독을 해제한다', async () => {
    const offReady = vi.fn()
    twixy.onOpenClawReady.mockReturnValue(offReady)
    const { hook, ws } = await mountReady()

    hook.unmount()
    await flush()
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect(offReady).toHaveBeenCalled()
  })
})
