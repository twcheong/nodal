// useWorkflowClaw / useOrchestrationClaw 특성화 테스트 — 계약표(gateway-hooks-contract.md)의
// 두 훅 열을 고정한다. 두 훅은 서로의 미러(soul 인자·IPC 채널명·문구만 다름)라 한 스위트를
// 두 번 돌린다. transport 이전 전/후 구현이 같은 테스트를 통과해야 한다.

import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket, acceptSession } from '../test/fakeWebSocket'

// isElectron 가드가 모듈 로드 시점에 평가되므로 import 보다 먼저 심는다.
const twixy = vi.hoisted(() => {
  const twixy = {
    platform: 'win32',
    getGatewayToken:         vi.fn(async () => 'tok'),
    workflowChatAppend:      vi.fn(),
    workflowChatLoad:        vi.fn(async () => []),
    workflowChatClear:       vi.fn(),
    orchestrationChatAppend: vi.fn(),
    orchestrationChatLoad:   vi.fn(async () => []),
    orchestrationChatClear:  vi.fn(),
  }
  Object.assign(window, { twixy })
  return twixy
})
vi.mock('../lib/workflowSoul', () => ({ getWorkflowSoul: () => 'SOUL' }))
vi.mock('../lib/orchestrationSoul', () => ({ getOrchestrationSoul: () => 'SOUL' }))

import { useWorkflowClaw } from './useWorkflowClaw'
import { useOrchestrationClaw } from './useOrchestrationClaw'

const NO_WORKFLOWS: TwixyWorkflow[] = []

const cases = [
  {
    name: 'useWorkflowClaw',
    useHook: (id: string | null) => useWorkflowClaw(id),
    displayName: 'Twixy Workflow Builder',
    wsError: 'Workflow builder WS error',
    append: twixy.workflowChatAppend, load: twixy.workflowChatLoad, clear: twixy.workflowChatClear,
  },
  {
    name: 'useOrchestrationClaw',
    useHook: (id: string | null) => useOrchestrationClaw(id, NO_WORKFLOWS),
    displayName: 'Twixy Orchestration Builder',
    wsError: 'Orchestration builder WS error',
    append: twixy.orchestrationChatAppend, load: twixy.orchestrationChatLoad, clear: twixy.orchestrationChatClear,
  },
]

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

const assistant = (content: unknown) => ({ event: 'session.message', payload: { message: { role: 'assistant', content } } })

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

