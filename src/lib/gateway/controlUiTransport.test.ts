// controlUiTransport 계약 테스트 — 가짜 WebSocket 위에서 돈다 (네트워크 없음).
// 7개 훅이 공유하던 핸드셰이크/RPC 동작과, transport 로 옮기며 구조적으로 고친
// 잠재 버그 #1(connect 거절 후 lock 잔존)을 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../../test/fakeWebSocket'
import { createControlUiTransport, type ControlUiTransportOptions } from './controlUiTransport'
import { createSession, extractText, releaseSessions } from './sessionClient'

const flush = () => vi.advanceTimersByTimeAsync(0)

function make(over: Partial<ControlUiTransportOptions> = {}) {
  const getToken = vi.fn(async (): Promise<string | null> => 'tok-1')
  const transport = createControlUiTransport({
    url: 'ws://test', displayName: 'Twixy Test', platform: 'win32',
    wsErrorMessage: 'Test WS error', getToken, ...over,
  })
  return { transport, getToken: (over.getToken as typeof getToken | undefined) ?? getToken }
}

// 소켓 생성 → challenge → connect 응답까지 한 번에.
async function connectOk(transport: ReturnType<typeof make>['transport']) {
  const p = transport.ensureConnected()
  await flush()
  const ws = FakeWebSocket.last
  ws.challenge()
  ws.respond('connect', { ok: true })
  await p
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('handshake', () => {
  it('challenge 를 받으면 connect rpc 를 보내고, ok 면 연결된다', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)

    expect(ws.url).toBe('ws://test')
    expect(ws.sent[0].method).toBe('connect')
    expect(ws.sent[0].params).toEqual({
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'openclaw-control-ui', displayName: 'Twixy Test', version: '0.1.0', platform: 'win32', mode: 'ui' },
      caps: [],
      auth: { token: 'tok-1' },
      role: 'operator',
      scopes: ['operator.admin', 'operator.write', 'operator.read'],
    })
    expect(transport.isConnected()).toBe(true)
  })

  it('caps — 기본은 빈 배열, 선언하면 그대로 실린다', async () => {
    // 기본이 [] 인 것은 계약이다: 필요 없는 소켓에 프레임을 늘리지 않는다.
    // 'tool-events' 를 선언한 연결만 게이트웨이의 tool 스트림 수신자로 등록된다 —
    // 선언하지 않으면 툴 활동 프레임이 **아예 오지 않는다**.
    const plain = make()
    const ws1 = await connectOk(plain.transport)
    expect((ws1.sent[0].params as { caps: string[] }).caps).toEqual([])

    FakeWebSocket.reset()
    const capped = make({ caps: ['tool-events'] })
    const ws2 = await connectOk(capped.transport)
    expect((ws2.sent[0].params as { caps: string[] }).caps).toEqual(['tool-events'])
  })

  it('토큰이 없거나 provider 가 throw 하면 auth 없이 연결로 degrade 한다', async () => {
    const { transport } = make({ getToken: vi.fn(async () => { throw new Error('ipc down') }) })
    const ws = await connectOk(transport)
    expect(ws.sent[0].params.auth).toBeUndefined()
  })

  it('auth 거절 — 게이트웨이 메시지로 reject 하고 소켓을 버린다', async () => {
    const { transport } = make()
    const p = transport.ensureConnected()
    await flush()
    const ws = FakeWebSocket.last
    ws.challenge()
    ws.respond('connect', { ok: false, error: { message: 'bad token' } })

    await expect(p).rejects.toThrow('bad token')
    expect(transport.isConnected()).toBe(false)
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('auth 거절에 메시지가 없으면 "Auth rejected"', async () => {
    const { transport } = make()
    const p = transport.ensureConnected()
    await flush()
    FakeWebSocket.last.challenge()
    FakeWebSocket.last.respond('connect', { ok: false })
    await expect(p).rejects.toThrow('Auth rejected')
  })

  it('challenge 전에 소켓이 닫히면 connect 가 hang 하지 않고 reject 된다', async () => {
    const { transport } = make()
    const p = transport.ensureConnected()
    await flush()
    FakeWebSocket.last.close()
    await expect(p).rejects.toThrow('Connection closed')
  })
})

