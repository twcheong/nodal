import { describe, it, expect } from 'vitest'
import { compareSemver } from './appRelease'

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('0.0.0', '0.0.0')).toBe(0)
  })

  it('returns 1 when a > b and -1 when a < b', () => {
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1)
    expect(compareSemver('0.1.9', '0.2.0')).toBe(-1)
  })

  it('compares major/minor/patch in order of significance', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.2.0', '1.1.99')).toBe(1)
    expect(compareSemver('1.1.5', '1.1.4')).toBe(1)
  })

  it('treats missing trailing parts as 0', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0)
    expect(compareSemver('1', '1.0.0')).toBe(0)
    expect(compareSemver('1.2.1', '1.2')).toBe(1)
    expect(compareSemver('1.2', '1.2.1')).toBe(-1)
  })

  it('ignores non-numeric / prerelease tags (parseInt fallback to 0)', () => {
    // "1.0.0-beta" -> [1, 0, NaN||0] == "1.0.0"
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(0)
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBe(0)
  })

  it('handles multi-digit numeric parts (not lexicographic)', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1)
  })

  it('is antisymmetric across a range of pairs', () => {
    const pairs: [string, string][] = [
      ['0.1.0', '0.2.0'],
      ['1.0.0', '1.0.1'],
      ['2.3.4', '2.3.4'],
      ['10.0.0', '9.99.99'],
    ]
    for (const [a, b] of pairs) {
      // `|| 0` normalizes -0 -> 0 so toBe (Object.is) does not distinguish signed zero.
      expect(Math.sign(compareSemver(a, b)) || 0).toBe(Math.sign(-compareSemver(b, a)) || 0)
    }
  })
})
