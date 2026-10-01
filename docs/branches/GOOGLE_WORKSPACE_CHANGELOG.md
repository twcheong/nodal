# `feature/google-workspace` — Branch Change Log

> **Scope:** Google Workspace OAuth (loopback PKCE) + Docs read/write + Sheets read/write.
> **Branch base:** `feature/file-io` HEAD `4ceec68` (2026-04-25).
> **Parent in stack:** `feature/file-io`.
> **Child in stack:** `feature/dashboard-v2`.
>
> **Update rule:** Append a new section **before every `git push`** with the exact files/handlers/skills changed in that push. End each entry with the 7-char commit hash. Do **not** touch `TWIXY_ENTERPRISE_CHANGELOG.md` from this branch.
>
> **Entry template:** see `FILE_IO_CHANGELOG.md`.

---

<!-- New entries go below, newest on top. -->

## 2026-04-25 — Google Workspace OAuth + Docs/Sheets R/W (commit `35c46ab`)

> First push on `feature/google-workspace`.

### 추가된 파일
- `electron/google/oauth.ts` — Loopback PKCE OAuth 2.0 client. Encrypts tokens via Electron `safeStorage` and persists to `<projectRoot>/.twixy/google-tokens.enc`. Auto-refresh via `client.on('tokens', …)`. Decodes email from `id_token` JWT payload. Exports `connect()`, `disconnect()`, `getStatus()`, `getAuthorizedClient()`, plus `setClient()` / `clearClient()` / `getClient()` so the user can paste their own Desktop OAuth credentials in Settings.
- `electron/google/docs.ts` — `writeGdoc(auth, payload)` creates a doc and applies block-level styles (`TITLE` / `HEADING_1-3` / `NORMAL_TEXT` / bullets) in one `batchUpdate`. `readGdoc(auth, id)` walks `body.content` to produce a normalized `{ blocks, text }` shape so callers don't have to traverse the Docs tree.
- `electron/google/sheets.ts` — `writeGsheet` supports both create-new and write-into-existing (auto-adds missing tabs). Uses `valueInputOption: 'RAW'` so numeric cells stay numeric. `readGsheet` defaults to `A1:ZZ500` of the first tab; takes optional `range` for explicit tab/region.
- `skills/gdoc-report/gdoc-report.tskill` — Thin wrapper: insight → Docs blocks → `tool-write-gdoc`. Aborts cleanly if Google not connected.
- `skills/sheet-sync/sheet-sync.tskill` — One-shot mirror between local XLSX and Google Sheets. Direction (`push` vs `pull`) inferred from what the user names.
- `docs/branches/GOOGLE_WORKSPACE_CHANGELOG.md` — this file.

### 수정된 파일
- `electron/main.ts`
  - Imported the 3 google modules + 3 file-io tool modules.
  - Registered 9 IPC handlers: `google-get-status`, `google-set-client`, `google-clear-client`, `google-get-client`, `tool-google-connect`, `tool-google-disconnect`, `tool-write-gdoc`, `tool-read-gdoc`, `tool-write-gsheet`, `tool-read-gsheet`.
  - Each tool handler resolves `getAuthorizedClient(getTwixyMetaDir())` and surfaces auth errors as `{ ok: false, error: 'not_connected' }` so the renderer can route to Settings.
- `electron/preload.ts`
  - Added a `tools` namespace under `window.twixy.tools` exposing `googleGetStatus`, `googleSetClient`, `googleClearClient`, `googleGetClient`, `googleConnect`, `googleDisconnect`, `writeGdoc`, `readGdoc`, `writeGsheet`, `readGsheet` (plus the file-io writers from the parent branch).
- `src/global.d.ts`
  - Added types: `TwixyGoogleStatusResult`, `TwixyWriteGdocPayload`, `TwixyReadGdocResult`, `TwixyWriteGsheetPayload`, `TwixyReadGsheetResult`. Tool result wrapper `TwixyToolResult<T>` reused from the parent branch.
- `src/components/SettingsPanel.tsx`
  - New "Google Workspace" section (above Mobile Channels) with: connection status badge, Client ID + Client Secret inputs (using existing `Field` / `SecretInput` components), Save Client / Clear Client / Connect / Disconnect buttons, scope readout when connected.
  - Reason: surfaces the OAuth handshake to the user without leaving the app, and matches the BYOK pattern already used for Anthropic/OpenAI keys.
  - Added two style helpers (`primaryBtnStyle`, `ghostBtnStyle`) shared with future panels.
- `package.json` / `package-lock.json` — added `googleapis` + `google-auth-library` runtime deps.

### 신규 IPC / 툴 / 스킬
- `google-get-status` — `{ ok, connected, email, scopes }`
- `google-set-client` — `{ clientId, clientSecret } → { ok }`; persists to `<projectRoot>/.twixy/google-client.enc`
- `google-clear-client` — wipes both the OAuth client and any saved tokens
- `google-get-client` — `{ ok, hasClient, clientId }` (no secret returned)
- `tool-google-connect` — opens system browser to consent screen, completes loopback PKCE, returns `{ ok, email }`
- `tool-google-disconnect` — clears tokens but keeps the OAuth client
- `tool-write-gdoc` — `{ title, blocks } → { ok, documentId, url, title }`
- `tool-read-gdoc` — `{ documentId } → { ok, blocks, text, title }`
- `tool-write-gsheet` — `{ title?, spreadsheetId?, sheets[{ name, rows }] } → { ok, spreadsheetId, url, sheets }`
- `tool-read-gsheet` — `{ spreadsheetId, range? } → { ok, range, rowCount, columnCount, rows }`
- Skill `gdoc-report` — single-shot insight → Google Doc publish
- Skill `sheet-sync` — XLSX ↔ Google Sheet mirror

### 설계 결정
- **OAuth client BYO.** Desktop OAuth "secrets" are public anyway (Google policy). Asking the user to paste their own client keeps Twixy out of the trust path and dodges per-tenant quota collisions.
- **Token storage outside workspace.** `<projectRoot>/.twixy/` (via `getTwixyMetaDir()`), not the agent-visible workspace whitelist — SOUL.md restricts the LLM agent, not the Electron main process. Avoids needing a SOUL.md change.
- **Loopback PKCE only.** Embedded webviews are forbidden by Google's policy for OAuth on desktop. Loopback (`http://127.0.0.1:<random>`) + PKCE is the supported path.
- **Read shape is normalized JSON.** Same philosophy as the Excel reader and SOUL.md's "no raw token dumps from sub-agents" rule — keeps payloads small for the LLM.

### 검증
- `npx tsc -p tsconfig.electron.json --noEmit` → 0 errors.
- `npx tsc --noEmit` → 5 pre-existing errors in `ChatPanel.tsx`, `DashboardPanel.tsx`, `SkillsPanel.tsx`, `useOpenClaw.ts` (verified present on `feature/twixy-enterprise @ 88dd9a7` before this branch).
- Settings UI section renders with the same `channelCardStyle` patterns as Mobile Channels — visual smoke check pending first `npm run dev` boot.
- End-to-end OAuth round-trip (Connect → write doc → read back) deferred until the user wires their own Desktop OAuth client in the Cloud Console.
