import { useCallback, useEffect, useState } from 'react'

// Bytes → human-readable
function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export function AdminPanel() {
  const [cfg,   setCfg]   = useState<ProjectConfig | null>(null)
  const [actor, setActor] = useState<MRActor | null>(null)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState<string | null>(null)
  const [statsBusy, setStatsBusy] = useState(false)

  const refresh = useCallback(async () => {
    const [c, a] = await Promise.all([
      window.twixy.getProjectConfig(),
      window.twixy.mrCurrentActor(),
    ])
    setCfg(c); setActor(a); setLoading(false)
  }, [])

  const refreshStats = useCallback(async () => {
    setStatsBusy(true)
    try { setStats(await window.twixy.adminStats()) }
    finally { setStatsBusy(false) }
  }, [])

  useEffect(() => { void refresh(); void refreshStats() }, [refresh, refreshStats])

  // Live-update stats when MRs change — the blob count / sizes move with merges
  useEffect(() => {
    if (!window.twixy?.onMRChanged) return
    return window.twixy.onMRChanged(() => { void refreshStats() })
  }, [refreshStats])

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }

  const patch = async (p: Partial<ProjectConfig>) => {
    setSaving(true)
    const res = await window.twixy.setProjectConfig(p)
    setSaving(false)
    if (!res.ok) { flash(res.error ?? 'save failed'); return }
    setCfg(res.config!); flash('Saved')
  }

  const claim = async () => {
    setSaving(true)
    const res = await window.twixy.claimProjectOwnership()
    setSaving(false)
    if (!res.ok) { flash(res.error ?? 'claim failed'); return }
    setCfg(res.config!); flash('You are now the owner.')
  }

  if (loading) {
    return <Scroller><div style={muted}>Loading…</div></Scroller>
  }
  if (!cfg) {
    return (
      <Scroller>
        <H>Admin</H>
        <div style={muted}>No project selected. Pick a project in Chat to enable admin controls.</div>
      </Scroller>
    )
  }

  const isOwner   = !!cfg.ownerUid && cfg.ownerUid === actor?.uid
  const unclaimed = !cfg.ownerUid
  const canEdit   = isOwner || unclaimed || cfg.mode === 'solo'

  return (
    <Scroller>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <H>Admin</H>
        <RoleBadge mode={cfg.mode} canEdit={canEdit} isOwner={isOwner} />
      </div>
      <p style={{ margin: '0 0 28px', fontSize: 13, color: 'var(--text-muted)' }}>
        Project-level configuration. Solo users have full control; team projects gate write access behind ownership.
      </p>

      {/* ── Project ── */}
      <Section title="Project">
        <Card>
          <Row label="Project ID">
            <code style={mono}>{cfg.projectId}</code>
          </Row>
          <Row label="Created">
            <span style={{ fontSize: 12 }}>{new Date(cfg.createdAt).toLocaleString()}</span>
          </Row>
          <Row label="Collab mode">
            <select
              value={cfg.mode}
              disabled={!canEdit || saving}
              onChange={e => patch({ mode: e.target.value as CollabMode })}
              style={sel}
            >
              <option value="solo">Solo — single user, self-merge</option>
              <option value="shared-folder">Shared folder — Dropbox / iCloud sync</option>
              <option value="server">Server — on-prem LAN box (Phase 3)</option>
            </select>
          </Row>
          {msg && <div style={{ fontSize: 11, color: msg.includes('fail') ? 'var(--danger)' : 'var(--accent)' }}>{msg}</div>}
        </Card>
      </Section>

      {/* ── Ownership & Team ── */}
      <Section title="Ownership & Team">
        <Card>
          <Row label="Owner">
            {cfg.ownerUid ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <span style={{ color: isOwner ? 'var(--accent)' : 'var(--text-primary)' }}>
                  {cfg.ownerEmail ?? cfg.ownerUid}{isOwner && ' (you)'}
                </span>
              </div>
            ) : (
              <button onClick={claim} disabled={saving} style={primaryBtn}>Claim ownership</button>
            )}
          </Row>
          <Row label="Required approvals">
            <input
              type="number" min={0} max={10}
              value={cfg.requiredApprovals ?? 1}
              disabled={!canEdit || saving}
              onChange={e => setCfg({ ...cfg, requiredApprovals: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
              onBlur={e => {
                const n = Math.max(0, Math.min(10, Number(e.currentTarget.value) || 0))
                if (n !== (cfg.requiredApprovals ?? 1)) patch({ requiredApprovals: n })
              }}
              style={{ ...input, width: 70 }}
            />
          </Row>
          <Reviewers cfg={cfg} canEdit={canEdit} saving={saving} patch={patch} />
        </Card>
      </Section>

      {/* ── Server connection (server mode only) ── */}
      {cfg.mode === 'server' && (
        <Section title="Server connection">
          <Card>
            <Row label="Server URL">
              <input
                type="text"
                value={cfg.serverUrl ?? ''}
                disabled={!canEdit || saving}
                placeholder="https://twixy.yourcompany.lan"
                onChange={e => setCfg({ ...cfg, serverUrl: e.target.value })}
                onBlur={e => {
                  const v = e.currentTarget.value.trim()
                  if (v !== (cfg.serverUrl ?? '')) patch({ serverUrl: v || undefined })
                }}
                style={{ ...input, flex: 1 }}
              />
            </Row>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Phase 3 (push/pull to on-prem NAS server) is not yet wired. Save the URL now — the sync layer will pick it up when it ships.
            </div>
          </Card>
        </Section>
      )}

      {/* ── Storage ── */}
      <Section title="Storage" right={
        <button onClick={refreshStats} disabled={statsBusy} style={secondaryBtn}>
          {statsBusy ? 'Scanning…' : '↻ Rescan'}
        </button>
      }>
        <Card>
          {stats ? (
            <>
              <StorageRow
                label="shared/" hint="Read-only team library"
                path={stats.paths.shared} stat={stats.storage.shared}
              />
              <StorageRow
                label="user/" hint="Your personal working copy (APFS-cloned from shared/)"
                path={stats.paths.user} stat={stats.storage.user}
              />
              <StorageRow
                label=".twixy/" hint="Config, MRs, and MR blobs"
                path={stats.paths.meta} stat={stats.storage.meta}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid var(--border-subtle)', marginTop: 4 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>MR blobs</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Content-addressed proposal storage</div>
                </div>
                <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
                  {stats.storage.blobs.count} · {fmtBytes(stats.storage.blobs.size)}
                </div>
              </div>
            </>
          ) : (
            <div style={muted}>Loading storage stats…</div>
          )}
        </Card>
      </Section>

      {/* ── Activity (MR counts) ── */}
      <Section title="Activity">
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <StatTile label="Open MRs"   value={stats?.mrs.open   ?? 0} color="var(--accent)" />
            <StatTile label="Merged"     value={stats?.mrs.merged ?? 0} color="var(--accent)" />
            <StatTile label="Rejected"   value={stats?.mrs.other  ?? 0} color="#64748b" />
          </div>
        </Card>
      </Section>

      {/* Guardrail 설정은 Settings 탭으로 이동 (GuardrailSettings). */}

      {/* ── Identity / diagnostics ── */}
      <Section title="Identity">
        <Card>
          <Row label="Your actor UID">
            <code style={mono}>{actor?.uid ?? '—'}</code>
          </Row>
          {actor?.email && (
            <Row label="Your email">
              <span style={{ fontSize: 12 }}>{actor.email}</span>
            </Row>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            UIDs prefixed <code>local_</code> are machine-local fallbacks. Once you sign in to Supabase, the UID switches to your account.
          </div>
        </Card>
      </Section>
    </Scroller>
  )
}

// ── Subcomponents ───────────────────────────────────────────────────

function Reviewers({ cfg, canEdit, saving, patch }: {
  cfg: ProjectConfig
  canEdit: boolean
  saving: boolean
  patch: (p: Partial<ProjectConfig>) => Promise<void>
}) {
  const [uid,   setUid]   = useState('')
  const [email, setEmail] = useState('')

  const add = async () => {
    if (!uid.trim()) return
    const reviewers = [
      ...(cfg.reviewers ?? []),
      { uid: uid.trim(), email: email.trim() || undefined },
    ]
    await patch({ reviewers })
    setUid(''); setEmail('')
  }

  const remove = async (target: string) => {
    const reviewers = (cfg.reviewers ?? []).filter(r => r.uid !== target)
    await patch({ reviewers })
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>
        Default reviewers
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        Added to every new MR. Authors can still override per-request.
      </div>
      {(cfg.reviewers ?? []).length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
          No reviewers yet.{cfg.mode === 'solo' && ' Solo mode allows self-merge.'}
        </div>
      )}
      {(cfg.reviewers ?? []).map(r => (
        <div key={r.uid} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 0', fontSize: 12, borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.email ?? r.uid}
            </div>
            {r.email && <code style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.uid}</code>}
          </div>
          <button
            onClick={() => remove(r.uid)}
            disabled={!canEdit || saving}
            style={{ ...secondaryBtn, color: 'var(--danger)', borderColor: 'rgba(181, 72, 47,0.4)' }}
          >
            Remove
          </button>
        </div>
      ))}
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
          <input type="text" placeholder="Reviewer UID" value={uid}
                 onChange={e => setUid(e.target.value)} style={{ ...input, flex: 1 }} />
          <input type="text" placeholder="Email (optional)" value={email}
                 onChange={e => setEmail(e.target.value)} style={{ ...input, flex: 1 }} />
          <button onClick={add} disabled={!uid.trim() || saving} style={primaryBtn}>Add</button>
        </div>
      )}
    </div>
  )
}

