// useOrchestrationGateway 특성화 테스트 — 계약표(gateway-hooks-contract.md)의 이 훅 열을 고정한다.
// transport 이전 전/후 구현이 같은 테스트를 통과해야 한다.

import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../test/fakeWebSocket'

// isElectron 가드가 모듈 로드 시점에 평가되므로 import 보다 먼저 심는다.
const twixy = vi.hoisted(() => {
  const twixy = { platform: 'win32', getGatewayToken: vi.fn(async () => 'tok') }
  Object.assign(window, { twixy })
  return twixy
})

import { useOrchestrationGateway } from './useOrchestrationGateway'

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useOrchestrationGateway>, unknown>>
type Outcome<T> = { value?: T; error?: string }

// promise 의 결과를 관찰 가능한 형태로 (미처리 rejection 방지).
function watch<T>(p: Promise<T>): Outcome<T> {
  const o: Outcome<T> = {}
  p.then(v => { o.value = v }, e => { o.error = (e as Error).message })
  return o
}

// 마운트 → 핸드셰이크 완료까지.
async function mountReady() {
  const hook = renderHook(() => useOrchestrationGateway())
  await flush()
  const ws = FakeWebSocket.last
  ws.challenge()
  await flush()
  ws.respond('connect', { ok: true })
  await flush()
  return { hook, ws }
}

async function newSession(hook: Hook, ws: FakeWebSocket, key: string) {
  let out!: Outcome<string>
  act(() => { out = watch(hook.result.current.createSession()) })
  await flush()
  ws.respond('sessions.create', { ok: true, payload: { key } })
  await flush()
  ws.respond('sessions.messages.subscribe', { ok: true })
  await flush()
  expect(out.value).toBe(key)
}

async function startSend(hook: Hook, key: string, text: string, opts?: { timeoutMs?: number; model?: string }) {
  let out!: Outcome<Awaited<ReturnType<Hook['result']['current']['send']>>>
  act(() => { out = watch(hook.result.current.send(key, text, opts)) })
  await flush()
  return out
}

const chat = (sessionKey: string | undefined, state: string, extra: Record<string, unknown> = {}) =>
  ({ event: 'chat', payload: { ...(sessionKey ? { sessionKey } : {}), state, ...extra } })
const assistant = (sessionKey: string | undefined, content: unknown, id?: string) =>
  ({ event: 'session.message', payload: { ...(sessionKey ? { sessionKey } : {}), message: { role: 'assistant', content, ...(id ? { id } : {}) } } })
