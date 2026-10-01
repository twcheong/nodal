import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

/**
 * Connections token vault — safeStorage-encrypted secret store for the
 * Settings → Connections section (Discord bot token today; Notion / Slack /
 * Kakao later).
 *
 * - Single encrypted file: <userData>/connections.json.enc. The whole JSON
 *   map is encrypted with Electron safeStorage (OS keychain-backed DPAPI /
 *   Keychain / libsecret). No keytar.
 * - Secrets NEVER cross the IPC boundary: the renderer only ever receives
 *   `{ service, connected, account? }` via the connections-* IPC handlers.
 * - Google is intentionally NOT stored here — its tokens already live in
 *   <projectRoot>/.twixy/google-tokens.enc (see electron/google/oauth.ts)
 *   and the Connections registry just mirrors that status.
 */

export type VaultService = 'notion' | 'slack' | 'discord' | 'kakao'

/**
 * Vault key namespace. Connections services use their bare name; MCP client
 * servers (Settings → 연동 → MCP 서버) store their Bearer token under
 * `mcp:<serverId>`. Same single encrypted file / safeStorage mechanism — the
 * widened key just lets one MCP server's token sit alongside connection tokens.
 */
export type VaultKey = VaultService | `mcp:${string}`

export type VaultEntry = {
  token:    string
  /** Human-readable account label (e.g. Discord bot username). Safe to expose. */
  account?: string | null
  savedAt:  number
}

type VaultFile = Partial<Record<VaultKey, VaultEntry>>

const VAULT_FILE = 'connections.json.enc'

function vaultPath(userDataDir: string): string {
  return path.join(userDataDir, VAULT_FILE)
}

function loadVault(userDataDir: string): VaultFile {
  try {
    const buf = fs.readFileSync(vaultPath(userDataDir))
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
    const parsed = JSON.parse(json) as VaultFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function saveVault(userDataDir: string, vault: VaultFile): void {
  fs.mkdirSync(userDataDir, { recursive: true })
  const json = JSON.stringify(vault)
  const out  = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  fs.writeFileSync(vaultPath(userDataDir), out, { mode: 0o600 })
}

/** Read one service's secret. Main-process only — never send over IPC. */
export function getSecret(userDataDir: string, service: VaultKey): VaultEntry | null {
  return loadVault(userDataDir)[service] ?? null
}

export function setSecret(userDataDir: string, service: VaultKey, token: string, account?: string | null): void {
  const vault = loadVault(userDataDir)
  vault[service] = { token, account: account ?? null, savedAt: Date.now() }
  saveVault(userDataDir, vault)
}

export function deleteSecret(userDataDir: string, service: VaultKey): void {
  const vault = loadVault(userDataDir)
  if (!(service in vault)) return
  delete vault[service]
  saveVault(userDataDir, vault)
}

/** Token-free metadata for status display. Safe to expose to the renderer. */
export function listMeta(userDataDir: string): Partial<Record<VaultService, { account: string | null; savedAt: number }>> {
  const vault = loadVault(userDataDir)
  const out: Partial<Record<VaultService, { account: string | null; savedAt: number }>> = {}
  for (const [key, entry] of Object.entries(vault) as [VaultKey, VaultEntry][]) {
    // Skip MCP server tokens (mcp:<id>) — those are surfaced by mcp-servers.ts.
    if (key.startsWith('mcp:')) continue
    const service = key as VaultService
    if (entry?.token) out[service] = { account: entry.account ?? null, savedAt: entry.savedAt }
  }
  return out
}