function StorageRow({ label, hint, path, stat }: {
  label: string; hint: string; path: string; stat: AdminDirStats
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
          <div>{fmtBytes(stat.size)}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {stat.files} files{stat.capped && ' (capped)'}
          </div>
        </div>
        <button onClick={() => window.twixy.adminReveal(path)} style={secondaryBtn}>
          Reveal
        </button>
      </div>
    </div>
  )
}

function StatTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: 'var(--bg-input)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'monospace', marginTop: 4 }}>
        {value}
      </div>
    </div>
  )
}

function RoleBadge({ mode, canEdit, isOwner }: { mode: CollabMode; canEdit: boolean; isOwner: boolean }) {
  const label = mode === 'solo' ? 'Solo' : isOwner ? 'Owner' : canEdit ? 'Unclaimed' : 'Viewer'
  const color = mode === 'solo' || isOwner ? 'var(--accent)' : canEdit ? 'var(--warning)' : 'var(--text-muted)'
  return (
    <div style={{
      padding: '4px 10px', borderRadius: 999, fontSize: 10, fontWeight: 700,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      background: 'var(--bg-input)', color, border: `1px solid ${color}`,
    }}>
      {label}
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius)',
      padding: '18px 22px',
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 140 }}>
        {label}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

function Scroller({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px', color: 'var(--text-primary)' }}>
      {children}
    </div>
  )
}

function H({ children }: { children: React.ReactNode }) {
  return <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>{children}</h2>
}

// ── Shared styles ──
const muted: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' }
const mono:  React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }

const input: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 12,
  padding: '6px 10px',
  outline: 'none',
}

const sel: React.CSSProperties = { ...input, minWidth: 260 }

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-sm)', fontSize: 12,
  fontWeight: 600, cursor: 'pointer',
}

const secondaryBtn: React.CSSProperties = {
  padding: '4px 10px', background: 'transparent',
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
  color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
}
