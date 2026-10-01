# `feature/dashboard-v2` — Branch Change Log

> **Scope:** Dashboard panel rewrite (v2). Adds three new sections — Recent Reports, Data Sources, Next Actions — backed by a single `dashboard-snapshot` IPC. Builds on Phase 1 (`feature/file-io`) writers and Phase 2 (`feature/google-workspace`) Google connection state.
> **Branch base:** `feature/google-workspace` HEAD `e387b2a` (2026-04-25).
> **Parent in stack:** `feature/google-workspace`.
> **Child in stack:** (none — top of the stack).
>
> **Update rule:** Append a new section **before every `git push`** with the exact files/handlers/sections changed in that push. End each entry with the 7-char commit hash. Do **not** touch `TWIXY_ENTERPRISE_CHANGELOG.md` from this branch.
>
> **Entry template:** see `FILE_IO_CHANGELOG.md`.

---

<!-- New entries go below, newest on top. -->

## 2026-04-25 — `dashboard-snapshot` IPC + Recent Reports / Sources / Next Actions strip (commit `71d0352`)

> First push on `feature/dashboard-v2`.

### 추가된 파일
- `docs/branches/DASHBOARD_V2_CHANGELOG.md` — this file.

### 수정된 파일
- `electron/main.ts`
  - New IPC handler `dashboard-snapshot`: returns `{ recentReports, dataSources, nextActions }` in one round-trip. Walks `data/reports/` (top 30 by mtime), counts files in `data/raw|saved|insights|exports|reports`, reads `googleStatus(getTwixyMetaDir())`, picks the newest insight from `data/insights/`, and emits 1–3 heuristic next actions (generate report pack, publish to Google Docs, connect Google, run a first analytics scan).
- `electron/preload.ts`
  - Added `dashboardSnapshot()` to the top-level `window.twixy` surface (sibling of `recentFiles`, not under `tools` — same call-site pattern as the other dashboard reads).
- `src/global.d.ts`
  - New types: `TwixyReportKind`, `TwixyDashboardReport`, `TwixyDashboardNextAction`, `TwixyDashboardSnapshot`. `TwixyAPI.dashboardSnapshot` declared.
- `src/components/DashboardPanel.tsx`
  - Added `snapshot` state + 6s polling effect (shares cadence with the existing widget auto-sync).
  - Rendered new `<SnapshotStrip>` at the top of the widget grid — three cards in a responsive grid: Recent Reports (clickable file rows that reveal in Finder), Data Sources (Google connection dot + per-folder file counts + relative timestamps), Next Actions (each item gets a "Use" button when it has a `prompt`, which drops the prompt into the dashboard input box).
  - Reason: closes the SOUL.md loop "데이터 수집 → 분석 → 실행 → 결과 추적" by surfacing the artifacts produced by Phase 1+2 (PDF/XLSX/PPTX/Google Docs) and recommending the next concrete step.
  - Imported `Fragment` for the data-source key/value grid.

### 신규 IPC
- `dashboard-snapshot` — `() → TwixyDashboardSnapshot`. Cheap synchronous walks of small dirs; safe to poll.

### 검증
- `npx tsc -p tsconfig.electron.json --noEmit` → 0 errors.
- `npx tsc --noEmit` → 5 pre-existing errors (same set as on `feature/twixy-enterprise @ 88dd9a7`); none in new code.
- Visual smoke check pending first `npm run dev` boot — Electron app, no browser preview path.