// 툴 활동은 `agent` 의 tool 스트림으로 온다 — connect 에서 'tool-events' cap 을 선언한
// 연결에만 간다. 예전 `session.tool` 프레임은 전역 sessions.subscribe 연결에만 가므로
// 이 훅에는 **온 적이 없다**(죽은 경로였다). phase 는 start/update/result 이고
// 이름 필드는 name, 상관키는 toolCallId 다.
const tool = (sessionKey: string | undefined, phase: string, name: string, toolCallId = `call-${name}`) =>
  ({ event: 'agent', payload: { ...(sessionKey ? { sessionKey } : {}), stream: 'tool', runId: 'run-1', data: { phase, name, toolCallId } } })

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useOrchestrationGateway', () => {
  it('마운트 즉시 연결한다 — 핸드셰이크만, 세션은 만들지 않는다', async () => {
    const hook = renderHook(() => useOrchestrationGateway())
    expect(hook.result.current.status).toBe('connecting')
    expect(Object.keys(hook.result.current).sort()).toEqual(
      ['abort', 'abortAll', 'activity', 'createSession', 'ensureReady', 'send', 'status'])
    await flush()
    const ws = FakeWebSocket.last
    ws.challenge()
    await flush()
    expect((ws.sent[0].params.client as Record<string, unknown>).displayName).toBe('Twixy Orchestration')
    expect(ws.sent[0].params.auth).toEqual({ token: 'tok' })
    ws.respond('connect', { ok: true })
    await flush()

    expect(hook.result.current.status).toBe('ready')
    expect(ws.sent.map(r => r.method)).toEqual(['connect'])
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('createSession — 호출자가 부를 때만 workflow-runner 세션 생성 + 구독', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    expect(ws.sent.map(r => r.method)).toEqual(['connect', 'sessions.create', 'sessions.messages.subscribe'])
    expect(ws.sent[1].params).toEqual({ agentId: 'workflow-runner' })
    expect(ws.sent[2].params).toEqual({ key: 'k1' })
  })

  it('createSession — key 가 없으면 "sessions.create failed"', async () => {
    const { hook, ws } = await mountReady()
    let out!: Outcome<string>
    act(() => { out = watch(hook.result.current.createSession()) })
    await flush()
    ws.respond('sessions.create', { ok: false, error: { message: 'nope' } })
    await flush()
    expect(out.error).toBe('sessions.create failed')
  })

  it('send — chat final 에서 마지막 assistant 본문·messageId·toolCalls 로 resolve, activity 미러', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const out = await startSend(hook, 'k1', 'do it', { model: 'm-1' })
    expect(ws.pendingReq('sessions.send')?.params).toEqual({ key: 'k1', message: 'do it', model: 'm-1' })
    expect(hook.result.current.activity).toEqual({ k1: { thinking: true } })
    ws.respond('sessions.send', { ok: true })
    await flush()
    expect(out).toEqual({})   // send ACK 는 완료가 아니다

    act(() => { ws.emit(tool('k1', 'start', 'browser')) })
    expect(hook.result.current.activity).toEqual({ k1: { thinking: true, tool: 'browser' } })
    act(() => { ws.emit(assistant('k1', 'draft')) })
    act(() => { ws.emit(assistant('k1', [{ type: 'text', text: '[[x]] final text' }], 'msg-9')) })
    expect(out).toEqual({})   // assistant 메시지만으로는 끝나지 않는다
    act(() => { ws.emit(chat('k1', 'final')) })
    await flush()

    expect(out.value).toEqual({ text: 'final text', messageId: 'msg-9', toolCalls: [{ name: 'browser' }] })
    expect(hook.result.current.activity).toEqual({})
  })

  it('send — model 을 안 주면 params 에 싣지 않는다', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    await startSend(hook, 'k1', 'plain')
    expect(ws.pendingReq('sessions.send')?.params).toEqual({ key: 'k1', message: 'plain' })
    ws.respond('sessions.send', { ok: true })
    await flush()
  })

  it('chat error → 게이트웨이 메시지로 reject (없으면 chat_error)', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const a = await startSend(hook, 'k1', 'one')
    ws.respond('sessions.send', { ok: true })
    act(() => { ws.emit(chat('k1', 'error', { error: { message: 'image input 404' } })) })
    await flush()
    expect(a.error).toBe('image input 404')

    const b = await startSend(hook, 'k1', 'two')
    ws.respond('sessions.send', { ok: true })
    act(() => { ws.emit(chat('k1', 'error')) })
    await flush()
    expect(b.error).toBe('chat_error')
    expect(hook.result.current.activity).toEqual({})
  })

  it('sessionKey 없는 프레임은 버린다 (chat / session.message / session.tool)', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const out = await startSend(hook, 'k1', 'go')
    ws.respond('sessions.send', { ok: true })

    act(() => { ws.emit(assistant(undefined, 'keyless text')) })
    act(() => { ws.emit(tool(undefined, 'start', 'browser')) })
    act(() => { ws.emit(chat(undefined, 'final')) })
    await flush()
    expect(out).toEqual({})
    expect(hook.result.current.activity).toEqual({ k1: { thinking: true } })

    act(() => { ws.emit(chat('k1', 'final')) })
    await flush()
    expect(out.value).toEqual({ text: '', messageId: null, toolCalls: [] })
  })

  it('이벤트는 sessionKey 로 라우팅 — 병렬 세션이 서로의 final 을 먹지 않는다', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    await newSession(hook, ws, 'k2')
    const a = await startSend(hook, 'k1', 'A')
    ws.respond('sessions.send', { ok: true })
    const b = await startSend(hook, 'k2', 'B')
    ws.respond('sessions.send', { ok: true })

    act(() => { ws.emit(assistant('k2', 'answer-B')) })
    act(() => { ws.emit(chat('k2', 'final')) })
    await flush()
    expect(b.value?.text).toBe('answer-B')
    expect(a).toEqual({})
    expect(hook.result.current.activity).toEqual({ k1: { thinking: true } })
  })

  it('같은 key 의 awaiter 는 FIFO — final 하나에 하나씩', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const first = await startSend(hook, 'k1', 'one')
    ws.respond('sessions.send', { ok: true })
    const second = await startSend(hook, 'k1', 'two')
    ws.respond('sessions.send', { ok: true })

    act(() => { ws.emit(assistant('k1', 'r1')) })
    act(() => { ws.emit(chat('k1', 'final')) })
    await flush()
    expect(first.value?.text).toBe('r1')
    expect(second).toEqual({})
    act(() => { ws.emit(assistant('k1', 'r2')) })
    act(() => { ws.emit(chat('k1', 'final')) })
    await flush()
    expect(second.value?.text).toBe('r2')
  })

  it('turn timeout — 기본 10분, opts.timeoutMs 로 override ("turn_timeout")', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const slow = await startSend(hook, 'k1', 'slow')
    ws.respond('sessions.send', { ok: true })
    await act(() => vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1))
    expect(slow).toEqual({})
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(slow.error).toBe('turn_timeout')

    const quick = await startSend(hook, 'k1', 'quick', { timeoutMs: 5_000 })
    ws.respond('sessions.send', { ok: true })
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(quick.error).toBe('turn_timeout')
  })

  it('소켓이 닫히면 모든 awaiter 를 ws_closed 로 reject, status error, activity 비움', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    await newSession(hook, ws, 'k2')
    const a = await startSend(hook, 'k1', 'A')
    ws.respond('sessions.send', { ok: true })
    const b = await startSend(hook, 'k2', 'B')
    ws.respond('sessions.send', { ok: true })
    await flush()

    act(() => { ws.close() })
    await flush()
    expect(a.error).toBe('ws_closed')
    expect(b.error).toBe('ws_closed')
    expect(hook.result.current.status).toBe('error')
    expect(hook.result.current.activity).toEqual({})
  })

  it('닫힌 뒤 ensureReady 가 새로 연결한다 (토큰도 새로 조회)', async () => {
    const { hook, ws } = await mountReady()
    act(() => { ws.close() })
    await flush()

    let out!: Outcome<void>
    act(() => { out = watch(hook.result.current.ensureReady()) })
    await flush()
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws)
    ws2.challenge()
    await flush()
    ws2.respond('connect', { ok: true })
    await flush()
    expect(out.error).toBeUndefined()
    expect(hook.result.current.status).toBe('ready')
    expect(twixy.getGatewayToken).toHaveBeenCalledTimes(2)
  })

  it('abort — sessions.abort 후 그 key 의 awaiter 를 cancelled 로 reject, abortAll 은 전 key', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    await newSession(hook, ws, 'k2')
    const a = await startSend(hook, 'k1', 'A')
    ws.respond('sessions.send', { ok: true })
    const b = await startSend(hook, 'k2', 'B')
    ws.respond('sessions.send', { ok: true })

    act(() => { void hook.result.current.abort('k1') })
    await flush()
    expect(ws.pendingReq('sessions.abort')?.params).toEqual({ key: 'k1' })
    ws.respond('sessions.abort', { ok: true })
    await flush()
    expect(a.error).toBe('cancelled')
    expect(b).toEqual({})

    act(() => { void hook.result.current.abortAll() })
    await flush()
    while (ws.pendingReq('sessions.abort')) { ws.respond('sessions.abort', { ok: true }) }
    await flush()
    expect(b.error).toBe('cancelled')
    expect(hook.result.current.activity).toEqual({})
  })

  it('언마운트 시 만든 세션을 전부 반납한다 (소켓을 닫기 전에)', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    await newSession(hook, ws, 'k2')

    hook.unmount()
    await flush()
    expect(ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params))
      .toEqual([{ key: 'k1' }, { key: 'k2' }])
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('언마운트 시 소켓을 닫고 대기 중 awaiter 를 ws_closed 로 깨운다', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const a = await startSend(hook, 'k1', 'A')
    ws.respond('sessions.send', { ok: true })
    await flush()

    hook.unmount()
    await flush()
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect(a.error).toBe('ws_closed')
  })
})

