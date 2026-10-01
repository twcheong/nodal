import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runnerHarnessPreamble, harnessLabel } from './runnerHarness'

// localStorage 스텁 — 게이팅만 검증. ?raw SOUL 은 vitest(vite) 가 로드.
function stubStorage(value: string | null) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'twixy.runnerHarness' ? value : null),
    setItem: () => {}, removeItem: () => {},
  })
}

describe('runnerHarness gating (기본 ON)', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it("기본(플래그 없음) → 하네스 주입 + v3 SOUL 본문 포함", () => {
    stubStorage(null)
    const out = runnerHarnessPreamble()
    expect(out.startsWith('[Runner Harness')).toBe(true)
    expect(out).toContain('Reasoning')   // v3 SOUL 본문 실제 로드 확인
    expect(harnessLabel()).toBe('v3')
  })

  it("'off' → 빈 문자열, baseline", () => {
    stubStorage('off')
    expect(runnerHarnessPreamble()).toBe('')
    expect(harnessLabel()).toBe('off')
  })

  it('off 외 다른 값 → 여전히 ON', () => {
    stubStorage('anything')
    expect(runnerHarnessPreamble().startsWith('[Runner Harness')).toBe(true)
    expect(harnessLabel()).toBe('v3')
  })

  it('localStorage 접근 자체가 throw 해도 안전(ON 취급 = 릴리즈 기본)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
    expect(runnerHarnessPreamble().startsWith('[Runner Harness')).toBe(true)
    expect(harnessLabel()).toBe('v3')
  })
})
