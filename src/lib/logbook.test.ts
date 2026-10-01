import { describe, it, expect } from 'vitest'
import { l6TaskId, l7TaskId } from './logbook'

describe('l6TaskId', () => {
  it('formats plan:step:<planId>:<stepId>', () => {
    expect(l6TaskId('p1', 's1')).toBe('plan:step:p1:s1')
  })

  it('sanitizes colons in ids to underscores', () => {
    expect(l6TaskId('a:b', 'c:d')).toBe('plan:step:a_b:c_d')
  })

  it('handles empty parts', () => {
    expect(l6TaskId('', '')).toBe('plan:step::')
  })
})

describe('l7TaskId', () => {
  it('formats plan:step:exec:<planId>:<stepId>', () => {
    expect(l7TaskId('p1', 's1')).toBe('plan:step:exec:p1:s1')
  })

  it('sanitizes colons in ids to underscores', () => {
    expect(l7TaskId('a:b:c', 's:1')).toBe('plan:step:exec:a_b_c:s_1')
  })
})

describe('l6/l7 relationship', () => {
  it('l7 is the exec-prefixed sibling of l6', () => {
    const l6 = l6TaskId('plan9', 's3')
    const l7 = l7TaskId('plan9', 's3')
    expect(l6).toBe('plan:step:plan9:s3')
    expect(l7).toBe('plan:step:exec:plan9:s3')
    expect(l7).not.toBe(l6)
  })
})
