# Adding a New Agent-Callable Tool

> **Audience:** future Twixy contributors (and future-Henry).
> **Why this doc:** putting a function in `electron/tools/` is **not enough** — the OpenClaw LLM agent won't see it. There are 4 mandatory layers + 2 optional. Skip any of layers 1–4 and the tool is invisible to the LLM (or unsafe, or lost on the next `npm install`).

## Scope — Level 1 tool vs Level 2 tool skill (read this first)

This doc predates the L1/L2 split and covers **Level 1 tools only** — real
machinery: the node's depth-1 `tool` field, the `tool_*` callables, the bridge.
**Level 2 tool skills** (`toolSkills` labels backed by a `skills/<name>/SKILL.md`
runbook) are a different, much cheaper layer with their own doc:
[ADDING_A_TOOL_SKILL.md](ADDING_A_TOOL_SKILL.md). Rule of thumb: **capability
lives in L1, judgment lives in L2.** A new file format or API → this doc. A new
"how to use the existing tools well" runbook → the other doc, no patch needed.
Most features want BOTH (worked example: `tool_write_pptx` upgrade +
`skills/pptx` runbook — see [PPTX_DECK_GENERATION.md](PPTX_DECK_GENERATION.md)).

L2 has its own delivery pitfall that looks like an L1 failure: the runbook
compiles and lands in `<project>/shared/skills/` but never reaches
`users/<uid>/skills/` + `SKILLS.md`, so the executor behaves as if the skill
doesn't exist (2026-08-12 incident — the executor fell back to a competing
skill). The 3-hop delivery chain and where it stalls is documented in
ADDING_A_TOOL_SKILL.md; check `users/<uid>/skills/` before debugging L1 layers.

## Extending an EXISTING L1 tool (the short path)

Adding capability to a tool that is already wired (new payload fields, new
slide kinds, new presets) does NOT need the full 4-layer wiring. The subset
that actually changes, in order — from the `tool_write_pptx` v2 upgrade:

1. `electron/tools/<area>/<name>.ts` — the capability itself
2. Layer 4 description/schema in `pi-embedded-*.js` — the executor only knows
   what the description says; new fields that aren't described don't exist
3. Layer 4.5 description in `tool-policy-*.js` — keep consistent
4. `npx patch-package openclaw` (covers 2+3), commit the patch
5. `src/global.d.ts` renderer-side payload types — manual sync, no drift guard
6. SOUL.md intent row (`wc -c SOUL.md` — 20,000-char cap!) + the L2 runbook if
   the new capability changes how decks/files should be composed
7. `src/lib/workflowTools.ts` sub-skill description (builder-facing)

Layers 2/3/5/7 usually stay untouched — the bridge passes `payload` through
whole, and the tool name (guardrail key, BRIDGE_TOOL_BY_SKILL mapping) doesn't
change. If the payload schema uses `passthroughObj` (e.g. pptx `slides`), new
shapes need NO schema change — but then unknown-variant typos reach the tool at
runtime, so make the tool `throw` on unknown enum values instead of silently
skipping (the pre-v2 pptx tool silently emitted blank slides on kind typos).

## Architecture (one paragraph)

The OpenClaw agent runs as a **separate Node subprocess** (gateway on `ws://127.0.0.1:18789`) spawned by the Electron main process. Its tool list is hardcoded inside `node_modules/openclaw/dist/pi-embedded-*.js` and there is **no public extension API**. To expose Twixy tools to the LLM we patch that file via `patch-package`, and the patched tools `execute()` by POSTing JSON to a **loopback HTTP bridge** (`electron/agent-tool-bridge.ts`) that the Electron main process runs on `127.0.0.1:<dynamic port>`. The bridge is authenticated by a per-launch random Bearer token injected into the openclaw subprocess via env. The bridge handler then calls the same internal function that the renderer-facing `ipcMain.handle('tool-*')` already uses.

```
LLM (in openclaw subprocess)
   │  calls tool_write_foo(args)
   ▼
__twixyExtraTools() in pi-embedded-*.js   ← layer 4 (patch)
   │  POST http://127.0.0.1:<port>/tool/write-foo
   ▼
agent-tool-bridge.ts HANDLERS             ← layer 3
   │  calls writeFoo(safePath, payload)
   ▼
electron/tools/files/foo.ts               ← layer 1 (also called by IPC)
   ▲
   │  ipcMain.handle('tool-write-foo')    ← layer 2 (renderer path)
   │
Renderer (Settings panel, skill cards)
```

