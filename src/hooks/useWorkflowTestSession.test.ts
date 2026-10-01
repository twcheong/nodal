// useWorkflowTestSession 특성화 테스트 — 계약표(gateway-hooks-contract.md)의 이 훅 열을 고정한다.
// transport 이전 전/후 구현이 같은 테스트를 통과해야 한다.

import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../test/fakeWebSocket'

// isElectron 가드가 모듈 로드 시점에 평가되므로 import 보다 먼저 심는다.
const twixy = vi.hoisted(() => {
  const twixy = {
    platform: 'win32',
    getGatewayToken: vi.fn(async () => 'tok'),
    browserSlotSet:  vi.fn(async () => ({ ok: true })),
  }
  Object.assign(window, { twixy })
  return twixy
})

import { useWorkflowTestSession } from './useWorkflowTestSession'

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

type Outcome<T> = { value?: T; error?: string }
function watch<T>(p: Promise<T>): Outcome<T> {
  const o: Outcome<T> = {}
  p.then(v => { o.value = v }, e => { o.error = (e as Error).message })
  return o
}

// sessions.usage 가 돌려줄 user-wide 누적 토큰 — 테스트가 turn 사이에 올린다.
let totals = { input: 0, cacheRead: 0, output: 0 }
let sessionSeq = 0

function mount(activeWorkflowId: string | null = 'wf-A') {
  return renderHook(({ id }: { id: string | null }) => useWorkflowTestSession(id), { initialProps: { id: activeWorkflowId } })
}
type Hook = ReturnType<typeof mount>

async function startSend(hook: Hook, workflowId: string, text: string, opts?: { timeoutMs?: number; displayText?: string }) {
  let out!: Outcome<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
  act(() => { out = watch(hook.result.current.sendAndAwaitFinal(workflowId, text, opts)) })
  await flush()
  return out
}

const keyed = (sessionKey: string | undefined) => (sessionKey ? { sessionKey } : {})
const chat = (sessionKey: string | undefined, state: string, extra: Record<string, unknown> = {}) =>
  ({ event: 'chat', payload: { ...keyed(sessionKey), state, ...extra } })
