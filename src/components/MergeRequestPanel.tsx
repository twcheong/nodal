import { useState, useEffect, useCallback, useMemo } from 'react'

// Phase 2 MR panel — lists merge requests, shows diffs, lets the current user
// review / comment / merge / cancel. Creation of MRs happens implicitly from
// writes to shared/ (not yet wired — tracked as Phase 2 step 3) and from a
// "Propose change" button we'll add inside Skills/Data panels later.

type StatusFilter = 'all' | 'open' | 'approved' | 'merged' | 'rejected'

const STATUS_LABELS: Record<MRStatus, string> = {
  open:              'Open',
  changes_requested: 'Changes requested',
  approved:          'Approved',
  merged:            'Merged',
  rejected:          'Rejected',
}

const STATUS_COLORS: Record<MRStatus, string> = {
  open:              'var(--accent)',
  changes_requested: 'var(--danger)',
  approved:          'var(--accent)',
  merged:            'var(--accent)',
  rejected:          'var(--text-secondary)',
}

function relTime(iso: string): string {
  const d = new Date(iso).getTime()
  const diff = (Date.now() - d) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatBytes(n: number): string {
  if (n < 1024)           return `${n} B`
  if (n < 1024 * 1024)    return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)      return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

export function MergeRequestPanel() {
  const [mrs, setMrs]               = useState<MergeRequest[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter]         = useState<StatusFilter>('all')
  const [actor, setActor]           = useState<MRActor | null>(null)
  const [loading, setLoading]       = useState(true)
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [pulling, setPulling]       = useState(false)
  const [pullMsg, setPullMsg]       = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const list = await window.twixy.mrList()
    setMrs(list)
    setLoading(false)
  }, [])

  const handlePull = useCallback(async () => {
    setPulling(true)
    setPullMsg(null)
    try {
      const res = await window.twixy.pullShared()
      if (!res.ok) {
        setPullMsg(res.error ? `Pull failed: ${res.error}` : 'Pull failed')
      } else {
        const changed = res.copied + res.updated
        if (changed === 0) {
          setPullMsg('Already up to date')
        } else {
          const parts: string[] = []
          if (res.copied > 0)  parts.push(`${res.copied} new`)
          if (res.updated > 0) parts.push(`${res.updated} updated`)
          setPullMsg(parts.join(', '))
        }
      }
      if (res.ok && (res.copied + res.updated) > 0) await refresh()
    } finally {
      setPulling(false)
      setTimeout(() => setPullMsg(null), 3000)
    }
  }, [refresh])

  // Initial load + listen for changes (merge / review / comment / create).
  useEffect(() => {
    void refresh()
    window.twixy.mrCurrentActor().then(setActor)
    return window.twixy.onMRChanged(() => { void refresh() })
  }, [refresh])

  const filtered = useMemo(() => {
    if (filter === 'all') return mrs
    if (filter === 'open') {
      return mrs.filter(m => m.status === 'open' || m.status === 'changes_requested')
    }
    return mrs.filter(m => m.status === filter)
  }, [mrs, filter])

  // Auto-select the first visible MR after filtering.
  useEffect(() => {
    if (!selectedId || !filtered.find(m => m.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null)
    }
  }, [filtered, selectedId])

  const selected = useMemo(
    () => mrs.find(m => m.id === selectedId) ?? null,
    [mrs, selectedId],
  )

  const runAction = useCallback(async (fn: () => Promise<MRResult>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      if (!res.ok) setError(res.error ?? 'unknown error')
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'var(--text-primary)' }}>

      {/* Pull bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <button
          onClick={handlePull}
          disabled={pulling}
          style={{
            padding: '5px 14px', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600,
            cursor: pulling ? 'not-allowed' : 'pointer', opacity: pulling ? 0.6 : 1,
          }}
        >
          {pulling ? 'Pulling…' : '↓ Pull from shared'}
        </button>
        {pullMsg && (
          <span style={{ fontSize: 12, color: pullMsg.includes('failed') ? 'var(--danger)' : 'var(--text-muted)' }}>
            {pullMsg}
          </span>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <MRList
        mrs={filtered}
        filter={filter}
        onFilter={setFilter}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={loading}
        counts={{ total: mrs.length }}
      />
      <MRDetail
        mr={selected}
        actor={actor}
        busy={busy}
        error={error}
        onReview={(decision, comment) =>
          runAction(() => window.twixy.mrReview({ id: selected!.id, decision, comment }))
        }
        onComment={(body) =>
          runAction(() => window.twixy.mrComment({ id: selected!.id, body }))
        }
        onMerge={() =>
          runAction(() => window.twixy.mrMerge(selected!.id))
        }
        onCancel={() =>
          runAction(() => window.twixy.mrCancel(selected!.id))
        }
      />
      </div>
    </div>
  )
}

// ── List side ────────────────────────────────────────────────────────────
function MRList(props: {
  mrs:        MergeRequest[]
  filter:     StatusFilter
  onFilter:   (f: StatusFilter) => void
  selectedId: string | null
  onSelect:   (id: string) => void
  loading:    boolean
  counts:     { total: number }
}) {
  const { mrs, filter, onFilter, selectedId, onSelect, loading, counts } = props

  const filters: { key: StatusFilter; label: string }[] = [
    { key: 'all',      label: 'All' },
    { key: 'open',     label: 'Open' },
    { key: 'approved', label: 'Approved' },
    { key: 'merged',   label: 'Merged' },
    { key: 'rejected', label: 'Rejected' },
  ]

  return (
    <aside style={{
      width: 320,
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>Merge Requests</h2>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
          {counts.total === 0
            ? 'No requests yet'
            : `${counts.total} total`}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => onFilter(f.key)}
              style={{
                background:    filter === f.key ? 'var(--accent-dim)' : 'transparent',
                color:         filter === f.key ? 'var(--accent)' : 'var(--text-muted)',
                border:        '1px solid var(--border-subtle)',
                borderRadius:  'var(--radius-sm)',
                padding:       '4px 10px',
                fontSize:      11,
                cursor:        'pointer',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
        {!loading && mrs.length === 0 && (
          <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)' }}>
            No merge requests in this view.
          </div>
        )}
        {mrs.map(mr => (
          <button
            key={mr.id}
            onClick={() => onSelect(mr.id)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '12px 20px',
              border: 'none',
              borderBottom: '1px solid var(--border-subtle)',
              background: selectedId === mr.id ? 'var(--bg-hover)' : 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{
                fontSize: 13, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, minWidth: 0,
              }}>
                {mr.title}
              </span>
              <StatusPill status={mr.status} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
              <span>{mr.author.email ?? mr.author.uid.slice(0, 10)}</span>
              <span>·</span>
              <span>{relTime(mr.createdAt)}</span>
              <span>·</span>
              <span>{mr.changes.length} file{mr.changes.length === 1 ? '' : 's'}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}

function StatusPill({ status }: { status: MRStatus }) {
  return (
    <span style={{
      fontSize:     10,
      fontWeight:   600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color:        STATUS_COLORS[status],
      border:       `1px solid ${STATUS_COLORS[status]}`,
      padding:      '2px 6px',
      borderRadius: 'var(--radius-sm)',
      whiteSpace:   'nowrap',
    }}>
      {STATUS_LABELS[status]}
    </span>
  )
}

// ── Detail side ──────────────────────────────────────────────────────────
function MRDetail(props: {
  mr:        MergeRequest | null
  actor:     MRActor | null
  busy:      boolean
  error:     string | null
  onReview:  (decision: 'approve' | 'reject', comment?: string) => void | Promise<void>
  onComment: (body: string) => void | Promise<void>
  onMerge:   () => void | Promise<void>
  onCancel:  () => void | Promise<void>
}) {
  const { mr, actor, busy, error, onReview, onComment, onMerge, onCancel } = props
  const [commentBody, setCommentBody] = useState('')
  const [reviewComment, setReviewComment] = useState('')

  if (!mr) {
    return (
      <div style={{
        flex: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: 13,
      }}>
        Select a merge request to view details.
      </div>
    )
  }

  const isAuthor      = actor?.uid === mr.author.uid
  const terminalState = mr.status === 'merged' || mr.status === 'rejected'
  const canMerge      = !terminalState && (mr.status === 'approved' || isAuthor) // isAuthor → self-merge in solo mode (server enforces)
  const canReview     = !terminalState
  const canCancel     = !terminalState && isAuthor

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '20px 28px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <StatusPill status={mr.status} />
          <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mr.id}</code>
        </div>
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 600 }}>{mr.title}</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Opened by {mr.author.email ?? mr.author.uid} · {relTime(mr.createdAt)}
          {mr.mergedAt && <> · merged {relTime(mr.mergedAt)}</>}
        </div>
        {mr.description && (
          <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {mr.description}
          </p>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        {/* Reviewers */}
        <Section title="Reviewers">
          {mr.reviewers.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              No reviewers assigned. {mr.status !== 'merged' && 'Owner self-merge is allowed in solo mode.'}
            </div>
          )}
          {mr.reviewers.map(r => (
            <div key={r.uid} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 0', fontSize: 12,
            }}>
              <span>{r.email ?? r.uid}</span>
              <span style={{
                color: r.decision === 'approve' ? 'var(--accent)'
                     : r.decision === 'reject'  ? 'var(--danger)'
                     : 'var(--text-muted)',
                fontSize: 11, fontWeight: 500,
              }}>
                {r.decision
                  ? `${r.decision} · ${relTime(r.at!)}`
                  : 'awaiting review'}
              </span>
            </div>
          ))}
        </Section>

        {/* Changes */}
        <Section title={`Changes (${mr.changes.length})`}>
          {mr.changes.map(c => (
            <ChangeRow key={c.path} change={c} mrId={mr.id} />
          ))}
        </Section>

        {/* Comments */}
        <Section title="Discussion">
          {mr.comments.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No comments yet.</div>
          )}
          {mr.comments.map(c => (
            <div key={c.id} style={{
              padding: '10px 0',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 13,
            }}>
              <div style={{ display: 'flex', gap: 8, color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>
                <strong style={{ color: 'var(--text-primary)' }}>{c.author.email ?? c.author.uid}</strong>
                <span>·</span>
                <span>{relTime(c.at)}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{c.body}</div>
            </div>
          ))}
          {!terminalState && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={commentBody}
                onChange={e => setCommentBody(e.target.value)}
                placeholder="Leave a comment…"
                rows={3}
                style={textareaStyle}
              />
              <button
                onClick={async () => {
                  if (!commentBody.trim()) return
                  await onComment(commentBody)
                  setCommentBody('')
                }}
                disabled={busy || !commentBody.trim()}
                style={secondaryBtnStyle}
              >
                Comment
              </button>
            </div>
          )}
        </Section>

        {error && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(181, 72, 47, 0.1)',
            border: '1px solid rgba(181, 72, 47, 0.4)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12, color: 'var(--danger)',
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Action bar */}
      {!terminalState && (
        <div style={{
          padding: '14px 28px',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {canReview && (
            <>
              <input
                type="text"
                value={reviewComment}
                onChange={e => setReviewComment(e.target.value)}
                placeholder="Optional review note"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={async () => {
                  await onReview('approve', reviewComment || undefined)
                  setReviewComment('')
                }}
                disabled={busy}
                style={approveBtnStyle}
              >
                Approve
              </button>
              <button
                onClick={async () => {
                  await onReview('reject', reviewComment || undefined)
                  setReviewComment('')
                }}
                disabled={busy}
                style={secondaryBtnStyle}
              >
                Request changes
              </button>
            </>
          )}
          {canMerge && (
            <button onClick={onMerge} disabled={busy} style={mergeBtnStyle}>
              Merge
            </button>
          )}
          {canCancel && (
            <button onClick={onCancel} disabled={busy} style={dangerBtnStyle}>
              Cancel MR
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h3 style={{
        margin: '0 0 10px',
        fontSize: 11, fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--text-muted)',
      }}>
        {title}
      </h3>
      {children}
    </section>
  )
}

// ── Single change row with lazy-loaded diff ─────────────────────────────
function ChangeRow({ change, mrId }: { change: MRChange; mrId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [before, setBefore]     = useState<MRBlobResult | null>(null)
  const [after,  setAfter]      = useState<MRBlobResult | null>(null)
  const [loading, setLoading]   = useState(false)

  const loadDiff = useCallback(async () => {
    setLoading(true)
    try {
      const needsAfter  = change.op !== 'delete'
      const needsBefore = change.op !== 'add'
      const [b, a] = await Promise.all([
        needsBefore ? window.twixy.mrReadShared(change.path) : Promise.resolve(null),
        needsAfter  ? window.twixy.mrReadBlob({ id: mrId, sha: (change as { blobSha: string }).blobSha, path: change.path }) : Promise.resolve(null),
      ])
      setBefore(b)
      setAfter(a)
    } finally {
      setLoading(false)
    }
  }, [change, mrId])

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && !before && !after) void loadDiff()
  }

  const opColor = change.op === 'add' ? 'var(--accent)'
                : change.op === 'modify' ? 'var(--accent)'
                : 'var(--danger)'

  return (
    <div style={{
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
      marginBottom: 8,
      overflow: 'hidden',
    }}>
      <button
        onClick={toggle}
        style={{
          width: '100%', textAlign: 'left',
          background: 'transparent', color: 'var(--text-primary)',
          border: 'none', padding: '10px 12px',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12, fontFamily: 'monospace',
        }}
      >
        <span style={{
          color: opColor, fontWeight: 600,
          textTransform: 'uppercase', fontSize: 10,
          minWidth: 48,
        }}>
          {change.op}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {change.path}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 12 }}>
          {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading diff…</div>}
          {!loading && (
            <div style={{ display: 'flex', gap: 12 }}>
              {change.op !== 'add' && (
                <BlobPreview label="Before" blob={before} />
              )}
              {change.op !== 'delete' && (
                <BlobPreview label="After" blob={after} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BlobPreview({ label, blob }: { label: string; blob: MRBlobResult | null }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        fontSize: 10, fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        marginBottom: 6,
      }}>
        {label}
      </div>
      {!blob && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</div>}
      {blob?.binary && blob.dataUrl && (
        <div>
          <img
            src={blob.dataUrl}
            alt={label}
            style={{
              maxWidth: '100%',
              maxHeight: 240,
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              display: 'block',
              background: 'var(--bg-surface)',
              objectFit: 'contain',
            }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
            {formatBytes(blob.size ?? 0)}
          </div>
        </div>
      )}
      {blob?.binary && !blob.dataUrl && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          binary ({formatBytes(blob.size ?? 0)})
        </div>
      )}
      {blob?.text !== undefined && (
        <pre style={{
          margin: 0,
          padding: 10,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 240, overflow: 'auto',
        }}>
          {blob.text || '(empty)'}
        </pre>
      )}
      {blob && !blob.ok && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {blob.error ?? 'unavailable'}
        </div>
      )}
    </div>
  )
}

// ── Shared styles ────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 12,
  padding: '6px 10px',
  outline: 'none',
  boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'inherit',
  padding: '8px 10px',
  resize: 'vertical',
}

const baseBtn: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
}

const secondaryBtnStyle: React.CSSProperties = { ...baseBtn, alignSelf: 'flex-start' }
const approveBtnStyle:   React.CSSProperties = { ...baseBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }
const mergeBtnStyle:     React.CSSProperties = { ...baseBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }
const dangerBtnStyle:    React.CSSProperties = { ...baseBtn, color: 'var(--danger)', borderColor: 'rgba(181, 72, 47,0.4)' }
