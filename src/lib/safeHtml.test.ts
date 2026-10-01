import { describe, it, expect } from 'vitest'
import { safeHtml } from './safeHtml'

describe('safeHtml', () => {
  it('정상 서식은 유지', () => {
    expect(safeHtml('<b>hi</b> <a href="https://x.com">link</a>')).toContain('<b>hi</b>')
  })
  it('script / event handler / javascript: URL 제거', () => {
    expect(safeHtml('<script>alert(1)</script>hi')).not.toContain('<script')
    expect(safeHtml('<img src=x onerror="alert(1)">')).not.toContain('onerror')
    expect(safeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  })
  it('문자열 아니면 빈 문자열', () => {
    expect(safeHtml(null)).toBe('')
    expect(safeHtml(undefined)).toBe('')
  })
})