## The 4 mandatory layers

### 1. Internal function — `electron/tools/<area>/<name>.ts`

Pure logic. No Electron, no IPC. Takes a **safe path** (already jailed) and a typed payload, returns a typed result.

```ts
// electron/tools/files/foo.ts
import fs from 'node:fs'

export type WriteFooPayload = { title: string; body: string }

export async function writeFoo(safePath: string, payload: WriteFooPayload): Promise<{ bytes: number }> {
  fs.writeFileSync(safePath, /* … */)
  return { bytes: fs.statSync(safePath).size }
}
```

**Rules:**
- Never call `resolveInsideWorkspace()` here — accept an already-resolved `safePath`. Path-jailing is the caller's job (layers 2 and 3 both do it).
- Throw `Error` on failure with a human-readable message.

### 2. Electron IPC handler — `electron/main.ts`

Lets the **renderer** call this tool (Settings panel, skill cards, etc.). Follow the existing `ipcMain.handle('tool-*', …)` pattern.

```ts
// electron/main.ts (near the other tool-* handlers)
ipcMain.handle('tool-write-foo', async (_e, { relPath, payload }: { relPath: string; payload: WriteFooPayload }) => {
  const safe = resolveInsideWorkspace(getWorkspace(), relPath)
  if (!safe) throw new Error('path outside workspace')
  return await writeFoo(safe, payload)
})
```

Then expose it on `window.twixy.tools.*` in `electron/preload.ts` and add the type in `src/global.d.ts`.

### 3. Bridge handler — `electron/agent-tool-bridge.ts`

Lets the **LLM** call this tool. Add one entry to the `HANDLERS` map.

```ts
// electron/agent-tool-bridge.ts
const HANDLERS: Record<string, ToolHandler> = {
  // … existing tools …
  'write-foo': async (body, { getWorkspace }) => {
    const { relPath, payload } = body as { relPath: string; payload: WriteFooPayload }
    const safe = resolveInsideWorkspace(getWorkspace(), relPath)
    if (!safe) throw new Error('path outside workspace')
    return await writeFoo(safe, payload)
  },
}
```

**Rules:**
- The handler key is the URL slug (`write-foo`), the LLM tool name is `tool_write_foo` (different — see layer 4).
- Bridge always re-runs `resolveInsideWorkspace()` — IPC and bridge are two independent entry points. Do not trust the LLM's path.
- Throw on error; the bridge wraps the throw into `{ ok: false, error }` for you. Returning `undefined` is fine.

### 4. OpenClaw patch — `node_modules/openclaw/dist/pi-embedded-*.js`

This is the only layer the LLM actually sees. Add one tool object inside `__twixyExtraTools()`.

```js
// inside __twixyExtraTools() in pi-embedded-*.js
{
  label: 'Write Foo',
  name: 'tool_write_foo',
  description: 'One-line plain-English explanation. State the user-intent that triggers it. End with: "Use this instead of <bad alternative>."',
  parameters: Type.Object({
    relPath: Type.String({ description: 'Workspace-relative path under data/reports/' }),
    payload: Type.Object({
      title: Type.String(),
      body:  Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  execute: async (args) => jsonResult(await call('write-foo', args)),
},
```

**Then run `npx patch-package openclaw`** to regenerate `patches/openclaw+<version>.patch`. **If you skip this step, the tool disappears on the next `npm install`.** The patch file is the source of truth — the `node_modules` edit is just a workspace.

### 4.5. Profile allowlist registration — `node_modules/openclaw/dist/tool-policy-*.js`

**This step is mandatory and easy to forget — skipping it is what bit us in session `d51323ee`.** Adding the tool to `__twixyExtraTools()` puts it in the array `createOpenClawTools()` returns, but OpenClaw runs a **second filter** (`tools.profile`) that drops any tool whose `id` is not in `CORE_TOOL_DEFINITIONS`. The LLM never sees filtered-out tools, even though the bridge is up and the patch is loaded — and the LLM falls back to generic `write` (which writes JSON to `.pptx` files, etc.).

Add an entry per tool to `CORE_TOOL_DEFINITIONS`:

```js
// node_modules/openclaw/dist/tool-policy-<hash>.js
{
  id: "tool_write_foo",
  label: "tool_write_foo",
  description: "One-line summary. End with: 'use instead of <bad alternative>'.",
  sectionId: "fs",            // or "automation" for cloud / network tools
  profiles: ["coding"],       // CRITICAL — this is the allowlist gate
  includeInOpenClawGroup: true
}
```

