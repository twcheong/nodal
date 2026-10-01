import { useCallback, useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { safeHtml } from '../lib/safeHtml'

type PlanSummary = {
  id: string
  uid: string
  title: string
  updatedAt: string
  skillsReferenced: string[]
}

type AdminData = {
  projectRoot: string
  todaySkills: string[]
  donePlansToday: PlanSummary[]
  topSkillsThisMonth: { name: string; count: number }[]
  newSkillsThisMonth: { name: string; mtime: string }[]
  allDonePlans: PlanSummary[]
}

type SavedProject = { root: string; name: string }

const PROJECTS_KEY = 'twixy-enterprise.projects'
function loadProjects(): SavedProject[] {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]') } catch { return [] }
}
function saveProjects(ps: SavedProject[]) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(ps)) } catch { /* ignore */ }
}

type AppView =
  | { page: 'projects' }
  | { page: 'dashboard' }
  | { page: 'completed-work'; dateFilter: DateFilter; uidFilter: string | null }

type DateFilter = 'today' | 'week' | 'month' | 'all'

const TODAY = new Date().toISOString().slice(0, 10)
const WEEK_AGO = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
const MONTH = new Date().toISOString().slice(0, 7)

// ── Root ─────────────────────────────────────────────────────────

export function TwixyEnterpriseDashboard() {
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>(loadProjects)
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [data, setData]         = useState<AdminData | null>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [view, setView]         = useState<AppView>({ page: 'projects' })
  const [runModal, setRunModal] = useState<{ plan: PlanSummary; content: string } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const pickFolder = useCallback(async () => {
    const folder = await window.twixy.twixyEnterprisePickFolder()
    if (!folder) return
    const name = folder.split('/').pop() ?? folder
    setSavedProjects(prev => {
      if (prev.some(p => p.root === folder)) return prev
      const next = [...prev, { root: folder, name }]
      saveProjects(next)
      return next
    })
    setProjectRoot(folder)
    setRefreshKey(k => k + 1)
    setView({ page: 'dashboard' })
  }, [])

  const openProject = useCallback((root: string) => {
    setProjectRoot(root)
    setRefreshKey(k => k + 1)
    setView({ page: 'dashboard' })
  }, [])

  const removeProject = useCallback((root: string) => {
    setSavedProjects(prev => {
      const next = prev.filter(p => p.root !== root)
      saveProjects(next)
      return next
    })
  }, [])

  useEffect(() => {
    if (!projectRoot) return
    setLoading(true)
    setError(null)
    window.twixy.twixyEnterpriseAdminLoad(projectRoot)
      .then((d: AdminData) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [projectRoot, refreshKey])

  const openRun = useCallback(async (plan: PlanSummary) => {
    if (!projectRoot) return
    // main 이 거부하면(고르지 않은 폴더·이상한 id) reject 된다 — 조용히 삼키면
    // "기록 없음" 과 구별되지 않으므로 모달에 그대로 띄운다.
    try {
      const content = await window.twixy.twixyEnterpriseReadRun(projectRoot, plan.uid, plan.id)
      setRunModal({ plan, content: content ?? '_No run log found._' })
    } catch (e) {
      setRunModal({ plan, content: `⚠ ${e instanceof Error ? e.message : String(e)}` })
    }
  }, [projectRoot])

  const goCompleted = useCallback((dateFilter: DateFilter, uid: string | null = null) => {
    setView({ page: 'completed-work', dateFilter, uidFilter: uid })
  }, [])

  const projectName = projectRoot ? (projectRoot.split('/').pop() ?? projectRoot) : null

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 40px 0', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {view.page === 'dashboard' && (
            <button onClick={() => setView({ page: 'projects' })} style={backBtn}>← Projects</button>
          )}
          {view.page === 'completed-work' && (
            <button onClick={() => setView({ page: 'dashboard' })} style={backBtn}>← Dashboard</button>
          )}
          <div>
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
              {view.page === 'projects'  ? 'Projects' :
               view.page === 'dashboard' ? (projectName ?? 'Dashboard') :
               'Completed Work'}
            </span>
            {projectRoot && view.page !== 'projects' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
                {projectRoot}
              </div>
            )}
          </div>
        </div>
        <button onClick={pickFolder} style={primaryBtn}>
          {view.page === 'projects' ? '+ Add project' : 'Change folder'}
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 40px 40px' }}>

        {view.page === 'projects' && (
          <ProjectsView
            projects={savedProjects}
            onOpen={openProject}
            onRemove={removeProject}
            onAdd={pickFolder}
          />
        )}

        {view.page !== 'projects' && loading && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        )}
        {view.page !== 'projects' && error && (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
        )}

        {data && !loading && view.page === 'dashboard' && (
          <DashboardView data={data} onOpenRun={openRun} onGoCompleted={goCompleted} />
        )}

        {data && !loading && view.page === 'completed-work' && (
          <CompletedWorkView
            plans={data.allDonePlans}
            initialDate={view.dateFilter}
            initialUid={view.uidFilter}
            onOpenRun={openRun}
          />
        )}
      </div>

      {runModal && (
        <RunModal
          plan={runModal.plan}
          content={runModal.content}
          onClose={() => setRunModal(null)}
        />
      )}
    </div>
  )
}

