import fs from 'node:fs'
import path from 'node:path'
import { getSecret, setSecret, deleteSecret } from './vault'
import { refreshToken as oauthRefreshToken } from './mcp-oauth'
import type { BuiltinMcpServer } from '../../shared/product/types'

/**
 * MCP client server store — user-registered external MCP servers that the
 * embedded OpenClaw Pi runtime consumes as a *client* (Settings → 연동 →
 * "MCP 서버").
 *
 * OpenClaw (v2026.4.2) reads `cfg.mcp.servers` from openclaw.json and
 * `loadEmbeddedPiMcpConfig()` materializes each server's tools automatically,
 * exposing them to the agent as `<safeServerName>__<toolName>`. No
 * tools.profile/allow edits are needed. A gateway respawn IS needed after a
 * change so the new openclaw.json is read at startup.
 *
 * Storage split (mirrors the connections vault security model):
 *   - Non-sensitive metadata → plaintext JSON at <userData>/mcp-servers.json.
 *   - Bearer tokens → the safeStorage-encrypted connections vault under the
 *     `mcp:<id>` key. Tokens NEVER cross the IPC boundary and never land in
 *     the plaintext metadata file.
 *
 * Transports (OpenClaw mcp.servers schema):
 *   - stdio          : { command, args?, env? }
 *   - sse            : { url }                  (transport omitted → SSE default)
 *   - streamable-http : { url, transport: 'streamable-http' }
 * Latest remote servers (e.g. Notion) require the explicit
 * transport: 'streamable-http' — a bare url is attempted as SSE.
 * Auth (http kinds) is passed as headers: { Authorization: 'Bearer <token>' }.
 *
 * Auth modes (http kinds), `authMode`:
 *   - 'none'  : no Authorization header.
 *   - 'token' : a user-pasted static Bearer token (Phase 1). Stored as a plain
 *               string in the vault under `mcp:<id>`. `hasToken` mirrors this.
 *   - 'oauth' : Twixy brokered the token via OAuth (Phase 2). The vault stores a
 *               JSON *blob* (McpOAuthBlob) under the same `mcp:<id>` key, holding
 *               accessToken/refreshToken/expiresAt + the data needed to refresh.
 *               buildMcpServersConfigBlock refreshes near-expiry tokens at
 *               gateway (re)start and injects the live accessToken as Bearer.
 */

export type McpAuthMode = 'none' | 'token' | 'oauth'

export type McpServerDef =
  | { id: string; label: string; kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { id: string; label: string; kind: 'http'; url: string; transport: 'sse' | 'streamable-http'; hasToken: boolean; authMode?: McpAuthMode }

/** Token-free view, safe to expose to the renderer. */
export type McpServerMeta = McpServerDef

/**
 * OAuth token blob stored (as JSON.stringify) in the vault entry's `token`
 * field under `mcp:<id>` when authMode === 'oauth'. Never crosses the IPC
 * boundary — only the main process reads/writes it.
 */
export type McpOAuthBlob = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  clientId: string
  tokenEndpoint: string
  serverUrl: string
}

const META_FILE = 'mcp-servers.json'

function metaPath(userDataDir: string): string {
  return path.join(userDataDir, META_FILE)
}

function vaultKey(id: string): `mcp:${string}` {
  return `mcp:${id}`
}

