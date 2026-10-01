// runNodeSequence — 두 러너가 공유하는 노드 시퀀싱 루프.
//
// 왜 여기에 테스트가 필요한가: 이 루프를 부르는 두 호출부 중 Test run 쪽은
// 훅 안이라 단위 테스트가 없다. 시퀀스를 순수 함수로 빼낸 덕에 정책 조합을
// 직접 찔러볼 수 있게 됐으니, 훅에서는 못 덮던 것들을 여기서 덮는다:
// review 정책, 재개(startIndex), 합계 누적, 멈춤 semantics.
import { describe, it, expect, vi } from 'vitest'
import { runNodeSequence, type ReviewOutcome } from './runNodeSequence'

const node = (p: Record<string, unknown>) => p as unknown as TwixyWorkflowNode
const wfOf = (...nodes: TwixyWorkflowNode[]) => ({
  version: 1, id: 'w', title: 'W', author: { uid: 'u' }, createdAt: '', updatedAt: '', nodes,
} as unknown as TwixyWorkflow)

const A = node({ id: 'a', type: 'action', title: 'A' })
const B = node({ id: 'b', type: 'action', title: 'B' })
const R = node({ id: 'r', type: 'review', title: 'R' })

const autoApprove = async (): Promise<ReviewOutcome> => ({
  metrics: { status: 'done', durationMs: 0, costUsd: 0, reason: 'Auto-approved' },
})

/** 기본 배선 — 응답 목록을 순서대로 돌려주고, 원장은 노드마다 1씩 움직인다. */
function harness(opts: {
  workflow: TwixyWorkflow
  replies?: string[]
  onReview?: (a: { node: TwixyWorkflowNode; index: number }) => Promise<ReviewOutcome>
  startIndex?: number
  abort?: { aborted: boolean }
  sendImpl?: (text: string) => Promise<{ text: string; messageId: null; toolCalls: [] }>
  extra?: Record<string, unknown>
}) {
  const seen: Array<{ id: string; status: string; reason?: string; totals: number }> = []
  const sent: string[] = []
  let i = 0
  let usd = 0
  const run = runNodeSequence({
    workflow: opts.workflow,
    startIndex: opts.startIndex,
    abort: opts.abort ?? { aborted: false },
    buildPrompt: ({ node: nd, isFirst }) => `P:${nd.id}:${isFirst ? 'first' : 'next'}`,
    turn: {
      send: opts.sendImpl ?? (async (text: string) => {
        sent.push(text)
        return { text: opts.replies?.[i++] ?? '', messageId: null, toolCalls: [] as [] }
      }),
    },
    turnPolicy: () => ({ timeoutMs: 1000 }),
    getUsage: async () => ({ usd: ++usd }),
    onReview: opts.onReview ?? autoApprove,
    onNode: ({ nodeId, metrics, totals }) =>
      seen.push({ id: nodeId, status: metrics.status, reason: metrics.reason, totals: totals.cost }),
    ...opts.extra,
  })
  return run.then(r => ({ r, seen, sent }))
}

