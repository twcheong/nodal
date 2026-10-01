// ── 외부 연동 IPC — Google Workspace · Gmail · Connections · MCP (main.ts 에서 이동) ──
//
// 한 덩어리로 묶은 이유: 넷 다 **Settings → 연동** 화면 하나가 부르고, 토큰 보관
// 방식(safeStorage 금고 · <projectRoot>/.twixy/*.enc)과 "설정이 바뀌면 게이트웨이를
// 다시 띄운다" 는 계약을 공유한다. 실제 구현은 google/ · connections/ 밑에 이미 있고
// 여기는 IPC 표면만이다 — 핸들러 본문은 전부 try/catch → `{ ok, ... }` 한 겹이다.
//
// 게이트웨이 재기동은 main 이 아니라 gateway.ts 에서 직접 가져온다(accountIpc ·
// setupIpc 와 같다). 창 참조만 주입받는다 — `openclaw-ready` 를 렌더러에 알려야 해서다.
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  connect      as googleConnect,
  disconnect   as googleDisconnect,
  status       as googleStatus,
  getAuthorizedClient as googleAuthClient,
  loadClientConfig    as googleLoadClient,
  saveClientConfig    as googleSaveClient,
  deleteClientConfig  as googleDeleteClient,
  type GoogleClientConfig,
} from './google/oauth'
import { readGdoc, writeGdoc, type WriteGdocPayload } from './google/docs'
import { readGsheet, writeGsheet, type WriteGsheetPayload } from './google/sheets'
import { sendEmailWithScopeCheck, type SendEmailPayload } from './google/gmail'
import {
  listConnections,
  connectService,
  disconnectService,
  setServiceToken,
  type ConnectionDeps,
  type ConnectionService,
} from './connections/registry'
import {
  listMcpServers,
  upsertMcpServer,
  removeMcpServer,
  saveOAuthServer,
  normalizeMcpId,
  type McpServerDef,
  type McpOAuthBlob,
} from './connections/mcp-servers'
import { discoverMcpAuth, registerClient, runOAuthFlow } from './connections/mcp-oauth'
import { killGatewayIfRunning, startOpenClaw } from './gateway'
import { getTwixyMetaDir } from './paths'

export interface IntegrationsIpcDeps {
  getMainWindow: () => BrowserWindow | null
}

