import { describe, it, expect } from 'vitest'
import {
  extractWorkflowSpecBlock,
  stripWorkflowSpecBlock,
  parseWorkflowSpecFromText,
  parseSimplePlanFromText,
  stripSimplePlanBlock,
  interleaveHumanReviews,
} from './parseWorkflowSpec'

const fence = (tag: string, body: string) => '```' + tag + '\n' + body + '\n```'

describe('extractWorkflowSpecBlock', () => {
  it('extracts the tagged workflow-spec block', () => {
    const body = '{"title":"T","nodes":[]}'
    expect(extractWorkflowSpecBlock('lead\n' + fence('workflow-spec', body))).toBe(body)
  })

  it('falls back to a json fence containing title + nodes', () => {
    const body = '{ "title": "X", "nodes": [] }'
    expect(extractWorkflowSpecBlock(fence('json', body))).toBe(body)
  })

  it('ignores a json fence missing title/nodes', () => {
    expect(extractWorkflowSpecBlock(fence('json', '{ "foo": 1 }'))).toBeNull()
  })

  it('returns null when there is no block', () => {
    expect(extractWorkflowSpecBlock('nothing here')).toBeNull()
  })
})

describe('stripWorkflowSpecBlock', () => {
  it('removes a tagged block', () => {
    const text = 'before\n' + fence('workflow-spec', '{"title":"T","nodes":[]}') + '\nafter'
    const out = stripWorkflowSpecBlock(text)
    expect(out).not.toContain('workflow-spec')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('removes a fallback json block with title+nodes', () => {
    const text = 'intro\n' + fence('json', '{ "title":"T", "nodes":[] }')
    expect(stripWorkflowSpecBlock(text)).toBe('intro')
  })

  it('returns text unchanged when no matching block', () => {
    expect(stripWorkflowSpecBlock('plain text')).toBe('plain text')
  })
})

describe('parseWorkflowSpecFromText', () => {
  it('parses and normalizes a tagged spec', () => {
    const spec = parseWorkflowSpecFromText(fence('workflow-spec', JSON.stringify({
      title: 'My WF', description: 'desc',
      nodes: [{ type: 'action', title: 'Do it', tool: 'read' }],
    })))
    expect(spec?.title).toBe('My WF')
    expect(spec?.description).toBe('desc')
    expect(spec?.nodes).toHaveLength(1)
    expect(spec?.nodes[0]).toMatchObject({ type: 'action', title: 'Do it', tool: 'read' })
  })

  it('maps SOUL vocabulary: shape->type, label->title, order sorts nodes', () => {
    const spec = parseWorkflowSpecFromText(fence('workflow-spec', JSON.stringify({
      name: 'Aliased',
      nodes: [
        { shape: 'square', label: 'Second', order: 2 },
        { shape: 'circle', label: 'First', order: 1 },
      ],
    })))
    expect(spec?.title).toBe('Aliased')
    expect(spec?.nodes.map(n => n.title)).toEqual(['First', 'Second'])
    expect(spec?.nodes.map(n => n.type)).toEqual(['action', 'validation'])
  })

  it('drops a tool not in the catalog but keeps the node', () => {
    const spec = parseWorkflowSpecFromText(fence('workflow-spec', JSON.stringify({
      title: 'T', nodes: [{ type: 'action', title: 'N', tool: 'nonsense-tool' }],
    })))
    expect(spec?.nodes[0].tool).toBeUndefined()
  })

  it('filters toolSkills to the catalog for the chosen tool', () => {
    const spec = parseWorkflowSpecFromText(fence('workflow-spec', JSON.stringify({
      title: 'T',
      nodes: [{ type: 'action', title: 'N', tool: 'write', toolSkills: ['pdf', 'not-a-skill'] }],
    })))
    expect(spec?.nodes[0].toolSkills).toEqual(['pdf'])
  })

  it('returns null when title is missing', () => {
    expect(parseWorkflowSpecFromText(fence('workflow-spec', JSON.stringify({ nodes: [] })))).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseWorkflowSpecFromText(fence('workflow-spec', '{ bad json'))).toBeNull()
  })

  it('returns null when no spec block exists', () => {
    expect(parseWorkflowSpecFromText('no block')).toBeNull()
  })

  it('derives a title for a node that only has a detail/prompt', () => {
    const spec = parseWorkflowSpecFromText(fence('workflow-spec', JSON.stringify({
      title: 'T', nodes: [{ type: 'action', prompt: 'Fetch the homepage. Then parse it.' }],
    })))
    expect(spec?.nodes[0].title).toBe('Fetch the homepage.')
  })
})

describe('parseSimplePlanFromText', () => {
  it('parses a simple-plan and strips review nodes', () => {
    const plan = parseSimplePlanFromText(fence('simple-plan', JSON.stringify({
      title: 'P',
      nodes: [
        { type: 'action', title: 'A' },
        { type: 'review', title: 'R' },
        { type: 'validation', title: 'V' },
      ],
    })))
    expect(plan?.title).toBe('P')
    expect(plan?.nodes.map(n => n.type)).toEqual(['action', 'validation'])
  })

  it('returns null when no simple-plan block', () => {
    expect(parseSimplePlanFromText(fence('workflow-spec', '{"title":"T","nodes":[]}'))).toBeNull()
  })
})

describe('stripSimplePlanBlock', () => {
  it('removes the simple-plan block', () => {
    const text = 'plan:\n' + fence('simple-plan', '{"title":"T","nodes":[]}')
    expect(stripSimplePlanBlock(text)).toBe('plan:')
  })
})

describe('interleaveHumanReviews', () => {
  const n = (title: string, type: any = 'action') => ({ type, title }) as any

  it('returns input unchanged with fewer than 2 nodes', () => {
    const one = [n('A')]
    expect(interleaveHumanReviews(one)).toBe(one)
  })

  it('leaves nodes untouched when a review already exists', () => {
    const nodes = [n('A'), n('R', 'review'), n('B')]
    expect(interleaveHumanReviews(nodes)).toBe(nodes)
  })

  it('inserts a review between each pair of action nodes', () => {
    const out = interleaveHumanReviews([n('A'), n('B'), n('C')])
    expect(out.map(x => x.type)).toEqual(['action', 'review', 'action', 'review', 'action'])
    expect(out).toHaveLength(5)
  })
})
