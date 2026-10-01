// @vitest-environment node
//
// D2 — Enterprise 어드민 IPC 가 받는 경로의 **출처**를 고정한다.
//
// 핸들러 자체는 electron 없이 못 띄우므로, 핸들러가 부르는 두 관문 함수를 직접 본다:
// `requirePickedRoot`(다이얼로그로 고른 폴더인가) · `enterpriseRunPath`(uid·planId 가
// 한 세그먼트인가). 핸들러는 이 둘만 거치면 되므로 여기서 막히면 채널에서도 막힌다.
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { enterpriseRunPath, requirePickedRoot } from './enterpriseIpc'

const PICKED = path.join(os.tmpdir(), 'twixy-enterprise-picked')
const OTHER  = path.join(os.tmpdir(), 'twixy-enterprise-not-picked')

describe('requirePickedRoot — 다이얼로그가 돌려준 폴더만', () => {
  it('고른 폴더는 그대로 통과한다', () => {
    expect(requirePickedRoot(PICKED, [PICKED])).toBe(PICKED)
  })

  it('고르지 않은 폴더는 거부한다 (빈 결과가 아니라 throw)', () => {
    expect(() => requirePickedRoot(OTHER, [PICKED])).toThrow(/not_user_picked/)
  })

  it('목록이 비어 있으면 무엇도 통과하지 못한다', () => {
    expect(() => requirePickedRoot(PICKED, [])).toThrow(/not_user_picked/)
  })

  it('문자열이 아니거나 빈 값도 거부한다', () => {
    for (const bad of [undefined, null, '', 42, {}, ['/tmp']]) {
      expect(() => requirePickedRoot(bad, [PICKED]), JSON.stringify(bad) ?? String(bad)).toThrow(/not_user_picked/)
    }
  })
})

describe('enterpriseRunPath — uid·planId 는 한 세그먼트', () => {
  it('정상 id 는 <root>/users/<uid>/plans/<planId>/run.md 를 만든다', () => {
    expect(enterpriseRunPath(PICKED, 'u1', 'plan_abc', [PICKED]))
      .toBe(path.join(PICKED, 'users', 'u1', 'plans', 'plan_abc', 'run.md'))
  })

  it('uid 의 traversal 을 거부한다', () => {
    for (const bad of ['..', '../..', 'a/b', 'a\\b', '.']) {
      expect(() => enterpriseRunPath(PICKED, bad, 'plan_abc', [PICKED]), bad).toThrow(/invalid id/)
    }
  })

  it('planId 의 traversal 을 거부한다', () => {
    for (const bad of ['..', 'x/../../y', 'a\\b', '.. ']) {
      expect(() => enterpriseRunPath(PICKED, 'u1', bad, [PICKED]), bad).toThrow(/invalid id/)
    }
  })

  it('경로 검사가 id 검사보다 **먼저** 온다 — 고르지 않은 폴더는 id 가 멀쩡해도 못 읽는다', () => {
    expect(() => enterpriseRunPath(OTHER, 'u1', 'plan_abc', [PICKED])).toThrow(/not_user_picked/)
  })
})
