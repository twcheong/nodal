// OrchestrationListsPanel — 좌측 상단 Orchestration 리스트 (WorkflowListsPanel 미러,
// embedded 전용). 항목 클릭 시 active 변경, + 로 title 만 입력해 생성.
import { useState } from 'react'

interface Props {
  orchestrations: TwixyOrchestration[]
  activeId:  string | null
  isLoading: boolean
  onSelect:  (id: string) => void
  onCreate:  (title: string) => Promise<TwixyOrchestration | null>
  onDelete:  (id: string) => Promise<boolean>
}

export function OrchestrationListsPanel({ orchestrations, activeId, isLoading, onSelect, onCreate, onDelete }: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submitCreate = async () => {
    const t = newTitle.trim()
    if (!t) return
    setBusy(true)
    try {
      const o = await onCreate(t)
      if (o) { setNewTitle(''); setShowCreate(false); onSelect(o.id) }
    } finally { setBusy(false) }
  }

  return (
    <aside style={{ width: '100%', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, flex: 1 }}>Orchestrations</span>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {isLoading ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)' }}>Loading…</div>
        ) : orchestrations.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No orchestrations yet</div>
        ) : (
          orchestrations.map(o => {
            const isActive = o.id === activeId
            return (
              <div key={o.id} onClick={() => onSelect(o.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px', fontSize: 12, cursor: 'pointer',
                  background: isActive ? 'var(--bg-active)' : 'transparent', color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent' }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>▸</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.title}</span>
                <button title="Delete" onClick={async e => { e.stopPropagation(); if (!confirm(`Delete orchestration "${o.title}"?`)) return; await onDelete(o.id) }}
                  style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0, visibility: isActive ? 'visible' : 'hidden' }}>×</button>
              </div>
            )
          })
        )}
      </div>

      <footer style={{ borderTop: '1px solid var(--border-subtle)', padding: 8 }}>
        {showCreate ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input type="text" autoFocus value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Orchestration title"
              onKeyDown={e => {
                // Korean/CJK IME: skip Enter while composing.
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitCreate()
                else if (e.key === 'Escape') { setShowCreate(false); setNewTitle('') }
              }}
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, padding: '5px 8px', outline: 'none' }} />
            <div style={{ display: 'flex', gap: 4 }}>
              <button disabled={busy || !newTitle.trim()} onClick={submitCreate}
                style={{ flex: 1, background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 11, padding: '4px 6px', cursor: busy || !newTitle.trim() ? 'not-allowed' : 'pointer', opacity: busy || !newTitle.trim() ? 0.5 : 1 }}>Create</button>
              <button onClick={() => { setShowCreate(false); setNewTitle('') }}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 11, padding: '4px 8px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)}
            style={{ width: '100%', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 11, padding: '5px 8px', cursor: 'pointer' }}>+ New Orchestration</button>
        )}
      </footer>
    </aside>
  )
}
