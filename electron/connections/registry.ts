import {
  connect    as googleConnect,
  disconnect as googleDisconnect,
  status     as googleStatus,
} from '../google/oauth'
import { GMAIL_SEND_SCOPE } from '../google/gmail'
import { getSecret, setSecret, deleteSecret, type VaultService } from './vault'

/**
 * Connections service registry — single source of truth for the
 * Settings → Connections section (Claude.ai-connector-style cards).
 *
 * Status model only — tokens never leave the main process:
 *   - google  : mirrors the existing Google Workspace OAuth state
 *               (electron/google/oauth.ts). `needs_reauth` when connected
 *               but the granted scopes predate gmail.send.
 *   - discord : token-input service. Token lives in the safeStorage vault;
 *               validated against the Discord API on save.
 *   - notion / slack / kakao : registered placeholders ("준비 중") —
 *               activated in a later phase (Notion MCP client, Slack app).
 */

export type ConnectionService = 'google' | 'notion' | 'slack' | 'discord' | 'kakao'

export type ConnectionState = 'connected' | 'disconnected' | 'needs_reauth' | 'coming_soon'

export type ConnectionInfo = {
  service:   ConnectionService
  connected: boolean
  state:     ConnectionState
  /** Display label only (email / bot name) — never a token. */
  account?:  string | null
  /** Optional human-readable hint (e.g. which permission is missing). */
  detail?:   string | null
}

export interface ConnectionDeps {
  /** <projectRoot>/.twixy — where the existing Google OAuth state lives. */
  getTwixyMetaDir: () => string
  /** Electron userData dir — where the connections vault lives. */
  getUserDataDir:  () => string
}

const COMING_SOON: ConnectionService[] = ['notion', 'slack', 'kakao']

function googleConnection(metaDir: string): ConnectionInfo {
  try {
    const s = googleStatus(metaDir)
    if (!s.connected) {
      return {
        service: 'google', connected: false, state: 'disconnected',
        detail: s.hasClient ? null : 'OAuth client (ID/Secret) not configured yet',
      }
    }
    const scopes = s.scopes ?? []
    const hasGmailSend = scopes.includes(GMAIL_SEND_SCOPE)
    return {
      service:   'google',
      connected: true,
      state:     hasGmailSend ? 'connected' : 'needs_reauth',
      account:   s.email ?? null,
      detail:    hasGmailSend ? null : 'gmail.send permission missing — re-consent required',
    }
  } catch {
    return { service: 'google', connected: false, state: 'disconnected' }
  }
}

function vaultConnection(userDataDir: string, service: VaultService & ConnectionService): ConnectionInfo {
  const entry = getSecret(userDataDir, service)
  if (entry?.token) {
    return { service, connected: true, state: 'connected', account: entry.account ?? null }
  }
  return { service, connected: false, state: COMING_SOON.includes(service) ? 'coming_soon' : 'disconnected' }
}

export function listConnections(deps: ConnectionDeps): ConnectionInfo[] {
  const metaDir     = deps.getTwixyMetaDir()
  const userDataDir = deps.getUserDataDir()
  return [
    googleConnection(metaDir),
    vaultConnection(userDataDir, 'notion'),
    vaultConnection(userDataDir, 'slack'),
    vaultConnection(userDataDir, 'discord'),
    vaultConnection(userDataDir, 'kakao'),
  ]
}

/**
 * Trigger the interactive connect flow for a service.
 * - google: reuses the existing loopback-PKCE OAuth flow (system browser +
 *   127.0.0.1 callback). Because oauth.ts always requests the full
 *   GOOGLE_SCOPES list with prompt=consent, this same call also serves as
 *   the "권한 추가" re-consent path when gmail.send is missing.
 * - discord: token-input service — use setServiceToken() instead.
 * - notion/slack/kakao: not wired yet.
 */
export async function connectService(deps: ConnectionDeps, service: ConnectionService): Promise<ConnectionInfo> {
  if (service === 'google') {
    await googleConnect(deps.getTwixyMetaDir())
    return googleConnection(deps.getTwixyMetaDir())
  }
  if (service === 'discord') {
    throw new Error('discord_requires_token: paste a bot token in Settings → 연동 instead.')
  }
  throw new Error(`${service}_not_available_yet: this connector ships in a later phase.`)
}

export function disconnectService(deps: ConnectionDeps, service: ConnectionService): ConnectionInfo {
  if (service === 'google') {
    googleDisconnect(deps.getTwixyMetaDir())
    return googleConnection(deps.getTwixyMetaDir())
  }
  deleteSecret(deps.getUserDataDir(), service)
  return vaultConnection(deps.getUserDataDir(), service)
}

/**
 * Save a token for a token-input service (Discord today). The token is
 * validated against the live API in the main process before being stored,
 * so a successful save always carries the resolved account label.
 */
export async function setServiceToken(deps: ConnectionDeps, service: ConnectionService, token: string): Promise<ConnectionInfo> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('empty_token')
  if (service === 'google') {
    throw new Error('google_uses_oauth: connect Google via the OAuth flow, not a raw token.')
  }
  if (service !== 'discord') {
    throw new Error(`${service}_not_available_yet: this connector ships in a later phase.`)
  }
  const account = await validateDiscordBotToken(trimmed)
  setSecret(deps.getUserDataDir(), service, trimmed, account)
  return vaultConnection(deps.getUserDataDir(), service)
}

/** GET /users/@me with the bot token; returns the bot's username on success. */
async function validateDiscordBotToken(token: string): Promise<string> {
  let res: Response
  try {
    res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    })
  } catch (err) {
    throw new Error(`discord_unreachable: ${String((err as Error)?.message ?? err)}`)
  }
  if (res.status === 401) throw new Error('discord_invalid_token: Discord rejected this bot token (401).')
  if (!res.ok) throw new Error(`discord_validation_failed: HTTP ${res.status}`)
  const me = await res.json() as { username?: string; discriminator?: string }
  if (!me?.username) throw new Error('discord_validation_failed: no username in response')
  return me.discriminator && me.discriminator !== '0'
    ? `${me.username}#${me.discriminator}`
    : me.username
}
