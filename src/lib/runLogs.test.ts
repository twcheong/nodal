import { describe, it, expect } from 'vitest'
import { categorizeError, suggestNextAction, buildFailLog, runDetailToCsv } from './runLogs'

describe('categorizeError', () => {
  it('classifies transient failures as system', () => {
    expect(categorizeError('Request timed out')).toBe('system')
    expect(categorizeError('ECONNRESET network error')).toBe('system')
  })
  it('classifies browser failures by reason text', () => {
    expect(categorizeError('selector not found on page')).toBe('browser')
  })
  it('classifies browser failures by a browser tool call', () => {
    expect(categorizeError('something failed', [{ name: 'chrome_navigate' }])).toBe('browser')
  })
  it('classifies missing-input failures', () => {
    expect(categorizeError('required placeholder was invalid')).toBe('input')
    expect(categorizeError('file not found')).toBe('input')
  })
  it('defaults to agent for self-reported task failure', () => {
    expect(categorizeError('NODE_STATUS: could not finish')).toBe('agent')
    expect(categorizeError(undefined)).toBe('agent')
  })
})

describe('suggestNextAction', () => {
  it('returns a distinct message per category', () => {
    const cats = ['system', 'browser', 'input', 'agent'] as const
    const msgs = cats.map(suggestNextAction)
    expect(new Set(msgs).size).toBe(4)
    msgs.forEach(m => expect(m.length).toBeGreaterThan(0))
  })
})

const detail = (over: Partial<any> = {}): any => ({
  runId: 'r1', wfId: 'w1', wfTitle: 'My WF', status: 'failed',
  startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000,
  totals: { ms: 1000, usd: 0.5, tokensIn: 10, tokensOut: 20 },
  nodes: [], ...over,
})

describe('buildFailLog', () => {
  it('clips long prompt/output fields to 2000 chars + ellipsis', () => {
    const long = 'x'.repeat(5000)
    const log: any = buildFailLog(detail({ nodes: [
      { nodeId: 'n1', title: 'A', type: 'action', status: 'done', prompt: long, output: long },
    ] }))
    expect(log.nodes[0].prompt).toHaveLength(2001)
    expect(log.nodes[0].prompt.endsWith('…')).toBe(true)
    expect(log.runId).toBe('r1')
  })

  it('caps tool calls at 30', () => {
    const calls = Array.from({ length: 50 }, (_, i) => ({ name: `t${i}` }))
    const log: any = buildFailLog(detail({ nodes: [
      { nodeId: 'n1', title: 'A', status: 'done', toolCalls: calls },
    ] }))
    expect(log.nodes[0].toolCalls).toHaveLength(30)
  })

  it('slims output when the log exceeds the size cap', () => {
    const big = 'y'.repeat(2000)
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      nodeId: `n${i}`, title: `T${i}`, status: i === 0 ? 'failed' : 'done',
      prompt: big, output: big,
    }))
    const log: any = buildFailLog(detail({ nodes }))
    // Every node's output is dropped once slimmed.
    expect(log.nodes.every((n: any) => n.output === undefined)).toBe(true)
    // Non-failed nodes lose their prompt too; the failed node keeps it.
    const failed = log.nodes.find((n: any) => n.status === 'failed')
    expect(failed?.prompt).toBeTruthy()
    expect(JSON.stringify(log).length).toBeLessThanOrEqual(200 * 1024)
  })
})

describe('runDetailToCsv', () => {
  it('emits a header plus one row per node', () => {
    const csv = runDetailToCsv(detail({ nodes: [
      { nodeId: 'n1', title: 'Step A', type: 'action', tool: 'read', status: 'done',
        startedAt: 1_700_000_000_000, durationMs: 500, costUsd: 0.1, tokensIn: 5, tokensOut: 7,
        toolCalls: [{ name: 'read', detail: 'file.txt' }], reason: '', output: 'hi' },
    ] }))
    const lines = csv.split('\n')
    expect(lines[0]).toContain('order,node,type,tool,status')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"Step A"')
    expect(lines[1]).toContain('read(file.txt)')
  })

  it('escapes embedded quotes by doubling them', () => {
    const csv = runDetailToCsv(detail({ nodes: [
      { nodeId: 'n1', title: 'He said "hi"', status: 'done' },
    ] }))
    expect(csv).toContain('"He said ""hi"""')
  })
})
