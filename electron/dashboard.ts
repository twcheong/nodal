// ── 대시보드 스냅샷 (main.ts 에서 이동) ─────────────────────────────────────
//
// 대시보드 세 구획(최근 리포트 · 데이터 소스 · 다음 액션)을 한 번에 내려주는 IPC 하나.
// 작은 디렉토리를 동기로 훑는다 — 렌더러가 6초마다 폴링한다 (Stage 4 슬라이스 2).
import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './trustBoundary'
import { status as googleStatus } from './google/oauth'

export interface DashboardDeps {
  getWorkspace: () => string
  getTwixyMetaDir: () => string
}

/** dashboard-snapshot IPC 를 등록한다. import 시점 부작용 없음. */
export function registerDashboardIpc(deps: DashboardDeps): void {
  const { getWorkspace, getTwixyMetaDir } = deps

  // ── Dashboard snapshot (Phase 3 / dashboard-v2) ─────────────────
  // One IPC that powers the three new dashboard sections:
  //   • Recent Reports — local PDF/XLSX/PPTX in data/reports/
  //   • Data Sources  — Google connection + workspace folder counts
  //   • Next Actions  — heuristic follow-ups derived from the newest insight
  // Lightweight on purpose: synchronous walks of small directories. The
  // renderer polls every 6s alongside the existing widget sync loop.
  ipcMain.handle('dashboard-snapshot', () => {
    const ws = getWorkspace()
    const reportKindFor = (name: string): 'pdf' | 'xlsx' | 'pptx' | 'other' => {
      const ext = name.toLowerCase().split('.').pop() ?? ''
      if (ext === 'pdf')  return 'pdf'
      if (ext === 'xlsx') return 'xlsx'
      if (ext === 'pptx') return 'pptx'
      return 'other'
    }
    type Report = { name: string; relPath: string; kind: ReturnType<typeof reportKindFor>; mtime: number; sizeBytes: number }
    function listReports(): Report[] {
      const dir = path.resolve(ws, 'data', 'reports')
      if (!isInside(ws, dir) || !fs.existsSync(dir)) return []
      const out: Report[] = []
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
      for (const e of entries) {
        if (!e.isFile()) continue
        const full = path.join(dir, e.name)
        try {
          const st = fs.statSync(full)
          out.push({
            name:      e.name,
            relPath:   path.relative(ws, full),
            kind:      reportKindFor(e.name),
            mtime:     st.mtimeMs,
            sizeBytes: st.size,
          })
        } catch { /* skip */ }
      }
      return out.sort((a, b) => b.mtime - a.mtime).slice(0, 30)
    }

    function countFiles(rel: string): number {
      const abs = path.resolve(ws, rel)
      if (!isInside(ws, abs, { allowRoot: true }) || !fs.existsSync(abs)) return 0
      let n = 0
      try {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (e.isFile()) n++
        }
      } catch { /* ignore */ }
      return n
    }

    function newestInsight(): { name: string; relPath: string; mtime: number } | null {
      const dir = path.resolve(ws, 'data', 'insights')
      if (!isInside(ws, dir) || !fs.existsSync(dir)) return null
      let best: { name: string; relPath: string; mtime: number } | null = null
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isFile()) continue
          const full = path.join(dir, e.name)
          let st: fs.Stats
          try { st = fs.statSync(full) } catch { continue }
          if (!best || st.mtimeMs > best.mtime) {
            best = { name: e.name, relPath: path.relative(ws, full), mtime: st.mtimeMs }
          }
        }
      } catch { /* ignore */ }
      return best
    }

    const reports = listReports()
    let google: { connected: boolean; email: string | null } = { connected: false, email: null }
    try {
      const s = googleStatus(getTwixyMetaDir())
      google = { connected: !!s.connected, email: s.email ?? null }
    } catch { /* google may not be wired yet */ }

    const insight = newestInsight()
    const hasReports = reports.length > 0
    const nextActions: { id: string; label: string; hint: string; prompt?: string }[] = []
    if (insight && !hasReports) {
      nextActions.push({
        id:     'pack-from-insight',
        label:  'Generate report pack from latest insight',
        hint:   `${insight.name} → PDF + XLSX + PPTX in data/reports/`,
        prompt: `Run the report-pack skill on ${insight.relPath}`,
      })
    }
    if (insight && google.connected) {
      nextActions.push({
        id:     'gdoc-from-insight',
        label:  'Publish latest insight to Google Docs',
        hint:   `${insight.name} → shareable doc in your Google Workspace`,
        prompt: `Run the gdoc-report skill on ${insight.relPath}`,
      })
    }
    if (!google.connected) {
      nextActions.push({
        id:    'connect-google',
        label: 'Connect Google Workspace',
        hint:  'Enables Docs / Sheets read/write from skills.',
      })
    }
    if (!insight) {
      nextActions.push({
        id:    'first-insight',
        label: 'Run an analytics scan to produce a first insight',
        hint:  'No files in data/insights/ yet — once one lands, report skills unlock.',
      })
    }

    return {
      recentReports: reports,
      dataSources: {
        google,
        workspace: {
          rawCount:      countFiles('data/raw'),
          savedCount:    countFiles('data/saved'),
          insightsCount: countFiles('data/insights'),
          exportsCount:  countFiles('exports'),
          reportsCount:  reports.length,
        },
        lastReportAt: reports[0]?.mtime ?? null,
        lastInsightAt: insight?.mtime ?? null,
      },
      nextActions,
    }
  })
}
