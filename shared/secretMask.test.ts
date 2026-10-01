// @vitest-environment node
// 마스킹 규칙 — main 과 렌더러가 공유하는 유일한 출처. 핵심은 "마스크를 저장하면 안 된다".
import { describe, expect, it } from 'vitest'
import { isMaskedSecret, maskSecret, mergeSecret, SECRET_MASK_PREFIX } from './secretMask'

const REAL = 'fixture-secret-1234567890-abcdefghijklmnop'

describe('maskSecret', () => {
  it('끝 4자만 남긴다', () => {
    expect(maskSecret(REAL)).toBe(SECRET_MASK_PREFIX + 'mnop')
    expect(maskSecret('sk-ant-api03-SECRETVALUE9zyx')).toBe(SECRET_MASK_PREFIX + '9zyx')
  })

  it('마스크에 비밀 본문이 남지 않는다', () => {
    const m = maskSecret(REAL)
    expect(m).not.toContain('1234567890')
    expect(m).not.toContain('abcdefghijkl')
    expect(m.length).toBeLessThanOrEqual(SECRET_MASK_PREFIX.length + 4)
  })

  it('4자 이하는 끝자리도 안 남긴다 (그게 값 전체라서)', () => {
    for (const v of ['a', 'ab', 'abc', 'abcd']) expect(maskSecret(v)).toBe(SECRET_MASK_PREFIX)
  })

  it('빈 값은 빈 값 — 저장된 게 없으면 마스크도 없다', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret(undefined as unknown as string)).toBe('')
  })
})

describe('isMaskedSecret', () => {
  it('우리가 만든 마스크만 참', () => {
    expect(isMaskedSecret(maskSecret(REAL))).toBe(true)
    expect(isMaskedSecret(SECRET_MASK_PREFIX)).toBe(true)
  })

  it('진짜 비밀값·빈 값·문자열 아닌 값은 거짓', () => {
    for (const v of [REAL, 'sk-ant-xxx', '', '****1234', '••1234', undefined, null, 42, {}]) {
      expect(isMaskedSecret(v), String(v)).toBe(false)
    }
  })
})

describe('mergeSecret — 저장 시 세 갈래', () => {
  it('마스크가 들어오면 기존 값을 지킨다 (이 규칙이 존재하는 이유)', () => {
    expect(mergeSecret(maskSecret(REAL), REAL)).toBe(REAL)
    expect(mergeSecret(SECRET_MASK_PREFIX, REAL)).toBe(REAL)
    // 사용자가 마스크 뒤에 덧붙여도 기존 값이 날아가지는 않는다 (UI 가 애초에 못 하게 막지만,
    // 여기서도 안전한 쪽으로 — 키를 잃는 것보다 안 바뀐 게 낫다).
    expect(mergeSecret(maskSecret(REAL) + 'oops', REAL)).toBe(REAL)
  })

  it('빈 문자열은 삭제 — 기존 동작 유지', () => {
    expect(mergeSecret('', REAL)).toBe('')
  })

  it('새 값은 그대로 교체', () => {
    expect(mergeSecret('sk-new-key-value', REAL)).toBe('sk-new-key-value')
  })

  it('저장된 게 없는데 마스크가 오면 undefined', () => {
    expect(mergeSecret(maskSecret(REAL), undefined)).toBeUndefined()
  })

  it('문자열이 아닌 값은 undefined', () => {
    expect(mergeSecret(undefined, REAL)).toBeUndefined()
    expect(mergeSecret(42, REAL)).toBeUndefined()
  })
})