// ── Projects view ─────────────────────────────────────────────────

function ProjectsView({ projects, onOpen, onRemove, onAdd }: {
  projects: SavedProject[]
  onOpen: (root: string) => void
  onRemove: (root: string) => void
  onAdd: () => void
}) {
  if (projects.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, paddingTop: 80, color: 'var(--text-muted)',
      }}>
        <div style={{ fontSize: 40 }}>📂</div>
        <div style={{ fontSize: 14 }}>No projects yet</div>
        <button onClick={onAdd} style={{ ...primaryBtn, marginTop: 4 }}>+ Add project folder</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {projects.map(p => (
        <div
          key={p.root}
          onClick={() => onOpen(p.root)}
          style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
            borderRadius: 10, padding: '16px 18px', cursor: 'pointer',
            position: 'relative', transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, paddingRight: 24 }}>
            {p.name}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {p.root}
          </div>
          <button
            onClick={e => { e.stopPropagation(); onRemove(p.root) }}
            style={{
              position: 'absolute', top: 10, right: 10, background: 'transparent',
              border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
              fontSize: 16, lineHeight: 1, padding: '2px 5px', borderRadius: 4,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Dashboard view ────────────────────────────────────────────────

function DashboardView({ data, onOpenRun, onGoCompleted }: {
  data: AdminData
  onOpenRun: (p: PlanSummary) => void
  onGoCompleted: (date: DateFilter, uid?: string | null) => void
}) {
  const workerFreq = useMemo(() =>
    Object.entries(
      data.donePlansToday.reduce<Record<string, number>>((acc, p) => {
        acc[p.uid] = (acc[p.uid] ?? 0) + 1
        return acc
      }, {})
    ).sort((a, b) => b[1] - a[1]),
  [data.donePlansToday])

  const maxFreq = workerFreq[0]?.[1] ?? 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Worker completion frequency */}
        <Section title="Today's Completions by Worker">
          {workerFreq.length === 0
            ? <Empty>No completions today</Empty>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {workerFreq.map(([uid, count]) => (
                  <div
                    key={uid}
                    onClick={() => onGoCompleted('today', uid)}
                    style={{ cursor: 'pointer' }}
                    title="View this worker's completed tasks"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{
                        fontSize: 11, fontFamily: 'monospace', color: 'var(--accent)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '82%',
                        textDecoration: 'underline', textDecorationColor: 'rgba(154,154,154,0.4)',
                      }}>
                        {uid}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', flexShrink: 0, marginLeft: 8 }}>
                        {count}
                      </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-input)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2, background: 'var(--accent)',
                        width: `${(count / maxFreq) * 100}%`, transition: 'width 0.3s ease',
                      }} />
                    </div>
                  </div>
                ))}
              </div>
          }
        </Section>

        {/* Completed today */}
        <Section
          title="Completed Today"
          right={
            data.donePlansToday.length > 0
              ? <button onClick={() => onGoCompleted('today')} style={linkBtn}>
                  {data.donePlansToday.length} total →
                </button>
              : undefined
          }
        >
          {data.donePlansToday.length === 0
            ? <Empty>No completed tasks today</Empty>
            : <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
                {data.donePlansToday.map(p => (
                  <PlanRow key={p.id} plan={p} onClick={() => onOpenRun(p)} />
                ))}
              </div>
          }
        </Section>

      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        <Section title="Most Used Skills This Month">
          {data.topSkillsThisMonth.length === 0
            ? <Empty>No skill usage this month</Empty>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {data.topSkillsThisMonth.map((s, i) => (
                  <div key={s.name} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 10px', borderRadius: 6,
                    background: i === 0 ? 'rgba(154,154,154,0.12)' : 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', minWidth: 18 }}>
                        #{i + 1}
                      </span>
                      <span style={{ fontSize: 12 }}>{s.name}</span>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: 'var(--accent)' }}>
                      {s.count}×
                    </span>
                  </div>
                ))}
              </div>
          }
        </Section>

        <Section title="New Skills This Month">
          {data.newSkillsThisMonth.length === 0
            ? <Empty>No new skills created this month</Empty>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {data.newSkillsThisMonth.map(s => (
                  <div key={s.name} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 10px', borderRadius: 6,
                    background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
                  }}>
                    <span style={{ fontSize: 12 }}>{s.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(s.mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
          }
        </Section>

      </div>
    </div>
  )
}

// ── Completed Work page ───────────────────────────────────────────

function CompletedWorkView({ plans, initialDate, initialUid, onOpenRun }: {
  plans: PlanSummary[]
  initialDate: DateFilter
  initialUid: string | null
  onOpenRun: (p: PlanSummary) => void
}) {
  const [dateFilter, setDateFilter] = useState<DateFilter>(initialDate)
  const [uidFilter,  setUidFilter]  = useState<string>(initialUid ?? 'all')

  const allUids = useMemo(() =>
    [...new Set(plans.map(p => p.uid))].sort(),
  [plans])

  const filtered = useMemo(() => {
    return plans.filter(p => {
      const d = p.updatedAt.slice(0, 10)
      const dateOk =
        dateFilter === 'all'   ? true :
        dateFilter === 'today' ? d === TODAY :
        dateFilter === 'week'  ? d >= WEEK_AGO :
        /* month */               p.updatedAt.startsWith(MONTH)
      const uidOk = uidFilter === 'all' || p.uid === uidFilter
      return dateOk && uidOk
    })
  }, [plans, dateFilter, uidFilter])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', borderRadius: 8,
        background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Date
        </span>
        {(['today', 'week', 'month', 'all'] as DateFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setDateFilter(f)}
            style={dateFilter === f ? activeFilterBtn : filterBtn}
          >
            {f === 'today' ? 'Today' : f === 'week' ? 'This week' : f === 'month' ? 'This month' : 'All time'}
          </button>
        ))}

        <div style={{ width: 1, height: 18, background: 'var(--border-subtle)', margin: '0 4px' }} />

        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Worker
        </span>
        <select value={uidFilter} onChange={e => setUidFilter(e.target.value)} style={selectStyle}>
          <option value="all">All workers</option>
          {allUids.map(uid => <option key={uid} value={uid}>{uid}</option>)}
        </select>

        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          {filtered.length} result{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {filtered.length === 0
        ? <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
            No completed tasks for this filter
          </div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(p => (
              <PlanRow key={p.id} plan={p} onClick={() => onOpenRun(p)} showUid />
            ))}
          </div>
      }
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────

