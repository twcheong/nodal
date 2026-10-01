import { describe, it, expect } from 'vitest'
import {
  normalizeType, normalizeName, typesCompatible, typeAbbrev,
  workflowType, workflowOutputFields, inputSatisfied, compatOf, pairCompatibility,
  memberOutputFields, deriveEntryInputs, missingRequired, deriveEntryUnits,
  optionSatisfied, unitSatisfied, unmetUnitCount, criticalPathMs,
} from './orchestrationIO'

// ── builders ────────────────────────────────────────────────────────────────
const param = (id: string, valueType = 'text', observed = ''): any => ({
  id, kind: 'scalar', valueType, label: id, observed, confidence: 'low',
})
const writeNode = (fields: Array<{ name: string; type: string }>): any => ({
  id: 'n', type: 'action', title: 'w', tool: 'write', outputScope: fields,
})
const wf = (id: string, over: Partial<any> = {}): any => ({
  version: 1, id, title: id, nodes: [], inputs: [], author: { uid: 'u' },
  createdAt: '', updatedAt: '', ...over,
})
const leaf = (id: string, workflowId: string): any => ({ id, workflowId })

describe('normalizeType', () => {
  it('buckets known type strings', () => {
    expect(normalizeType('url')).toBe('url')
    expect(normalizeType('website URL')).toBe('url')
    expect(normalizeType('filepath')).toBe('path')
    expect(normalizeType('search query')).toBe('query')
    expect(normalizeType('json object')).toBe('json')
    expect(normalizeType('integer')).toBe('number')
  })
  it('strips a trailing [] and falls back to text', () => {
    expect(normalizeType('md[]')).toBe('text')
    expect(normalizeType('string')).toBe('text')
  })
  it('treats empty/nullish as text', () => {
    expect(normalizeType('')).toBe('text')
    expect(normalizeType(null)).toBe('text')
    expect(normalizeType(undefined)).toBe('text')
  })
})

describe('normalizeName', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeName('Target_URL')).toBe('targeturl')
    expect(normalizeName(' My Field-1 ')).toBe('myfield1')
    expect(normalizeName(null)).toBe('')
  })
})

describe('typesCompatible', () => {
  it('matches same bucket', () => {
    expect(typesCompatible('url', 'website')).toBe(true)
  })
  it('accepts text input as a universal sink', () => {
    expect(typesCompatible('url', 'text')).toBe(true)
  })
  it('rejects a genuine mismatch', () => {
    expect(typesCompatible('url', 'number')).toBe(false)
  })
})

describe('typeAbbrev', () => {
  it('abbreviates workflow types', () => {
    expect(typeAbbrev('research')).toBe('RSCH')
    expect(typeAbbrev('execution')).toBe('EXEC')
    expect(typeAbbrev('custom')).toBe('CUSTOM')
    expect(typeAbbrev(null)).toBe('')
    expect(typeAbbrev(undefined)).toBe('')
  })
})

describe('workflowType', () => {
  it('honors an explicit type', () => {
    expect(workflowType(wf('a', { type: 'research' }))).toBe('research')
  })
  it('derives research when the last non-review node is a write', () => {
    expect(workflowType(wf('a', { nodes: [{ type: 'action', tool: 'read' }, writeNode([])] }))).toBe('research')
  })
  it('derives research for validation directly after a write', () => {
    expect(workflowType(wf('a', { nodes: [writeNode([]), { type: 'validation' }] }))).toBe('research')
  })
  it('defaults to execution otherwise', () => {
    expect(workflowType(wf('a', { nodes: [{ type: 'action', tool: 'chrome' }] }))).toBe('execution')
    expect(workflowType(null)).toBe('execution')
  })
})

describe('workflowOutputFields', () => {
  it('unions write outputScopes and dedups by normalized name', () => {
    const w = wf('a', { nodes: [
      writeNode([{ name: 'Report', type: 'url' }, { name: 'report', type: 'md' }]),
      writeNode([{ name: 'Extra', type: 'json' }]),
    ] })
    expect(workflowOutputFields(w).map(f => f.name)).toEqual(['Report', 'Extra'])
  })
  it('ignores non-write nodes and empty workflows', () => {
    expect(workflowOutputFields(wf('a', { nodes: [{ type: 'action', tool: 'read', outputScope: [{ name: 'x', type: 'text' }] }] }))).toEqual([])
    expect(workflowOutputFields(null)).toEqual([])
  })
})