The `id` must exactly match the `name` field used in layer 4 (i.e. `tool_write_foo`, not `write_foo`).

**Then re-run `npx patch-package openclaw`** — this updates `patches/openclaw+<version>.patch` to cover both the `pi-embedded-*.js` change (layer 4) and the `tool-policy-*.js` change (layer 4.5).

**Symptom of skipping this step:** boot log shows `[tools] tools.profile (coding) allowlist contains unknown entries (...)` warning *for unrelated core tools*, but **no** warning that names your tool — because the warning only fires for tools that ARE in `CORE_TOOL_DEFINITIONS` but unavailable in the runtime. Your tools just silently disappear. The LLM's internal thinking will say something like *"I don't see `tool_write_foo` listed even though SOUL.md mentions it"*, then it falls back to bash / generic write. That is the canonical "I patched it but the LLM still won't use it" failure mode.

**Description writing tips (the LLM only sees this — make it count):**
- Lead with the user intent, not the implementation. ("When the user asks for an Excel sheet, …")
- End with the negative: ("Use this instead of `pip install openpyxl` or shell scripts.") Without this, the LLM falls back to bash on smart-but-wrong instinct (this is exactly what bit us in session `0c6aa068`).
- Keep schemas tight. `additionalProperties: false` for known shapes; use `passthroughObj()` only when the payload is genuinely free-form (e.g. user-defined slide blocks).

## Optional layers

### 5. Guardrail classification — `__twixyGuardrailClassify()` in the patch

If the tool has side effects (writes a file, sends a network request, mutates a Google account), classify it so the existing approval popup / allowlist UI works. Add a branch:

```js
if (toolName === 'tool_write_foo') {
  return { kind: 'write', key: p.relPath ?? '<unknown>' }
}
```

Existing kinds and their semantics:
- `'write'` — writes to the workspace. Key = `relPath`. Slots into the user's write-allowlist (e.g. `data/reports/**`).
- `'bash'` — network or credential side-effect (OAuth, external API). Key = tool name. Always prompts in default mode unless allowlisted.
- (omit) — read-only. Never gated.

### 6. SOUL.md mapping

Add a row to the "Marketing Deliverable Tools" table mapping the user's natural-language intent to the tool name. **Watch the 20,000-char cap** — if you blow past it, the LLM context truncates the tail (where this section lives) and the LLM stops calling your tool.

## Two audiences — the mistake that costs the most

A tool has **two** descriptions, read by **two different LLMs**, and they are not
interchangeable. Getting only one right produces a tool that exists, works, and
is never used.

| Surface | Read by | Where | If you skip it |
|---|---|---|---|
| `description` in `__twixyExtraTools()` | the **executor** (the model running a workflow node) | layer 4 patch | The model calls `bash`/`web_fetch` instead |
| `description` in `WORKFLOW_TOOLS` | the **builder** (the model authoring a workflow spec) | `src/lib/workflowTools.ts` (layer 6) | No spec ever names your tool, so the executor never gets the chance |
| node-prompt tool line | the **executor**, per node | `bridgeToolsFor()` → `buildNodePrompt()` (layer 7) | Spec says `data / collect`; executor has never heard of it and falls back |

Layer 7 exists because the builder's vocabulary and the executor's callable
names are different namespaces. The spec says `tool: "data", toolSkills:
["collect"]`; the callable tool is `tool_fetch_to_file`. Nothing connects them
unless you add the mapping to `BRIDGE_TOOL_BY_SKILL` in `workflowTools.ts`.
Tools whose catalog name happens to resemble an openclaw built-in (`chrome`,
`write`) hide this bug; a genuinely new name exposes it immediately.

**Layer 7 has TWO injection sites — patch both.** `buildNodePrompt` exists
twice, and both are live:

| Builder | Used by |
|---|---|
| `src/hooks/useWorkflowTest.ts` (`buildNodePrompt`, private) | **Test runs** — the WF tab and Copilot ▶ Run |
| `src/lib/runWorkflowNodes.ts` (`buildNodePrompt`) | **Orchestration runs** (`useOrchestrationRun`) |