function RunModal({ plan, content, onClose }: {
  plan: PlanSummary; content: string; onClose: () => void
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
        borderRadius: 12, width: '100%', maxWidth: 740, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{plan.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
              run.md · uid: {plan.uid}
            </div>
          </div>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>
        <div
          className="md-render"
          style={{ overflowY: 'auto', padding: '20px 24px', fontSize: 13, lineHeight: 1.7 }}
          dangerouslySetInnerHTML={{ __html: safeHtml(marked(content, { breaks: true, gfm: true })) }}
        />
      </div>
    </div>
  )
}

function Section({ title, right, children }: {
  title: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
      borderRadius: 10, padding: '18px 20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em', color: 'var(--text-muted)',
        }}>
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function PlanRow({ plan, onClick, showUid }: {
  plan: PlanSummary; onClick: () => void; showUid?: boolean
}) {
  const time = new Date(plan.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const date = new Date(plan.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div
      onClick={onClick}
      style={{
        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
        background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {plan.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{showUid ? `${date} ${time}` : time}</span>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>View log →</span>
        </div>
      </div>
      {showUid && (
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', marginBottom: 4 }}>
          {plan.uid}
        </div>
      )}
      {plan.skillsReferenced.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {plan.skillsReferenced.map(s => (
            <span key={s} style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 999,
              background: 'var(--bg-surface)', color: 'var(--text-muted)',
              border: '1px solid var(--border-subtle)',
            }}>{s}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{children}</div>
}

// ── Styles ────────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  padding: '7px 16px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
}
const backBtn: React.CSSProperties = {
  padding: '5px 10px', background: 'transparent',
  border: '1px solid var(--border-subtle)', borderRadius: 6,
  color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
}
const closeBtn: React.CSSProperties = {
  padding: '4px 8px', background: 'transparent',
  border: '1px solid var(--border-subtle)', borderRadius: 6,
  color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
}
const linkBtn: React.CSSProperties = {
  padding: '3px 8px', background: 'transparent', border: 'none',
  color: 'var(--accent)', fontSize: 11, cursor: 'pointer', fontWeight: 600,
}
const filterBtn: React.CSSProperties = {
  padding: '4px 10px', background: 'transparent',
  border: '1px solid var(--border-subtle)', borderRadius: 5,
  color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
}
const activeFilterBtn: React.CSSProperties = {
  ...filterBtn,
  background: 'rgba(154,154,154,0.15)',
  border: '1px solid rgba(154,154,154,0.4)',
  color: 'var(--accent)', fontWeight: 600,
}
const selectStyle: React.CSSProperties = {
  padding: '4px 8px', background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)', borderRadius: 5,
  color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer',
}