// ── 계약표 #10 — send 실패 경로가 q.pop() 으로 "맨 뒤" awaiter 를 버렸다 (timeout 경로는 identity) ──
describe('useOrchestrationGateway — send 실패 경로 (#10)', () => {
  it('뒤 turn 의 send RPC 실패가 같은 key 의 다른 turn awaiter 를 버리지 않는다', async () => {
    const { hook, ws } = await mountReady()
    await newSession(hook, ws, 'k1')
    const first = await startSend(hook, 'k1', 'one')
    ws.respond('sessions.send', { ok: true })
    await flush()
    // 두 번째 turn 은 ACK 가 끝내 안 온다 → 5s 뒤 turn 타이머가 자기 awaiter 를 먼저 빼고,
    // 이어서 send RPC 가 timeout 난다. 그 catch 가 큐의 맨 뒤(= first)를 pop 하면 안 된다.
    const second = await startSend(hook, 'k1', 'two', { timeoutMs: 5_000 })
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(second.error).toBe('RPC timeout: sessions.send')
    expect(first).toEqual({})
    expect(hook.result.current.activity).toEqual({ k1: { thinking: true } })   // first 가 아직 돈다

    act(() => { ws.emit(assistant('k1', 'r1')) })
    act(() => { ws.emit(chat('k1', 'final')) })
    await flush()
    expect(first.value?.text).toBe('r1')
  })

  it('연결 전 send 는 "WS not open" 으로 실패 — awaiter promise 가 unhandled rejection 으로 새지 않는다', async () => {
    const hook = renderHook(() => useOrchestrationGateway())
    const out = await startSend(hook, 'k1', 'too early')
    expect(out.error).toBe('WS not open')
    expect(hook.result.current.activity).toEqual({})
  })
})