We patched only `runWorkflowNodes.ts` and shipped: the spec named `data /
collect`, the mapping existed, the bridge was live — and the Test-run prompt
still carried no tool line, so the executor browsed 29 pages and timed out.
The proof procedure is in the runner's session log
(`~/.openclaw/agents/workflow-runner/sessions/*.jsonl`): grep the node prompt
for `Tools for this node`. Zero hits = the builder you patched is not the one
that ran. Until the two builders are unified, every prompt-rule change goes in
both files (each carries a cross-reference comment).

**Also:** `renderToolCatalog()` emits sub-skill **IDs only** — sub-skill
`description` fields never reach the builder. All steering must live in the
depth-1 `description`.

## When a tool changes the recommended workflow shape

If your tool is meant to replace how something is normally done, the tool alone
will not change behaviour. `WORKFLOW_SOUL.md` steers the builder far more
strongly than any catalog line, and it steers by **example**, not by rule:

1. **Find the competing doctrine first.** Grep the SOUL for the pattern you are
   replacing. We shipped a `data` tool while the SOUL still taught "split
   `chrome` page visits into batches of 10–15" as a ✅ best practice — the
   builder kept emitting batch nodes because a procedural instruction beats a
   principle.
2. **Add a worked example, don't just add prose.** The SOUL's canonical example
   is labelled "follow this shape exactly" and the builder copies it. Prose that
   contradicts the only example loses. Add a second example (with a selection
   table at the top) rather than arguing with the first one in text.
3. **State the boundary on the tool you are displacing**, not only on the new
   one — `chrome`'s description now says what it is *not* for.

## Verify the sandbox empirically — assumptions here are expensive

If the tool executes anything model-authored (SQL, a query, a path, a template),
probe the escape surface with real calls before wiring it up. For
`tool_query_data` the engine's own filesystem access reached the real disk:
`COPY (SELECT 1) TO '/tmp/pwned.csv'` actually created the file. A regex
denylist was rejected as unholdable; containment is structural instead (inputs
materialised from buffers, then `SET enable_external_access=false`, so the
engine refuses every path). Write the probe as a test you keep — see
`queryData.ts`'s header comment for the list of things that must stay blocked.

## Wire-up checklist

Before you commit, sanity-check all six:

- [ ] Layer 1: `electron/tools/<area>/<name>.ts` exports a typed function
- [ ] Layer 2: `ipcMain.handle('tool-<name>', …)` in `electron/main.ts`
- [ ] Layer 2: `window.twixy.tools.<name>` in `electron/preload.ts` + `src/global.d.ts`
- [ ] Layer 3: `'<name>'` entry in `HANDLERS` map in `agent-tool-bridge.ts`
- [ ] Layer 4: tool object inside `__twixyExtraTools()` with TypeBox schema
- [ ] Layer 4.5: entry in `CORE_TOOL_DEFINITIONS` array of `tool-policy-*.js` with matching `id` and `profiles: ["coding"]` ← **easiest to forget, hardest to debug**
- [ ] Layer 4: **`npx patch-package openclaw` ran (covers both 4 and 4.5) and `patches/openclaw+*.patch` is in your commit**
- [ ] (Optional) Layer 5: classification branch in `__twixyGuardrailClassify()` if it has side effects
- [ ] (Optional) Layer 6: SOUL.md row added (and total still under 20,000 chars: `wc -c SOUL.md`)

Workflow-callable tools need three more — skip any and the tool is invisible to
the layer that decides to use it:

- [ ] Layer 6a: entry in `WORKFLOW_TOOLS` (`src/lib/workflowTools.ts`) **and** the
      `WorkflowTool` union in `src/global.d.ts` **and** `__EXPECTED_UNION` (the
      drift assertion catches two of the three, not all)
- [ ] Layer 6b: steering in the depth-1 `description` — lead with the intent, end
      with the negative ("use this instead of X"). Sub-skill descriptions are
      **not** rendered to the builder
- [ ] Layer 7: `BRIDGE_TOOL_BY_SKILL` mapping so `buildNodePrompt()` names the
      concrete `tool_*` in the node prompt — in **both** builders
      (`useWorkflowTest.ts` for Test runs, `runWorkflowNodes.ts` for
      Orchestration); the mapping itself lives once in `workflowTools.ts`

Verification for these is behavioural, not a boot log: ask the Copilot for a
workflow that should use the tool, and check the saved `workflow.json` names it.
Then run it and confirm the tool actually appears in the run log — a spec that
names the tool but an executor that ignores it is the layer-7 failure.

## Verification

