// useDashboardClaw 특성화 테스트 — 계약표(gateway-hooks-contract.md)의 이 훅 열을 고정한다.
// transport 이전 전/후 구현이 같은 테스트를 통과해야 한다.

import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket, acceptSession } from '../test/fakeWebSocket'

// isElectron 가드가 모듈 로드 시점에 평가되므로 import 보다 먼저 심는다.
const twixy = vi.hoisted(() => {
  const twixy = { platform: 'win32', getGatewayToken: vi.fn(async () => 'tok') }
  Object.assign(window, { twixy })
  return twixy
})

import { useDashboardClaw } from './useDashboardClaw'

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

const assistant = (content: unknown) => ({ event: 'session.message', payload: { message: { role: 'assistant', content } } })

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useDashboardClaw>, unknown>>

// requestWidget 을 걸고 결과를 관찰 가능한 형태로 돌려준다 (미처리 rejection 방지).
async function request(hook: Hook, prompt: string) {
  const outcome: { value?: string; error?: string } = {}
  act(() => {
    hook.result.current.requestWidget(prompt).then(
      v => { outcome.value = v },
      e => { outcome.error = (e as Error).message },
    )
  })
  await flush()
  return outcome
}

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

describe('useDashboardClaw', () => {
  it('마운트만으로는 연결하지 않는다 — 첫 request 때 lazy', () => {
    const hook = renderHook(() => useDashboardClaw())
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(Object.keys(hook.result.current).sort()).toEqual(['busy', 'error', 'requestWidget'])
  })

  it('핸드셰이크 안에서 agentId 없는 세션 생성 → PREFIX 붙여 전송 → 첫 assistant 메시지로 resolve', async () => {
    const hook = renderHook(() => useDashboardClaw())
    const outcome = await request(hook, 'sales by month')
    const ws = FakeWebSocket.last
    expect(hook.result.current.busy).toBe(true)
    await acceptSession(ws, flush)

    expect(ws.sent.map(r => r.method)).toEqual(['connect', 'sessions.create', 'sessions.messages.subscribe', 'sessions.send'])
    expect((ws.sent[0].params.client as Record<string, unknown>).displayName).toBe('Twixy Dashboard')
    expect(ws.sent[1].params).toEqual({})
    const sent = ws.sent[3].params as { key: string; message: string }
    expect(sent.key).toBe('sess-1')
    expect(sent.message.startsWith('[TWIXY DASHBOARD — VISUALIZATION REQUEST]')).toBe(true)
    expect(sent.message.endsWith('Visualisation request: sales by month')).toBe(true)

    ws.respond('sessions.send', { ok: true })
    await flush()
    expect(outcome).toEqual({})   // send ACK 는 완료가 아니다

    act(() => { ws.emit(assistant([{ type: 'tool_use', name: 'read' }])) })   // 빈 텍스트는 무시
    act(() => { ws.emit(assistant('```widget-spec\n{}\n```')) })
    await flush()
    expect(outcome.value).toBe('```widget-spec\n{}\n```')
    expect(hook.result.current.busy).toBe(false)
    expect(hook.result.current.error).toBeNull()
  })

  it('PREFIX 는 매 요청마다 붙고, 두 번째 요청은 같은 소켓·세션을 쓴다', async () => {
    const hook = renderHook(() => useDashboardClaw())
    await request(hook, 'one')
    const ws = FakeWebSocket.last
    await acceptSession(ws, flush)
    ws.respond('sessions.send', { ok: true })
    act(() => { ws.emit(assistant('first')) })
    await flush()

    await request(hook, 'two')
    expect(FakeWebSocket.instances).toHaveLength(1)
    const second = ws.pendingReq('sessions.send')?.params as { message: string }
    expect(second.message.startsWith('[TWIXY DASHBOARD')).toBe(true)
    expect(second.message.endsWith('two')).toBe(true)
  })

  it('45초 안에 답이 없으면 timeout 으로 reject + error 상태', async () => {
    const hook = renderHook(() => useDashboardClaw())
    const outcome = await request(hook, 'slow')
    const ws = FakeWebSocket.last
    await acceptSession(ws, flush)
    ws.respond('sessions.send', { ok: true })

    await act(() => vi.advanceTimersByTimeAsync(44_999))
    expect(outcome).toEqual({})
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(outcome.error).toBe('AI response timed out (45s)')
    expect(hook.result.current.error).toBe('AI response timed out (45s)')
    expect(hook.result.current.busy).toBe(false)
  })

  it('응답 대기 중 소켓이 닫히면 "Connection closed" 로 reject, 다음 요청은 새로 연결', async () => {
    const hook = renderHook(() => useDashboardClaw())
    const outcome = await request(hook, 'one')
    const ws1 = FakeWebSocket.last
    await acceptSession(ws1, flush)
    ws1.respond('sessions.send', { ok: true })
    await flush()

    act(() => { ws1.close() })
    await flush()
    expect(outcome.error).toBe('Connection closed')

    await request(hook, 'two')
    expect(FakeWebSocket.last).not.toBe(ws1)
    expect(twixy.getGatewayToken).toHaveBeenCalledTimes(2)
  })

  // ── 계약표 #9 — 단일 슬롯 pendingResponse 가 겹친 요청에 덮어써지지 않는다 ──
  describe('requestWidget 이 겹칠 때 (#9)', () => {
    it('직렬화 — 앞 요청이 끝난 뒤에야 다음 메시지를 보내고, 답은 각자에게 간다', async () => {
      const hook = renderHook(() => useDashboardClaw())
      const first  = await request(hook, 'first')
      const second = await request(hook, 'second')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)

      // 세션 하나에 턴 하나만 — 두 번째 메시지는 아직 나가지 않았다.
      expect(ws.sent.filter(r => r.method === 'sessions.send')).toHaveLength(1)
      ws.respond('sessions.send', { ok: true })
      act(() => { ws.emit(assistant('answer-1')) })
      await flush()
      expect(first.value).toBe('answer-1')
      expect(second).toEqual({})
      expect(hook.result.current.busy).toBe(true)   // 아직 하나가 돌고 있다

      const sends = ws.sent.filter(r => r.method === 'sessions.send')
      expect(sends).toHaveLength(2)
      expect((sends[1].params.message as string).endsWith('second')).toBe(true)
      ws.respond('sessions.send', { ok: true })
      act(() => { ws.emit(assistant('answer-2')) })
      await flush()
      expect(second.value).toBe('answer-2')
      expect(hook.result.current.busy).toBe(false)
    })

    it('앞 요청의 45s timeout 이 뒤 요청을 죽이지 않는다', async () => {
      const hook = renderHook(() => useDashboardClaw())
      const first  = await request(hook, 'first')
      const second = await request(hook, 'second')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      ws.respond('sessions.send', { ok: true })

      await act(() => vi.advanceTimersByTimeAsync(45_000))
      expect(first.error).toBe('AI response timed out (45s)')
      expect(second).toEqual({})

      ws.respond('sessions.send', { ok: true })
      act(() => { ws.emit(assistant('answer-2')) })
      await flush()
      expect(second.value).toBe('answer-2')
    })

    it('이미 끝난 요청의 늦은 send 실패가 다음 요청의 슬롯을 지우지 않는다', async () => {
      const hook = renderHook(() => useDashboardClaw())
      const first = await request(hook, 'first')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      // first 의 sessions.send 는 ACK 되지 않은 채로 답이 먼저 도착
      act(() => { ws.emit(assistant('answer-1')) })
      await flush()
      expect(first.value).toBe('answer-1')

      const second = await request(hook, 'second')
      // second 의 send 만 ACK — first 의 send 는 끝내 응답이 없어 15s 뒤 timeout 난다.
      ws.emit({ type: 'res', id: ws.sent.filter(r => r.method === 'sessions.send')[1].id, ok: true })
      await act(() => vi.advanceTimersByTimeAsync(15_000))
      act(() => { ws.emit(assistant('answer-2')) })
      await flush()
      expect(second.value).toBe('answer-2')
    })
  })

  // ── 계약표 #12 — 언마운트 시 소켓·타이머 정리 ──
  describe('언마운트 정리 (#12)', () => {
    it('소켓을 닫고, 기다리던 요청을 reject 하며, 45s 타이머를 남기지 않는다', async () => {
      const hook = renderHook(() => useDashboardClaw())
      const outcome = await request(hook, 'one')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      ws.respond('sessions.send', { ok: true })
      await flush()

      hook.unmount()
      await flush()

      expect(outcome.error).toBe('Connection closed')
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
      expect([ws.onopen, ws.onmessage, ws.onerror, ws.onclose]).toEqual([null, null, null, null])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('언마운트 시 게이트웨이 세션을 반납한다 (소켓을 닫기 전에)', async () => {
      const hook = renderHook(() => useDashboardClaw())
      const outcome = await request(hook, 'one')
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      ws.respond('sessions.send', { ok: true })
      await flush()

      hook.unmount()
      await flush()
      expect(ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params)).toEqual([{ key: 'sess-1' }])
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
      expect(outcome.error).toBe('Connection closed')
    })

    it('큐에서 기다리던 요청은 언마운트 뒤 새 소켓을 열지 않고 reject 된다', async () => {
      const hook = renderHook(() => useDashboardClaw())
      const first  = await request(hook, 'first')
      const second = await request(hook, 'second')
      await acceptSession(FakeWebSocket.last, flush)

      hook.unmount()
      await flush()

      expect(first.error).toBe('Connection closed')
      expect(second.error).toBe('Connection closed')
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('StrictMode 이중 마운트 뒤에도 정상 동작 — 소켓은 하나', async () => {
      const hook = renderHook(() => useDashboardClaw(), { wrapper: StrictMode })
      const outcome = await request(hook, 'one')
      expect(FakeWebSocket.instances).toHaveLength(1)
      const ws = FakeWebSocket.last
      await acceptSession(ws, flush)
      ws.respond('sessions.send', { ok: true })
      act(() => { ws.emit(assistant('answer')) })
      await flush()
      expect(outcome.value).toBe('answer')
      expect(hook.result.current.busy).toBe(false)
    })
  })

  it('핸드셰이크 전 WS error → reject + error 상태', async () => {
    const hook = renderHook(() => useDashboardClaw())
    const outcome = await request(hook, 'x')
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(outcome.error).toBe('Dashboard WS error')
    expect(hook.result.current.error).toBe('Dashboard WS error')
    expect(hook.result.current.busy).toBe(false)
  })
})