// 옛 구현에서는 테스트할 수 없던 경로 — 마운트의 `void ensureReady()` 가 거절을 받아줄 곳이 없어
// 연결 실패마다 unhandled rejection 이 났다. transport 이전 뒤의 보장을 고정한다.
describe('useOrchestrationGateway — 연결 실패·StrictMode (transport 이전 후)', () => {
  it('마운트 연결이 WS error 로 실패하면 status error — unhandled rejection 없음', async () => {
    const hook = renderHook(() => useOrchestrationGateway())
    await flush()
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(hook.result.current.status).toBe('error')
  })

  it('auth 거절 → status error, 다음 ensureReady 는 같은 거절을 재사용하지 않고 새로 시도한다 (#1)', async () => {
    const hook = renderHook(() => useOrchestrationGateway())
    await flush()
    const ws1 = FakeWebSocket.last
    ws1.challenge()
    await flush()
    ws1.respond('connect', { ok: false, error: { message: 'bad token' } })
    await flush()
    expect(hook.result.current.status).toBe('error')

    let out!: Outcome<void>
    act(() => { out = watch(hook.result.current.ensureReady()) })
    await flush()
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    ws2.challenge()
    await flush()
    ws2.respond('connect', { ok: true })
    await flush()
    expect(out.error).toBeUndefined()
    expect(hook.result.current.status).toBe('ready')
  })

  it('StrictMode 이중 마운트 — 소켓 하나로 ready 까지 간다', async () => {
    const hook = renderHook(() => useOrchestrationGateway(), { wrapper: StrictMode })
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.last
    ws.challenge()
    await flush()
    ws.respond('connect', { ok: true })
    await flush()
    expect(hook.result.current.status).toBe('ready')
  })
})
