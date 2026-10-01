// useCopilotChat 특성화 테스트 — 계약표(gateway-hooks-contract.md)의 이 훅 열을 고정한다.
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
vi.mock('../lib/copilotSoul', () => ({ getCopilotSoul: () => 'COPILOT_SOUL', getSimpleSoul: () => 'SIMPLE_SOUL' }))
vi.mock('../lib/contentSoul', () => ({ getContentSoul: () => 'CONTENT_SOUL' }))

import { useCopilotChat, type CopilotMode } from './useCopilotChat'
import { registerCopilotMode } from '../lib/copilotModes'
import { PRODUCT } from '../lib/product'

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))
const NO_WORKFLOWS: TwixyWorkflow[] = []

let sessionSeq = 0
const onAssistant = vi.fn()

function mount() {
  return renderHook(() => useCopilotChat(NO_WORKFLOWS, onAssistant))
}
type Hook = ReturnType<typeof mount>

async function send(hook: Hook, text: string, opts?: Parameters<Hook['result']['current']['sendMessage']>[1]) {
  act(() => { void hook.result.current.sendMessage(text, opts) })
  await flush()
}

// 새 대화를 열고 첫 메시지를 보낸다 → 그 대화 id.
async function newChat(hook: Hook, text: string, mode?: CopilotMode) {
  act(() => { hook.result.current.newConversation() })
  if (mode) act(() => { hook.result.current.setMode(mode) })
  await send(hook, text)
  return hook.result.current.activeConvId!
}

const sends = (ws: FakeWebSocket) => ws.sent.filter(r => r.method === 'sessions.send').map(r => r.params as { key: string; message: string })
const creates = (ws: FakeWebSocket) => ws.sent.filter(r => r.method === 'sessions.create').map(r => r.params)
const deletes = (ws: FakeWebSocket) => ws.sent.filter(r => r.method === 'sessions.delete').map(r => r.params)

const assistant = (sessionKey: string | undefined, content: unknown) =>
  ({ event: 'session.message', payload: { ...(sessionKey ? { sessionKey } : {}), message: { role: 'assistant', content } } })
const chat = (sessionKey: string | undefined, state: string, extra: Record<string, unknown> = {}) =>
  ({ event: 'chat', payload: { ...(sessionKey ? { sessionKey } : {}), state, ...extra } })
// 답하고 턴을 끝낸다 — 게이트웨이는 메시지 뒤에 chat final 을 보낸다. thinking 은 final 이 내린다.
const reply = (ws: FakeWebSocket, sessionKey: string, content: unknown) => { ws.emit(assistant(sessionKey, content)); ws.emit(chat(sessionKey, 'final')) }
// 툴 활동은 `agent` 의 tool 스트림으로 온다 ('tool-events' cap 선언 연결에만).
// 예전 session.tool 은 전역 sessions.subscribe 연결에만 가므로 이 훅엔 온 적이 없다.
const tool = (sessionKey: string, phase: string, name: string, toolCallId = `call-${name}`) =>
  ({ event: 'agent', payload: { sessionKey, stream: 'tool', runId: 'run-1', data: { phase, name, toolCallId } } })

