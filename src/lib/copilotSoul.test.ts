import { describe, it, expect } from 'vitest'
import { getSimpleSoul, getCopilotSoul } from './copilotSoul'
import { getWorkflowSoul } from './workflowSoul'

describe('getSimpleSoul', () => {
  it('has the simple-execution header', () => {
    expect(getSimpleSoul()).toContain('Twixy Copilot — Simple Execution Mode')
  })

  it('instructs use of simple-plan and forbids workflow-spec/copilot-action', () => {
    const soul = getSimpleSoul()
    expect(soul).toContain('```simple-plan')
    expect(soul).toContain('NEVER ```workflow-spec``` and NEVER ```copilot-action```')
  })

  it('embeds the workflow authoring soul', () => {
    expect(getSimpleSoul()).toContain(getWorkflowSoul())
  })

  it('has no unreplaced catalog placeholder', () => {
    expect(getSimpleSoul()).not.toContain('<!-- TOOLS_CATALOG -->')
  })

  it('is deterministic', () => {
    expect(getSimpleSoul()).toBe(getSimpleSoul())
  })
})

describe('getCopilotSoul', () => {
  it('has the router+author header', () => {
    expect(getCopilotSoul()).toContain('request router + workflow author')
  })

  it('documents show and run copilot-action shapes', () => {
    const soul = getCopilotSoul()
    expect(soul).toContain('"action": "show"')
    expect(soul).toContain('"action": "run"')
  })

  it('embeds the workflow authoring soul', () => {
    expect(getCopilotSoul()).toContain(getWorkflowSoul())
  })

  it('is distinct from the simple soul', () => {
    expect(getCopilotSoul()).not.toBe(getSimpleSoul())
  })
})
