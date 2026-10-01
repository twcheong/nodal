// runNodeTurn — 두 러너가 공유하는 "노드 한 개를 모는" 루프.
//
// 축소 재시도 사다리는 지금까지 useWorkflowTest 안에 인라인으로 있어서 직접
// 테스트가 없었다. 합치면서 여기로 나왔으니 여기서 덮는다. 특히 두 가지:
//   - slicePortions 를 안 넘기면 재시도가 아예 없어야 한다 (Orchestration 의 계약).
//   - 타임아웃 재시도 전에 반드시 cancel 이 불려야 한다 (안 부르면 뒤늦은 final 이
//     다음 노드의 awaiter 와 짝이 어긋나 엉뚱한 출력이 done 처리된다).
import { describe, it, expect, vi } from 'vitest'
import { runNodeTurn, sliceNoteFor } from './runNodeTurn'

const timeout = () => new Error('turn_timeout')
const reply = (text: string) => ({ text, messageId: null, toolCalls: [] })

/** n 번 turn_timeout 을 던지고 그 다음부터 성공하는 send. */
function flakySend(failures: number, finalText = 'done') {
  const sent: string[] = []
  const labels: Array<string | undefined> = []
  let calls = 0
  const send = async (text: string, opts: { timeoutMs: number; displayText?: string }) => {
    sent.push(text); labels.push(opts.displayText)
    if (calls++ < failures) throw timeout()
    return reply(finalText)
  }
  return { send, sent, labels, calls: () => calls }
}

describe('runNodeTurn', () => {
  it('slicePortions 없으면 타임아웃은 즉시 실패 — 재시도 없음 (Orchestration 계약)', async () => {
    const f = flakySend(1)
    const cancel = vi.fn()
    await expect(runNodeTurn(
      { send: f.send, cancel, abort: { aborted: false } },
      'P', { timeoutMs: 100 },
    )).rejects.toThrow('turn_timeout')
    expect(f.calls()).toBe(1)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('타임아웃 → cancel 후 범위를 줄여 재시도하고, 성공하면 autoSlice 를 남긴다', async () => {
    const f = flakySend(2)
    const cancel = vi.fn(async () => {})
    const onSliceRetry = vi.fn()
    const r = await runNodeTurn(
      { send: f.send, cancel, abort: { aborted: false } },
      'PROMPT',
      { timeoutMs: 540_000, slicePortions: ['about half', 'about a quarter'], drainMs: 0, onSliceRetry },
    )
    expect(f.calls()).toBe(3)
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(r.autoSlice).toEqual({ attempts: 2, portion: 'about a quarter' })
    // 1회차는 프롬프트 그대로, 2·3회차는 축소 지시문이 뒤에 붙는다.
    expect(f.sent[0]).toBe('PROMPT')
    expect(f.sent[1]).toBe('PROMPT' + sliceNoteFor('about half', 540_000))
    expect(f.sent[2]).toBe('PROMPT' + sliceNoteFor('about a quarter', 540_000))
    expect(onSliceRetry.mock.calls).toEqual([[0, 'about half'], [1, 'about a quarter']])
  })

  it('사다리를 다 쓰면 마지막 타임아웃을 그대로 던진다', async () => {
    const f = flakySend(99)
    await expect(runNodeTurn(
      { send: f.send, cancel: async () => {}, abort: { aborted: false } },
      'P', { timeoutMs: 100, slicePortions: ['half'], drainMs: 0 },
    )).rejects.toThrow('turn_timeout')
    expect(f.calls()).toBe(2)   // 최초 + 1단계
  })

  it('타임아웃이 아닌 에러는 재시도하지 않는다', async () => {
    let calls = 0
    const send = async () => { calls++; throw new Error('gateway exploded') }
    await expect(runNodeTurn(
      { send, cancel: async () => {}, abort: { aborted: false } },
      'P', { timeoutMs: 100, slicePortions: ['half'], drainMs: 0 },
    )).rejects.toThrow('gateway exploded')
    expect(calls).toBe(1)
  })

  it('drain 중 Stop 을 누르면 재시도하지 않는다', async () => {
    const abort = { aborted: false }
    let calls = 0
    const send = async () => { calls++; throw timeout() }
    await expect(runNodeTurn(
      { send, cancel: async () => { abort.aborted = true }, abort },
      'P', { timeoutMs: 100, slicePortions: ['half'], drainMs: 0 },
    )).rejects.toThrow('turn_timeout')
    expect(calls).toBe(1)
  })

  it('성공 응답은 자기보고를 판정하고 상태 줄을 제거해 돌려준다', async () => {
    const send = async () => reply('Wrote it.\nNODE_STATUS: OK')
    const ok = await runNodeTurn({ send, abort: { aborted: false } }, 'P', { timeoutMs: 100 })
    expect(ok.failure).toBeNull()
    expect(ok.text).toBe('Wrote it.')
    expect(ok.rawText).toContain('NODE_STATUS')

    const send2 = async () => reply('Nope.\nNODE_STATUS: FAILED — sitemap 404')
    const bad = await runNodeTurn({ send: send2, abort: { aborted: false } }, 'P', { timeoutMs: 100 })
    expect(bad.failure).toBe('sitemap 404')
    expect(bad.text).toBe('Nope.')
  })

  it('cancel 이 없어도(Orchestration) 죽지 않는다', async () => {
    const send = async () => reply('x')
    await expect(runNodeTurn({ send, abort: { aborted: false } }, 'P', { timeoutMs: 100 }))
      .resolves.toMatchObject({ text: 'x' })
  })
})