**Packaged builds:** `scripts/prepare-openclaw-bundle.mjs` installs a *vanilla*
openclaw into `tmp/openclaw-bundle/` and then re-applies `patches/openclaw+*.patch`
itself (added 2026-08-12 — before that the dmg silently shipped an openclaw
without any Twixy tools, invisible in dev because dev uses the repo's patched
`node_modules/`). If you see all Twixy tools missing ONLY in a packaged app,
check that the bundle step logged `applying patches/openclaw+*.patch…`.

Boot logs to expect on `npm run dev`:

```
[twixy] tool-bridge listening on 127.0.0.1:<port>
[openclaw] [gateway] listening on ws://127.0.0.1:18789
```

Then in the Twixy chat: "make a foo for me" (or whatever intent you mapped). Watch:

1. The LLM **calls** `tool_write_foo` (visible in chat as a tool-call card) — not bash, not Python, not a generic file-write.
2. The bridge log shows the POST (or, if quiet, you can `lsof -nP -iTCP:<port>` to confirm the port is loopback-only).
3. The expected file lands in the workspace, NOT a JSON dump with the wrong extension.

If the LLM ignores the tool and shells out instead, the most common cause is SOUL.md being truncated past 20,000 chars (the deliverable-tool mapping is at the tail and gets cut). Run `wc -c SOUL.md` and trim if needed.

## Common mistakes (real ones we hit)

| Mistake | Symptom | Fix |
|---|---|---|
| Skipped layer 4 (patch) | Tool callable from renderer, LLM never sees it | Add to `__twixyExtraTools()` + patch-package |
| **Skipped layer 4.5** (allowlist) | Bridge listening, patch loaded, but LLM thinking says "I don't see tool_X listed" → falls back to generic `write` | Add tool `id` to `CORE_TOOL_DEFINITIONS` in `tool-policy-*.js` with `profiles: ["coding"]`, then re-run `patch-package` |
| Skipped `patch-package` | Tool works on this machine, gone after `rm -rf node_modules && npm install` | Run `npx patch-package openclaw` and commit the diff |
| LLM calls `write` (generic file-write) instead of `tool_write_pptx` and dumps JSON to a `.pptx` filename | File doesn't open in PowerPoint — `file <name>.pptx` reports `JSON data` | Strengthen tool description ("MUST use this for any .pptx output, do NOT write JSON") + check SOUL.md isn't truncating the mapping |
| Bridge env vars missing in subagents | `__twixyExtraTools()` returns `[]` for subagents only | (Currently fine — subagents are in-process and inherit `process.env`. If openclaw ever forks subagents to a child process, you'd need to pass `TWIXY_TOOL_BRIDGE_PORT/TOKEN` through their env explicitly.) |
| Forgot `additionalProperties: false` | LLM sometimes invents extra fields, server ignores them silently | Always set it on closed shapes |
| **Skipped layer 7** (bridge-name mapping) | Spec correctly says `tool: "data"`, run log shows the executor using `web_fetch` and hitting the 50K truncation instead. No error anywhere — it just quietly does the expensive thing | Add the pair to `BRIDGE_TOOL_BY_SKILL`; `buildNodePrompt()` then names `tool_fetch_to_file` in the node prompt |
| **Patched only ONE of the two prompt builders** | Mapping exists, verification "looks done", but the Test-run prompt still has no tool line — executor browses page-by-page and times out. Nothing errors; you only see it in the runner session log | `buildNodePrompt` is duplicated: `useWorkflowTest.ts` (Test runs) AND `runWorkflowNodes.ts` (Orchestration). Change both; confirm with `grep 'Tools for this node' ~/.openclaw/agents/workflow-runner/sessions/<latest>.jsonl` |
| Steering written only in the sub-skill `description` | Builder never picks the tool; catalog looks correct when you read the source | `renderToolCatalog()` emits sub-skill IDs only — move it to the depth-1 `description` |
| Tool added but SOUL still teaches the old shape | Builder keeps emitting the pattern you replaced, even with correct catalog text | Grep SOUL for the competing doctrine; add a worked example, not more prose |
| Assumed the embedded engine is sandboxed | Model-authored SQL wrote a file outside the workspace | Probe the escape surface with real calls; contain structurally, not with a denylist |

## See also

- `docs/branches/AGENT_TOOLS_BRIDGE_CHANGELOG.md` — full history of how the bridge was built (Phase 4)
- `electron/agent-tool-bridge.ts` — the bridge implementation, with security model in the file header
- `patches/openclaw+*.patch` — current state of the openclaw patches (bridge tools, guardrail, freeze hook)
