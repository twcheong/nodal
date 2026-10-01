import { describe, it, expect } from 'vitest'
import {
  renderToolCatalog,
  findTool,
  findSkill,
  validateTool,
  filterValidSkills,
  nodeShapeFor,
  nodeTagFor,
} from './workflowTools'

describe('renderToolCatalog', () => {
  const md = renderToolCatalog()
  it('lists a tool with its sub-skills', () => {
    expect(md).toContain('`chrome`')
    expect(md).toContain('sub-skills: instagram')
  })
  it('lists a tool with no sub-skills without a sub-skills clause', () => {
    const line = md.split('\n').find(l => l.startsWith('- `web-fetch`'))
    expect(line).toBeDefined()
    expect(line).not.toContain('sub-skills')
  })
})

describe('findTool', () => {
  it('finds a known tool', () => {
    expect(findTool('write')?.label).toBe('Write')
  })
  it('returns undefined for an unknown tool', () => {
    expect(findTool('bogus' as any)).toBeUndefined()
  })
  it('returns undefined for undefined id', () => {
    expect(findTool(undefined)).toBeUndefined()
  })
})

describe('findSkill', () => {
  it('finds a skill within its tool', () => {
    expect(findSkill('write', 'pdf')?.label).toBe('PDF')
  })
  it('returns undefined for a skill not under the tool', () => {
    expect(findSkill('write', 'instagram')).toBeUndefined()
  })
  it('returns undefined when the tool is undefined', () => {
    expect(findSkill(undefined, 'pdf')).toBeUndefined()
  })
})

describe('validateTool', () => {
  it('accepts a catalog id', () => {
    expect(validateTool('chrome')).toBe('chrome')
  })
  it('rejects a non-catalog string', () => {
    expect(validateTool('hammer')).toBeUndefined()
  })
  it('rejects non-string input', () => {
    expect(validateTool(123)).toBeUndefined()
    expect(validateTool(null)).toBeUndefined()
  })
})

describe('filterValidSkills', () => {
  it('keeps only skills valid for the tool', () => {
    expect(filterValidSkills('write', ['pdf', 'csv', 'nope'])).toEqual(['pdf', 'csv'])
  })
  it('returns [] when tool is undefined', () => {
    expect(filterValidSkills(undefined, ['pdf'])).toEqual([])
  })
  it('returns [] when tool has no skills catalog', () => {
    expect(filterValidSkills('read', ['anything'])).toEqual([])
  })
  it('returns [] for a non-array', () => {
    expect(filterValidSkills('write', 'pdf' as any)).toEqual([])
  })
})

describe('nodeShapeFor', () => {
  it('maps node types to shapes', () => {
    expect(nodeShapeFor('action')).toBe('circle')
    expect(nodeShapeFor('review')).toBe('triangle')
    expect(nodeShapeFor('validation')).toBe('square')
  })
})

describe('nodeTagFor', () => {
  it('tags review and validation nodes by type', () => {
    expect(nodeTagFor({ type: 'review' } as any)).toBe('Human Review')
    expect(nodeTagFor({ type: 'validation' } as any)).toBe('Validation')
  })
  it('tags an action node by its tool label', () => {
    expect(nodeTagFor({ type: 'action', tool: 'chrome' } as any)).toBe('Chrome')
  })
  it('falls back to Tool? when an action has no valid tool', () => {
    expect(nodeTagFor({ type: 'action' } as any)).toBe('Tool?')
  })
})