/** 연동 IPC 19개를 등록한다. import 시점 부작용 없음. */
export function registerIntegrationsIpc(deps: IntegrationsIpcDeps): void {
  const { getMainWindow } = deps

  // ── Google Workspace (file-io Phase 2) ──────────────────────────
  // OAuth (loopback PKCE, desktop client) + Docs/Sheets read/write.
  // Tokens live encrypted in <projectRoot>/.twixy/google-tokens.enc; the
  // (public-by-design) desktop client_id+secret live in google-client.json
  // next to it. Settings UI is the only writer of the client config.

  ipcMain.handle('google-get-status', () => {
    try { return { ok: true, ...googleStatus(getTwixyMetaDir()) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('google-set-client', (_e, cfg: GoogleClientConfig) => {
    try {
      if (!cfg?.clientId || !cfg?.clientSecret) return { ok: false, error: 'missing_client_fields' }
      googleSaveClient(getTwixyMetaDir(), cfg)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('google-clear-client', () => {
    try {
      googleDeleteClient(getTwixyMetaDir())
      googleDisconnect(getTwixyMetaDir())
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('google-get-client', () => {
    try {
      const cfg = googleLoadClient(getTwixyMetaDir())
      return { ok: true, hasClient: !!cfg, clientId: cfg?.clientId ?? null }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('tool-google-connect', async () => {
    try {
      const result = await googleConnect(getTwixyMetaDir())
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('tool-google-disconnect', () => {
    try { googleDisconnect(getTwixyMetaDir()); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('tool-write-gdoc', async (_e, payload: WriteGdocPayload) => {
    try {
      const auth = googleAuthClient(getTwixyMetaDir())
      const result = await writeGdoc(auth, payload)
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('tool-read-gdoc', async (_e, payload: { documentId: string }) => {
    try {
      const auth = googleAuthClient(getTwixyMetaDir())
      const result = await readGdoc(auth, payload.documentId)
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('tool-write-gsheet', async (_e, payload: WriteGsheetPayload) => {
    try {
      const auth = googleAuthClient(getTwixyMetaDir())
      const result = await writeGsheet(auth, payload)
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('tool-read-gsheet', async (_e, payload: { spreadsheetId: string; range?: string }) => {
    try {
      const auth = googleAuthClient(getTwixyMetaDir())
      const result = await readGsheet(auth, payload.spreadsheetId, { range: payload.range })
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Gmail send (Connections Phase 1) ────────────────────────────
  // Reuses the Google Workspace OAuth client/tokens; sendEmailWithScopeCheck
  // rejects with a "설정 > 연동" hint when the stored token predates the
  // gmail.send scope (existing users must re-consent once).
  ipcMain.handle('tool-send-email', async (_e, payload: SendEmailPayload) => {
    try {
      const result = await sendEmailWithScopeCheck(getTwixyMetaDir(), payload)
      return { ok: true, ...result }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Connections (Settings → 연동) ────────────────────────────────
  // Claude.ai-connector-style service cards. Status-only over IPC — raw
  // tokens never leave the main process (vault: <userData>/connections.json.enc,
  // Google: <projectRoot>/.twixy/google-tokens.enc).
  const connectionDeps: ConnectionDeps = {
    getTwixyMetaDir,
    getUserDataDir: () => app.getPath('userData'),
  }

  ipcMain.handle('connections-list', () => {
    try { return { ok: true, connections: listConnections(connectionDeps) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('connections-connect', async (_e, service: ConnectionService) => {
    try {
      const connection = await connectService(connectionDeps, service)
      return { ok: true, connection }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('connections-disconnect', (_e, service: ConnectionService) => {
    try {
      const connection = disconnectService(connectionDeps, service)
      return { ok: true, connection }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('connections-set-token', async (_e, payload: { service: ConnectionService; token: string }) => {
    try {
      const connection = await setServiceToken(connectionDeps, payload.service, payload.token)
      return { ok: true, connection }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // ── MCP client servers (Settings → 연동 → MCP 서버) ──────────────
  // User-registered external MCP servers that the embedded OpenClaw Pi runtime
  // consumes as a client (cfg.mcp.servers in openclaw.json → tools auto-exposed
  // as <safeServerName>__<toolName>). Metadata lives in plaintext at
  // <userData>/mcp-servers.json; Bearer tokens stay in the safeStorage vault
  // under mcp:<id> and never cross IPC. A change requires a gateway respawn so
  // the regenerated openclaw.json is read at startup — same kill()+startOpenClaw()
  // +'openclaw-ready' pattern used by the guardrail / designated-paths handlers.
  async function respawnGateway(): Promise<void> {
    killGatewayIfRunning()
    await startOpenClaw()
    getMainWindow()?.webContents.send('openclaw-ready')
  }

  ipcMain.handle('mcp-list', () => {
    try { return { ok: true, servers: listMcpServers(app.getPath('userData')) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('mcp-upsert', async (_e, payload: { def: McpServerDef; token?: string }) => {
    try {
      upsertMcpServer(app.getPath('userData'), payload.def, payload.token)
      await respawnGateway()
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('mcp-remove', async (_e, id: string) => {
    try {
      removeMcpServer(app.getPath('userData'), id)
      await respawnGateway()
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // OAuth connect (Phase 2). Twixy is the token broker: discover the server's
  // OAuth endpoints, register a throwaway client via DCR (or use a user-supplied
  // client_id for servers without DCR, e.g. Slack), run the loopback-PKCE flow in
  // the system browser, store the resulting token blob in the vault under
  // mcp:<id>, then respawn the gateway so openclaw.json picks up the new server.
  ipcMain.handle('mcp-oauth-connect', async (_e, payload: { url: string; label?: string; clientId?: string }) => {
    try {
      const userDataDir = app.getPath('userData')
      const url = String(payload?.url ?? '').trim()
      if (!url) return { ok: false, error: 'URL을 입력하세요.' }
      try { new URL(url) } catch { return { ok: false, error: '유효한 URL이 아닙니다.' } }

      const label = String(payload?.label ?? '').trim() || new URL(url).hostname
      const id = normalizeMcpId(label) || normalizeMcpId(new URL(url).hostname)

      // 1-3: discover authorization/token endpoints.
      const auth = await discoverMcpAuth(url)

      // 4: obtain a client_id. Prefer DCR; otherwise require a user-supplied one.
      let clientId = String(payload?.clientId ?? '').trim()
      if (!clientId) {
        if (!auth.registrationEndpoint) {
          return { ok: false, error: '이 서버는 자동 등록(DCR)을 지원하지 않습니다. client_id를 입력하세요.' }
        }
        // The redirect_uri registered here is a 127.0.0.1 loopback; the port is
        // ephemeral per RFC 8252, so any loopback port matches. We register with a
        // placeholder port and the runOAuthFlow uses the live port at runtime.
        const reg = await registerClient(
          auth.registrationEndpoint,
          'http://127.0.0.1/callback',
          auth.scopesSupported?.join(' '),
        )
        clientId = reg.clientId
      }

      // 5: run the PKCE flow (opens the system browser, waits for the callback).
      const tokens = await runOAuthFlow({ serverUrl: url, auth, clientId, scopes: auth.scopesSupported })

      const blob: McpOAuthBlob = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId,
        tokenEndpoint: auth.tokenEndpoint,
        serverUrl: url,
      }
      const server = saveOAuthServer(userDataDir, { id, label, url, transport: 'streamable-http' }, blob)
      await respawnGateway()
      return { ok: true, server }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })
}
