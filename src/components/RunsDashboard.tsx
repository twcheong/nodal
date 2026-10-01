// ─────────────────────────────────────────────────────────────────────────────
// RunsDashboard.tsx — Workflow Status Dashboard (Epic 2).
//
// 데이터 소스 3개를 합쳐 보여준다:
//   1. liveRuns  — 이 머신에서 지금 도는 run (WorkflowView 브리지, 실시간)
//   2. 로컬 히스토리 — runs.jsonl (workflowRunHistoryList IPC)
//   3. 팀 runs — org_workflow_runs (30s 폴링; 팀 미소속이면 스킵)
// 내 run 은 로컬 기록을 우선하고 runId 로 dedup. 팀원 머신의 run 은 원격 제어
// 불가(아키텍처상) — 보기만. 내 run 은 Stop/Resume 가능.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import type { WorkflowTestState } from '../hooks/useWorkflowTest'
import { listTeamRuns, type OrgRunRow } from '../lib/teamRuns'
import { RunLogView } from './RunLogView'
import { useConfirm } from './TwixyConfirm'
import { Button, Chip } from './ui'
import { DisplayCost } from '../lib/useDisplayUsd'

// 통합 run 행 — 로컬/팀 소스를 한 테이블로.
interface RunRow {
  runId:      string
  wfId:       string
  wfTitle:    string
  runnerName: string      // 'You' | 팀원 이름
  isMine:     boolean
  status:     'running' | 'done' | 'failed' | 'aborted'
  startedAt:  number
  durationMs: number | null
  costUsd:    number | null
  failReason?: string | null
  // 팀원 실패 run 의 클립된 상세 로그 (org 행 출처) — 로그 뷰어 fallback.
  failLog?:   unknown | null
}

interface Preset {
  name:   string
  status: string | null
  owner:  string | null
  days:   number | null
  query:  string
}

const PRESETS_KEY = 'twixy.runsDash.presets'
const NOTIFY_KEY  = 'twixy.runsDash.notify'

interface Props {
  userId:   string
  orgIds:   string[]
  liveRuns: Record<string, WorkflowTestState>
  workflows: TwixyWorkflow[]
  onStopRun:   (wfId: string) => void
  onResumeRun: (wf: TwixyWorkflow) => void
  onRetryFromNode?: (wf: TwixyWorkflow, nodeId: string) => void
  onOpenWorkflow?: (id: string) => void
}

