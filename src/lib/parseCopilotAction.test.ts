import { describe, it, expect } from 'vitest'
import { parseCopilotAction, stripCopilotActionBlock } from './parseCopilotAction'

const block = (json: string) => '```copilot-action\n' + json + '\n```'

describe('parseCopilotAction', () => {
  it('parses a valid run block with string inputs', () => {
    const text = 'ok\n' + block('{ "action": "run", "workflowId": "wf_abc", "inputs": { "url": "https://x" } }')
    expect(parseCopilotAction(text)).toEqual({
      action: 'run',
      workflowId: 'wf_abc',
      inputs: { url: 'https://x' },
    })
  })

  it('parses a show block (no inputs -> empty object)', () => {
    expect(parseCopilotAction(block('{ "action": "show", "workflowId": "wf1" }'))).toEqual({
      action: 'show',
      workflowId: 'wf1',
      inputs: {},
    })
  })

  it('returns null when no block present', () => {
    expect(parseCopilotAction('just prose, no block here')).toBeNull()
  })

  it('returns null on invalid JSON', () => {
    expect(parseCopilotAction(block('{ not json }'))).toBeNull()
  })

  it('returns null for an unknown action verb', () => {
    expect(parseCopilotAction(block('{ "action": "delete" }'))).toBeNull()
  })

  it('coerces non-string input values via JSON.stringify', () => {
    const r = parseCopilotAction(block('{ "action": "run", "inputs": { "n": 5, "flag": true, "obj": {"a":1} } }'))
    expect(r?.inputs).toEqual({ n: '5', flag: 'true', obj: '{"a":1}' })
  })

  it('drops a non-string workflowId to undefined', () => {
    const r = parseCopilotAction(block('{ "action": "run", "workflowId": 42 }'))
    expect(r?.workflowId).toBeUndefined()
  })
})

describe('stripCopilotActionBlock', () => {
  it('removes the block and trims surrounding prose', () => {
    const text = 'Here you go.\n' + block('{ "action": "show", "workflowId": "w" }')
    expect(stripCopilotActionBlock(text)).toBe('Here you go.')
  })

  it('leaves text unchanged (only trimmed) when no block', () => {
    expect(stripCopilotActionBlock('  hi there  ')).toBe('hi there')
  })
})