describe('inputSatisfied', () => {
  const outs = [{ name: 'url', type: 'url' }] as any
  it('is satisfied by a matching output', () => {
    expect(inputSatisfied(param('url', 'url'), outs).ok).toBe(true)
  })
  it('reports a missing output', () => {
    const r = inputSatisfied(param('other', 'url'), outs)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('no output')
  })
  it('reports a type mismatch', () => {
    const r = inputSatisfied(param('url', 'number'), outs)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('≠')
  })
})

describe('compatOf / pairCompatibility', () => {
  const outs = [{ name: 'url', type: 'url' }] as any
  it('is neutral when there are no inputs', () => {
    expect(compatOf(outs, []).status).toBe('neutral')
  })
  it('is ok when every input is satisfied', () => {
    expect(compatOf(outs, [param('url', 'url')]).status).toBe('ok')
  })
  it('warns and lists unmet inputs', () => {
    const r = compatOf(outs, [param('missing', 'url')])
    expect(r.status).toBe('warn')
    expect(r.unmet[0].id).toBe('missing')
  })
  it('pairCompatibility wires prev outputs to next inputs', () => {
    const prev = wf('p', { nodes: [writeNode([{ name: 'url', type: 'url' }])] })
    const next = wf('n', { inputs: [param('url', 'url')] })
    expect(pairCompatibility(prev, next).status).toBe('ok')
  })
})

describe('memberOutputFields', () => {
  const wfById = new Map<string, any>([
    ['A', wf('A', { nodes: [writeNode([{ name: 'a', type: 'url' }])] })],
    ['B', wf('B', { nodes: [writeNode([{ name: 'b', type: 'json' }])] })],
    ['C', wf('C', { nodes: [writeNode([{ name: 'a', type: 'url' }, { name: 'c', type: 'md' }])] })],
  ])
  it('reads a leaf workflow output', () => {
    expect(memberOutputFields(leaf('m', 'A'), wfById).map(f => f.name)).toEqual(['a'])
  })
  it('pipeline group yields only the last member output', () => {
    const grp = { id: 'g', workflowId: '', subPattern: 'pipeline', children: [leaf('1', 'A'), leaf('2', 'B')] } as any
    expect(memberOutputFields(grp, wfById).map(f => f.name)).toEqual(['b'])
  })
  it('parallel group unions branch outputs', () => {
    const grp = { id: 'g', workflowId: '', subPattern: 'parallel', children: [leaf('1', 'A'), leaf('2', 'B')] } as any
    expect(memberOutputFields(grp, wfById).map(f => f.name).sort()).toEqual(['a', 'b'])
  })
  it('relay group intersects branch outputs', () => {
    const grp = { id: 'g', workflowId: '', subPattern: 'relay', children: [leaf('1', 'A'), leaf('2', 'C')] } as any
    expect(memberOutputFields(grp, wfById).map(f => f.name)).toEqual(['a'])
  })
  it('prefers an explicit group outputScope', () => {
    const grp = { id: 'g', workflowId: '', subPattern: 'parallel', outputScope: [{ name: 'z', type: 'text' }], children: [leaf('1', 'A')] } as any
    expect(memberOutputFields(grp, wfById).map(f => f.name)).toEqual(['z'])
  })
})

describe('deriveEntryInputs', () => {
  const wfById = new Map<string, any>([
    ['A', wf('A', { inputs: [param('url'), param('lang')] })],
    ['B', wf('B', { inputs: [param('url'), param('depth')] })],
  ])
  it('pipeline takes the first member inputs only', () => {
    const out = deriveEntryInputs([leaf('1', 'A'), leaf('2', 'B')], 'pipeline', wfById)
    expect(out.map(p => p.id)).toEqual(['url', 'lang'])
  })
  it('parallel unions member inputs, dedup by id', () => {
    const out = deriveEntryInputs([leaf('1', 'A'), leaf('2', 'B')], 'parallel', wfById)
    expect(out.map(p => p.id)).toEqual(['url', 'lang', 'depth'])
  })
})

