# `feature/agent-tools-bridge` — Branch Change Log

> **Scope:** Phase 4 — register the Phase 1 (`feature/file-io`) and Phase 2 (`feature/google-workspace`) tool handlers with the OpenClaw agent runtime so the LLM can invoke them directly. Patches `node_modules/openclaw/dist/pi-embedded-BYdcxQ5A.js` to inject 11 custom tools whose `execute()` POSTs JSON to a loopback HTTP bridge run by the Electron main process. Closes the gap discovered in session `0c6aa068` (04-25): the new IPC handlers existed but were invisible to the LLM, which fell back to `pip install python-pptx` and a screenshot path that hit "no endpoints support image input".
> **Branch base:** `feature/dashboard-v2` HEAD `20a17a8` (2026-04-25).
> **Parent in stack:** `feature/dashboard-v2`.
> **Child in stack:** (none — top of the stack).
>
> **Update rule:** Append a new section **before every `git push`** with the exact files/handlers/sections changed in that push. End each entry with the 7-char commit hash. Do **not** touch `TWIXY_ENTERPRISE_CHANGELOG.md` from this branch.
>
> **Entry template:** see `FILE_IO_CHANGELOG.md`.

---

<!-- New entries go below, newest on top. -->

## 2026-04-30 — Per-step compaction + session reset between plan steps (commit `134aca4`)

> Adds context bounding to multi-step plans. Without compaction, every step inherits the previous step's full transcript, so by step 3+ the gateway session is bloated with tool snapshots / browser dumps from earlier steps that downstream steps don't actually need. Worse, in long plans the LLM context window starts truncating the SOUL.md / step instructions at the head of the prompt — the very first thing that should always be intact.
>
> **New flow per step:** main step LLM run → verifyAcceptance → on success: kill subagents + freeze announce + run a compactor LLM round-trip that produces a short markdown summary plus a list of toolCallIds it wants kept verbatim → persist (`steps/<id>/raw.jsonl` + `step.compactSummary` + `step.rawToolCallIds`) → `sessions.reset` to wipe the gateway transcript → next step starts fresh, with prior compactSummaries + flagged raw tool blocks re-injected as a prefix to the step prompt (`buildPriorContextBlock`).
>
> Also closes two race bugs hit while building this: (a) "step 3 aborted ~4s after send" race in the inter-step gap, and (b) "step 2 paused with Resume button while sub-agent still running" false-positive on `sessions_yield`.

### 추가된 파일
- _(none — all changes in existing files)_

### 수정된 파일
- `electron/planning.ts`
  - **`PlanStep`** type — 4 new optional fields: `compactSummary`, `rawToolCallIds`, `rawTranscriptPath`, `compactedAt`. All populated by `saveStepCompact` after a successful step.
  - **`StepCompactPayload`** type (new export) — payload shape the renderer sends to `plan-step-compact`: `{ compactSummary, rawToolCallIds?, rawMessages? }`. `rawMessages` is the gateway message slice for the step, persisted verbatim.
  - **`saveStepCompact()`** (new) — writes `compactSummary` + `rawToolCallIds` onto the step, persists `rawMessages` to `<planId>/steps/<stepId>/raw.jsonl`, sets `step.rawTranscriptPath` (relative to `plansRoot`), bumps `plan.updatedAt`, and appends a "Compact summary" + "Raw retained" + "Raw transcript" block to `run.md` so the human-readable log stays consistent.
  - **`readStepRaw()`** (new) — reads `<planId>/steps/<stepId>/raw.jsonl` back as `unknown[]`, one parsed JSON per line. Returns `[]` on missing file. Used by the runner to re-inject flagged toolCallIds verbatim into a downstream step's prompt without re-running the tool.
  - **`stepRawDir()` / `stepRawJsonlPath()`** helpers (new, file-local).
  - **`renderPlanMd()`** — appends `_Compacted:_ <head>…` line under each step entry that has a `compactSummary` so `plan.md` reflects the compaction state.
- `electron/main.ts`
  - **`plan-step-compact`** IPC handler (new) — calls `Planning.saveStepCompact`, broadcasts `'step-compact'` plan change.
  - **`plan-step-read-raw`** IPC handler (new) — returns `Planning.readStepRaw(...)`.
  - Imports `StepCompactPayload` from `./planning`.