describe.each(cases)('$name', ({ useHook, displayName, wsError, append, load, clear }) => {
  async function mount(id: string | null = 'id-1') {
    const hook = renderHook(() => useHook(id))
    await flush()   // 채팅 history load
    return hook
  }

  // send 를 걸고(응답은 기다리지 않음) 소켓이 생길 때까지 flush.
  async function send(hook: Awaited<ReturnType<typeof mount>>, text: string, displayText?: string) {
    act(() => { void hook.result.current.sendMessage(text, displayText) })
    await flush()
  }

  it('마운트만으로는 연결하지 않는다 — 첫 send 때 lazy', async () => {
    const hook = await mount()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(Object.keys(hook.result.current).sort()).toEqual(['error', 'isThinking', 'messages', 'resetChat', 'sendMessage'])
  })

  it('첫 send: 핸드셰이크 안에서 builder 세션 생성 → SOUL prepend 해 전송', async () => {
    const hook = await mount()
    await send(hook, ' hello ')
    const ws = FakeWebSocket.last
    await acceptSession(ws, flush)

    expect(ws.sent.map(r => r.method)).toEqual(['connect', 'sessions.create', 'sessions.messages.subscribe', 'sessions.send'])
    expect((ws.sent[0].params.client as Record<string, unknown>).displayName).toBe(displayName)
    expect(ws.sent[0].params.auth).toEqual({ token: 'tok' })
    expect(ws.sent[1].params).toEqual({ agentId: 'builder' })
    expect(ws.sent[2].params).toEqual({ key: 'sess-1' })
    expect(ws.sent[3].params).toEqual({ key: 'sess-1', message: 'SOUL\n\n---\n\nhello' })

    expect(hook.result.current.isThinking).toBe(true)
    expect(hook.result.current.messages.map(m => [m.role, m.content])).toEqual([['user', 'hello']])
    expect(append).toHaveBeenCalledWith('id-1', expect.objectContaining({ role: 'user', content: 'hello' }))
  })

  it('assistant 메시지 도착이 곧 완료 — thinking 해제 + 디스크 append', async () => {
    const hook = await mount()
    await send(hook, 'hello')
    const ws = FakeWebSocket.last
    await acceptSession(ws, flush)
    ws.respond('sessions.send', { ok: true })
    await flush()
    expect(hook.result.current.isThinking).toBe(true)   // send ACK 는 완료가 아니다

    // user echo · 빈 텍스트는 무시
    act(() => { ws.emit({ event: 'session.message', payload: { message: { role: 'user', content: 'hello' } } }) })
    act(() => { ws.emit(assistant([{ type: 'tool_use', name: 'x' }])) })
    expect(hook.result.current.isThinking).toBe(true)

    act(() => { ws.emit(assistant([{ type: 'text', text: '[[reply_to_current]] hi there' }])) })
    expect(hook.result.current.isThinking).toBe(false)
    expect(hook.result.current.messages.map(m => [m.role, m.content])).toEqual([['user', 'hello'], ['assistant', 'hi there']])
    expect(append).toHaveBeenLastCalledWith('id-1', expect.objectContaining({ role: 'assistant', content: 'hi there' }))
  })

  it('두 번째 send 는 같은 소켓·세션에 SOUL 없이, displayText 는 말풍선에만', async () => {
    const hook = await mount()
    await send(hook, 'one')
    const ws = FakeWebSocket.last
    await acceptSession(ws, flush)
    ws.respond('sessions.send', { ok: true })
    await send(hook, 'two + hidden snapshot', 'two')

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.pendingReq('sessions.send')?.params).toEqual({ key: 'sess-1', message: 'two + hidden snapshot' })
    expect(hook.result.current.messages.at(-1)?.content).toBe('two')
  })

  it('소켓이 닫히면 다음 send 가 새로 연결·새 세션·SOUL 재주입 (토큰도 새로 조회)', async () => {
    const hook = await mount()
    await send(hook, 'one')
    const ws1 = FakeWebSocket.last
    await acceptSession(ws1, flush)
    ws1.respond('sessions.send', { ok: true })
    act(() => { ws1.close() })

    await send(hook, 'two')
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    await acceptSession(ws2, flush, 'sess-2')
    expect(twixy.getGatewayToken).toHaveBeenCalledTimes(2)
    expect(ws2.pendingReq('sessions.send')?.params).toEqual({ key: 'sess-2', message: 'SOUL\n\n---\n\ntwo' })
  })

  it('resetChat — 화면·디스크를 비우고 다음 메시지에 SOUL 을 다시 붙인다 (세션은 유지)', async () => {
    const hook = await mount()
    await send(hook, 'one')
    const ws = FakeWebSocket.last
    await acceptSession(ws, flush)
    ws.respond('sessions.send', { ok: true })

    act(() => { hook.result.current.resetChat() })
    expect(hook.result.current.messages).toEqual([])
    expect(hook.result.current.isThinking).toBe(false)
    expect(clear).toHaveBeenCalledWith('id-1')

    await send(hook, 'again')
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.pendingReq('sessions.send')?.params).toEqual({ key: 'sess-1', message: 'SOUL\n\n---\n\nagain' })
  })

  it('핸드셰이크 전 WS error → error 상태 + thinking 해제', async () => {
    const hook = await mount()
    await send(hook, 'hello')
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(hook.result.current.error).toBe(wsError)
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('세션 생성 실패 → "Session create failed"', async () => {
    const hook = await mount()
    await send(hook, 'hello')
    const ws = FakeWebSocket.last
    ws.challenge()
    await flush()
    ws.respond('connect', { ok: true })
    await flush()
    ws.respond('sessions.create', { ok: false, error: { message: 'nope' } })
    await flush()
    expect(hook.result.current.error).toBe('Session create failed')
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('auth 거절 → 게이트웨이 메시지가 error 로', async () => {
    const hook = await mount()
    await send(hook, 'hello')
    const ws = FakeWebSocket.last
    ws.challenge()
    await flush()
    ws.respond('connect', { ok: false, error: { message: 'bad token' } })
    await flush()
    expect(hook.result.current.error).toBe('bad token')
  })

  // ── 계약표 #8 — assistant 메시지 없이 턴이 죽어도 thinking 이 영원히 남지 않는다 ──
  describe('턴이 assistant 메시지 없이 끝날 때 (#8)', () => {
    async function thinking() {
      const hook = await mount()
      await send(hook, 'hello')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      ws.respond('sessions.send', { ok: true })
      await flush()
      expect(hook.result.current.isThinking).toBe(true)
      return { hook, ws }
    }

    it('chat error → thinking 해제 + 게이트웨이 메시지를 error 로', async () => {
      const { hook, ws } = await thinking()
      act(() => { ws.emit({ event: 'chat', payload: { sessionKey: 'sess-1', state: 'error', error: { message: 'image input 404' } } }) })
      expect(hook.result.current.isThinking).toBe(false)
      expect(hook.result.current.error).toBe('image input 404')
    })

    it('chat final → thinking 해제 (error 는 건드리지 않음)', async () => {
      const { hook, ws } = await thinking()
      act(() => { ws.emit({ event: 'chat', payload: { key: 'sess-1', state: 'final' } }) })
      expect(hook.result.current.isThinking).toBe(false)
      expect(hook.result.current.error).toBeNull()
    })

    it('다른 세션·key 없는 chat 이벤트는 무시한다', async () => {
      const { hook, ws } = await thinking()
      act(() => { ws.emit({ event: 'chat', payload: { sessionKey: 'someone-else', state: 'error', error: { message: 'x' } } }) })
      act(() => { ws.emit({ event: 'chat', payload: { state: 'final' } }) })
      act(() => { ws.emit({ event: 'chat', payload: { sessionKey: 'sess-1', state: 'start' } }) })
      expect(hook.result.current.isThinking).toBe(true)
      expect(hook.result.current.error).toBeNull()
    })

    it('응답 대기 중 소켓이 닫히면 thinking 해제', async () => {
      const { hook, ws } = await thinking()
      act(() => { ws.close() })
      expect(hook.result.current.isThinking).toBe(false)
    })
  })

  // ── 계약표 #12 — 언마운트 시 소켓·타이머 정리 ──
  describe('언마운트 정리 (#12)', () => {
    it('소켓을 닫고 핸들러·타이머를 남기지 않으며, 이후 프레임은 처리하지 않는다', async () => {
      const hook = await mount()
      await send(hook, 'hello')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)   // sessions.send 는 ACK 없이 떠 있는 상태
      const staleHandler = ws.onmessage!
      append.mockClear()

      hook.unmount()
      await flush()

      expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
      expect([ws.onopen, ws.onmessage, ws.onerror, ws.onclose]).toEqual([null, null, null, null])
      expect(vi.getTimerCount()).toBe(0)
      staleHandler({ data: JSON.stringify(assistant('too late')) })
      expect(append).not.toHaveBeenCalled()
    })

    it('언마운트 시 게이트웨이 세션을 반납한다 (소켓을 닫기 전에)', async () => {
      const hook = await mount()
      await send(hook, 'hello')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)

      hook.unmount()
      await flush()
      // 닫힌 소켓의 send 는 기록되지 않으므로, 이 요청이 보인다는 건 close 전에 나갔다는 뜻.
      expect(ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params)).toEqual([{ key: 'sess-1' }])
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    })

    it('세션이 없으면 아무것도 반납하지 않는다', async () => {
      const hook = await mount()
      hook.unmount()
      await flush()
      expect(FakeWebSocket.instances).toHaveLength(0)
    })

    it('StrictMode 이중 마운트 뒤에도 정상 동작 — 소켓은 하나', async () => {
      const hook = renderHook(() => useHook('id-1'), { wrapper: StrictMode })
      await flush()
      await send(hook, 'hello')
      expect(FakeWebSocket.instances).toHaveLength(1)
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      ws.respond('sessions.send', { ok: true })
      act(() => { ws.emit(assistant('hi')) })

      expect(hook.result.current.error).toBeNull()
      expect(hook.result.current.isThinking).toBe(false)
      expect(hook.result.current.messages.map(m => m.content)).toEqual(['hello', 'hi'])
    })
  })

  it('id 가 없으면 디스크를 건드리지 않는다', async () => {
    const hook = await mount(null)
    await send(hook, 'hello')
    expect(append).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })
})
