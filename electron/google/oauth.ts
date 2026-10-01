import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { URL } from 'node:url'
import { shell, safeStorage } from 'electron'
import { OAuth2Client } from 'google-auth-library'

/**
 * Loopback-PKCE OAuth flow for Google Workspace per Google's "OAuth 2.0
 * for Desktop apps" guidance:
 *   https://developers.google.com/identity/protocols/oauth2/native-app
 *
 * - The user supplies a "Desktop" OAuth client (client_id + client_secret)
 *   from GCP Console once. We persist them at <metaDir>/google-client.json.
 * - On `connect()`, we boot an ephemeral http server on localhost, open the
 *   auth URL in the user's default browser, exchange the returned code (with
 *   PKCE verifier) for tokens, and persist them encrypted with safeStorage.
 * - Subsequent calls to `getAuthorizedClient()` return an OAuth2Client with
 *   the refresh token loaded — google-auth-library handles access-token
 *   refresh automatically.
 *
 * Token storage lives in `<projectRoot>/.twixy/`, the same directory used
 * for project config — never inside the agent-visible workspace, since
 * SOUL.md's whitelist scopes the LLM agent (not main process) to data/*.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  // drive.file = only files this app created or that the user explicitly
  // opened with it. Avoids requesting full Drive scope.
  'https://www.googleapis.com/auth/drive.file',
  // gmail.send = compose+send only; no read access to the mailbox.
  // NOTE: users who connected before this scope was added keep their old
  // token until they re-consent — tool_send_email surfaces a clear
  // "설정 > 연동에서 Google 권한을 갱신하세요" error in that case, and the
  // Connections UI shows the card as "권한 추가 필요".
  'https://www.googleapis.com/auth/gmail.send',
  // gmail.readonly = read mailbox (list/search/read messages); no send or
  // mutate. Added for tool_read_gmail (고객 문의·회신 맥락 파악). Same
  // re-consent caveat as gmail.send above — readMessages/listMessages
  // surface a clear "설정 > 연동에서 Google 권한을 갱신하세요" error when
  // the stored token predates this scope.
  'https://www.googleapis.com/auth/gmail.readonly',
] as const

export type GoogleClientConfig = {
  clientId:     string
  clientSecret: string
}

export type GoogleTokenSet = {
  access_token?:  string | null
  refresh_token?: string | null
  scope?:         string | null
  token_type?:    string | null
  expiry_date?:   number | null
  id_token?:      string | null
  email?:         string | null
}

export type GoogleStatus = {
  connected:  boolean
  hasClient:  boolean
  email?:     string | null
  scopes?:    string[]
  expiresAt?: number | null
}

const CLIENT_FILE = 'google-client.json'
const TOKEN_FILE  = 'google-tokens.enc'

function clientPath(metaDir: string): string { return path.join(metaDir, CLIENT_FILE) }
function tokenPath(metaDir: string): string  { return path.join(metaDir, TOKEN_FILE) }

export function loadClientConfig(metaDir: string): GoogleClientConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(clientPath(metaDir), 'utf8')) as Record<string, unknown>
    if (typeof raw.clientId !== 'string' || typeof raw.clientSecret !== 'string') return null
    if (!raw.clientId || !raw.clientSecret) return null
    return { clientId: raw.clientId, clientSecret: raw.clientSecret }
  } catch { return null }
}

export function saveClientConfig(metaDir: string, cfg: GoogleClientConfig): void {
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(clientPath(metaDir), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

export function deleteClientConfig(metaDir: string): void {
  try { fs.unlinkSync(clientPath(metaDir)) } catch { /* missing is fine */ }
}