- `electron/preload.ts`
  - **`planStepCompact(id, stepId, compact)`** — invokes `plan-step-compact`, throws on `!ok`.
  - **`planStepReadRaw(id, stepId)`** — direct invoke of `plan-step-read-raw` (returns `unknown[]`).
- `src/global.d.ts`
  - **`TwixyPlanStep`** — added the same 4 compaction fields as `electron/planning.ts`.
  - **`TwixyAPI`** — added `planStepCompact` and `planStepReadRaw` declarations.
- `src/hooks/useOpenClaw.ts`
  - **`resetSession()`** (new) — calls `sessions.reset` RPC. The gateway preserves the old transcript file on disk and points `sessionKey` at a fresh `sessionId/sessionFile`. Used by the plan runner between steps so each step's LLM input is bounded.
  - **`getSessionMessages(limit=9999)`** (new) — calls `sessions.get` RPC; returns the current transcript as `unknown[]`. Used by the runner to capture a step's raw transcript slice immediately before compaction.
  - **Aborted-message terminal handler** in the `session.message` event branch — when `extractText(msg.content) === ''` and `(stopReason ∈ {aborted, error} || errorMessage)`, reject pending `turnAwaiters` with `Error('run_<reason>')` and clear `isThinking` / timers / refs. Without this, an aborted run silently dropped through the empty-text filter (L950) and left `awaiter` unresolved + `isThinking=true` forever (the "infinite thinking" bug — observed in session `51abd069` after a step-3 abort race).
  - **`subagentInFlight` guard** on the same handler — when a sub-agent is still tracked in `subagentSessionsRef` or `rootFinaledWhileSubagentBusy=true`, skip the abort path. The gateway emits a transient `session.message` (WS-only, not persisted to JSONL) with empty content + abort-like fields when `sessions_yield` runs; without the guard, this was firing on every plan step that delegated to a sub-agent, causing the runner to see `interrupted=true` and pause the plan even though the sub-agent's work was still pending. Real aborts that also kill the sub-agent will fire `phase:'end'/'error'` on the child key, removing it from the ref, so the next abort message after that proceeds normally.
  - Both `resetSession` and `getSessionMessages` exported from the hook return tuple.