/** Normalize to an OpenClaw-safe server name: alphanumerics + underscore only. */
export function normalizeMcpId(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

type MetaFile = { servers: McpServerDef[] }

function loadMetaFile(userDataDir: string): MetaFile {
  try {
    const raw = fs.readFileSync(metaPath(userDataDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<MetaFile>
    if (parsed && Array.isArray(parsed.servers)) return { servers: parsed.servers }
  } catch { /* fall through */ }
  return { servers: [] }
}

function saveMetaFile(userDataDir: string, file: MetaFile): void {
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(metaPath(userDataDir), JSON.stringify(file, null, 2), { mode: 0o600 })
}

/** List registered servers, token-free. Safe to expose over IPC. */
export function listMcpServers(userDataDir: string): McpServerMeta[] {
  return loadMetaFile(userDataDir).servers
}

/**
 * Validate + upsert a server definition. When `token` is provided for an http
 * server it is stored in the vault under `mcp:<id>` and `hasToken` is forced
 * true; an empty/omitted token leaves any existing vault entry untouched
 * unless explicitly cleared. Throws on validation failure (caller maps to
 * { ok:false, error }).
 */
export function upsertMcpServer(userDataDir: string, def: McpServerDef, token?: string): McpServerMeta {
  const id = normalizeMcpId(def.id)
  if (!id) throw new Error('mcp_invalid_id: id must contain at least one alphanumeric/underscore character.')
  const label = String(def.label ?? '').trim() || id

  let normalized: McpServerDef
  if (def.kind === 'stdio') {
    const command = String(def.command ?? '').trim()
    if (!command) throw new Error('mcp_invalid_stdio: command is required for a stdio server.')
    const args = Array.isArray(def.args) ? def.args.map(String) : undefined
    const env = def.env && typeof def.env === 'object'
      ? Object.fromEntries(Object.entries(def.env).map(([k, v]) => [String(k), String(v)]))
      : undefined
    normalized = { id, label, kind: 'stdio', command, ...(args && args.length ? { args } : {}), ...(env && Object.keys(env).length ? { env } : {}) }
  } else if (def.kind === 'http') {
    const url = String(def.url ?? '').trim()
    if (!url) throw new Error('mcp_invalid_http: url is required for an http server.')
    try { new URL(url) } catch { throw new Error('mcp_invalid_http: url is not a valid URL.') }
    const transport = def.transport
    if (transport !== 'sse' && transport !== 'streamable-http') {
      throw new Error('mcp_invalid_http: transport must be "sse" or "streamable-http".')
    }
    const authMode: McpAuthMode = def.authMode ?? (def.hasToken ? 'token' : 'none')
    // OAuth servers carry a vault blob (written by saveOAuthServer), not a
    // user-pasted token — never overwrite it from the token arg here.
    const trimmedToken = authMode === 'oauth' ? '' : (token ?? '').trim()
    const willHaveToken = authMode === 'oauth'
      ? hasVaultToken(userDataDir, id)
      : (trimmedToken ? true : !!def.hasToken && hasVaultToken(userDataDir, id))
    normalized = { id, label, kind: 'http', url, transport, hasToken: willHaveToken, authMode }
  } else {
    throw new Error('mcp_invalid_kind: kind must be "stdio" or "http".')
  }

  const file = loadMetaFile(userDataDir)
  const idx = file.servers.findIndex(s => s.id === id)
  if (idx >= 0) file.servers[idx] = normalized
  else file.servers.push(normalized)
  saveMetaFile(userDataDir, file)

  // Token side-effects (http only). Non-empty token → store. We intentionally
  // do NOT delete an existing token on an empty token here, so editing other
  // fields keeps the saved credential.
  if (normalized.kind === 'http') {
    const trimmedToken = (token ?? '').trim()
    if (trimmedToken) setSecret(userDataDir, vaultKey(id), trimmedToken)
  }

  return normalized
}

function hasVaultToken(userDataDir: string, id: string): boolean {
  return !!getSecret(userDataDir, vaultKey(id))?.token
}

/**
 * Persist (upsert) an OAuth-brokered http server: writes the metadata with
 * authMode 'oauth' and stores the token blob (JSON) in the vault under
 * `mcp:<id>`. Used by the mcp-oauth-connect IPC after a successful flow.
 */
export function saveOAuthServer(
  userDataDir: string,
  args: { id: string; label: string; url: string; transport?: 'sse' | 'streamable-http' },
  blob: McpOAuthBlob,
): McpServerMeta {
  const id = normalizeMcpId(args.id)
  if (!id) throw new Error('mcp_invalid_id: id must contain at least one alphanumeric/underscore character.')
  const label = String(args.label ?? '').trim() || id
  const url = String(args.url ?? '').trim()
  if (!url) throw new Error('mcp_invalid_http: url is required for an http server.')
  try { new URL(url) } catch { throw new Error('mcp_invalid_http: url is not a valid URL.') }
  const transport = args.transport ?? 'streamable-http'

  // Store the token blob (as a JSON string) in the same vault slot Phase 1 uses.
  setSecret(userDataDir, vaultKey(id), JSON.stringify(blob))

  const normalized: McpServerDef = { id, label, kind: 'http', url, transport, hasToken: true, authMode: 'oauth' }
  const file = loadMetaFile(userDataDir)
  const idx = file.servers.findIndex(s => s.id === id)
  if (idx >= 0) file.servers[idx] = normalized
  else file.servers.push(normalized)
  saveMetaFile(userDataDir, file)
  return normalized
}

function readOAuthBlob(userDataDir: string, id: string): McpOAuthBlob | null {
  const raw = getSecret(userDataDir, vaultKey(id))?.token
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<McpOAuthBlob>
    if (typeof parsed.accessToken === 'string' && typeof parsed.tokenEndpoint === 'string') {
      return parsed as McpOAuthBlob
    }
  } catch { /* not a blob (Phase 1 plain token) */ }
  return null
}

/** Remove a server's metadata and any stored token. */
export function removeMcpServer(userDataDir: string, rawId: string): void {
  const id = normalizeMcpId(rawId)
  if (!id) return
  const file = loadMetaFile(userDataDir)
  const next = file.servers.filter(s => s.id !== id)
  if (next.length !== file.servers.length) saveMetaFile(userDataDir, { servers: next })
  deleteSecret(userDataDir, vaultKey(id))
}

/**
 * Build the `mcp.servers` block for openclaw.json from saved metadata + vault
 * tokens. Keyed by server id (already an OpenClaw-safe name). stdio →
 * command/args/env; http → url + (optional) transport + Authorization header.
 */
export async function buildMcpServersConfigBlock(
  getUserDataDir: () => string,
  builtins: BuiltinMcpServer[] = [],
): Promise<Record<string, unknown>> {
  const userDataDir = getUserDataDir()
  const out: Record<string, unknown> = {}
  for (const s of listMcpServers(userDataDir)) {
    if (s.kind === 'stdio') {
      out[s.id] = {
        command: s.command,
        ...(s.args && s.args.length ? { args: s.args } : {}),
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      }
    } else {
      const block: Record<string, unknown> = { url: s.url }
      // URL-only is attempted as SSE by OpenClaw; emit transport explicitly
      // for streamable-http (and harmlessly for sse too, for clarity).
      block.transport = s.transport
      const bearer = await resolveBearer(userDataDir, s)
      if (bearer) block.headers = { Authorization: `Bearer ${bearer}` }
      out[s.id] = block
    }
  }
  // 제품 내장 서버 (PRODUCT.features.builtinMcp) — 마지막에 써서 사용자가 같은 id 로
  // 등록한 서버가 내장 서버를 가리지 못하게 한다.
  for (const b of builtins) {
    out[b.id] = b.kind === 'stdio'
      ? { command: b.command, ...(b.args?.length ? { args: b.args } : {}), ...(b.env ? { env: b.env } : {}) }
      : { url: b.url, transport: b.transport }
  }
  return out
}

/**
 * Resolve the Bearer token to inject for an http server.
 *   - authMode 'oauth': read the stored blob; if the accessToken is missing or
 *     expiring within 60s and we have a refresh_token, refresh it now, persist
 *     the rotated blob, and return the fresh accessToken. Refresh failure leaves
 *     the server without a header (and logs a warning) rather than aborting the
 *     whole config build.
 *   - authMode 'token'/'none' (Phase 1): the vault holds a plain string token.
 * Config is (re)built at gateway (re)start, so refreshing here is the natural
 * point to keep the static OpenClaw token current.
 */
async function resolveBearer(userDataDir: string, s: Extract<McpServerDef, { kind: 'http' }>): Promise<string | null> {
  if (!s.hasToken) return null
  if (s.authMode === 'oauth') {
    const blob = readOAuthBlob(userDataDir, s.id)
    if (!blob) return null
    const expiringSoon = typeof blob.expiresAt === 'number' && blob.expiresAt < Date.now() + 60_000
    if (expiringSoon && blob.refreshToken) {
      try {
        const next = await oauthRefreshToken({
          tokenEndpoint: blob.tokenEndpoint,
          refreshToken: blob.refreshToken,
          clientId: blob.clientId,
          serverUrl: blob.serverUrl,
        })
        const updated: McpOAuthBlob = {
          ...blob,
          accessToken: next.accessToken,
          // Some servers rotate the refresh_token; keep the old one if absent.
          refreshToken: next.refreshToken ?? blob.refreshToken,
          expiresAt: next.expiresAt ?? blob.expiresAt,
        }
        setSecret(userDataDir, vaultKey(s.id), JSON.stringify(updated))
        return updated.accessToken
      } catch (err) {
        console.warn(`[mcp-oauth] refresh failed for ${s.id}; injecting no auth header:`, String(err))
        return null
      }
    }
    return blob.accessToken
  }
  // Phase 1: plain string token.
  return getSecret(userDataDir, vaultKey(s.id))?.token ?? null
}
