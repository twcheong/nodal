import { describe, it, expect } from 'vitest'
import { getOrchestrationSoul } from './orchestrationSoul'

// Minimal shapes; cast to the global types the fn reads structurally.
const wf = (p: Record<string, unknown>) => p as unknown as NonNullable<Parameters<typeof getOrchestrationSoul>[0]>[number]
const ag = (p: Record<string, unknown>) => p as unknown as NonNullable<Parameters<typeof getOrchestrationSoul>[1]>[number]

describe('getOrchestrationSoul', () => {
  it('replaces the WORKFLOWS_CATALOG placeholder', () => {
    const soul = getOrchestrationSoul()
    expect(soul).not.toContain('<!-- WORKFLOWS_CATALOG -->')
  })

  it('shows empty-state placeholders when no workflows or agents', () => {
    const soul = getOrchestrationSoul([], [])
    expect(soul).toContain('_(no workflows yet')
    expect(soul).toContain('_(no AI agents yet')
  })

  it('lists workflow id, title, and node count with correct pluralization', () => {
    const soul = getOrchestrationSoul(
      [
        wf({ id: 'wf1', title: 'One', nodes: [{}] }),
        wf({ id: 'wf2', title: 'Two', nodes: [{}, {}] }),
      ],
      [],
    )
    expect(soul).toContain('`wf1`')
    expect(soul).toContain('**One**')
    expect(soul).toContain('(1 node)')
    expect(soul).toContain('`wf2`')
    expect(soul).toContain('(2 nodes)')
  })

  it('includes optional workflow type when present', () => {
    const soul = getOrchestrationSoul([wf({ id: 'w', title: 'T', nodes: [], type: 'pipeline' })], [])
    expect(soul).toContain('(0 nodes pipeline)')
  })

  it('treats missing nodes as 0 nodes', () => {
    const soul = getOrchestrationSoul([wf({ id: 'w', title: 'T' })], [])
    expect(soul).toContain('(0 nodes)')
  })

  it('lists agent id, title, type, option count, and truncated description', () => {
    const soul = getOrchestrationSoul(
      [],
      [
        ag({ id: 'a1', title: 'Agent', agentType: 'relay', options: [{}], description: 'hello' }),
      ],
    )
    expect(soul).toContain('`a1`')
    expect(soul).toContain('**Agent**')
    expect(soul).toContain('(relay, 1 option)')
    expect(soul).toContain('— hello')
  })

  it('pluralizes agent options and truncates long descriptions to 100 chars', () => {
    const long = 'z'.repeat(150)
    const soul = getOrchestrationSoul(
      [],
      [ag({ id: 'a', title: 'A', agentType: 'group', options: [{}, {}], description: long })],
    )
    expect(soul).toContain('(group, 2 options)')
    expect(soul).toContain('z'.repeat(100))
    expect(soul).not.toContain('z'.repeat(101))
  })

  it('omits description dash when agent has no description', () => {
    const soul = getOrchestrationSoul([], [ag({ id: 'a', title: 'A', agentType: 'group', options: [] })])
    expect(soul).toContain('(group, 0 options)')
    expect(soul).not.toContain('`a` · **A** (group, 0 options) —')
  })
})