const assistant = (sessionKey: string | undefined, content: unknown, id?: string) =>
  ({ event: 'session.message', payload: { ...keyed(sessionKey), message: { role: 'assistant', content, ...(id ? { id } : {}) } } })
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
  totals = { input: 0, cacheRead: 0, output: 0 }
  sessionSeq = 0
  // 핸드셰이크·세션 생성·usage 는 배경 RPC — 자동 응답. sessions.send 는 테스트가 직접 다룬다.
  FakeWebSocket.autoChallenge = true
  FakeWebSocket.auto = {
    'connect':                     () => ({ ok: true }),
    'sessions.create':             () => ({ ok: true, payload: { key: `sess-${++sessionSeq}` } }),
    'sessions.messages.subscribe': () => ({ ok: true }),
    'sessions.send':               () => ({ ok: true }),
    'sessions.abort':              () => ({ ok: true }),
    'sessions.reset':              () => ({ ok: true }),
    'sessions.delete':             () => ({ ok: true }),
    'sessions.usage':              (req) => req.params.key
      ? { ok: true, payload: { totals: { totalCost: 0.12, input: 100, cacheRead: 20, output: 30 } } }
      : { ok: true, payload: { aggregates: { byModel: [{ model: 'test-model', totals: { ...totals } }] } } },
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useWorkflowTestSession', () => {
  it('마운트만으로는 연결하지 않는다 — 첫 send 때 lazy', async () => {
    const hook = mount()
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(hook.result.current.status).toBe('connecting')
    expect(Object.keys(hook.result.current).sort()).toEqual([
      'assignBrowserProfile', 'cancelTurn', 'contextUsage', 'destroyScope', 'fetchSessionUsage',
      'isThinking', 'messages', 'resetSession', 'sendAndAwaitFinal', 'status', 'toolActivity',
    ])
  })

  it('첫 send: 연결 → workflow-runner 세션 → usage 스냅샷 → send, chat final 로 resolve', async () => {
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'internal node prompt', { displayText: 'Step 1' })
    const ws = FakeWebSocket.last

    expect(ws.sent.map(r => r.method)).toEqual(
      ['connect', 'sessions.create', 'sessions.messages.subscribe', 'sessions.usage', 'sessions.send'])
    expect((ws.sent[0].params.client as Record<string, unknown>).displayName).toBe('Twixy Workflow Test')
    expect(ws.sent[1].params).toEqual({ agentId: 'workflow-runner' })
    expect(ws.sent[2].params).toEqual({ key: 'sess-1' })
    expect(ws.sent[4].params).toEqual({ key: 'sess-1', message: 'internal node prompt' })
    expect(hook.result.current.status).toBe('ready')
    expect(hook.result.current.isThinking).toBe(true)
    // displayText 만 화면에 — 내부 프롬프트는 새지 않는다.
    expect(hook.result.current.messages.map(m => [m.role, m.content])).toEqual([['user', 'Step 1']])
    expect(out).toEqual({})

    act(() => { ws.emit(tool('sess-1', 'start', 'browser')) })
    expect(hook.result.current.toolActivity).toEqual({ name: 'browser', isSubagent: false })
    act(() => { ws.emit(tool('sess-1', 'result', 'browser')) })
    expect(hook.result.current.toolActivity).toBeNull()
    act(() => { ws.emit(assistant('sess-1', [{ type: 'text', text: '[[x]] done' }], 'msg-1')) })
    expect(out).toEqual({})   // assistant 메시지만으로는 끝나지 않는다

    totals = { input: 1000, cacheRead: 200, output: 300 }
    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(out.value).toEqual({ text: 'done', messageId: 'msg-1', toolCalls: [{ name: 'browser' }] })
    expect(hook.result.current.isThinking).toBe(false)
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['Step 1', 'done'])
    // final 뒤 usage 를 다시 읽어 직전 스냅샷과의 delta 를 context 사용량으로.
    expect(hook.result.current.contextUsage).toMatchObject({ usedTokens: 1500, modelId: 'test-model' })
  })

  it('병렬 툴 호출 — 하나가 끝나도 남은 호출이 있으면 칩이 사라지지 않는다', async () => {
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'go')
    const ws = FakeWebSocket.last

    act(() => { ws.emit(tool('sess-1', 'start', 'exec', 'call-1')) })
    act(() => { ws.emit(tool('sess-1', 'start', 'read', 'call-2')) })
    expect(hook.result.current.toolActivity).toEqual({ name: 'read', isSubagent: false })
    // 먼저 시작한 호출이 끝나도 read 가 아직 돈다 — 이름으로 묶으면 여기서 칩이 사라진다.
    act(() => { ws.emit(tool('sess-1', 'result', 'exec', 'call-1')) })
    expect(hook.result.current.toolActivity).toEqual({ name: 'read', isSubagent: false })
    act(() => { ws.emit(tool('sess-1', 'result', 'read', 'call-2')) })
    expect(hook.result.current.toolActivity).toBeNull()

    // toolCalls 는 호출 단위로 한 번씩만 (update 프레임이 여러 번 와도).
    act(() => { ws.emit(tool('sess-1', 'start', 'exec', 'call-3')) })
    act(() => { ws.emit(tool('sess-1', 'update', 'exec', 'call-3')) })
    act(() => { ws.emit(tool('sess-1', 'update', 'exec', 'call-3')) })
    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(out.value?.toolCalls).toEqual([{ name: 'exec' }, { name: 'read' }, { name: 'exec' }])
  })

  it('턴이 끝나면 툴 추적도 초기화된다 — 다음 턴에 유령 칩이 남지 않는다', async () => {
    const hook = mount('wf-A')
    await startSend(hook, 'wf-A', 'one')
    const ws = FakeWebSocket.last
    act(() => { ws.emit(tool('sess-1', 'start', 'exec', 'call-1')) })   // result 없이 턴 종료
    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(hook.result.current.toolActivity).toBeNull()

    await startSend(hook, 'wf-A', 'two')
    expect(hook.result.current.toolActivity).toBeNull()
  })

  it('같은 workflowId 는 세션을 재사용하고, 동시 호출도 세션을 하나만 만든다 (create-lock)', async () => {
    const hook = mount('wf-A')
    act(() => { void hook.result.current.assignBrowserProfile('wf-A', 'wf-1') })
    const out = await startSend(hook, 'wf-A', 'one')
    const ws = FakeWebSocket.last
    expect(ws.sent.filter(r => r.method === 'sessions.create')).toHaveLength(1)
    expect(twixy.browserSlotSet).toHaveBeenCalledWith({ sessionKey: 'sess-1', profile: 'wf-1' })

    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(out.value?.text).toBe('')
    await startSend(hook, 'wf-A', 'two')
    expect(ws.sent.filter(r => r.method === 'sessions.create')).toHaveLength(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('assignBrowserProfile 해제 — 세션이 없으면 아무것도 하지 않는다', async () => {
    const hook = mount('wf-A')
    await act(() => hook.result.current.assignBrowserProfile('wf-A', null))
    expect(twixy.browserSlotSet).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('백그라운드 워크플로 run 은 화면을 뺏지 않고, 전환하면 그 버퍼가 복원된다', async () => {
    const hook = mount('wf-A')
    const bg = await startSend(hook, 'wf-B', 'background run', { displayText: 'B step' })
    const ws = FakeWebSocket.last
    expect(hook.result.current.messages).toEqual([])
    expect(hook.result.current.isThinking).toBe(false)

    act(() => { ws.emit(assistant('sess-1', 'B answer')) })
    expect(hook.result.current.messages).toEqual([])

    hook.rerender({ id: 'wf-B' })
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['B step', 'B answer'])
    expect(hook.result.current.isThinking).toBe(true)

    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(bg.value?.text).toBe('B answer')
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('sessionKey 없는 프레임은 무시한다 — 활성 세션으로 폴백하지 않는다 (#11)', async () => {
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'go')
    const ws = FakeWebSocket.last

    act(() => { ws.emit(tool(undefined, 'start', 'read')) })
    expect(hook.result.current.toolActivity).toBeNull()
    act(() => { ws.emit(assistant(undefined, 'keyless answer')) })
    act(() => { ws.emit(chat(undefined, 'final')) })
    await flush()
    expect(out).toEqual({})
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['go'])
    expect(hook.result.current.isThinking).toBe(true)

    // key 가 실린 프레임은 그대로 동작한다.
    act(() => { ws.emit(assistant('sess-1', 'real answer')) })
    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(out.value?.text).toBe('real answer')
  })

  it('우리가 만들지 않은 세션 key 의 프레임은 무시한다', async () => {
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'go')
    const ws = FakeWebSocket.last
    act(() => { ws.emit(assistant('someone-else', 'not mine')) })
    act(() => { ws.emit(chat('someone-else', 'final')) })
    await flush()
    expect(out).toEqual({})
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['go'])
  })

  it('chat error → 게이트웨이 메시지로 reject (없으면 chat_error)', async () => {
    const hook = mount('wf-A')
    const a = await startSend(hook, 'wf-A', 'one')
    const ws = FakeWebSocket.last
    act(() => { ws.emit(chat('sess-1', 'error', { error: { message: 'image input 404' } })) })
    await flush()
    expect(a.error).toBe('image input 404')
    expect(hook.result.current.isThinking).toBe(false)

    const b = await startSend(hook, 'wf-A', 'two')
    act(() => { ws.emit(chat('sess-1', 'error')) })
    await flush()
    expect(b.error).toBe('chat_error')
  })

  it('turn timeout — 기본 10분, opts.timeoutMs 로 override ("turn_timeout")', async () => {
    const hook = mount('wf-A')
    const slow = await startSend(hook, 'wf-A', 'slow')
    await act(() => vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1))
    expect(slow).toEqual({})
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(slow.error).toBe('turn_timeout')

    const quick = await startSend(hook, 'wf-A', 'quick', { timeoutMs: 5_000 })
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(quick.error).toBe('turn_timeout')
  })

  it('cancelTurn — 그 워크플로 세션만 abort + cancelled, 다른 run 은 그대로', async () => {
    const hook = mount('wf-A')
    const a = await startSend(hook, 'wf-A', 'A')
    const b = await startSend(hook, 'wf-B', 'B')
    const ws = FakeWebSocket.last

    await act(() => hook.result.current.cancelTurn('wf-A'))
    expect(ws.sent.filter(r => r.method === 'sessions.abort').map(r => r.params)).toEqual([{ key: 'sess-1' }])
    expect(a.error).toBe('cancelled')
    expect(b).toEqual({})
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('fetchSessionUsage — 그 세션 key 로만 집계, 세션이 없으면 null', async () => {
    const hook = mount('wf-A')
    expect(await hook.result.current.fetchSessionUsage('wf-A')).toBeNull()
    await startSend(hook, 'wf-A', 'go')
    let usage: unknown
    await act(async () => { usage = await hook.result.current.fetchSessionUsage('wf-A') })
    expect(usage).toEqual({ usd: 0.12, tokensIn: 120, tokensOut: 30 })
    expect(FakeWebSocket.last.sent.at(-1)?.params).toMatchObject({ key: 'sess-1', limit: 1 })
  })

  it('resetSession — 활성 세션에 sessions.reset, 화면·context 사용량 0 으로', async () => {
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'go')
    const ws = FakeWebSocket.last
    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(out.value).toBeDefined()

    await act(() => hook.result.current.resetSession())
    expect(ws.sent.find(r => r.method === 'sessions.reset')?.params).toEqual({ key: 'sess-1', reason: 'reset' })
    expect(hook.result.current.messages).toEqual([])
    expect(hook.result.current.contextUsage).toMatchObject({ usedTokens: 0, pct: 0 })
  })

  it('destroyScope — 접두사에 걸리는 세션만 삭제, 돌던 turn 은 cancelled', async () => {
    const hook = mount('conv1::wf-A')
    const mine  = await startSend(hook, 'conv1::wf-A', 'A')
    const other = await startSend(hook, 'conv2::wf-A', 'B')
    const ws = FakeWebSocket.last

    await act(() => hook.result.current.destroyScope('conv1::'))
    expect(ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params)).toEqual([{ key: 'sess-1' }])
    expect(mine.error).toBe('cancelled')
    expect(other).toEqual({})
    expect(hook.result.current.messages).toEqual([])
    expect(hook.result.current.isThinking).toBe(false)

    // 지워진 스코프로 다시 보내면 새 세션을 만든다.
    await startSend(hook, 'conv1::wf-A', 'again')
    expect(ws.sent.filter(r => r.method === 'sessions.create')).toHaveLength(3)
  })

  it('세션당 메시지 버퍼는 300개로 캡', async () => {
    const hook = mount('wf-A')
    await startSend(hook, 'wf-A', 'go')
    const ws = FakeWebSocket.last
    act(() => { for (let i = 0; i < 320; i++) ws.emit(assistant('sess-1', `m${i}`)) })
    expect(hook.result.current.messages).toHaveLength(300)
    expect(hook.result.current.messages.at(-1)?.content).toBe('m319')
  })

  it('소켓이 닫히면 awaiter 를 ws_closed 로 reject·status error, 다음 send 는 새 연결·새 세션', async () => {
    const hook = mount('wf-A')
    const a = await startSend(hook, 'wf-A', 'A')
    const ws1 = FakeWebSocket.last
    act(() => { ws1.close() })
    await flush()
    expect(a.error).toBe('ws_closed')
    expect(hook.result.current.status).toBe('error')
    expect(hook.result.current.isThinking).toBe(false)

    await startSend(hook, 'wf-A', 'again')
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    expect(ws2.sent.map(r => r.method)).toContain('sessions.create')
    expect(twixy.getGatewayToken).toHaveBeenCalledTimes(2)
    expect(hook.result.current.status).toBe('ready')
  })

  it('연결 실패 — WS error 문구로 reject·status error, 세션은 만들지 않는다', async () => {
    FakeWebSocket.autoChallenge = false
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'go')
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(out.error).toBe('Workflow test WS error')
    expect(hook.result.current.status).toBe('error')
    expect(FakeWebSocket.last.sent).toEqual([])
  })

  it('auth 거절 — 게이트웨이 메시지로 reject·status error', async () => {
    FakeWebSocket.auto['connect'] = () => ({ ok: false, error: { message: 'bad token' } })
    const hook = mount('wf-A')
    const out = await startSend(hook, 'wf-A', 'go')
    expect(out.error).toBe('bad token')
    expect(hook.result.current.status).toBe('error')
  })

  it('언마운트 시 살아 있는 세션을 전부 반납한다 (소켓을 닫기 전에)', async () => {
    const hook = mount('wf-A')
    await startSend(hook, 'wf-A', 'A')
    await startSend(hook, 'wf-B', 'B')
    const ws = FakeWebSocket.last

    hook.unmount()
    await flush()
    expect(ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params))
      .toEqual([{ key: 'sess-1' }, { key: 'sess-2' }])
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('언마운트 시 소켓을 닫고 대기 중 awaiter 를 ws_closed 로 깨운다', async () => {
    const hook = mount('wf-A')
    const a = await startSend(hook, 'wf-A', 'A')
    const ws = FakeWebSocket.last
    hook.unmount()
    await flush()
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect(a.error).toBe('ws_closed')
  })
})