describe('runNodeSequence', () => {
  it('노드가 없으면 즉시 done', async () => {
    const { r } = await harness({ workflow: wfOf() })
    expect(r).toMatchObject({ status: 'done', finalOutput: '', outputs: {} })
  })

  it('순서대로 돌고 running → done 을 보고한다', async () => {
    const { r, seen, sent } = await harness({ workflow: wfOf(A, B), replies: ['one', 'two'] })
    expect(r.status).toBe('done')
    expect(seen.map(s => `${s.id}:${s.status}`)).toEqual(['a:running', 'a:done', 'b:running', 'b:done'])
    expect(sent).toEqual(['P:a:first', 'P:b:next'])
    expect(r.outputs).toEqual({ a: 'one', b: 'two' })
    expect(r.finalOutput).toBe('two')
  })

  it('startIndex 로 재개하면 앞 노드는 건드리지 않고, 재개 노드가 isFirst 다', async () => {
    const { r, seen, sent } = await harness({ workflow: wfOf(A, B), startIndex: 1, replies: ['two'] })
    expect(r.status).toBe('done')
    expect(seen.every(s => s.id === 'b')).toBe(true)
    expect(sent).toEqual(['P:b:first'])
  })

  it('review 정책이 skipped 를 주면 기록만 하고 합계는 안 늘린다', async () => {
    const { r, seen } = await harness({
      workflow: wfOf(R, A), replies: ['x'],
      onReview: async () => ({ metrics: { status: 'skipped', durationMs: 500, reason: 'Human chose to skip' } }),
    })
    expect(seen[0]).toMatchObject({ id: 'r', status: 'skipped' })
    expect(seen[0].totals).toBe(0)   // skip 의 durationMs 는 합계에 안 들어간다
    expect(r.status).toBe('done')
  })

  it('review 의 totalsDelta 는 run 합계에 더해진다', async () => {
    const { seen } = await harness({
      workflow: wfOf(R, A), replies: ['x'],
      onReview: async () => ({
        metrics: { status: 'done', costUsd: 0.5, reason: 'Note sent' },
        totalsDelta: { cost: 0.5, ms: 100 },
      }),
    })
    expect(seen.find(s => s.id === 'r')?.totals).toBe(0.5)
  })

  it('review 가 모델을 썼으면 원장 기준선을 다시 잡아 다음 노드가 그 비용을 물려받지 않는다', async () => {
    const reads: string[] = []
    let usd = 0
    const r = await runNodeSequence({
      workflow: wfOf(R, A),
      abort: { aborted: false },
      buildPrompt: () => 'P',
      turn: { send: async () => ({ text: 'ok', messageId: null, toolCalls: [] }) },
      turnPolicy: () => ({ timeoutMs: 1000 }),
      getUsage: async () => { reads.push('read'); return { usd: ++usd } },
      // 리뷰가 비용을 썼다고 신고 → 기준선 재동기화가 일어나야 한다
      onReview: async () => ({ metrics: { status: 'done' }, totalsDelta: { cost: 1 } }),
      onNode: () => {},
    })
    expect(r.status).toBe('done')
    // baseline 1회 + review 후 재동기화 1회 + 노드 정산 1회 = 최소 3회
    expect(reads.length).toBeGreaterThanOrEqual(3)
  })

  it('review 가 stop 을 주면 aborted 로 끝난다', async () => {
    const { r, seen } = await harness({
      workflow: wfOf(R, A),
      onReview: async () => ({ metrics: { status: 'aborted' }, stop: { reason: 'Stopped by user' } }),
    })
    expect(r).toMatchObject({ status: 'aborted', stoppedAtNodeId: 'r', reason: 'Stopped by user' })
    expect(seen.some(s => s.id === 'a')).toBe(false)
    expect(r.failedNodeId).toBeUndefined()   // 중단에는 failedNodeId 를 붙이지 않는다
  })

  it('시작 전에 이미 Stop 이면 그 노드를 aborted 로 보고하고 끝낸다', async () => {
    const { r, seen, sent } = await harness({ workflow: wfOf(A, B), abort: { aborted: true } })
    expect(r).toMatchObject({ status: 'aborted', stoppedAtNodeId: 'a' })
    expect(r.failedNodeId).toBeUndefined()
    expect(sent).toHaveLength(0)
    expect(seen).toEqual([{ id: 'a', status: 'aborted', reason: 'Stopped by user', totals: 0 }])
  })

  it('자기보고 실패 → failed, 뒤 노드는 돌지 않는다. failureKind 가 self-report', async () => {
    const { r, seen, sent } = await harness({
      workflow: wfOf(A, B), replies: ['bad\nNODE_STATUS: FAILED — nope', 'never'],
    })
    expect(r).toMatchObject({
      status: 'failed', failedNodeId: 'a', stoppedAtNodeId: 'a',
      failureKind: 'self-report', reason: 'nope',
    })
    expect(sent).toHaveLength(1)
    expect(seen.some(s => s.id === 'b')).toBe(false)
    expect(r.outputs.a).toBe('bad')   // 부분 출력은 보존
  })

  it('던져진 에러 → failed, mapError 로 문구를 번역하고 failureKind 가 error', async () => {
    const { r, seen } = await harness({
      workflow: wfOf(A, B),
      sendImpl: async () => { throw new Error('403 Key limit exceeded') },
      extra: { mapError: (raw: string) => `friendly(${raw})` },
    })
    expect(r).toMatchObject({ status: 'failed', failedNodeId: 'a', failureKind: 'error' })
    expect(r.reason).toBe('friendly(403 Key limit exceeded)')
    expect(seen.at(-1)?.reason).toBe('friendly(403 Key limit exceeded)')
  })

  it('Stop 으로 인한 throw 는 aborted — 사용자 문구로 덮고 mapError 를 타지 않는다', async () => {
    const abort = { aborted: false }
    const { r } = await harness({
      workflow: wfOf(A),
      abort,
      sendImpl: async () => { abort.aborted = true; throw new Error('cancelled') },
      extra: { mapError: () => 'SHOULD NOT APPEAR' },
    })
    expect(r).toMatchObject({ status: 'aborted', reason: 'Stopped by user', failedNodeId: 'a' })
  })

  it('recordPrompt / recordToolCalls 를 안 주면 메트릭에 그 필드가 없다', async () => {
    const metrics: Array<Record<string, unknown>> = []
    await runNodeSequence({
      workflow: wfOf(A), abort: { aborted: false },
      buildPrompt: () => 'LONG PROMPT',
      turn: { send: async () => ({ text: 'x', messageId: null, toolCalls: [{ name: 't' }] }) },
      turnPolicy: () => ({ timeoutMs: 1000 }),
      getUsage: async () => ({ usd: 1 }),
      onReview: autoApprove,
      onNode: ({ metrics: m }) => metrics.push(m as unknown as Record<string, unknown>),
    })
    const done = metrics.find(m => m.status === 'done')!
    expect('prompt' in done).toBe(false)
    expect('toolCalls' in done).toBe(false)
  })

  it('recordPrompt 는 길이를 자르고, recordToolCalls 는 툴 목록을 남긴다', async () => {
    const metrics: Array<Record<string, unknown>> = []
    await runNodeSequence({
      workflow: wfOf(A), abort: { aborted: false },
      buildPrompt: () => 'LONG PROMPT',
      turn: { send: async () => ({ text: 'x', messageId: null, toolCalls: [{ name: 't' }] }) },
      turnPolicy: () => ({ timeoutMs: 1000 }),
      getUsage: async () => ({ usd: 1 }),
      onReview: autoApprove,
      onNode: ({ metrics: m }) => metrics.push(m as unknown as Record<string, unknown>),
      recordPrompt: 4,
      recordToolCalls: true,
    })
    const done = metrics.find(m => m.status === 'done')!
    expect(done.prompt).toBe('LONG')
    expect(done.toolCalls).toEqual([{ name: 't' }])
  })

  it('logLabel 이 없으면 실패해도 콘솔에 아무것도 찍지 않는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await harness({ workflow: wfOf(A), replies: ['NODE_STATUS: FAILED — x'] })
    expect(warn).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    warn.mockRestore(); err.mockRestore()
  })
})