function loadTokens(metaDir: string): GoogleTokenSet | null {
  try {
    const buf = fs.readFileSync(tokenPath(metaDir))
    const decrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
    const parsed = JSON.parse(decrypted) as GoogleTokenSet
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

function saveTokens(metaDir: string, tokens: GoogleTokenSet): void {
  fs.mkdirSync(metaDir, { recursive: true })
  const json = JSON.stringify(tokens)
  const out  = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  fs.writeFileSync(tokenPath(metaDir), out, { mode: 0o600 })
}

function deleteTokens(metaDir: string): void {
  try { fs.unlinkSync(tokenPath(metaDir)) } catch { /* missing is fine */ }
}

function makePkcePair(): { verifier: string; challenge: string } {
  const verifier  = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function decodeIdTokenEmail(idToken: string | null | undefined): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : null
  } catch { return null }
}

/**
 * Run the loopback-PKCE flow end to end. Resolves once tokens are saved.
 * The promise rejects if the user closes the browser tab without completing,
 * or if the redirected callback carries an `error` param.
 */
export async function connect(metaDir: string, opts?: { timeoutMs?: number }): Promise<GoogleStatus> {
  const cfg = loadClientConfig(metaDir)
  if (!cfg) throw new Error('Google client not configured. Set client_id + client_secret in Settings → Google Workspace.')

  const { verifier, challenge } = makePkcePair()
  const state = crypto.randomBytes(16).toString('base64url')
  const timeoutMs = opts?.timeoutMs ?? 5 * 60 * 1000

  return await new Promise<GoogleStatus>((resolve, reject) => {
    let settled = false

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost`)
        if (url.pathname !== '/oauth2/callback') {
          res.writeHead(404).end()
          return
        }
        const err   = url.searchParams.get('error')
        const code  = url.searchParams.get('code')
        const recvd = url.searchParams.get('state')
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(htmlPage('Twixy — Google connection failed', `<p>${escapeHtml(err)}</p>`))
          finish(reject, new Error(`oauth_error: ${err}`))
          return
        }
        if (!code || recvd !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(htmlPage('Twixy — Google connection failed', '<p>Missing or invalid state.</p>'))
          finish(reject, new Error('oauth_state_mismatch'))
          return
        }
        const port = (server.address() as { port: number } | null)?.port
        if (!port) {
          res.writeHead(500).end()
          finish(reject, new Error('oauth_no_port'))
          return
        }
        const redirectUri = `http://localhost:${port}/oauth2/callback`
        const oauth = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri })
        oauth.getToken({ code, codeVerifier: verifier })
          .then(({ tokens }) => {
            const merged: GoogleTokenSet = {
              access_token:  tokens.access_token  ?? null,
              refresh_token: tokens.refresh_token ?? null,
              scope:         tokens.scope         ?? null,
              token_type:    tokens.token_type    ?? null,
              expiry_date:   tokens.expiry_date   ?? null,
              id_token:      tokens.id_token      ?? null,
              email:         decodeIdTokenEmail(tokens.id_token),
            }
            saveTokens(metaDir, merged)
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(htmlPage('Twixy — Google connected', '<p>You can close this tab and return to Twixy.</p>'))
            finish(resolve, {
              connected: true,
              hasClient: true,
              email:     merged.email,
              scopes:    merged.scope ? merged.scope.split(' ') : [],
              expiresAt: merged.expiry_date ?? null,
            })
          })
          .catch((e: unknown) => {
            res.writeHead(500, { 'Content-Type': 'text/html' })
            res.end(htmlPage('Twixy — Google connection failed', `<p>${escapeHtml(String(e))}</p>`))
            finish(reject, e instanceof Error ? e : new Error(String(e)))
          })
      } catch (e) {
        finish(reject, e instanceof Error ? e : new Error(String(e)))
      }
    })

    function finish<T>(fn: (v: T) => void, value: T): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Give the response a tick to flush before tearing down the server.
      setTimeout(() => server.close(), 100)
      fn(value)
    }

    const timer = setTimeout(
      () => finish(reject, new Error('oauth_timeout')),
      timeoutMs,
    )

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number } | null)?.port
      if (!port) { finish(reject, new Error('oauth_listen_failed')); return }
      const redirectUri = `http://localhost:${port}/oauth2/callback`
      const oauth = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri })
      const authUrl = oauth.generateAuthUrl({
        access_type:           'offline',
        prompt:                'consent',
        scope:                 [...GOOGLE_SCOPES],
        state,
        code_challenge:        challenge,
        code_challenge_method: 'S256' as never,
      })
      shell.openExternal(authUrl).catch((e) => finish(reject, e instanceof Error ? e : new Error(String(e))))
    })

    server.on('error', (e) => finish(reject, e))
  })
}

export function disconnect(metaDir: string): void {
  deleteTokens(metaDir)
}

export function status(metaDir: string): GoogleStatus {
  const hasClient = !!loadClientConfig(metaDir)
  const tokens    = loadTokens(metaDir)
  if (!tokens || !tokens.refresh_token) {
    return { connected: false, hasClient }
  }
  return {
    connected: true,
    hasClient,
    email:     tokens.email ?? null,
    scopes:    tokens.scope ? tokens.scope.split(' ') : [],
    expiresAt: tokens.expiry_date ?? null,
  }
}

/**
 * Produce an OAuth2Client wired with the current refresh token. The caller
 * should pass it directly into `google.docs({ auth })` / `google.sheets({ auth })`.
 * Throws if not connected — callers map that to a `not_connected` IPC error.
 */
export function getAuthorizedClient(metaDir: string): OAuth2Client {
  const cfg    = loadClientConfig(metaDir)
  const tokens = loadTokens(metaDir)
  if (!cfg) throw new Error('google_client_not_configured')
  if (!tokens || !tokens.refresh_token) throw new Error('google_not_connected')
  const client = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret })
  client.setCredentials({
    access_token:  tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token,
    expiry_date:   tokens.expiry_date  ?? undefined,
    token_type:    tokens.token_type   ?? undefined,
    id_token:      tokens.id_token     ?? undefined,
    scope:         tokens.scope        ?? undefined,
  })
  // Persist refreshed tokens whenever the library rotates them.
  client.on('tokens', (t) => {
    const next: GoogleTokenSet = {
      ...tokens,
      access_token: t.access_token ?? tokens.access_token ?? null,
      expiry_date:  t.expiry_date  ?? tokens.expiry_date  ?? null,
      id_token:     t.id_token     ?? tokens.id_token     ?? null,
      scope:        t.scope        ?? tokens.scope        ?? null,
      // Google rarely re-issues a refresh_token; keep the original if absent.
      refresh_token: t.refresh_token ?? tokens.refresh_token ?? null,
      email: t.id_token ? decodeIdTokenEmail(t.id_token) ?? tokens.email ?? null : tokens.email ?? null,
    }
    saveTokens(metaDir, next)
  })
  return client
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#1a1a1a}h1{color:#7c6aff;font-size:22px}p{font-size:15px;line-height:1.6;color:#444}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
