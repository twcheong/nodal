// ── 모바일 채널 설정의 타입 + 비밀값 마스킹 (순수 모듈: electron import 없음) ─────────
//
// main.ts 에서 옮겨 온 것. 여기 있는 이유는 하나 — **필드 배선을 테스트할 수 있게** 하려고.
// 마스킹은 필드마다 "이 비밀은 저 비밀과 짝" 을 손으로 잇는 코드라, slack.appToken 을
// botToken 에 잘못 이어도 타입검사는 멀쩡히 통과한다. 그 실수는 "토큰이 조용히 바뀐다" 로만
// 드러나므로, 눈으로 보는 대신 테스트가 잡게 한다.
import { maskSecret, mergeSecret } from '../shared/secretMask'

export type TelegramChannel    = { enabled: boolean; botToken?: string; allowFrom?: string[]; dmPolicy?: 'pairing' | 'allowlist' | 'open' }
export type DiscordChannel     = { enabled: boolean; token?: string }
export type SignalChannel      = { enabled: boolean; account?: string; cliPath?: string; allowFrom?: string[]; dmPolicy?: 'pairing' | 'allowlist' | 'open' }
export type BlueBubblesChannel = { enabled: boolean; serverUrl?: string; password?: string; webhookPath?: string }
export type SlackChannel       = { enabled: boolean; botToken?: string; appToken?: string; dmPolicy?: 'pairing' | 'allowlist' | 'open'; allowFrom?: string[] }
export type ChannelsConfig = {
  telegram?:    TelegramChannel
  discord?:     DiscordChannel
  signal?:      SignalChannel
  bluebubbles?: BlueBubblesChannel
  slack?:       SlackChannel
}

// ── 채널 비밀값 마스킹 ───────────────────────────────────────────
// 렌더러에 평문 토큰을 주지 않는다. 화면에는 끝 4자만 보이고, 저장 때 그 마스크가 돌아오면
// "안 바꿨다" 로 읽어 기존 값을 지킨다 (shared/secretMask.ts).
// 비밀이 아닌 필드(enabled·dmPolicy·allowFrom·serverUrl·account·cliPath·webhookPath)는 그대로 — 
// 그건 설정 화면이 실제로 편집해야 하는 값이다.
export function maskChannels(c: ChannelsConfig): ChannelsConfig {
  return {
    ...c,
    ...(c.telegram    ? { telegram:    { ...c.telegram,    botToken: maskSecret(c.telegram.botToken ?? '') } }       : {}),
    ...(c.discord     ? { discord:     { ...c.discord,     token:    maskSecret(c.discord.token ?? '') } }           : {}),
    ...(c.slack       ? { slack:       { ...c.slack,       botToken: maskSecret(c.slack.botToken ?? ''),
                                                            appToken: maskSecret(c.slack.appToken ?? '') } }          : {}),
    ...(c.bluebubbles ? { bluebubbles: { ...c.bluebubbles, password: maskSecret(c.bluebubbles.password ?? '') } }     : {}),
  }
}

/** 들어온 설정에서 마스크인 비밀값만 디스크의 기존 값으로 되돌린다. */
export function unmaskChannels(incoming: ChannelsConfig, existing: ChannelsConfig): ChannelsConfig {
  return {
    ...incoming,
    ...(incoming.telegram    ? { telegram:    { ...incoming.telegram,    botToken: mergeSecret(incoming.telegram.botToken,    existing.telegram?.botToken) } }    : {}),
    ...(incoming.discord     ? { discord:     { ...incoming.discord,     token:    mergeSecret(incoming.discord.token,        existing.discord?.token) } }        : {}),
    ...(incoming.slack       ? { slack:       { ...incoming.slack,       botToken: mergeSecret(incoming.slack.botToken,       existing.slack?.botToken),
                                                                          appToken: mergeSecret(incoming.slack.appToken,       existing.slack?.appToken) } }      : {}),
    ...(incoming.bluebubbles ? { bluebubbles: { ...incoming.bluebubbles, password: mergeSecret(incoming.bluebubbles.password, existing.bluebubbles?.password) } } : {}),
  }
}

// ── openclaw.json 의 channels 블록 조립 (main.ts 에서 이동) ───────
// Discord 토큰만 환경변수(DISCORD_BOT_TOKEN) 로 전달하고 나머지는 config 인라인.

/**
 * Build the `channels` block injected into ~/.openclaw/openclaw.json.
 * Only enabled channels with the minimum required credentials are emitted —
 * partially-filled forms are skipped so the gateway doesn't fail to start.
 */
export function buildChannelsBlock(c: ChannelsConfig): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}

  if (c.telegram?.enabled && c.telegram.botToken) {
    out.telegram = {
      enabled: true,
      botToken: c.telegram.botToken,
      dmPolicy: c.telegram.dmPolicy ?? 'allowlist',
      ...(c.telegram.allowFrom?.length ? { allowFrom: c.telegram.allowFrom } : {}),
    }
  }
  // Discord token is passed via DISCORD_BOT_TOKEN env (see startOpenClaw)
  if (c.discord?.enabled && c.discord.token) {
    out.discord = {
      enabled: true,
      token: { source: 'env', provider: 'default', id: 'DISCORD_BOT_TOKEN' },
    }
  }
  if (c.signal?.enabled && c.signal.account) {
    out.signal = {
      enabled: true,
      account: c.signal.account,
      cliPath: c.signal.cliPath || 'signal-cli',
      dmPolicy: c.signal.dmPolicy ?? 'allowlist',
      ...(c.signal.allowFrom?.length ? { allowFrom: c.signal.allowFrom } : {}),
    }
  }
  if (c.bluebubbles?.enabled && c.bluebubbles.serverUrl && c.bluebubbles.password) {
    out.bluebubbles = {
      enabled: true,
      serverUrl: c.bluebubbles.serverUrl,
      password: c.bluebubbles.password,
      webhookPath: c.bluebubbles.webhookPath || '/bluebubbles-webhook',
    }
  }
  // Slack: Socket Mode. botToken+appToken 둘 다 있어야 기동. 평문 인라인.
  if (c.slack?.enabled && c.slack.botToken && c.slack.appToken) {
    out.slack = {
      enabled: true,
      mode: 'socket',
      botToken: c.slack.botToken,
      appToken: c.slack.appToken,
      dmPolicy: c.slack.dmPolicy ?? 'allowlist',
      ...(c.slack.allowFrom?.length ? { allowFrom: c.slack.allowFrom } : {}),
    }
  }

  return Object.keys(out).length ? out : undefined
}