// ── 계약표 #10 의 쌍둥이 — 이 훅도 send 실패 경로에서 queue.pop() 으로 "맨 뒤" awaiter 를 버렸다 ──
describe('useWorkflowTestSession — send 실패 경로 (#10)', () => {
  it('뒤 turn 의 send RPC 실패가 같은 세션의 다른 turn awaiter 를 버리지 않는다', async () => {
    const hook = mount('wf-A')
    const first = await startSend(hook, 'wf-A', 'node prompt')
    const ws = FakeWebSocket.last
    // 두 번째 turn(예: note 주입)은 ACK 가 끝내 안 온다.
    FakeWebSocket.auto['sessions.send'] = () => null
    const second = await startSend(hook, 'wf-A', 'note', { timeoutMs: 5_000 })
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(second.error).toBe('RPC timeout: sessions.send')
    expect(first).toEqual({})
    expect(hook.result.current.isThinking).toBe(true)   // first 가 아직 돈다

    act(() => { ws.emit(assistant('sess-1', 'r1')) })
    act(() => { ws.emit(chat('sess-1', 'final')) })
    await flush()
    expect(first.value?.text).toBe('r1')
  })
})

// transport 이전으로 생긴 보장 — 옛 구현은 connect 거절 뒤 lock 이 남아(#1) 재시도가 같은 거절을 받았다.
describe('useWorkflowTestSession — transport 이전 후', () => {
  it('연결 실패 뒤 다음 send 는 새로 시도해 성공한다 (#1)', async () => {
    FakeWebSocket.autoChallenge = false
    const hook = mount('wf-A')
    const first = await startSend(hook, 'wf-A', 'go')
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(first.error).toBe('Workflow test WS error')

    FakeWebSocket.autoChallenge = true
    const second = await startSend(hook, 'wf-A', 'again')
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(hook.result.current.status).toBe('ready')
    act(() => { FakeWebSocket.last.emit(chat('sess-1', 'final')) })
    await flush()
    expect(second.value).toBeDefined()
  })

  it('StrictMode 이중 마운트 뒤에도 정상 동작 — 소켓은 하나', async () => {
    const hook = renderHook(() => useWorkflowTestSession('wf-A'), { wrapper: StrictMode })
    let out!: Outcome<{ text: string }>
    act(() => { out = watch(hook.result.current.sendAndAwaitFinal('wf-A', 'go')) })
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    act(() => { FakeWebSocket.last.emit(assistant('sess-1', 'ok')) })
    act(() => { FakeWebSocket.last.emit(chat('sess-1', 'final')) })
    await flush()
    expect(out.value?.text).toBe('ok')
    expect(hook.result.current.status).toBe('ready')
  })
})
