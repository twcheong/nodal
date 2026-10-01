// @vitest-environment node
// 채널 비밀값 마스킹의 **필드 배선**. 규칙 자체는 shared/secretMask.test.ts 가 덮는다.
// 여기서 잡으려는 것은 "slack.appToken 을 botToken 에 이어 버렸다" 류 — 타입검사는 통과하고
// 증상은 "저장했더니 토큰이 서로 바뀌었다" 로만 나타나는 실수다.
import { describe, expect, it } from 'vitest'
import { maskChannels, unmaskChannels, type ChannelsConfig } from './channelSecrets'
import { isMaskedSecret } from '../shared/secretMask'

/** 필드마다 값을 다르게 둔다 — 서로 바꿔 이으면 즉시 틀린다. */
const STORED: ChannelsConfig = {
  telegram:    { enabled: true, botToken: 'tg-bot-token-AAAA', dmPolicy: 'allowlist', allowFrom: ['123'] },
  discord:     { enabled: true, token: 'discord-token-BBBB' },
  slack:       { enabled: true, botToken: 'xoxb-slack-bot-CCCC', appToken: 'xapp-slack-app-DDDD', dmPolicy: 'open' },
  bluebubbles: { enabled: true, serverUrl: 'http://bb.local', password: 'bb-password-EEEE', webhookPath: '/hook' },
  signal:      { enabled: true, account: '+8210', cliPath: 'signal-cli' },
}

describe('maskChannels — 내보낼 때', () => {
  it('비밀값은 전부 마스크가 되고 평문이 남지 않는다', () => {
    const m = maskChannels(STORED)
    expect(isMaskedSecret(m.telegram!.botToken!)).toBe(true)
    expect(isMaskedSecret(m.discord!.token!)).toBe(true)
    expect(isMaskedSecret(m.slack!.botToken!)).toBe(true)
    expect(isMaskedSecret(m.slack!.appToken!)).toBe(true)
    expect(isMaskedSecret(m.bluebubbles!.password!)).toBe(true)
    const json = JSON.stringify(m)
    for (const secret of ['tg-bot-token-AAAA', 'discord-token-BBBB', 'xoxb-slack-bot-CCCC', 'xapp-slack-app-DDDD', 'bb-password-EEEE']) {
      expect(json).not.toContain(secret)
    }
  })

  it('필드가 섞이지 않는다 — 마스크 끝 4자가 각자의 값에서 온다', () => {
    const m = maskChannels(STORED)
    expect(m.telegram!.botToken!.endsWith('AAAA')).toBe(true)
    expect(m.discord!.token!.endsWith('BBBB')).toBe(true)
    expect(m.slack!.botToken!.endsWith('CCCC')).toBe(true)
    expect(m.slack!.appToken!.endsWith('DDDD')).toBe(true)
    expect(m.bluebubbles!.password!.endsWith('EEEE')).toBe(true)
  })

  it('비밀이 아닌 필드는 그대로 (설정 화면이 실제로 편집하는 값)', () => {
    const m = maskChannels(STORED)
    expect(m.telegram).toMatchObject({ enabled: true, dmPolicy: 'allowlist', allowFrom: ['123'] })
    expect(m.bluebubbles).toMatchObject({ serverUrl: 'http://bb.local', webhookPath: '/hook' })
    expect(m.slack!.dmPolicy).toBe('open')
    expect(m.signal).toEqual(STORED.signal)          // signal 엔 비밀 필드가 없다
  })

  it('설정이 비어 있으면 마스크도 없다', () => {
    expect(maskChannels({})).toEqual({})
    expect(maskChannels({ telegram: { enabled: false } }).telegram!.botToken).toBe('')
  })
})

describe('unmaskChannels — 돌아올 때', () => {
  it('아무것도 안 건드린 왕복은 저장된 값을 그대로 지킨다 (이 기능의 핵심)', () => {
    expect(unmaskChannels(maskChannels(STORED), STORED)).toEqual(STORED)
  })

  it('한 필드만 새로 입력하면 그 필드만 바뀐다', () => {
    const sent = maskChannels(STORED)
    sent.slack = { ...sent.slack!, appToken: 'xapp-NEW-VALUE' }
    const merged = unmaskChannels(sent, STORED)
    expect(merged.slack!.appToken).toBe('xapp-NEW-VALUE')
    expect(merged.slack!.botToken).toBe('xoxb-slack-bot-CCCC')   // 옆 필드 보존
    expect(merged.telegram!.botToken).toBe('tg-bot-token-AAAA')
    expect(merged.bluebubbles!.password).toBe('bb-password-EEEE')
  })

  it('빈 문자열은 삭제 의사 — 기존 동작 유지', () => {
    const sent = maskChannels(STORED)
    sent.telegram = { ...sent.telegram!, botToken: '' }
    expect(unmaskChannels(sent, STORED).telegram!.botToken).toBe('')
  })

  it('저장된 게 없는 상태에서 처음 입력하는 경우', () => {
    const merged = unmaskChannels({ telegram: { enabled: true, botToken: 'first-token' } }, {})
    expect(merged.telegram!.botToken).toBe('first-token')
  })

  it('마스크가 왔는데 디스크에 값이 없으면 undefined (마스크를 저장하지 않는다)', () => {
    const merged = unmaskChannels(maskChannels(STORED), {})
    expect(merged.telegram!.botToken).toBeUndefined()
    expect(merged.slack!.appToken).toBeUndefined()
    expect(JSON.stringify(merged)).not.toContain('•')
  })
})
