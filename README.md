# Nodal Electron integration

This `electron` branch combines the Nodal desktop app from
`Appggong/twixy-marketing-copilot` (`feature/nodal-studio`, `389066a`) with the
Qwen Image 2.1 engine work from `twcheong/nodal` (`faabeaf`). The desktop app lives
in `products/nodal/`; its embedded engine lives in `products/nodal/engine/`.
See [Nodal setup and build instructions](products/nodal/README.md) and
[integration validation](products/nodal/integration-validation.md).
The engine-only `main` branch retains its existing layout.

The shared Electron shell and its original documentation follow below.

# Twixy — Personal Marketing Copilot

A desktop marketing/agent-orchestration IDE. Chat with an AI copilot, build visual
workflows and multi-agent orchestrations, run them against a bundled local agent
(OpenClaw), and collaborate with your team — all in one Electron app.

Built with Electron + React 19 + TypeScript + Vite.

---

## Features

### AI copilot & chat
- Conversational copilot panel that routes and authors work: it parses `copilot-action`
  directives (run/show a workflow with inputs) and can drive a one-time "simple execution"
  plan without building a full workflow.
- Simple-mode plan history persisted locally and re-injected for the LLM.
- Live tool-activity indicators, plan mode, quick actions, and file links in the chat surface.

### Visual workflow builder
- Builder chat emits `workflow-spec` / `simple-plan` blocks that are parsed and normalized
  into an internal workflow model (loose LLM field names remapped, nodes sorted, unknown
  tools/skills dropped against a static catalog).
- Interactive node canvas: drag, connect, and lay out steps; optional Human-Review nodes.
- Version diffing (side-by-side node comparison, added/removed/changed coloring).
- Headless sequential node runner with per-node cost/time deltas, abort/failure handling,
  and auto-handled review nodes.

### Multi-agent orchestration
- Compose workflows and AI agents into a nested member tree (groups + leaves) with immutable
  tree edits: group/ungroup, reparent, move, wrap-in-parallel, add-downstream.
- I/O-contract engine checks output→input compatibility between members, gates Run on unmet
  required inputs, and computes total runtime as the tree's critical path.
- Per-pattern execution strategies: **pipeline** (sequential), **parallel** / **research**
  (concurrent + aggregate), and **specialist/relay** (LLM picks one branch). Roundtable and
  conductor patterns exist but are currently disabled.

### Data files & reports
- Workspace file browser with sortable table previews for CSV/TSV/JSON/Markdown and images.
- In-app Markdown editing (Tiptap) and export to CSV / PDF / XLSX / PPTX.
- Run dashboards and live run logs with retry-from-node, plus CSV export of run detail.

### Pricing, quota & usage
- Static model catalog (cost, context window) with fallback raw-cost math and USD formatting.
- Subscription/quota client that mirrors tier limits for instant UI; display markup is applied
  out-of-process in the Electron main so the multiplier never crosses IPC.
- Status bar showing connection, tier, token/usage limits, credit balance, and upgrade CTA.

### Team collaboration
- Team invites (code-based + email via Supabase Edge Function), roster, and member management.
- Realtime co-editing of live-workflow documents and a shared-workflow registry with tag
  normalization and copy>run adoption ranking.
- 1:1 direct messages, team run telemetry, and shared/live workflow presence — all over Supabase
  realtime.

### Auth, setup, guardrails & connections
- Supabase auth, setup/upgrade flows, and a standalone guardrail approval popup for permission
  requests (approve / this-session / remember / deny) on actions like file overwrites.
- External connections: encrypted local secret vault, MCP servers (+ OAuth), and Google
  Docs/Sheets/Gmail/OAuth.
- Update notifications via a Supabase `app_release` singleton and semver comparison.

### Enterprise admin
- Separate build/window (`APP_MODE=twixy-enterprise`) with a dashboard that browses saved
  project folders and reports completed plans / skill usage per worker over today/week/month/all.

---

## Architecture

Twixy is a two-process Electron app plus several secondary BrowserWindows.

**Electron main process (`electron/`) — the trusted backend.**
Owns app lifecycle and window management, and exposes a large IPC surface (via `preload.ts`'s
`contextBridge` → `window.twixy`) for everything the renderer cannot do directly:

- `main.ts` — entry point: lifecycle, windows, hundreds of `ipcMain.handle` registrations,
  OpenClaw agent subprocess spawn/stream, auth/session handling, skills watcher.
- `pricing.ts` — display-markup pricing cache (multiplier stays in main).
- `planning.ts` — persistence + domain layer for Plans/Workflows/Orchestrations/AI-agents and
  run history, plus pure transforms (module-spec generalization, fingerprinting, markdown render).