- `src/hooks/usePlans.ts` (the bulk of the new logic — ~250 lines)
  - **Deps** added: `resetSession`, `getSessionMessages`. Hook contract now requires them from the caller (`App.tsx` wires `openclaw.resetSession` / `openclaw.getSessionMessages`).
  - **`verifyAndExplain()`** (new helper, file-private) — after a step's main LLM emits `[step-done]`, runs a separate verifier `sendAndAwaitFinal` that re-reads the full final reply and the step's `acceptance` criterion, asks the LLM to emit `RESULT: YES` or `RESULT: NO` + reason. Catches "(no output)" silent sub-agent failures and other patterns where `[step-done]` was emitted but no real artifact was produced. On `NO`, downgrades the step to `failed` with the verifier's reason as `summary`. The verifier prompt explicitly tolerates intermediate retries within the same turn (a tool that failed once but was retried successfully is NOT a failure).
  - **`buildCompactPrompt(...)`** (new) — produces the input for the per-step compactor LLM round-trip. Includes: which step we're compacting, which steps remain, the **full message slice for this step** (rawSlice from `getSessionMessages`), and instructions to emit a markdown summary + a `## Raw retentions` section listing toolCallIds whose raw output downstream steps must keep verbatim.
  - **`parseRawRetentions(text)`** (new) — pulls toolCallIds out of the compactor's `## Raw retentions` block. Tolerates several formats. Returns deduped string[].
  - **`buildPriorContextBlock(planId, plan, currentStepIdx)`** (new, async) — assembles the prefix injected at the head of every step's prompt: `=== Prior step summaries (compacted) ===` followed by each prior `step.compactSummary`, then `=== Retained raw tool outputs from prior steps ===` followed by raw tool blocks for any toolCallId in any prior step's `rawToolCallIds` (read via `planStepReadRaw`). Async because raw retention reads hit disk.
  - **Step runner — `runFromCurrent`** rewritten:
    - Top of run: `setRejectNewRuns(false)` (clear any leftover guard from a prior failed run) + `resetSession()` so step 1 starts on a fresh gateway session. Prior summaries / raw blocks are re-injected via `buildPriorContextBlock` for resumed runs.
    - Per step: `setRejectNewRuns(false)` immediately before `sendAndAwaitFinal(stepPrompt)` to close the inter-step race window where a stale `rejectNewRuns=true` from the previous step's boundary intercepted our own intentional send.
    - After `sendAndAwaitFinal` returns: `killActiveSubagents()` (immediate, success or failure — gives the gateway-patch's `markSubagentRunTerminated` time to set `suppressAnnounceReason="killed"` on any in-flight subagent before its announce reaches delivery). Followed by `[step-done]` retry if no marker, then `verifyAndExplain` if `acceptance` is set.
    - On `failed`/`interrupted`: `setRejectNewRuns(true)` + `setRequesterAnnounceFrozen(true)` + `addSystemMessage('Plan stopped — Step N "..." failed')` with `Try again` / `No thanks` actions.
    - On `done`: only run the compaction round-trip if there's a downstream step left (last step skips compaction — no consumer for the summary). The compactor uses a separate `sendAndAwaitFinal` with a 90s timeout; on failure we fall back to `_(compaction failed — raw transcript retained)_` so the next step still has a placeholder. Then `planStepCompact` persists summary + raw retentions + `rawMessages` (from `getSessionMessages`) → `resetSession()` → loop continues to the next step.
  - **Outcome** prompt at the very end: only fires if no step failed (`anyFailed=false`). Skipped on partial / aborted runs to avoid LLM noise on top of an already-failed plan.
  - All sub-agent / abort guards (`setRejectNewRuns`, `killActiveSubagents`, `setRequesterAnnounceFrozen`) keep the existing two-layer defense — React-side interceptor + gateway-side freeze — across the new compaction pause/reset cycles.
- `src/App.tsx`
  - Wires `resetSession` + `getSessionMessages` into `usePlans` deps.
  - **`handleResume(planId)`** helper (new) — synchronously clears `setRejectNewRuns(false)` before calling `plans.resumePlan`. PlanCard's Resume button, the "Try again" system-message action, and the overlay's `onOverlayResume` all route through this helper now. Without the synchronous clear, there was a microtask gap where stale subagent announces were intercepted, manifesting as a "Resume that does nothing" — the inline "Try again" button avoided this only because it cleared the flag itself first.
- `src/components/PlanCard.tsx`
  - `PlanStep` interface — added the same 4 compaction fields so the card can render compaction state when we expose it in the UI later.

### 신규 / 삭제된 IPC / 툴 / 스킬
- **New IPC:** `plan-step-compact`, `plan-step-read-raw`. Both scoped to the renderer's plan flow; not exposed to OpenClaw agent tools.
- No tool / skill changes.

### 검증
- `npx vite build` → renderer + dist-electron both build clean. App-bundle hash bumped (`Ciy0zxgC` → `BjJ9K5sm`) after the sub-agent guard fix.
- Plan-mode end-to-end on the 6-step "한국 AX 시장 경쟁사 조사 + PPT" plan (session `f39e53eb`):
  - **Before:** step 2 marked `interrupted` 21s in (sessions_yield false-positive — `Error: run_aborted` in run.md), plan stuck at "Resume" with sub-agent still running in the background.
  - **After (with sub-agent guard):** abort handler skips when sub-agent is in-flight, so yield turn-ends pass through and the runner stays awaiting until the sub-agent's autonomous wake produces the real `[step-done]`.
- Manual race verification on `setRejectNewRuns(false)` placement: tested resume after a failed step + clean run from step 1 → no spurious "step aborted ~4s after send" abort.
- See updated memory `feedback_planning_mode_openclaw.md` §11 (a/b/c/d) for the abort/race write-up.

---

## 2026-04-26 — Tool-policy allowlist registration + stable Supabase uid + SOUL.md trim (commit `1833619`)

> Second push on this branch. Closes the **real** root cause of the PPT-as-JSON failure observed in session `d51323ee`: bridge was up, patch was loaded, but OpenClaw's `tools.profile` filter (`pi-embedded-*.js:26214`) was silently dropping all 11 bridge tools because their ids were not in `CORE_TOOL_DEFINITIONS`. The LLM's internal thinking confirmed the symptom: *"I don't see `tool_write_pptx`, `tool_write_pdf`, `tool_write_xlsx` explicitly listed. They're mentioned in SOUL.md but that doesn't guarantee they're actual tool names I can call."* — so it fell back to the generic `write` tool and dumped the slide payload as JSON to a `.pptx` filename.

### 추가된 파일
- `docs/ADDING_A_NEW_AGENT_TOOL.md` — new contributor guide that documents the **6-layer** wiring (internal fn → IPC → preload → bridge handler → openclaw patch → **profile allowlist registration** → optional guardrail / SOUL mapping). Layer 4.5 (profile allowlist) is the one we forgot the first time and is the focus of this push.

### 수정된 파일
- `node_modules/openclaw/dist/tool-policy-Bk9WQZ0U.js` (patched via `patches/openclaw+2026.4.2.patch`)
  - Added 11 entries to `CORE_TOOL_DEFINITIONS` (after the existing `tts` entry) with `profiles: ["coding"]` and `includeInOpenClawGroup: true`. Each entry mirrors the bridge tool name (`id: "tool_write_pdf"`, etc.) so `filterToolsByPolicy()` keeps them in the LLM-facing tool list.
  - Without this, the warning at `pi-embedded-*.js:26193` only fires for tools that ARE in `CORE_TOOL_DEFINITIONS` but unavailable in the runtime — our tools were unknown to the policy entirely, so they were silently dropped before reaching the LLM.
  - `sectionId` chosen pragmatically: `fs` for the four file writers/readers, `automation` for the seven Google Workspace tools (cron is already there).
- `patches/openclaw+2026.4.2.patch` — regenerated via `npx patch-package openclaw`. Grew from 572 → 676 lines. The added hunk is the new `CORE_TOOL_DEFINITIONS` entries; the existing pi-embedded hunks (`twixy.freezeRequesterAnnounce`, plan-mode kill cascade, original guardrail gate, `__twixyExtraTools()`, `__twixyGuardrailClassify()`) are preserved.
- `electron/main.ts`
  - **`decodeJwtPayload()`** — new helper that base64url-decodes the payload of a Supabase JWT and returns `{ sub, email }`. No signature verification (token already accepted at the deeplink layer).
  - **`parseAuthDeeplink()`** — now decodes the inbound `access_token` JWT and populates `user: { id: claims.sub, email: claims.email }` in the stored session. Reason: previously only tokens were stored; the renderer's separate `auth-save-session` IPC was supposed to fill `user` later, but in practice that path didn't always run, leaving sessions with `user` undefined.
  - **`currentActor()`** — added a backwards-compat fallback: if `session.user.id` is missing, decode the JWT inline. This handles already-stored sessions (e.g. mine at `~/.openclaw/twixy-session.json`) without forcing re-login.
  - Reason for both: `os.hostname()` change (Mac sleep / system rename / macOS update can flip it from e.g. `ihyeonjun-ui-MacBookAir.local` to `Mac`) was silently changing the local-derived uid → workspace directory `users/local_<hash>/` orphaned, all prior data invisible. Going forward all users authenticate via Supabase, so the uid is the JWT `sub` and is stable across hostname flips.
  - **No automatic migration of legacy `local_*` directories** — by explicit decision, all users use the Supabase uid path from this point on. Any legacy `users/local_<hash>/` directories are left in place; the user can move/merge them manually if needed.
- `SOUL.md`
  - Cut from 21,050 → 19,632 chars (under the 20,000 truncation limit reported by `[agent/embedded] workspace bootstrap file SOUL.md is 21050 chars (limit 20000); truncating in injected context`).
  - **TSL structure code block** (L307~335 in old file) and **TSL path aliases table** (L337~349) replaced with a one-line pointer to `docs/tskill-writing-guide.md` — the guide already covers both with more detail. The TSL syntax was the bottom of the file and the most likely victim of the truncation tail.
  - **"Skill from conversation" subsection** (L264~285) replaced with a one-line pointer to a new section in `docs/tskill-writing-guide.md` — only relevant when the user asks to save a session as a skill, not on every turn.
  - Note: the truncation was NOT the cause of the PPT-as-JSON bug (the Marketing Deliverable Tools section starts at char ~12,377 and was never truncated), but it was an unrelated correctness issue worth fixing in the same push.
- `docs/tskill-writing-guide.md`
  - Appended new section **"Building a skill from a past conversation"** holding the session-log parsing / tool-call extraction / TSL stage mapping content lifted from SOUL.md. Net effect: no information loss, just relocated to where it belongs (a guide loaded only when authoring skills, not on every chat turn).

### 신규 / 삭제된 IPC / 툴 / 스킬
- None on the IPC surface.
- **All 11 bridge tools (`tool_write_pdf`, `tool_write_xlsx`, `tool_read_xlsx`, `tool_write_pptx`, `tool_google_status`, `tool_google_connect`, `tool_google_disconnect`, `tool_write_gdoc`, `tool_read_gdoc`, `tool_write_gsheet`, `tool_read_gsheet`)** are now actually visible to the LLM in the "coding" profile. They were registered in the array on the previous push but invisible due to the missing allowlist entries.

### 검증
- `npx tsc -p tsconfig.electron.json --noEmit` → 0 errors.
- `node --check node_modules/openclaw/dist/tool-policy-Bk9WQZ0U.js` → syntax OK after patch.
- `npx patch-package openclaw` round-trip → patch regenerated cleanly to 676 lines.
- `wc -c SOUL.md` → 19,632 (under the 20,000 truncation limit; the warning should disappear from the next boot).
- LLM end-to-end ("CSV로 PPT 만들어줘" → `tool_write_pptx` actually fires; produced .pptx must satisfy `file <name>.pptx` reporting "Microsoft PowerPoint 2007+", not "JSON data") — **pending manual run** on the next `npm run dev` boot. See `~/.claude/.../memory/project_agent_tools_bridge_test_checklist.md`.
- Stable-uid fix verification — first boot after fix should resolve the workspace path to `users/<JWT-sub>/` (i.e. `users/6dba5df4-…/` for the current session); further boots after a hostname change should resolve to the same path.

---

## 2026-04-25 — OpenClaw tool registration via loopback HTTP bridge (commit `f293cf5`)

> First push on `feature/agent-tools-bridge`. Closes the agent-side tool-discovery gap that caused the YouTube-CSV-to-PPT failure on session `0c6aa068`.

### 추가된 파일
- `electron/agent-tool-bridge.ts` — Loopback HTTP server (binds 127.0.0.1, dynamic port). Authenticated by a per-launch random 32-byte hex bearer token. Exposes `POST /tool/<name>` for 11 tools, all routed to the same internal functions used by the existing `ipcMain.handle('tool-*', ...)` handlers. Path inputs go through `resolveInsideWorkspace()` — same workspace-jail guard as the IPC layer.
- `docs/branches/AGENT_TOOLS_BRIDGE_CHANGELOG.md` — this file.

### 수정된 파일
- `electron/main.ts`
  - Imported `startAgentToolBridge` and added `let toolBridge: BridgeHandle | null = null` to the module-level state.
  - Inside the openclaw-spawn closure (~L1483), start the bridge on first boot (idempotent — reused across openclaw restarts), then inject `TWIXY_TOOL_BRIDGE_PORT` and `TWIXY_TOOL_BRIDGE_TOKEN` into the openclaw subprocess env alongside the existing guardrail/channel/llm env blocks. Bridge failure is logged but does **not** block openclaw startup — the agent simply runs without the 11 extra tools.
  - `before-quit` hook closes the bridge and clears the handle.
  - Reason: openclaw's tool array is hardcoded inside the npm package and there is no public extension API; an env-bridge is the cleanest way to inject tools without forking openclaw itself.
- `node_modules/openclaw/dist/pi-embedded-BYdcxQ5A.js` (patched via `patches/openclaw+2026.4.2.patch`)
  - **`__twixyExtraTools()`** — new helper inserted right before `createOpenClawTools()` (~L23873). Reads `TWIXY_TOOL_BRIDGE_PORT/TOKEN` from env; returns `[]` when unset (graceful no-op when the bridge didn't start). Otherwise returns 11 tool objects in OpenClaw's standard `{ label, name, description, parameters, execute }` shape, with TypeBox `Type.Object(...)` schemas. Each `execute()` POSTs JSON to `http://127.0.0.1:<port>/tool/<name>` with the `Authorization: Bearer <token>` header and wraps the response in `jsonResult(...)`.
  - **`createOpenClawTools()` return** — appended `...__twixyExtraTools()` to the tool-list spread so the 11 tools land in the same array OpenClaw passes to the LLM.
  - **`__twixyGuardrailClassify()`** — extended with three new branches:
    - `tool_write_pdf` / `tool_write_xlsx` / `tool_write_pptx` → kind `"write"`, key = `relPath` (slots into the existing write allowlist).
    - `tool_write_gdoc` / `tool_write_gsheet` → kind `"write"`, key = `title` or `spreadsheetId` (touches the user's Google account, so always require approval unless explicitly allowlisted).
    - `tool_google_connect` / `tool_google_disconnect` → kind `"bash"`, key = the tool name (network/credential side-effect category).
    - Read tools (`tool_read_xlsx`, `tool_read_gdoc`, `tool_read_gsheet`, `tool_google_status`) are intentionally NOT gated.
- `patches/openclaw+2026.4.2.patch` — regenerated via `npx patch-package openclaw`. Grew from 360 to 572 lines; existing hunks (`twixy.freezeRequesterAnnounce`, plan-mode kill cascade fixes, original guardrail gate) are preserved.
- `SOUL.md`
  - New "Marketing Deliverable Tools — USE THESE, NOT SHELL" section under "Capabilities You Have". Maps each common Korean intent ("PDF로 만들어줘", "엑셀로 정리", "PPT", "Google Docs로 발행", "is Google connected?") to the corresponding `tool_*` name, and explicitly tells the LLM **not** to shell out to `pip install` / `python-pptx` / `openpyxl` / `wkhtmltopdf` / `pandoc` (which were the failure modes on `0c6aa068`).
  - Reason: SOUL.md is loaded into every system prompt — making the tool↔intent mapping explicit there is the cheapest way to change LLM behavior without touching the bootstrap pipeline.

### 신규 노출 툴 (LLM이 직접 호출)
- `tool_write_pdf` — `{ relPath, payload: { title?, blocks } }` → workspace-relative PDF path.
- `tool_write_xlsx` — `{ relPath, payload: { sheets: [{ name, rows }] } }`.
- `tool_read_xlsx` — `{ relPath, maxRowsPerSheet? }` → first 200 rows/sheet by default.
- `tool_write_pptx` — `{ relPath, payload: { title?, accent?, slides } }` (default accent = Twixy purple `#7C6AFF`).
- `tool_google_status` — `{}` → `{ connected, email? }`.
- `tool_google_connect` — `{}` → triggers loopback OAuth.
- `tool_google_disconnect` — `{}`.
- `tool_write_gdoc` — `{ title, blocks }` → `{ documentId, url, title }`.
- `tool_read_gdoc` — `{ documentId }` → plain text + structural blocks.
- `tool_write_gsheet` — `{ title?, spreadsheetId?, sheets }`.
- `tool_read_gsheet` — `{ spreadsheetId, range? }` (default first sheet A1:ZZ500).

### 신규 IPC / HTTP 엔드포인트
- HTTP (loopback only): `POST http://127.0.0.1:<TWIXY_TOOL_BRIDGE_PORT>/tool/<name>` with `Authorization: Bearer <TWIXY_TOOL_BRIDGE_TOKEN>`. Body = JSON args. Response `{ ok: true, result }` or `{ ok: false, error }`. Unknown tool → 404, missing/wrong token → 401.
- No new Electron IPC handlers — bridge calls the same internal `writePdf` / `writeXlsx` / `readXlsx` / `writePptx` / `googleAuthClient` / `writeGdoc` / `readGdoc` / `writeGsheet` / `readGsheet` / `googleConnect` / `googleDisconnect` / `googleStatus` functions that the existing `ipcMain.handle('tool-*')` handlers already use.

### 검증
- `npx tsc -p tsconfig.electron.json --noEmit` → 0 errors.
- `npx tsc --noEmit` → 5 pre-existing errors (same set as on `feature/twixy-enterprise @ 88dd9a7`); none in new code.
- `node --check node_modules/openclaw/dist/pi-embedded-BYdcxQ5A.js` → syntax OK after patch.
- `npx patch-package openclaw` round-trip → patch regenerates cleanly to 572 lines.
- End-to-end smoke (LLM "PDF로 만들어줘" → `tool_write_pdf` fires, file lands in `data/reports/`) — **pending manual run**, see `~/.claude/.../memory/project_agent_tools_bridge_test_checklist.md` for the full P0/P1/P2 list.