describe('connect lock', () => {
  it('동시 ensureConnected 는 connect 한 번을 공유한다', async () => {
    const { transport, getToken } = make()
    const a = transport.ensureConnected()
    const b = transport.ensureConnected()
    await flush()
    FakeWebSocket.last.challenge()
    FakeWebSocket.last.respond('connect', { ok: true })
    await Promise.all([a, b])

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(getToken).toHaveBeenCalledTimes(1)
    // 이미 연결됐으면 소켓도 토큰 조회도 다시 하지 않는다.
    await transport.ensureConnected()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(getToken).toHaveBeenCalledTimes(1)
  })

  it('connect 가 실패하면 lock 이 풀려 다음 호출이 새로 시도한다 (#1)', async () => {
    const { transport } = make()
    const first = transport.ensureConnected()
    await flush()
    FakeWebSocket.last.error()
    await expect(first).rejects.toThrow('Test WS error')

    const ws2 = await connectOk(transport)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(ws2).not.toBe(FakeWebSocket.instances[0])
    expect(transport.isConnected()).toBe(true)
  })

  it('토큰 provider 는 connect 시도마다 한 번씩, 매번 새로 불린다', async () => {
    let n = 0
    const getToken = vi.fn(async () => `tok-${++n}`)
    const { transport } = make({ getToken })

    const ws1 = await connectOk(transport)
    expect(ws1.sent[0].params.auth).toEqual({ token: 'tok-1' })
    ws1.close()   // 게이트웨이 재시작

    const ws2 = await connectOk(transport)
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(ws2.sent[0].params.auth).toEqual({ token: 'tok-2' })
  })
})