const storedMsgs = (convId: string) =>
  (JSON.parse(localStorage.getItem(`twixy.copilot.msgs.${convId}`) ?? '[]') as Array<{ role: string; content: string }>).map(m => [m.role, m.content])

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.clearAllMocks()
  localStorage.clear()
  sessionSeq = 0
  FakeWebSocket.autoChallenge = true
  FakeWebSocket.auto = {
    'connect':                     () => ({ ok: true }),
    'sessions.create':             () => ({ ok: true, payload: { key: `sess-${++sessionSeq}` } }),
    'sessions.messages.subscribe': () => ({ ok: true }),
    'sessions.patch':              () => ({ ok: true }),
    'sessions.send':               () => ({ ok: true }),
    'sessions.abort':              () => ({ ok: true }),
    'sessions.delete':             () => ({ ok: true }),
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useCopilotChat', () => {
  it('마운트만으로는 연결하지 않는다 — 첫 send 때 lazy, 새 탭으로 시작', () => {
    const hook = mount()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(hook.result.current.activeConvId).toBeNull()
    expect(Object.keys(hook.result.current).sort()).toEqual([
      'abortActive', 'activeConvId', 'activeMode', 'activityLog', 'archiveConversation', 'cancelSilentTurn',
      'conversations', 'deleteConversation', 'error', 'isThinking', 'liveReply', 'messages', 'messagesFor', 'newConversation',
      'selectConversation', 'sendMessage', 'setConversationWorkflow', 'setMode', 'startConversation',
      'thinkingConvs', 'toolActivity',
    ])
  })

  it('첫 send (wf): 대화 lazy 생성·영속 → builder 세션 → COPILOT_SOUL + 카탈로그 + 텍스트', async () => {
    const hook = mount()
    await send(hook, ' hello ')
    const ws = FakeWebSocket.last
    const convId = hook.result.current.activeConvId!

    // 추론 스트림을 켠다 (sessions.patch) — 응답을 기다리지 않으므로 send 와 순서만 고정한다.
    expect(ws.sent.map(r => r.method)).toEqual(['connect', 'sessions.create', 'sessions.messages.subscribe', 'sessions.patch', 'sessions.send'])
    expect(ws.sent.find(r => r.method === 'sessions.patch')?.params).toEqual({ key: 'sess-1', reasoningLevel: 'stream' })
    expect((ws.sent[0].params.client as Record<string, unknown>).displayName).toBe(`${PRODUCT.displayName} Copilot`)
    expect(ws.sent[0].params.auth).toEqual({ token: 'tok' })
    expect(creates(ws)).toEqual([{ agentId: 'builder' }])
    const body = sends(ws)[0]
    expect(body.key).toBe('sess-1')
    expect(body.message.startsWith('COPILOT_SOUL\n\n---\n\n[Available workflows')).toBe(true)
    expect(body.message.endsWith('hello')).toBe(true)

    expect(hook.result.current.conversations.map(c => [c.id, c.title, c.mode])).toEqual([[convId, 'hello', 'wf']])
    expect(hook.result.current.messages.map(m => [m.role, m.content])).toEqual([['user', 'hello']])
    expect(hook.result.current.isThinking).toBe(true)
    expect(storedMsgs(convId)).toEqual([['user', 'hello']])
    expect(JSON.parse(localStorage.getItem('twixy.copilot.conversations')!)[0].id).toBe(convId)
  })

  it('턴 중에 쓰이는 답장·추론을 liveReply 로 보여주고, 메시지가 붙으면 그만큼 빼고, 턴이 끝나면 비운다', async () => {
    const hook = mount()
    await send(hook, 'hello')
    const ws = FakeWebSocket.last
    const delta = (text: string) => chat('sess-1', 'delta', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
    expect(hook.result.current.liveReply).toBeNull()

    act(() => { ws.emit({ event: 'agent', payload: { sessionKey: 'sess-1', stream: 'thinking', data: { text: 'Reasoning:\n_무대부터_' } } }) })
    expect(hook.result.current.liveReply).toEqual({ text: '', thinking: '무대부터' })
    act(() => { ws.emit(delta('배경을 먼저')) })
    expect(hook.result.current.liveReply).toEqual({ text: '배경을 먼저', thinking: '무대부터' })

    act(() => { ws.emit(assistant('sess-1', [{ type: 'text', text: '배경을 먼저' }])) })
    expect(hook.result.current.liveReply).toBeNull()                 // 정식 메시지가 됐다
    act(() => { ws.emit(delta('배경을 먼저\n\n결과를 기다리') ) })
    expect(hook.result.current.liveReply?.text).toBe('결과를 기다리')   // 같은 턴의 다음 말만

    act(() => { ws.emit(chat('sess-1', 'final')) })
    expect(hook.result.current.liveReply).toBeNull()
  })

  it('침묵 턴의 답장은 쓰이는 중에도 보이지 않는다', async () => {
    const hook = mount()
    await send(hook, 'first')
    await send(hook, 'check the deck', { silent: true })
    act(() => { FakeWebSocket.last.emit(chat('sess-1', 'delta', { message: { role: 'assistant', content: [{ type: 'text', text: 'internal' }] } })) })
    expect(hook.result.current.liveReply).toBeNull()
  })

  it('두 번째 send 는 같은 세션에 SOUL 없이 (카탈로그는 매번), displayText 는 말풍선에만', async () => {
    const hook = mount()
    await send(hook, 'one')
    await send(hook, 'two + hidden', { displayText: 'two' })
    const ws = FakeWebSocket.last
    expect(creates(ws)).toHaveLength(1)
    expect(sends(ws)[1].message.startsWith('[Available workflows')).toBe(true)
    expect(sends(ws)[1].message.endsWith('two + hidden')).toBe(true)
    expect(hook.result.current.messages.at(-1)?.content).toBe('two')
  })

  it('assistant 메시지 → 그 대화에 append·onAssistantMessage(convId, msg, mode), thinking 은 턴이 끝날 때(final) 해제', async () => {
    const hook = mount()
    await send(hook, 'hello')
    const ws = FakeWebSocket.last
    const convId = hook.result.current.activeConvId!
    act(() => { ws.emit(assistant('sess-1', [{ type: 'text', text: '[[x]] hi there' }])) })

    expect(hook.result.current.messages.map(m => [m.role, m.content])).toEqual([['user', 'hello'], ['assistant', 'hi there']])
    // 메시지 하나로는 턴이 안 끝난다 — 같은 턴에 툴·다음 말이 이어질 수 있다.
    expect(hook.result.current.isThinking).toBe(true)
    act(() => { ws.emit(chat('sess-1', 'final')) })
    expect(hook.result.current.isThinking).toBe(false)
    expect(onAssistant).toHaveBeenCalledWith(convId, expect.objectContaining({ role: 'assistant', content: 'hi there' }), 'wf')
    expect(storedMsgs(convId)).toEqual([['user', 'hello'], ['assistant', 'hi there']])
  })

  it('백그라운드 대화의 답은 frame key 로 라우팅돼 자기 대화에만 붙는다', async () => {
    const hook = mount()
    const a = await newChat(hook, 'A question')
    const b = await newChat(hook, 'B question')
    const ws = FakeWebSocket.last
    expect(hook.result.current.activeConvId).toBe(b)
    expect([...hook.result.current.thinkingConvs].sort()).toEqual([a, b].sort())

    act(() => { reply(ws, 'sess-1', 'A answer') })
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['B question'])
    expect(storedMsgs(a)).toEqual([['user', 'A question'], ['assistant', 'A answer']])
    expect(hook.result.current.messagesFor(a).map(m => m.content)).toEqual(['A question', 'A answer'])
    expect([...hook.result.current.thinkingConvs]).toEqual([b])
    expect(hook.result.current.isThinking).toBe(true)

    act(() => { hook.result.current.selectConversation(a) })
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['A question', 'A answer'])
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('sessionKey 없는 session.message 는 무시한다 — 활성 대화로 폴백하지 않는다 (#4)', async () => {
    const hook = mount()
    const a = await newChat(hook, 'A question')
    const b = await newChat(hook, 'B question')
    act(() => { FakeWebSocket.last.emit(assistant(undefined, 'keyless answer')) })
    expect(storedMsgs(b)).toEqual([['user', 'B question']])
    expect(storedMsgs(a)).toEqual([['user', 'A question']])
    expect(onAssistant).not.toHaveBeenCalled()
    // 완료 신호가 아니므로 thinking 도 내리지 않는다.
    expect(hook.result.current.isThinking).toBe(true)
  })

  it('evict/삭제로 장부에서 사라진 세션의 늦은 답장도 화면의 대화에 붙지 않는다 (#4)', async () => {
    const hook = mount()
    const first = await newChat(hook, 'conv 1')
    const ws = FakeWebSocket.last
    // 캡(3)을 넘겨 sess-1 을 evict — 게이트웨이 세션은 살아 있을 수 있다(삭제는 best-effort).
    for (let i = 1; i <= 3; i++) {
      act(() => { reply(ws, `sess-${i}`, `answer ${i}`) })
      await newChat(hook, `conv ${i + 1}`)
    }
    expect(deletes(ws)).toEqual([{ key: 'sess-1' }])
    const active = hook.result.current.activeConvId!

    act(() => { ws.emit(assistant('sess-1', 'late answer')) })
    expect(storedMsgs(active)).toEqual([['user', 'conv 4']])
    expect(storedMsgs(first)).toEqual([['user', 'conv 1'], ['assistant', 'answer 1']])
  })

  it('chat final/error 는 convByKey 로 라우팅 — error 는 실패 안내를 남기고, 모르는 key 는 무시', async () => {
    const hook = mount()
    const convId = await newChat(hook, 'hello')
    const ws = FakeWebSocket.last

    act(() => { ws.emit(chat('someone-else', 'error', { error: { message: 'x' } })) })
    act(() => { ws.emit(chat(undefined, 'final')) })
    expect(hook.result.current.isThinking).toBe(true)

    act(() => { ws.emit(chat('sess-1', 'final')) })
    expect(hook.result.current.isThinking).toBe(false)

    await send(hook, 'again')
    act(() => { ws.emit(chat('sess-1', 'error', { error: { message: 'image input 404' } })) })
    expect(hook.result.current.isThinking).toBe(false)
    expect(storedMsgs(convId).at(-1)).toEqual(
      ['assistant', '⚠️ The turn failed: image input 404. You can send a follow-up message to continue.'])
  })

  it('agent/tool → 그 대화의 toolActivity·activityLog (result 에서 해제)', async () => {
    const hook = mount()
    await send(hook, 'hello')
    const ws = FakeWebSocket.last
    act(() => { ws.emit(tool('sess-1', 'start', 'browser')) })
    expect(hook.result.current.toolActivity).toBe('browser')
    expect(hook.result.current.activityLog).toEqual(['▸ browser'])
    act(() => { ws.emit(tool('sess-1', 'result', 'browser')) })
    expect(hook.result.current.toolActivity).toBeNull()
  })

  it('세션은 대화×모드별 — 모드를 바꾸면 그 모드의 SOUL + 트랜스크립트 seed 로 새 세션, 돌아오면 이어진다', async () => {
    const hook = mount()
    await send(hook, 'plan my week')
    const ws = FakeWebSocket.last
    act(() => { reply(ws, 'sess-1', 'wf answer') })

    act(() => { hook.result.current.setMode('simple') })
    await flush()
    expect(hook.result.current.activeMode).toBe('simple')
    await send(hook, 'do it now')
    expect(creates(ws)).toEqual([{ agentId: 'builder' }, { agentId: 'builder' }])
    const simple = sends(ws)[1]
    expect(simple.key).toBe('sess-2')
    expect(simple.message.startsWith('SIMPLE_SOUL\n\n---\n\n')).toBe(true)
    expect(simple.message).toContain('User: plan my week')
    expect(simple.message).toContain('Assistant: wf answer')
    expect(simple.message.endsWith('[Current user request — THIS is the task and it OVERRIDES all background context above]\ndo it now')).toBe(true)
    expect(simple.message).not.toContain('[Available workflows')

    act(() => { hook.result.current.setMode('content') })
    await flush()
    await send(hook, 'make a deck', { contextPrelude: 'OUTLINE' })
    expect(sends(ws)[2].key).toBe('sess-3')
    expect(sends(ws)[2].message.startsWith('CONTENT_SOUL\n\n---\n\n')).toBe(true)
    expect(sends(ws)[2].message.endsWith('OUTLINE\nmake a deck')).toBe(true)

    act(() => { hook.result.current.setMode('wf') })
    await flush()
    await send(hook, 'back to wf')
    expect(creates(ws)).toHaveLength(3)
    expect(sends(ws)[3].key).toBe('sess-1')
    expect(sends(ws)[3].message.startsWith('[Available workflows')).toBe(true)
  })

  it('라이브 세션은 3개 캡 — 넘으면 가장 오래된 유휴 세션을 sessions.delete, 그 대화는 다음 전송에 seed 로 복원', async () => {
    const hook = mount()
    const first = await newChat(hook, 'conv 1')
    const ws = FakeWebSocket.last
    // thinking 중인 대화는 evict 대상이 아니다 — 답을 받아 유휴로 만든다.
    for (let i = 1; i <= 3; i++) {
      act(() => { reply(ws, `sess-${i}`, `answer ${i}`) })
      await newChat(hook, `conv ${i + 1}`)
    }
    expect(creates(ws)).toHaveLength(4)
    expect(deletes(ws)).toEqual([{ key: 'sess-1' }])

    act(() => { reply(ws, 'sess-4', 'answer 4') })
    act(() => { hook.result.current.selectConversation(first) })
    await send(hook, 'conv 1 again')
    expect(creates(ws)).toHaveLength(5)
    const resumed = sends(ws).at(-1)!
    expect(resumed.key).toBe('sess-5')
    expect(resumed.message.startsWith('COPILOT_SOUL\n\n---\n\n[Previous conversation transcript')).toBe(true)
    expect(resumed.message).toContain('Assistant: answer 1')
  })

  it('침묵 턴 — 보낸 것도 받은 것도 전사에 없고, 구독자에게는 전달된다. 다음 답장은 정상', async () => {
    const hook = mount()
    const convId = await newChat(hook, 'make a deck')
    const ws = FakeWebSocket.last
    act(() => { ws.emit(assistant('sess-1', 'deck v1')) })
    onAssistant.mockClear()

    await send(hook, 'internal layout check', { silent: true })
    expect(sends(ws).at(-1)!.message.endsWith('internal layout check')).toBe(true)
    act(() => { ws.emit(assistant('sess-1', 'deck v2 (fixed)')) })
    expect(storedMsgs(convId)).toEqual([['user', 'make a deck'], ['assistant', 'deck v1']])
    expect(onAssistant).toHaveBeenCalledTimes(1)

    act(() => { ws.emit(assistant('sess-1', 'a real reply')) })
    expect(storedMsgs(convId).at(-1)).toEqual(['assistant', 'a real reply'])
  })

  it('소켓이 닫히면 장부·thinking 을 리셋하고, 다음 send 는 새 연결·새 세션·SOUL+seed 재주입', async () => {
    const hook = mount()
    await send(hook, 'hello')
    const ws1 = FakeWebSocket.last
    act(() => { ws1.emit(assistant('sess-1', 'hi')) })
    await send(hook, 'second')
    expect(hook.result.current.isThinking).toBe(true)

    act(() => { ws1.close() })
    await flush()
    expect(hook.result.current.isThinking).toBe(false)
    expect(hook.result.current.thinkingConvs.size).toBe(0)

    await send(hook, 'third')
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    expect(twixy.getGatewayToken).toHaveBeenCalledTimes(2)
    expect(creates(ws2)).toEqual([{ agentId: 'builder' }])
    expect(sends(ws2)[0].message.startsWith('COPILOT_SOUL\n\n---\n\n[Previous conversation transcript')).toBe(true)
    expect(sends(ws2)[0].message).toContain('Assistant: hi')
  })

  it('abortActive — 활성 대화의 현재 모드 세션에 sessions.abort, thinking 해제', async () => {
    const hook = mount()
    await send(hook, 'hello')
    await act(() => hook.result.current.abortActive())
    expect(FakeWebSocket.last.sent.filter(r => r.method === 'sessions.abort').map(r => r.params)).toEqual([{ key: 'sess-1' }])
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('deleteConversation — 기록·영속 데이터·그 대화의 모든 모드 세션(content 포함)을 정리한다', async () => {
    const hook = mount()
    const convId = await newChat(hook, 'wf msg')
    const ws = FakeWebSocket.last
    act(() => { hook.result.current.setMode('content') })
    await flush()
    await send(hook, 'content msg')
    expect(creates(ws)).toHaveLength(2)

    act(() => { hook.result.current.deleteConversation(convId) })
    await flush()
    expect(deletes(ws)).toEqual([{ key: 'sess-1' }, { key: 'sess-2' }])
    expect(hook.result.current.conversations).toEqual([])
    expect(hook.result.current.activeConvId).toBeNull()
    expect(localStorage.getItem(`twixy.copilot.msgs.${convId}`)).toBeNull()
  })

  it('archiveConversation 은 삭제가 아니다 — 세션을 건드리지 않고 탭만 닫는다', async () => {
    const hook = mount()
    const convId = await newChat(hook, 'hello')
    act(() => { hook.result.current.archiveConversation(convId) })
    expect(hook.result.current.activeConvId).toBeNull()
    expect(hook.result.current.conversations[0].archivedAt).toEqual(expect.any(Number))
    expect(deletes(FakeWebSocket.last)).toEqual([])
  })

  it('연결 실패 → error 상태 + thinking 해제 ("Copilot WS error")', async () => {
    FakeWebSocket.autoChallenge = false
    const hook = mount()
    await send(hook, 'hello')
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(hook.result.current.error).toBe('Copilot WS error')
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('세션 생성 실패 → "Session create failed"', async () => {
    FakeWebSocket.auto['sessions.create'] = () => ({ ok: false, error: { message: 'nope' } })
    const hook = mount()
    await send(hook, 'hello')
    expect(hook.result.current.error).toBe('Session create failed')
    expect(hook.result.current.isThinking).toBe(false)
  })

  it('RPC 는 send 포함 15s 고정 — ACK 가 없으면 timeout 으로 error', async () => {
    delete FakeWebSocket.auto['sessions.send']
    const hook = mount()
    await send(hook, 'hello')
    await act(() => vi.advanceTimersByTimeAsync(14_999))
    expect(hook.result.current.error).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(hook.result.current.error).toBe('RPC timeout: sessions.send')
    expect(hook.result.current.isThinking).toBe(false)
  })
})

// ── 계약표 #2 — create-lock 을 읽는 key 와 쓰는 key 가 달라 직렬화가 작동하지 않았다 ──
describe('useCopilotChat — 세션 생성 직렬화 (#2)', () => {
  it('같은 대화×모드로 동시에 두 번 보내도 세션은 하나만 만든다', async () => {
    const hook = mount()
    act(() => { hook.result.current.startConversation('deck') })
    // 실제 경로: 사용자의 전송과 앱이 쓰는 침묵 턴(덱 자동 검증)이 같은 틱에 겹친다.
    act(() => {
      void hook.result.current.sendMessage('make a deck')
      void hook.result.current.sendMessage('internal layout check', { silent: true })
    })
    await flush()
    const ws = FakeWebSocket.last
    expect(creates(ws)).toHaveLength(1)
    expect(sends(ws).map(s => s.key)).toEqual(['sess-1', 'sess-1'])
  })

  it('같은 대화의 다른 모드는 서로의 lock 을 건드리지 않고 각자 세션을 만든다', async () => {
    const hook = mount()
    await send(hook, 'wf msg')
    act(() => { hook.result.current.setMode('simple') })
    await flush()
    await send(hook, 'simple msg')
    expect(creates(FakeWebSocket.last)).toHaveLength(2)
    expect(sends(FakeWebSocket.last).map(s => s.key)).toEqual(['sess-1', 'sess-2'])
  })
})

// ── 계약표 #3 — deleteConversation 이 모드 목록을 하드코딩해, 목록에 없는 모드의 세션이 남았다 ──
describe('useCopilotChat — deleteConversation 은 그 대화의 모든 세션을 반납한다 (#3)', () => {
  it('제품 프로필 목록에 없는 등록 모드의 세션도 sessions.delete 된다', async () => {
    // 모드의 출처는 둘이다 — registerCopilotMode 레지스트리와 PRODUCT.features.copilotModes.
    // 테스트 빌드는 twixy 프로필(simple/wf/content)이라 'video' 는 목록에 없다.
    registerCopilotMode({
      id: 'video', label: 'Video', title: '', hint: '', placeholder: '', agentId: 'main',
      buildBody: ({ text }) => text,
    })
    const hook = mount()
    const convId = await newChat(hook, 'animate this', 'video')
    const ws = FakeWebSocket.last
    expect(creates(ws)).toEqual([{ agentId: 'main' }])

    act(() => { hook.result.current.deleteConversation(convId) })
    await flush()
    expect(deletes(ws)).toEqual([{ key: 'sess-1' }])

    // 장부도 비었다 — 뒤늦게 온 그 세션의 프레임은 어느 대화에도 붙지 않는다.
    act(() => { ws.emit(chat('sess-1', 'error', { error: { message: 'late' } })) })
    expect(localStorage.getItem(`twixy.copilot.msgs.${convId}`)).toBeNull()
  })
})

// ── 계약표 #12 — 언마운트 cleanup 이 없어 소켓·RPC 타이머가 남았다 ──
describe('useCopilotChat — 언마운트 정리 (#12)', () => {
  it('소켓을 닫고 핸들러·타이머를 남기지 않으며, 이후 프레임은 어느 대화에도 붙지 않는다', async () => {
    delete FakeWebSocket.auto['sessions.send']   // send RPC 가 떠 있는 채로 언마운트
    const hook = mount()
    const convId = await newChat(hook, 'hello')
    const ws = FakeWebSocket.last
    const staleHandler = ws.onmessage!
    onAssistant.mockClear()

    hook.unmount()
    await flush()

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect([ws.onopen, ws.onmessage, ws.onerror, ws.onclose]).toEqual([null, null, null, null])
    expect(vi.getTimerCount()).toBe(0)
    staleHandler({ data: JSON.stringify(assistant('sess-1', 'too late')) })
    expect(storedMsgs(convId)).toEqual([['user', 'hello']])
    expect(onAssistant).not.toHaveBeenCalled()
  })

  it('언마운트 시 살아 있는 세션을 전부 반납한다 (소켓을 닫기 전에)', async () => {
    const hook = mount()
    await newChat(hook, 'wf msg')
    const ws = FakeWebSocket.last
    act(() => { hook.result.current.setMode('content') })
    await flush()
    await send(hook, 'content msg')
    expect(creates(ws)).toHaveLength(2)

    hook.unmount()
    await flush()
    expect(deletes(ws)).toEqual([{ key: 'sess-1' }, { key: 'sess-2' }])
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('StrictMode 이중 마운트 뒤에도 정상 동작 — 소켓은 하나', async () => {
    const hook = renderHook(() => useCopilotChat(NO_WORKFLOWS, onAssistant), { wrapper: StrictMode })
    act(() => { void hook.result.current.sendMessage('hello') })
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.last
    expect(creates(ws)).toHaveLength(1)
    act(() => { reply(ws, 'sess-1', 'hi') })
    expect(hook.result.current.error).toBeNull()
    expect(hook.result.current.isThinking).toBe(false)
    expect(hook.result.current.messages.map(m => m.content)).toEqual(['hello', 'hi'])
  })
})

// transport 이전으로 생긴 보장 — 옛 구현은 connect 거절 뒤 lock 이 남아(#1) 재시도가 같은 거절을 받았다.
describe('useCopilotChat — transport 이전 후', () => {
  it('연결 실패 뒤 다음 send 는 새로 시도해 성공한다 (#1)', async () => {
    FakeWebSocket.autoChallenge = false
    const hook = mount()
    await send(hook, 'hello')
    act(() => { FakeWebSocket.last.error() })
    await flush()
    expect(hook.result.current.error).toBe('Copilot WS error')

    FakeWebSocket.autoChallenge = true
    await send(hook, 'hello again')
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(hook.result.current.error).toBeNull()
    expect(sends(FakeWebSocket.last)).toHaveLength(1)
  })
})
