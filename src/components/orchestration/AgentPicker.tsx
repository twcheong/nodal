// AgentPicker — Orchestration 좌측. AI Agent(relay 그룹, 파일 단위) 목록. 클릭/드래그로 멤버 추가,
// '+New' 로 빈 AI Agent 생성, × 로 파일 삭제. AI Agent 는 캔버스에서 펼친 relay 그룹으로 편집된다.
import { useState } from 'react'
import { AGENT_DND_MIME } from './MemberPicker'
import { typeAbbrev } from '../../lib/orchestrationIO'

interface Props {
  agents:        TwixyAiAgent[]
  activeMembers: OrchestrationMember[]
  disabled?:     boolean
  onAdd:         (agentId: string) => void
  onCreate?:     (title: string) => void | Promise<void>
  onDelete?:     (id: string) => void | Promise<unknown>
}

export function AgentPicker({ agents, activeMembers, disabled, onAdd, onCreate, onDelete }: Props) {
  const memberAgentIds = new Set(activeMembers.map(m => m.agentId).filter(Boolean) as string[])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const submit = () => { const t = title.trim(); if (!t) { setCreating(false); return } void onCreate?.(t); setTitle(''); setCreating(false) }
  return (
    <aside style={{ width: '100%', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: 0 }}>
      <header style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Add member (AI Agent)</span>
        {onCreate && <button disabled={disabled} onClick={() => setCreating(v => !v)} title="New AI Agent" style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, lineHeight: 1, opacity: disabled ? 0.5 : 1 }}>＋</button>}
      </header>
      {creating && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 4 }}>
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              // Korean/CJK IME: don't submit while composing.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
              if (e.key === 'Escape') { setCreating(false); setTitle('') }
            }}
            placeholder="New AI Agent name…"
            style={{ flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 11, padding: '3px 6px', outline: 'none' }} />
          <button onClick={submit} style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', fontSize: 11, padding: '0 8px', cursor: 'pointer' }}>Add</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {agents.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No AI Agents. Click ＋ to create one, then add workflow options to it on the canvas.</div>
        ) : agents.map(a => {
          const added = memberAgentIds.has(a.id)
          return (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 0 }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
              <button disabled={disabled} onClick={() => onAdd(a.id)} title={added ? 'Add again — or drag onto the canvas' : 'Add as member — or drag onto the canvas'}
                draggable={!disabled}
                onDragStart={e => { e.dataTransfer.setData(AGENT_DND_MIME, a.id); e.dataTransfer.setData('text/plain', a.title); e.dataTransfer.effectAllowed = 'copy' }}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, padding: '5px 4px 5px 14px', fontSize: 12,
                  border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'grab', opacity: disabled ? 0.5 : 1 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 10, width: 10 }} title="drag">⠿</span>
                <span style={{ color: added ? '#3fb950' : 'var(--text-muted)', fontSize: 11, width: 12 }}>{added ? '✓' : '+'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                <span title={a.agentType} style={{ flexShrink: 0, fontSize: 8.5, color: a.agentType === 'research' ? '#3fb950' : '#d29922', textTransform: 'uppercase', letterSpacing: 0.3 }}>{typeAbbrev(a.agentType)}</span>
              </button>
              {onDelete && <button disabled={disabled} onClick={() => void onDelete(a.id)} title="Delete this AI Agent file" style={{ flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, padding: '0 8px' }}>×</button>}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