- `tsl-compiler.ts` — `.tskill` → `SKILL.md` Twixy Skill Language compiler.
- `mr.ts` — local-only Merge Request store governing changes to the shared workspace.
- `tools/files/` — file-write safety (workspace containment + designated-bucket path guards) and
  writers/extractors (xlsx, pdf, pptx, text extraction).
- `google/`, `connections/`, `guardrail/`, `designated-paths/` — Google APIs, connection vault +
  MCP, guardrail config, and write-policy config with their IPC wiring.
- `execution-plan-api.ts`, `agent-tool-bridge.ts` — localhost HTTP bridges so external tools and
  the agent subprocess can submit plans / call back into main.

**Renderer (`src/`) — the React UI.**
Talks to the backend through `window.twixy`, Supabase realtime, and network calls.

- `src/lib/` — headless core: chat-output parsers, pricing/entitlements, the orchestration I/O
  and tree engines, per-pattern strategies, system-prompt (SOUL) builders, and thin Supabase
  access layers for org/team data. Most heavy logic here is pure and dependency-free.
- `src/components/` — the whole desktop UI: chat/copilot, workflow builder + node canvas,
  orchestration canvas, data browser, run dashboards/logs, team collaboration, and auth/setup flows.
- `src/hooks/` — React hooks (auth, overlay sync, …).
- `src/composer/`, `src/sidetab/`, `src/guardrail/`, `src/admin/` — secondary BrowserWindow entry
  points (floating composer bar, side overlay panel, guardrail popup, enterprise admin dashboard).

**System-prompt files (repo root):** `SOUL.md`, `WORKFLOW_SOUL.md`, `ORCHESTRATION_SOUL.md`,
`AIAGENT_SOUL.md`, `TSL.md`, and `AGENTS.md` define the product-runtime agent behavior (distinct
from `CLAUDE.md`, which configures the *development* harness).

---

## Getting started

### Prerequisites
- Node.js 22+ and npm.
- Electron 33 (installed as a dev dependency).
- Native builds pull `openclaw` and apply local patches via `patch-package` on install.

### Install
```bash
npm install        # runs patch-package via postinstall
```

### Develop
```bash
npm run dev            # Vite renderer (dev server)
npm run dev:electron   # tsc watch for the Electron main process
```
Run the two in parallel (separate terminals). For the enterprise surface use
`npm run dev:twixy-enterprise`.

### Build
```bash
npm run build          # prepares the OpenClaw bundle, compiles electron/, and vite build
```

### Package / distribute
```bash
npm run dist           # build + electron-builder (current OS)
npm run dist:mac       # macOS dmg
npm run dist:win       # Windows nsis
npm run dist:all       # macOS + Windows
```
Enterprise variants: `dist:twixy-enterprise:mac` / `dist:twixy-enterprise:win`.

### Test & lint
```bash
npm test               # vitest run (jsdom)
npm run test:watch     # vitest watch
npm run lint           # eslint src electron
```

---

## Project layout

```
electron/            Main-process backend (IPC, agent subprocess, fs, Google/MCP/Supabase, guards)
  tools/files/       Path guards + file writers/extractors (xlsx, pdf, pptx, text)
  google/            Docs/Sheets/Gmail/OAuth wrappers
  connections/       Secret vault, MCP servers + OAuth
src/
  App.tsx, main.tsx  Renderer entry
  lib/               Headless core: parsers, pricing, orchestration engine, patterns, SOUL builders,
                     org/team Supabase access layers
  components/        React UI (chat, workflow builder, orchestration, data, runs, team, auth)
    workflow/  orchestration/  copilot/
  hooks/             React hooks
  composer/ sidetab/ guardrail/ admin/   Secondary BrowserWindow entry points
  test/              vitest setup
skills/              Built-in + user (.twixy-custom) product skills
assets/              App icons, entitlements
*.md (root)          Product SOUL / AGENTS prompts and TSL spec
```

---

## Testing

Tests run under **Vitest** in a **jsdom** environment (`vitest.config.ts`), included as
`src/**/*.{test,spec}.{ts,tsx}` with setup in `src/test/setup.ts`. The Electron main process
(`electron/`) is intentionally excluded — its config would try to build the main process during
test runs.

```bash
npm test           # one-shot run
npm run test:watch # watch mode
```

The most valuable unit-test targets are the deterministic, dependency-free helpers in `src/lib`
(chat-output parsers, orchestration I/O compatibility, tree edits, error/pricing/tag helpers) and
the pure helpers embedded in the Electron subsystems (TSL compiler, path guards, execution-plan
validator, MIME builder). Network/Supabase/IPC/localStorage-backed functions are not directly
unit-testable, though many wrap a pure helper that is.
