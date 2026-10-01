import { describe, expect, it } from 'vitest'
import { committed, deltaText, EMPTY_LIVE, plainReasoning, visibleText, withDelta, withThinking } from './liveReply'

describe('liveReply', () => {
  it('reads the accumulated text from a gateway chat delta frame', () => {
    expect(deltaText({ state: 'delta', message: { role: 'assistant', content: [{ type: 'text', text: '안녕' }] } })).toBe('안녕')
    expect(deltaText({ message: { content: 'plain' } })).toBe('plain')
    expect(deltaText({})).toBeNull()
  })

  it('shows only what is written after the last committed message in the same turn', () => {
    let l = withDelta(EMPTY_LIVE, '무대 배경부터')
    expect(visibleText(l)).toBe('무대 배경부터')
    l = committed(l)                       // session.message 로 대화에 붙었다
    expect(visibleText(l)).toBe('')
    l = withDelta(l, '무대 배경부터\n\n결과를 기다리는')   // 툴 뒤 다음 말이 이어 붙는다
    expect(visibleText(l)).toBe('결과를 기다리는')
  })

  it('shows the whole text when the gateway buffer restarts for a new message', () => {
    const l = withDelta(committed(withDelta(EMPTY_LIVE, '첫 메시지')), '두 번째')
    expect(visibleText(l)).toBe('두 번째')
  })

  it('strips the gateway reasoning format and resets it per message', () => {
    expect(plainReasoning('Reasoning:\n_first line_\n\n_second_')).toBe('first line\n\nsecond')
    const l = withThinking(EMPTY_LIVE, 'Reasoning:\n_plan the stage_')
    expect(l.thinking).toBe('plan the stage')
    expect(committed(l).thinking).toBe('')
  })
})
