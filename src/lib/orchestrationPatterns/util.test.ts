import { describe, it, expect } from 'vitest'
import { parseJsonLoose, firstLine, memberLabel } from './util'

describe('parseJsonLoose', () => {
  it('parses a bare JSON object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses a bare JSON array', () => {
    expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('extracts JSON from a ```json fenced block', () => {
    const text = 'Here you go:\n```json\n{"ok":true}\n```\nthanks'
    expect(parseJsonLoose(text)).toEqual({ ok: true })
  })

  it('extracts JSON from an unlabeled ``` fence', () => {
    expect(parseJsonLoose('```\n{"x":9}\n```')).toEqual({ x: 9 })
  })

  it('strips surrounding prose', () => {
    expect(parseJsonLoose('the answer is {"n":42} ok')).toEqual({ n: 42 })
  })

  it('handles nested objects', () => {
    expect(parseJsonLoose('{"a":{"b":[1,{"c":2}]}}')).toEqual({ a: { b: [1, { c: 2 }] } })
  })

  it('returns the first object when trailing junk follows', () => {
    expect(parseJsonLoose('{"first":1} garbage {"second":2}')).toEqual({ first: 1 })
  })

  it('returns null for empty string', () => {
    expect(parseJsonLoose('')).toBeNull()
  })

  it('returns null when no JSON is present', () => {
    expect(parseJsonLoose('just some prose, no braces here')).toBeNull()
  })

  it('is generic over the parsed type', () => {
    const v = parseJsonLoose<{ a: number }>('{"a":1}')
    expect(v?.a).toBe(1)
  })
})

describe('firstLine', () => {
  it('returns the first line of multiline text', () => {
    expect(firstLine('hello\nworld\nfoo')).toBe('hello')
  })

  it('trims leading/trailing whitespace before splitting', () => {
    expect(firstLine('  \n  first\nsecond  ')).toBe('first')
  })

  it('caps length at the max (default 200)', () => {
    const long = 'x'.repeat(500)
    expect(firstLine(long).length).toBe(200)
  })

  it('respects a custom max', () => {
    expect(firstLine('abcdef', 3)).toBe('abc')
  })

  it('returns empty string for empty/whitespace input', () => {
    expect(firstLine('')).toBe('')
    expect(firstLine('   ')).toBe('')
  })
})

describe('memberLabel', () => {
  const ctx = (title?: string) =>
    ({ workflowOf: () => (title ? ({ title } as { title: string }) : undefined) }) as any

  it('prefers the explicit member label', () => {
    const m = { label: 'Custom', workflowId: 'wf1' } as any
    expect(memberLabel(ctx('WF Title'), m)).toBe('Custom')
  })

  it('falls back to the resolved workflow title', () => {
    const m = { workflowId: 'wf1' } as any
    expect(memberLabel(ctx('WF Title'), m)).toBe('WF Title')
  })

  it('falls back to the workflowId when no label and no workflow', () => {
    const m = { workflowId: 'wf1' } as any
    expect(memberLabel(ctx(undefined), m)).toBe('wf1')
  })

  it('ignores empty-string label and uses next fallback', () => {
    const m = { label: '', workflowId: 'wf1' } as any
    expect(memberLabel(ctx('WF Title'), m)).toBe('WF Title')
  })
})