describe('rpc', () => {
  it('응답 프레임을 id 로 demux 한다', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const a = transport.rpc('a.method', { x: 1 })
    const b = transport.rpc('b.method', {})
    ws.respond('b.method', { ok: true, payload: { who: 'b' } })
    ws.respond('a.method', { ok: false, error: { message: 'nope' } })

    expect((await b).payload).toEqual({ who: 'b' })
    expect((await a).ok).toBe(false)
    expect(ws.pendingReq('a.method')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('소켓이 없으면 "WS not open" 으로 reject', async () => {
    const { transport } = make()
    await expect(transport.rpc('x', {})).rejects.toThrow('WS not open')
  })

  it('timeout(기본 15s) 이면 reject 하고 pending 을 지운다 — 늦은 응답은 무시', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const p = transport.rpc('slow.method', {})
    const settled = vi.fn()
    p.then(settled, settled)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toThrow('RPC timeout: slow.method')

    expect(() => ws.respond('slow.method', { ok: true })).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('호출별 timeout override', async () => {
    const { transport } = make()
    await connectOk(transport)
    const p = transport.rpc('sessions.send', {}, 60_000)
    const settled = vi.fn()
    p.then(settled, settled)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toThrow('RPC timeout: sessions.send')
  })

  it('거절에 분류용 code 가 붙는다 (ws_not_open / timeout / ws_closed)', async () => {
    const { transport } = make()
    // 연결 전
    await expect(transport.rpc('x', {})).rejects.toMatchObject({ code: 'ws_not_open' })

    const ws = await connectOk(transport)
    const slow = transport.rpc('slow', {})
    const outcome = slow.catch((e: { code?: string; message: string }) => e)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await outcome).toMatchObject({ code: 'timeout', message: 'RPC timeout: slow' })

    const inflight = transport.rpc('later', {})
    const closedErr = inflight.catch((e: { code?: string; message: string }) => e)
    ws.close()
    expect(await closedErr).toMatchObject({ code: 'ws_closed', message: 'Connection closed' })
  })

  it('dispose 로 인한 거절도 ws_closed 로 분류된다', async () => {
    const { transport } = make()
    await connectOk(transport)
    const inflight = transport.rpc('x', {})
    const outcome = inflight.catch((e: { code?: string; message: string }) => e)
    transport.dispose()
    expect(await outcome).toMatchObject({ code: 'ws_closed', message: 'Transport disposed' })
  })

  it('소켓이 닫히면 pending RPC 를 즉시 reject 하고 타이머를 지운다', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const onClose = vi.fn()
    transport.onClose(onClose)
    const a = transport.rpc('a', {})
    const b = transport.rpc('b', {})

    ws.close()
    await expect(a).rejects.toThrow('Connection closed')
    await expect(b).rejects.toThrow('Connection closed')
    expect(vi.getTimerCount()).toBe(0)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(transport.isConnected()).toBe(false)
  })
})

describe('events', () => {
  it('깨진 프레임은 무시하고 이후 프레임은 정상 전달한다', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const seen: Array<[string | undefined, string]> = []
    transport.onEvent((f, raw) => seen.push([f.event, raw]))

    ws.emit('not json {')
    ws.emit('null')
    ws.emit('42')
    ws.emit({ event: 'session.message', payload: { a: 1 } })

    expect(seen).toEqual([['session.message', JSON.stringify({ event: 'session.message', payload: { a: 1 } })]])
  })

  it('challenge·RPC 응답은 구독자에게 가지 않고, 구독자 예외는 다른 구독자를 막지 않는다', async () => {
    const { transport } = make()
    const bad  = vi.fn(() => { throw new Error('listener bug') })
    const good = vi.fn()
    transport.onEvent(bad)
    const off = transport.onEvent(good)
    const ws = await connectOk(transport)   // challenge + connect 응답이 지나간다
    expect(good).not.toHaveBeenCalled()

    ws.emit({ event: 'chat', payload: { state: 'final' } })
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)

    off()
    ws.emit({ event: 'chat', payload: { state: 'final' } })
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('재연결 뒤에는 이전(stale) 소켓의 프레임이 전달되지 않는다', async () => {
    const { transport } = make()
    const ws1 = await connectOk(transport)
    const staleHandler = ws1.onmessage!   // 브라우저가 이미 큐에 넣은 message 이벤트를 흉내
    const seen = vi.fn()
    transport.onEvent(seen)

    ws1.close()
    const ws2 = await connectOk(transport)
    staleHandler({ data: JSON.stringify({ event: 'session.message', payload: { from: 'old' } }) })
    ws1.emit({ event: 'session.message', payload: { from: 'old' } })
    expect(seen).not.toHaveBeenCalled()

    ws2.emit({ event: 'session.message', payload: { from: 'new' } })
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('dispose', () => {
  it('소켓을 닫고 핸들러·구독자를 떼며 pending 을 정리한다', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const onEvent = vi.fn()
    const onClose = vi.fn()
    transport.onEvent(onEvent)
    transport.onClose(onClose)
    const inflight = transport.rpc('a', {})

    transport.dispose()

    await expect(inflight).rejects.toThrow('Transport disposed')
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect([ws.onopen, ws.onmessage, ws.onerror, ws.onclose]).toEqual([null, null, null, null])
    // 호출자가 직접 닫은 것이므로 onClose 도 부르지 않는다.
    expect(onClose).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(transport.ensureConnected()).rejects.toThrow('Transport disposed')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('connect 도중 dispose — 진행 중이던 connect 가 reject 되고 소켓이 남지 않는다', async () => {
    const { transport } = make()
    const p = transport.ensureConnected()
    await flush()
    const ws = FakeWebSocket.last
    ws.challenge()              // connect rpc 가 떠 있는 상태
    transport.dispose()
    await expect(p).rejects.toThrow('Transport disposed')
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('토큰 조회 중 dispose — 소켓을 아예 열지 않는다', async () => {
    const { transport } = make()
    const p = transport.ensureConnected()
    transport.dispose()
    await expect(p).rejects.toThrow('Transport disposed')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('connect/close 를 반복해도 타이머·핸들러·미결 promise 가 쌓이지 않는다', async () => {
    const { transport } = make()
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) {
      const ws = await connectOk(transport)
      transport.rpc('hang', {}).then(() => outcomes.push('ok'), () => outcomes.push('rejected'))
      ws.close()
      await flush()
    }
    transport.dispose()

    expect(outcomes).toEqual(Array(5).fill('rejected'))
    expect(vi.getTimerCount()).toBe(0)
    for (const ws of FakeWebSocket.instances) {
      expect([ws.onopen, ws.onmessage, ws.onerror, ws.onclose]).toEqual([null, null, null, null])
    }
  })
})

describe('sessionClient', () => {
  it('createSession — create 후 그 key 로 messages.subscribe', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const p = createSession(transport, { agentId: 'builder' })
    expect(ws.pendingReq('sessions.create')?.params).toEqual({ agentId: 'builder' })
    ws.respond('sessions.create', { ok: true, payload: { key: 'sess-1' } })
    await flush()
    expect(ws.pendingReq('sessions.messages.subscribe')?.params).toEqual({ key: 'sess-1' })
    ws.respond('sessions.messages.subscribe', { ok: true })
    await expect(p).resolves.toBe('sess-1')
  })

  it('createSession — key 가 없으면 "Session create failed"', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    const p = createSession(transport, {})
    ws.respond('sessions.create', { ok: true, payload: {} })
    await expect(p).rejects.toThrow('Session create failed')
  })

  it('releaseSessions — 키마다 sessions.delete, 응답을 기다리지 않는다', async () => {
    const { transport } = make()
    const ws = await connectOk(transport)
    releaseSessions(transport, ['a', 'b'])
    expect(ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params)).toEqual([{ key: 'a' }, { key: 'b' }])

    // 응답 없이 바로 dispose — 반납은 best-effort 라 미처리 rejection 이 생기면 안 된다.
    transport.dispose()
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releaseSessions — 연결되지 않았으면 아무것도 보내지 않는다', async () => {
    const { transport } = make()
    releaseSessions(transport, ['a'])
    expect(FakeWebSocket.instances).toHaveLength(0)

    const ws = await connectOk(transport)
    ws.close()
    await flush()
    releaseSessions(transport, ['a'])
    expect(ws.sent.filter(r => r.method === 'sessions.delete')).toEqual([])
  })

  it('extractText — 텍스트 블록만 잇고 [[tag]] 를 걷어낸다', () => {
    expect(extractText('[[reply_to_current]] hello ')).toBe('hello')
    expect(extractText([
      { type: 'text', text: 'a' }, { type: 'tool_use', name: 'x' }, null, { type: 'text', text: 'b' },
    ])).toBe('ab')
    expect(extractText(undefined)).toBe('')
  })
})
