import { describe, it, expect } from 'vitest'
import { getWorkflowSoul } from './workflowSoul'
import { WORKFLOW_TOOLS, renderToolCatalog } from './workflowTools'

describe('getWorkflowSoul', () => {
  it('replaces the TOOLS_CATALOG placeholder', () => {
    const soul = getWorkflowSoul()
    expect(soul).not.toContain('<!-- TOOLS_CATALOG -->')
  })

  it('injects the rendered tool catalog', () => {
    const soul = getWorkflowSoul()
    expect(soul).toContain(renderToolCatalog())
    // every tool id shows up in the injected catalog
    for (const t of WORKFLOW_TOOLS) {
      expect(soul).toContain(`\`${t.id}\``)
    }
  })

  it('returns a non-trivial prompt string', () => {
    const soul = getWorkflowSoul()
    expect(typeof soul).toBe('string')
    expect(soul.length).toBeGreaterThan(100)
  })

  it('is deterministic across calls (catalog is static)', () => {
    expect(getWorkflowSoul()).toBe(getWorkflowSoul())
  })
})