export function RunsDashboard({ userId, orgIds, liveRuns, workflows, onStopRun, onResumeRun, onRetryFromNode, onOpenWorkflow }: Props) {
  const { confirm, confirmDialog } = useConfirm()
  const [localHistory, setLocalHistory] = useState<TwixyRunHistoryEntry[]>([])
  const [teamRuns, setTeamRuns] = useState<OrgRunRow[]>([])
  // 필터 (2.2) — 프리셋으로 저장 가능 (2.6).
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null)  // 'me' | runner_name
  const [daysFilter, setDaysFilter] = useState<number | null>(7)
  const [query, setQuery] = useState('')
  const [presets, setPresets] = useState<Preset[]>(() => {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]') as Preset[] } catch { return [] }
  })
  const [notifyOn, setNotifyOn] = useState(() => localStorage.getItem(NOTIFY_KEY) !== 'off')
  // 로그 뷰어 대상 run (모달).
  const [logTarget, setLogTarget] = useState<RunRow | null>(null)

  const loadLocal = useCallback(async () => {
    try { setLocalHistory((await window.twixy?.workflowRunHistoryList?.(500)) ?? []) } catch { /* 히스토리 없음 */ }
  }, [])
  const loadTeam = useCallback(async () => {
    if (!orgIds.length) return
    try { setTeamRuns(await listTeamRuns(orgIds)) } catch { /* 오프라인 등 — 로컬만으로 동작 */ }
  }, [orgIds])

  useEffect(() => { void loadLocal() }, [loadLocal])
  // 팀 runs 30s 폴링 (2.1 근실시간). Supabase Realtime 구독은 v2.
  useEffect(() => {
    void loadTeam()
    const t = setInterval(() => { void loadTeam() }, 30_000)
    return () => clearInterval(t)
  }, [loadTeam])
  // 내 run 이 끝나면 (liveRuns 변화) 로컬 히스토리 갱신.
  useEffect(() => {
    const anyRunning = Object.values(liveRuns).some(s => s.isRunning)
    if (!anyRunning) void loadLocal()
  }, [liveRuns, loadLocal])

  // ── 소스 통합 ──────────────────────────────────────────────────────────────
  const wfTitle = useCallback(
    (wfId: string) => workflows.find(w => w.id === wfId)?.title ?? wfId,
    [workflows],
  )

  const rows = useMemo<RunRow[]>(() => {
    const out = new Map<string, RunRow>()
    // 팀 runs (내 것 포함 — 로컬이 곧 덮어씀)
    for (const r of teamRuns) {
      const mine = r.runner_user_id === userId
      out.set(mine ? `${r.wf_id}:${new Date(r.started_at).getTime()}` : r.id, {
        runId:      r.id,
        wfId:       r.wf_id,
        wfTitle:    r.wf_title,
        runnerName: mine ? 'You' : r.runner_name || 'Teammate',
        isMine:     mine,
        status:     r.status,
        startedAt:  new Date(r.started_at).getTime(),
        durationMs: r.duration_ms,
        costUsd:    r.cost_usd,
        failReason: r.fail_reason,
        failLog:    r.fail_log,
      })
    }
    // 로컬 히스토리 — 내 run 의 신뢰 소스 (runId = `wfId:startedAt`).
    for (const e of localHistory) {
      out.set(e.runId, {
        runId: e.runId, wfId: e.wfId, wfTitle: e.wfTitle,
        runnerName: 'You', isMine: true,
        status: e.status, startedAt: e.startedAt,
        durationMs: e.durationMs, costUsd: e.costUsd, failReason: e.failReason,
      })
    }
    // 라이브 (이 머신, 실행 중) — 항상 최우선.
    for (const [wfId, st] of Object.entries(liveRuns)) {
      if (!st.isRunning || !st.startedAt) continue
      out.set(`${wfId}:${st.startedAt}`, {
        runId: `${wfId}:${st.startedAt}`, wfId, wfTitle: wfTitle(wfId),
        runnerName: 'You', isMine: true,
        status: 'running', startedAt: st.startedAt,
        durationMs: null, costUsd: st.totalCost || null,
      })
    }
    return [...out.values()].sort((a, b) => {
      // 실행 중 먼저, 이후 최신순 (실패 강조는 스타일로).
      if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
      return b.startedAt - a.startedAt
    })
  }, [teamRuns, localHistory, liveRuns, userId, wfTitle])

  const owners = useMemo(() => [...new Set(rows.filter(r => !r.isMine).map(r => r.runnerName))], [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cutoff = daysFilter ? Date.now() - daysFilter * 86_400_000 : 0
    return rows.filter(r => {
      if (statusFilter && r.status !== statusFilter) return false
      if (ownerFilter === 'me' && !r.isMine) return false
      if (ownerFilter && ownerFilter !== 'me' && r.runnerName !== ownerFilter) return false
      if (cutoff && r.startedAt < cutoff) return false
      if (q && !r.wfTitle.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, statusFilter, ownerFilter, daysFilter, query])

  // ── 요약 통계 (2.3) — 필터된 기간의 완료 run 기준 + 직전 동일 기간 대비 ──────
  const stats = useMemo(() => {
    const days = daysFilter ?? 30
    const now = Date.now()
    const inWindow  = rows.filter(r => r.status !== 'running' && r.startedAt >= now - days * 86_400_000)
    const prevWindow = rows.filter(r => r.status !== 'running'
      && r.startedAt >= now - 2 * days * 86_400_000 && r.startedAt < now - days * 86_400_000)
    const calc = (list: RunRow[]) => {
      const total = list.length
      const ok = list.filter(r => r.status === 'done').length
      // aborted(사용자 중단)는 성공률 계산에서 제외 — done / (done + failed) 만 기준.
      const rated = list.filter(r => r.status === 'done' || r.status === 'failed').length
      const durs = list.filter(r => typeof r.durationMs === 'number') as Array<RunRow & { durationMs: number }>
      return {
        total,
        successRate: rated ? Math.round((ok / rated) * 100) : 0,
        avgMs: durs.length ? durs.reduce((s, r) => s + r.durationMs, 0) / durs.length : 0,
        failed: list.filter(r => r.status === 'failed').length,
      }
    }
    return { cur: calc(inWindow), prev: calc(prevWindow) }
  }, [rows, daysFilter])

  // ── CSV export (2.3) ───────────────────────────────────────────────────────
  function exportCsv() {
    const header = 'workflow,runner,status,started_at,duration_ms,cost_usd,fail_reason'
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const lines = filtered.map(r =>
      [esc(r.wfTitle), esc(r.runnerName), r.status, new Date(r.startedAt).toISOString(),
       r.durationMs ?? '', r.costUsd ?? '', esc(r.failReason ?? '')].join(','))
    const blob = new Blob([header + '\n' + lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `twixy-runs-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // ── 프리셋 (2.6) ───────────────────────────────────────────────────────────
  function savePreset() {
    const name = prompt('Preset name?')?.trim()
    if (!name) return
    const next = [...presets.filter(p => p.name !== name), { name, status: statusFilter, owner: ownerFilter, days: daysFilter, query }]
    setPresets(next)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
  }
  function applyPreset(p: Preset) {
    setStatusFilter(p.status); setOwnerFilter(p.owner); setDaysFilter(p.days); setQuery(p.query)
  }
  function deletePreset(name: string) {
    const next = presets.filter(p => p.name !== name)
    setPresets(next)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
  }
  function toggleNotify() {
    const next = !notifyOn
    setNotifyOn(next)
    localStorage.setItem(NOTIFY_KEY, next ? 'on' : 'off')
  }

  if (!rows.length) return null  // run 이 하나도 없으면 섹션 자체를 숨김

  return (
    <div style={{ marginBottom: 28 }}>
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Workflow runs</div>
        <Button size="sm" onClick={() => { void loadTeam(); void loadLocal() }} title="Refresh runs">↻</Button>
        <Button size="sm" onClick={exportCsv} title="Export filtered runs as CSV">Export CSV</Button>
        <Button size="sm" onClick={toggleNotify} style={{ opacity: notifyOn ? 1 : 0.5 }} title="OS notification on run failure">
          {notifyOn ? <Bell size={12} strokeWidth={1.8} /> : <BellOff size={12} strokeWidth={1.8} />}
          {notifyOn ? 'Alerts on' : 'Alerts off'}
        </Button>
      </div>

      {/* 요약 위젯 (2.3) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <RunStat label={`Runs (${daysFilter ?? 30}d)`} value={String(stats.cur.total)} delta={stats.cur.total - stats.prev.total} />
        <RunStat label="Success rate" value={`${stats.cur.successRate}%`} delta={stats.cur.successRate - stats.prev.successRate} suffix="pp" />
        <RunStat label="Avg duration" value={fmtDur(stats.cur.avgMs)} />
        <RunStat label="Failed" value={String(stats.cur.failed)} delta={stats.cur.failed - stats.prev.failed} invert />
      </div>

      {/* 필터 (2.2) + 프리셋 (2.6) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search runs…"
          style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)',
                   borderRadius: 7, padding: '4px 9px', fontSize: 11, width: 150, outline: 'none' }}
        />
        {(['running', 'done', 'failed', 'aborted'] as const).map(s => (
          <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)}>{s}</Chip>
        ))}
        <Chip active={ownerFilter === 'me'} onClick={() => setOwnerFilter(ownerFilter === 'me' ? null : 'me')}>My runs</Chip>
        {owners.map(o => (
          <Chip key={o} active={ownerFilter === o} onClick={() => setOwnerFilter(ownerFilter === o ? null : o)}>{o}</Chip>
        ))}
        {[1, 7, 30].map(d => (
          <Chip key={d} active={daysFilter === d} onClick={() => setDaysFilter(daysFilter === d ? null : d)}>{d === 1 ? 'Today' : `${d}d`}</Chip>
        ))}
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        {presets.map(p => (
          <Chip key={p.name} active={false} onClick={() => applyPreset(p)} onRemove={() => deletePreset(p.name)}>{p.name}</Chip>
        ))}
        <Button size="sm" onClick={savePreset} title="Save current filters as a preset">+ Save view</Button>
      </div>

      {/* run 테이블 (2.1 / 2.5) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filtered.slice(0, 50).map(r => {
          const live = r.status === 'running' && r.isMine ? liveRuns[r.wfId] : null
          const currentNode = live ? currentNodeTitle(live, workflows.find(w => w.id === r.wfId)) : null
          const wf = workflows.find(w => w.id === r.wfId)
          const canResume = r.isMine && r.status === 'aborted' && !!wf
          // 클릭 기본 동작 = 로그 보기. 실행 중인 run 은 아직 저장된 로그가 없어
          // 워크플로(라이브 캔버스)로 이동한다. WF 이동은 Open 버튼.
          const hasLog = r.status !== 'running'
          return (
            <div
              key={r.runId}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                border: '1px solid var(--border)', borderRadius: 8,
                borderLeft: r.status === 'failed' ? '3px solid var(--red)' : '1px solid var(--border)',
                background: 'var(--bg-surface)', fontSize: 12,
                cursor: hasLog || (r.isMine && onOpenWorkflow) ? 'pointer' : 'default',
              }}
              onClick={() => {
                if (hasLog) setLogTarget(r)
                else if (r.isMine) onOpenWorkflow?.(r.wfId)
              }}
              title={r.failReason ?? (hasLog ? 'View execution log' : undefined)}
            >
              <StatusBadge status={r.status} />
              <span style={{ color: 'var(--text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                {r.wfTitle}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>{r.runnerName}</span>
              {currentNode && <span style={{ color: 'var(--text-muted)' }}>· {currentNode}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {r.status === 'running'
                  ? `${fmtDur(Date.now() - r.startedAt)} elapsed`
                  : `${new Date(r.startedAt).toLocaleString()} · ${fmtDur(r.durationMs ?? 0)}`}
                {typeof r.costUsd === 'number' && r.costUsd > 0
                  ? <> · <DisplayCost rawUsd={r.costUsd} /></>
                  : ''}
              </span>
              {r.status !== 'running' && (
                <Button size="sm" onClick={(e) => { e.stopPropagation(); setLogTarget(r) }} title="Open run log">
                  Log
                </Button>
              )}
              {r.isMine && r.status === 'running' && (
                <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); onStopRun(r.wfId) }}>
                  Stop
                </Button>
              )}
              {canResume && wf && (
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    void confirm({ title: 'Resume run?', message: `Resume "${r.wfTitle}" from where it was aborted?\n\nCompleted steps are kept; it continues from the stopped node.`, confirmLabel: 'Resume' })
                      .then(ok => { if (ok) onResumeRun(wf) })
                  }}
                >
                  Resume
                </Button>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No runs match the filters.</div>
        )}
      </div>

      {/* 실행 로그 뷰어 (Epic 3) */}
      {logTarget && (
        <RunLogView
          wfId={logTarget.wfId}
          startedAt={logTarget.startedAt}
          isMine={logTarget.isMine}
          fallbackDetail={failLogToDetail(logTarget)}
          canRetry={
            logTarget.isMine &&
            logTarget.status === 'failed' &&
            // 그 워크플로의 최신 run 일 때만 — startFromNode 는 마지막 상태에서 재개한다.
            !rows.some(o => o.wfId === logTarget.wfId && o.startedAt > logTarget.startedAt)
          }
          workflow={workflows.find(w => w.id === logTarget.wfId)}
          onRetryFromNode={onRetryFromNode}
          onOpenWorkflow={logTarget.isMine ? onOpenWorkflow : undefined}
          onClose={() => setLogTarget(null)}
        />
      )}
    </div>
  )
}

// 팀원 실패 run 의 fail_log(클립본)를 RunDetail 근사 형태로 변환 — 로그 뷰어 fallback.
function failLogToDetail(r: RunRow): TwixyRunDetail | null {
  const log = r.failLog as { nodes?: TwixyRunDetailNode[] } | null | undefined
  if (!log || !Array.isArray(log.nodes)) return null
  return {
    runId:     r.runId,
    wfId:      r.wfId,
    wfTitle:   r.wfTitle,
    status:    r.status === 'running' ? 'failed' : r.status,
    startedAt: r.startedAt,
    endedAt:   r.startedAt + (r.durationMs ?? 0),
    totals:    { ms: r.durationMs ?? 0, usd: r.costUsd ?? 0, tokensIn: 0, tokensOut: 0 },
    nodes:     log.nodes,
  }
}

// ── 조각들 ───────────────────────────────────────────────────────────────────
function currentNodeTitle(st: WorkflowTestState, wf: TwixyWorkflow | undefined): string | null {
  if (!wf) return null
  for (const n of wf.nodes) {
    const s = st.nodeStates[n.id]?.status
    if (s === 'running' || s === 'awaiting-review') return n.title
  }
  return null
}

function fmtDur(ms: number): string {
  if (!ms || ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function StatusBadge({ status }: { status: RunRow['status'] }) {
  const color =
    status === 'running' ? 'var(--green, #0d5c50)' :
    status === 'done'    ? 'var(--text-muted)' :
    status === 'failed'  ? 'var(--red)' : 'var(--text-muted)'
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, color, border: `1px solid ${color}`,
      borderRadius: 20, padding: '1px 8px', textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      {status}
    </span>
  )
}

function RunStat({ label, value, delta, suffix = '', invert = false }: {
  label: string; value: string; delta?: number; suffix?: string; invert?: boolean
}) {
  const good = invert ? (delta ?? 0) < 0 : (delta ?? 0) > 0
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', minWidth: 110, background: 'var(--bg-surface)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'baseline', gap: 6 }}>
        {value}
        {typeof delta === 'number' && delta !== 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, color: good ? 'var(--green, #0d5c50)' : 'var(--red)' }}>
            {delta > 0 ? '▲' : '▼'}{Math.abs(delta)}{suffix}
          </span>
        )}
      </div>
    </div>
  )
}

