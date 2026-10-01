import http from 'node:http'
import crypto from 'node:crypto'
import { URL } from 'node:url'
import { shell } from 'electron'
import { isAllowedExternalUrl } from '../trustBoundary'

/**
 * Generic MCP OAuth broker (Phase 2). Twixy acts as the OAuth *token broker*:
 * it runs the loopback-PKCE Authorization Code flow against any MCP server that
 * speaks the standard MCP OAuth discovery dance, stores the resulting
 * access/refresh tokens in the vault (see mcp-servers.ts), and injects the
 * access_token as a static `Authorization: Bearer <token>` header into
 * openclaw.json's mcp.servers. OpenClaw never performs OAuth itself — it only
 * consumes the static token we mint.
 *
 * The flow (verified against Notion's MCP, 2026-06):
 *   1. POST <serverUrl> (no auth) → 401 with
 *      `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="<url>"`.
 *   2. GET <resource_metadata> → { authorization_servers: ["<authServer>"] }.
 *   3. GET <authServer>/.well-known/oauth-authorization-server (fallback
 *      openid-configuration) → { authorization_endpoint, token_endpoint,
 *      registration_endpoint?, ... }.
 *   4. registration_endpoint present ⇒ Dynamic Client Registration (RFC 7591):
 *      POST a throwaway client, get a client_id (no pre-registered app needed).
 *   5. PKCE Authorization Code flow via the system browser + loopback callback.
 *
 * Unlike electron/google/oauth.ts this is provider-agnostic: it cannot use
 * google-auth-library's OAuth2Client (Google-specific). PKCE + token exchange
 * are implemented directly with node:crypto + fetch.
 */

export type McpAuthMeta = {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  scopesSupported?: string[]
}

export type McpOAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

const REDIRECT_PATH = '/callback'
const USER_AGENT = 'Twixy-MCP-Client/1.0'

function originOf(rawUrl: string): string {
  return new URL(rawUrl).origin
}

/**
 * Parse the `resource_metadata` URL out of a WWW-Authenticate header value, e.g.
 *   Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/..."
 */
function parseResourceMetadata(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/resource_metadata\s*=\s*"?([^",\s]+)"?/i)
  return m ? m[1] : null
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`http_${res.status}: ${url} ${body.slice(0, 300)}`)
  }
  return res.json()
}

/**
 * Step 1-3: discover the OAuth authorization + token endpoints for an MCP server.
 *
 * Step 1 probes the MCP endpoint (unauthenticated POST) to read the
 * `WWW-Authenticate` challenge. If that doesn't yield a resource_metadata URL we
 * fall back to `<origin>/.well-known/oauth-protected-resource`. Step 2 fetches
 * that protected-resource doc for the authorization server URL. Step 3 fetches
 * the auth server's metadata (oauth-authorization-server, falling back to
 * openid-configuration).
 */
export async function discoverMcpAuth(serverUrl: string): Promise<McpAuthMeta> {
  // Step 1 — probe for the WWW-Authenticate challenge.
  let resourceMetadataUrl: string | null = null
  try {
    const probe = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': USER_AGENT,
      },
      // Minimal MCP initialize-ish body; servers reject with 401 before parsing.
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    resourceMetadataUrl = parseResourceMetadata(probe.headers.get('www-authenticate'))
  } catch { /* network probe failed — fall through to the well-known fallback */ }

  if (!resourceMetadataUrl) {
    resourceMetadataUrl = `${originOf(serverUrl)}/.well-known/oauth-protected-resource`
  }

  // Step 2 — protected-resource metadata → authorization_servers[0].
  const prm = (await fetchJson(resourceMetadataUrl)) as { authorization_servers?: unknown }
  const authServers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : []
  const authServer = authServers.find((s): s is string => typeof s === 'string' && !!s)
  if (!authServer) {
    throw new Error(`mcp_oauth_no_auth_server: ${resourceMetadataUrl} did not list authorization_servers.`)
  }

  // Step 3 — authorization server metadata (oauth-authorization-server, then OIDC).
  const base = authServer.replace(/\/+$/, '')
  type AuthServerMeta = {
    authorization_endpoint?: string
    token_endpoint?: string
    registration_endpoint?: string
    scopes_supported?: unknown
  }
  let meta: AuthServerMeta | null = null
  for (const wellKnown of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    try {
      meta = (await fetchJson(`${base}${wellKnown}`)) as AuthServerMeta
      if (meta?.authorization_endpoint && meta?.token_endpoint) break
    } catch { meta = null }
  }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new Error(`mcp_oauth_discovery_failed: ${base} has no usable authorization-server metadata.`)
  }

  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : undefined,
    scopesSupported: Array.isArray(meta.scopes_supported)
      ? meta.scopes_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
  }
}

