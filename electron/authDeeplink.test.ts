// @vitest-environment node
// 로그인 딥링크·JWT 파싱 — main.ts 에서 옮긴 순수 함수의 동작을 고정한다 (옮기기 전과 동일해야 한다).
import { describe, expect, it } from 'vitest'
import { decodeJwtPayload, parseAuthDeeplink } from './authDeeplink'

/** 서명은 아무 값 — decodeJwtPayload 는 서명을 검증하지 않는다 (신원 추출용). */
function jwt(payload: unknown): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`
}

describe('decodeJwtPayload', () => {
  it('sub · email 을 뽑는다', () => {
    expect(decodeJwtPayload(jwt({ sub: 'u-123', email: 'a@b.co', role: 'authenticated' })))
      .toEqual({ sub: 'u-123', email: 'a@b.co' })
  })

  it('base64url 전용 문자(- _)와 패딩 없는 길이도 읽는다', () => {
    // '>>>' '???' 는 base64 로 '+' '/' 를 만든다 → base64url 에서는 '-' '_'. 길이도 4 의 배수가 아니게.
    const token = jwt({ sub: 'u>>>???', email: '한글@예시.kr' })
    expect(token.split('.')[1]).toMatch(/[-_]/)
    expect(decodeJwtPayload(token)).toEqual({ sub: 'u>>>???', email: '한글@예시.kr' })
  })

  it('클레임이 없으면 undefined 필드로 (null 아님)', () => {
    expect(decodeJwtPayload(jwt({ role: 'anon' }))).toEqual({ sub: undefined, email: undefined })
  })

  it('JWT 모양이 아니면 null', () => {
    expect(decodeJwtPayload('')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
    expect(decodeJwtPayload('a.b.c.d')).toBeNull()
    expect(decodeJwtPayload('a.!!!not-base64-json!!!.c')).toBeNull()
    expect(decodeJwtPayload(undefined as unknown as string)).toBeNull()
  })
})

describe('parseAuthDeeplink', () => {
  const access = jwt({ sub: 'u-123', email: 'a@b.co' })

  it('hash 의 토큰을 읽고 JWT 에서 user 를 채운다', () => {
    expect(parseAuthDeeplink(`twixy://auth#access_token=${access}&refresh_token=r1&expires_at=1726700000`, 'twixy'))
      .toEqual({ access_token: access, refresh_token: 'r1', expires_at: 1726700000, user: { id: 'u-123', email: 'a@b.co' } })
  })

  it('hash 가 없으면 query 로 폴백', () => {
    const s = parseAuthDeeplink(`twixy://auth?access_token=${access}&refresh_token=r1`, 'twixy')
    expect(s?.refresh_token).toBe('r1')
    expect(s?.expires_at).toBeNull()
  })

  it('스킴은 제품마다 다르다 — 주입한 스킴만 받는다', () => {
    const url = `nodal://auth#access_token=${access}&refresh_token=r1`
    expect(parseAuthDeeplink(url, 'nodal')?.refresh_token).toBe('r1')
    expect(parseAuthDeeplink(url, 'twixy')).toBeNull()
    expect(parseAuthDeeplink(`https://evil.example/auth#access_token=${access}&refresh_token=r1`, 'twixy')).toBeNull()
  })

  it('토큰이 하나라도 없으면 null', () => {
    expect(parseAuthDeeplink(`twixy://auth#access_token=${access}`, 'twixy')).toBeNull()
    expect(parseAuthDeeplink('twixy://auth#refresh_token=r1', 'twixy')).toBeNull()
    expect(parseAuthDeeplink('twixy://auth', 'twixy')).toBeNull()
  })

  it('expires_at 이 숫자가 아니면 null 로 두고 세션은 받는다', () => {
    expect(parseAuthDeeplink(`twixy://auth#access_token=${access}&refresh_token=r1&expires_at=soon`, 'twixy')?.expires_at).toBeNull()
  })

  it('access_token 이 JWT 가 아니어도 세션은 받되 user 는 비운다', () => {
    const s = parseAuthDeeplink('twixy://auth#access_token=opaque&refresh_token=r1', 'twixy')
    expect(s).toEqual({ access_token: 'opaque', refresh_token: 'r1', expires_at: null, user: undefined })
  })

  it('URL 이 아니면 null', () => {
    expect(parseAuthDeeplink('not a url', 'twixy')).toBeNull()
    expect(parseAuthDeeplink('', 'twixy')).toBeNull()
  })
})
