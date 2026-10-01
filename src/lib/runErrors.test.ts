import { describe, it, expect } from 'vitest'
import { classifyRunError, friendlyRunError, isCreditLimitError } from './runErrors'

describe('classifyRunError', () => {
  it('classifies credit-limit strings as terminal', () => {
    const info = classifyRunError('403 Key limit exceeded (monthly limit)')
    expect(info.kind).toBe('credit_limit')
    expect(info.terminal).toBe(true)
    expect(info.hint).toBeTruthy()
  })
  it('prefers credit over rate limit when a 429 body mentions credits', () => {
    expect(classifyRunError('429 insufficient_credits').kind).toBe('credit_limit')
  })
  it('classifies a plain rate limit as non-terminal', () => {
    const info = classifyRunError('429 Too Many Requests')
    expect(info.kind).toBe('rate_limit')
    expect(info.terminal).toBe(false)
  })
  it('classifies auth errors', () => {
    expect(classifyRunError('401 invalid api key').kind).toBe('auth')
  })
  it('classifies image-input errors', () => {
    expect(classifyRunError('No endpoints found that support image input').kind).toBe('no_image_input')
  })
  it('classifies network errors as non-terminal', () => {
    const info = classifyRunError('fetch failed: ECONNREFUSED')
    expect(info.kind).toBe('network')
    expect(info.terminal).toBe(false)
  })
  it('classifies user aborts', () => {
    expect(classifyRunError('aborted').kind).toBe('aborted')
    expect(classifyRunError('run_cancelled').kind).toBe('aborted')
  })
  it('reads the message off an Error instance', () => {
    expect(classifyRunError(new Error('credit balance is too low')).kind).toBe('credit_limit')
  })
  it('falls back to unknown, preserving the raw string as summary', () => {
    const info = classifyRunError('some weird failure')
    expect(info.kind).toBe('unknown')
    expect(info.summary).toBe('some weird failure')
    expect(info.raw).toBe('some weird failure')
  })
  it('handles null/undefined input', () => {
    const info = classifyRunError(undefined)
    expect(info.kind).toBe('unknown')
    expect(info.summary).toBe('Unknown error')
  })
})

describe('friendlyRunError', () => {
  it('joins summary and hint for a classified error', () => {
    expect(friendlyRunError('key limit exceeded')).toMatch(/AI credit limit reached — /)
  })
  it('returns the raw summary for unknown errors', () => {
    expect(friendlyRunError('mystery')).toBe('mystery')
  })
})

describe('isCreditLimitError', () => {
  it('is true only for credit-limit errors', () => {
    expect(isCreditLimitError('insufficient_quota')).toBe(true)
    expect(isCreditLimitError('429 rate limit')).toBe(false)
  })
})