describe('missingRequired', () => {
  it('keeps inputs with no value and no observed default', () => {
    const inputs = [param('a'), param('b', 'text', 'default'), param('c')]
    expect(missingRequired(inputs, { c: 'x' }).map(p => p.id)).toEqual(['a'])
  })
})

describe('deriveEntryUnits + option/unit satisfaction', () => {
  const wfById = new Map<string, any>([
    ['A', wf('A', { inputs: [param('url')] })],
    ['O1', wf('O1', { inputs: [param('q')] })],
    ['O2', wf('O2', { inputs: [param('handle')] })],
  ])
  const agentById = new Map<string, any>([
    ['ag', { version: 1, id: 'ag', title: 'Scout', agentType: 'research',
      options: [leaf('o1', 'O1'), leaf('o2', 'O2')], author: { uid: 'u' }, createdAt: '', updatedAt: '' }],
  ])

  it('builds a workflow unit for a plain leaf', () => {
    const units = deriveEntryUnits([leaf('m', 'A')], 'parallel', wfById)
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('workflow')
    expect(units[0].options[0].inputs.map((p: any) => p.id)).toEqual(['url'])
  })

  it('builds an agent unit with one option per agent option', () => {
    const member = { id: 'am', workflowId: '', agentId: 'ag' } as any
    const units = deriveEntryUnits([member], 'parallel', wfById, agentById)
    expect(units[0].kind).toBe('agent')
    expect(units[0].options.map(o => o.inputs.map((p: any) => p.id))).toEqual([['q'], ['handle']])
  })

  it('optionSatisfied requires all option inputs filled', () => {
    const opt = { id: 'o', label: 'o', inputs: [param('q')] }
    expect(optionSatisfied(opt, {})).toBe(false)
    expect(optionSatisfied(opt, { q: 'x' })).toBe(true)
    expect(optionSatisfied({ id: 'e', label: 'e', inputs: [] }, {})).toBe(true)
  })

  it('unitSatisfied for an agent needs only one option satisfied', () => {
    const unit: any = { kind: 'agent', id: 'ag', label: 'Scout', options: [
      { id: 'o1', label: 'a', inputs: [param('q')] },
      { id: 'o2', label: 'b', inputs: [param('handle')] },
    ] }
    expect(unitSatisfied(unit, {})).toBe(false)
    expect(unitSatisfied(unit, { handle: 'x' })).toBe(true)
  })

  it('unmetUnitCount counts unsatisfied units', () => {
    const units: any = [
      { kind: 'workflow', id: '1', label: '1', options: [{ id: '1', label: '1', inputs: [param('a')] }] },
      { kind: 'workflow', id: '2', label: '2', options: [{ id: '2', label: '2', inputs: [] }] },
    ]
    expect(unmetUnitCount(units, {})).toBe(1)
  })
})

describe('criticalPathMs', () => {
  const dur = { m1: { durationMs: 100 }, m2: { durationMs: 250 }, m3: { durationMs: 40 } }
  it('sums durations along a pipeline', () => {
    expect(criticalPathMs([leaf('m1', 'A'), leaf('m2', 'B')], 'pipeline', dur)).toBe(350)
  })
  it('takes the max across parallel branches', () => {
    expect(criticalPathMs([leaf('m1', 'A'), leaf('m2', 'B'), leaf('m3', 'C')], 'parallel', dur)).toBe(250)
  })
  it('recurses into a nested group for its path', () => {
    const grp = { id: 'g', workflowId: '', subPattern: 'pipeline', children: [leaf('m1', 'A'), leaf('m3', 'C')] } as any
    expect(criticalPathMs([grp, leaf('m2', 'B')], 'parallel', dur)).toBe(250)
    expect(criticalPathMs([grp, leaf('m2', 'B')], 'pipeline', dur)).toBe(140 + 250)
  })
  it('returns 0 for empty members', () => {
    expect(criticalPathMs([], 'pipeline', dur)).toBe(0)
  })
})