/**
 * Step 4 — Dynamic Client Registration (RFC 7591). Registers a throwaway public
 * client (token_endpoint_auth_method: "none") so we never need a pre-registered
 * app. Only call this when discoverMcpAuth returned a registrationEndpoint; for
 * servers without DCR (e.g. Slack) the caller must supply a client_id instead.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  scope?: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const body: Record<string, unknown> = {
    client_name: 'Twixy',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(scope ? { scope } : {}),
  }
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`mcp_oauth_register_failed: http_${res.status} ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { client_id?: unknown; client_secret?: unknown }
  if (typeof json.client_id !== 'string' || !json.client_id) {
    throw new Error('mcp_oauth_register_failed: response missing client_id.')
  }
  return {
    clientId: json.client_id,
    clientSecret: typeof json.client_secret === 'string' ? json.client_secret : undefined,
  }
}

function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Exchange or refresh against the token endpoint (application/x-www-form-urlencoded). */
async function postToken(tokenEndpoint: string, params: Record<string, string>): Promise<McpOAuthTokens> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(params).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`mcp_oauth_token_failed: http_${res.status} ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error('mcp_oauth_token_failed: response missing access_token.')
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  }
}

/**
 * Step 5 — run the full loopback-PKCE Authorization Code flow. Boots an
 * ephemeral http server on 127.0.0.1:0, opens the auth URL in the system
 * browser, waits for the redirect with the `code`, validates `state`, and
 * exchanges the code (+ PKCE verifier) for tokens at the token endpoint.
 *
 * The `resource` param (RFC 8707) is set to the serverUrl so the issued token
 * is audience-bound to the MCP server.
 */
export async function runOAuthFlow(args: {
  serverUrl: string
  auth: McpAuthMeta
  clientId: string
  scopes?: string[]
  timeoutMs?: number
}): Promise<McpOAuthTokens> {
  const { serverUrl, auth, clientId } = args
  const { verifier, challenge } = makePkcePair()
  const state = crypto.randomBytes(16).toString('base64url')
  const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000
  const scope = args.scopes && args.scopes.length ? args.scopes.join(' ') : undefined

  return await new Promise<McpOAuthTokens>((resolve, reject) => {
    let settled = false

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== REDIRECT_PATH) {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const recvd = url.searchParams.get('state')
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(htmlPage('Twixy — MCP 연결 실패', `<p>${escapeHtml(err)}</p>`))
          finish(reject, new Error(`mcp_oauth_error: ${err}`))
          return
        }
        if (!code || recvd !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(htmlPage('Twixy — MCP 연결 실패', '<p>state 불일치 또는 code 누락.</p>'))
          finish(reject, new Error('mcp_oauth_state_mismatch'))
          return
        }
        const port = (server.address() as { port: number } | null)?.port
        if (!port) {
          res.writeHead(500).end()
          finish(reject, new Error('mcp_oauth_no_port'))
          return
        }
        const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`
        postToken(auth.tokenEndpoint, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource: serverUrl,
        })
          .then((tokens) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(htmlPage('Twixy — 연결됨', '<p>연결되었습니다. 이 창을 닫고 Twixy로 돌아가세요.</p>'))
            finish(resolve, tokens)
          })
          .catch((e: unknown) => {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(htmlPage('Twixy — MCP 연결 실패', `<p>${escapeHtml(String(e))}</p>`))
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
      setTimeout(() => server.close(), 100)
      fn(value)
    }

    const timer = setTimeout(() => finish(reject, new Error('mcp_oauth_timeout')), timeoutMs)

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number } | null)?.port
      if (!port) { finish(reject, new Error('mcp_oauth_listen_failed')); return }
      const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`
      const authUrl = new URL(auth.authorizationEndpoint)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('resource', serverUrl)
      if (scope) authUrl.searchParams.set('scope', scope)
      // authorization_endpoint 는 **원격 MCP 서버의 메타데이터**가 준 값이다. 사용자가 붙여 넣은
      // 서버 URL 하나가 file: / ms-msdt: 같은 OS 핸들러를 띄우게 두지 않는다.
      if (!isAllowedExternalUrl(authUrl.toString())) {
        finish(reject, new Error('mcp_oauth_bad_authorization_endpoint')); return
      }
      shell.openExternal(authUrl.toString()).catch((e) => finish(reject, e instanceof Error ? e : new Error(String(e))))
    })

    server.on('error', (e) => finish(reject, e))
  })
}

/**
 * Refresh an access token using a stored refresh_token (grant_type=refresh_token).
 * Returns the new token set; some servers rotate the refresh_token, others omit
 * it (caller keeps the previous one in that case).
 */
export async function refreshToken(args: {
  tokenEndpoint: string
  refreshToken: string
  clientId: string
  serverUrl: string
}): Promise<McpOAuthTokens> {
  return await postToken(args.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    resource: args.serverUrl,
  })
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#1a1a1a}h1{color:#7c6aff;font-size:22px}p{font-size:15px;line-height:1.6;color:#444}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
