import { describe, it, expect } from 'vitest'
import { friendlyTool } from './ChatPanel'

describe('friendlyTool', () => {
  it('maps web search aliases', () => {
    expect(friendlyTool('web_search', false)).toBe('Searching the web')
    expect(friendlyTool('tavily_search', false)).toBe('Searching the web')
  })

  it('maps web fetch aliases', () => {
    expect(friendlyTool('web_fetch', false)).toBe('Reading page')
    expect(friendlyTool('tavily_extract', false)).toBe('Reading page')
  })

  it('adds a sub-agent prefix for browser control only when delegated', () => {
    expect(friendlyTool('browser_click', false)).toBe('Controlling browser')
    expect(friendlyTool('browser_click', true)).toBe('Sub-agent: controlling browser')
  })

  it('maps exec/bash to running command', () => {
    expect(friendlyTool('exec', false)).toBe('Running command')
    expect(friendlyTool('bash', true)).toBe('Sub-agent: running command')
  })

  it('maps apply_patch and apply-patch to editing files', () => {
    expect(friendlyTool('apply_patch', false)).toBe('Editing files')
    expect(friendlyTool('apply-patch', true)).toBe('Sub-agent: editing files')
  })

  it('maps read/write prefixes', () => {
    expect(friendlyTool('read_file', false)).toBe('Reading file')
    expect(friendlyTool('write_file', true)).toBe('Sub-agent: writing file')
  })

  it('maps search and grep prefixes to searching', () => {
    expect(friendlyTool('search_repo', false)).toBe('Searching')
    expect(friendlyTool('grep', true)).toBe('Sub-agent: searching')
  })

  it('maps canvas prefix to building widget', () => {
    expect(friendlyTool('canvas_create', false)).toBe('Building widget')
    expect(friendlyTool('canvas_create', true)).toBe('Sub-agent: building widget')
  })

  it('always labels sessions/subagent as delegating regardless of flag', () => {
    expect(friendlyTool('sessions_spawn', false)).toBe('Delegating to sub-agent')
    expect(friendlyTool('subagent_run', true)).toBe('Delegating to sub-agent')
  })

  it('falls back to the raw name, prefixed when delegated', () => {
    expect(friendlyTool('mystery_tool', false)).toBe('mystery_tool')
    expect(friendlyTool('mystery_tool', true)).toBe('Sub-agent: mystery_tool')
  })

  it('prioritises the web_search exact match over the search-prefix rule', () => {
    // web_search starts with neither "search" nor "grep"; guards regression on ordering
    expect(friendlyTool('web_search', true)).toBe('Searching the web')
  })

  it('maps the write prefix in the non-delegated case', () => {
    expect(friendlyTool('write_file', false)).toBe('Writing file')
  })

  it('maps the read prefix in the delegated case', () => {
    expect(friendlyTool('read_file', true)).toBe('Sub-agent: reading file')
  })

  it('matches the bare "browser" name via prefix', () => {
    expect(friendlyTool('browser', false)).toBe('Controlling browser')
  })

  it('maps sessions_yield through the sessions prefix', () => {
    expect(friendlyTool('sessions_yield', false)).toBe('Delegating to sub-agent')
  })
})
