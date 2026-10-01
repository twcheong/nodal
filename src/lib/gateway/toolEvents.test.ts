// 툴 이벤트 파서·추적기 계약. 페이로드 모양은 번들(openclaw dist)의 emit 지점과
// 패키지 앱 실측 프레임에서 확인한 것을 고정한다.

import { describe, it, expect } from 'vitest'
import { parseAgentToolFrame, ToolCallTracker, TOOL_EVENTS_CAP } from './toolEvents'

const frame = (data: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  event: 'agent',
  payload: { stream: 'tool', runId: 'run-1', seq: 1, sessionKey: 'sess-1', data, ...over },
})

describe('parseAgentToolFrame', () => {
  it('start — 이름은 name, 상관키는 toolCallId', () => {
    expect(parseAgentToolFrame(frame({ phase: 'start', name: 'exec', toolCallId: 'call-1', args: { a: 1 } })))
      .toEqual({ sessionKey: 'sess-1', toolCallId: 'call-1', name: 'exec', phase: 'start' })
  })

  it('update — partialResult 가 없어도(게이트웨이가 지운다) 파싱된다', () => {
    expect(parseAgentToolFrame(frame({ phase: 'update', name: 'exec', toolCallId: 'call-1' })))
      .toMatchObject({ phase: 'update', name: 'exec', toolCallId: 'call-1' })
  })

  it('result — isError 를 살려 온다 (실패한 툴 호출 구분)', () => {
    expect(parseAgentToolFrame(frame({ phase: 'result', name: 'exec', toolCallId: 'call-1', isError: true, meta: {} })))
      .toEqual({ sessionKey: 'sess-1', toolCallId: 'call-1', name: 'exec', phase: 'result', isError: true })
    expect(parseAgentToolFrame(frame({ phase: 'result', name: 'exec', toolCallId: 'call-1', isError: false })))
      .toMatchObject({ isError: false })
  })

  it('툴 스트림이 아닌 agent 프레임은 버린다 (lifecycle / assistant)', () => {
    for (const stream of ['lifecycle', 'assistant', 'error']) {
      expect(parseAgentToolFrame(frame({ phase: 'start', name: 'x', toolCallId: 'c' }, { stream }))).toBeNull()
    }
  })

  it('session.tool 프레임은 이 파서 대상이 아니다', () => {
    expect(parseAgentToolFrame({
      event: 'session.tool',
      payload: { sessionKey: 'sess-1', data: { phase: 'start', tool_name: 'exec' } },
    })).toBeNull()
  })

  it('필수 필드가 없으면 버린다 — 잘못된 칩을 그리느니 안 그린다', () => {
    expect(parseAgentToolFrame(frame({ phase: 'start', toolCallId: 'c' }))).toBeNull()              // name 없음
    expect(parseAgentToolFrame(frame({ phase: 'start', name: 'x' }))).toBeNull()                    // toolCallId 없음
    expect(parseAgentToolFrame(frame({ phase: 'start', name: 'x', toolCallId: 'c' }, { sessionKey: undefined }))).toBeNull()
    expect(parseAgentToolFrame(frame({ phase: 'end', name: 'x', toolCallId: 'c' }))).toBeNull()     // 없는 phase
    expect(parseAgentToolFrame({ event: 'agent', payload: undefined })).toBeNull()
  })

  it('cap 상수', () => expect(TOOL_EVENTS_CAP).toBe('tool-events'))
})

describe('ToolCallTracker', () => {
  const evt = (phase: 'start' | 'update' | 'result', toolCallId: string, name: string, sessionKey = 'k') =>
    ({ sessionKey, toolCallId, name, phase } as const)

  it('start → 표시, result → 해제', () => {
    const t = new ToolCallTracker()
    expect(t.apply(evt('start', 'c1', 'exec'))).toEqual({ current: 'exec', started: true })
    expect(t.apply(evt('update', 'c1', 'exec'))).toEqual({ current: 'exec', started: false })
    expect(t.apply(evt('result', 'c1', 'exec'))).toEqual({ current: null, started: false })
    expect(t.current('k')).toBeNull()
  })

  it('병렬 호출 — 하나가 끝나도 남은 호출이 있으면 칩이 사라지지 않는다', () => {
    const t = new ToolCallTracker()
    t.apply(evt('start', 'c1', 'exec'))
    expect(t.apply(evt('start', 'c2', 'read'))).toEqual({ current: 'read', started: true })
    // 먼저 시작한 쪽이 끝나도 아직 read 가 돈다.
    expect(t.apply(evt('result', 'c1', 'exec')).current).toBe('read')
    expect(t.apply(evt('result', 'c2', 'read')).current).toBeNull()
  })

  it('같은 툴 이름의 병렬 호출도 toolCallId 로 구분된다 (이름으로 묶으면 뭉개진다)', () => {
    const t = new ToolCallTracker()
    t.apply(evt('start', 'c1', 'exec'))
    t.apply(evt('start', 'c2', 'exec'))
    expect(t.apply(evt('result', 'c1', 'exec')).current).toBe('exec')   // c2 가 아직 돈다
    expect(t.apply(evt('result', 'c2', 'exec')).current).toBeNull()
  })

  it('세션(키)별로 독립이다', () => {
    const t = new ToolCallTracker()
    t.apply(evt('start', 'c1', 'exec', 'A'))
    t.apply(evt('start', 'c9', 'read', 'B'))
    expect(t.current('A')).toBe('exec')
    expect(t.current('B')).toBe('read')
    t.clear('A')
    expect(t.current('A')).toBeNull()
    expect(t.current('B')).toBe('read')
  })

  it('짝 없는 result 가 와도 깨지지 않는다 (재연결 후 늦게 도착한 프레임)', () => {
    const t = new ToolCallTracker()
    expect(t.apply(evt('result', 'ghost', 'exec'))).toEqual({ current: null, started: false })
  })

  it('clearAll — 연결이 끊기면 전부 잊는다', () => {
    const t = new ToolCallTracker()
    t.apply(evt('start', 'c1', 'exec', 'A'))
    t.apply(evt('start', 'c2', 'read', 'B'))
    t.clearAll()
    expect(t.current('A')).toBeNull()
    expect(t.current('B')).toBeNull()
  })
})
