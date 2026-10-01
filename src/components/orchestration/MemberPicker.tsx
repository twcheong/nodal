// MemberPicker — 좌측 하단. 기존 Workflow(L5) 목록. 클릭 또는 캔버스로 드래그&
// 드롭해서 활성 orchestration 의 멤버로 추가한다. 이미 멤버인 워크플로는 ✓ 표시.
export const WORKFLOW_DND_MIME = 'application/x-twixy-workflow-id'
export const AGENT_DND_MIME = 'application/x-twixy-agent-id'

interface Props {
  workflows:     TwixyWorkflow[]
  activeMembers: OrchestrationMember[]
  disabled?:     boolean
  onAdd:         (workflowId: string) => void
}

export function MemberPicker({ workflows, activeMembers, disabled, onAdd }: Props) {
  const memberWfIds = new Set(activeMembers.map(m => m.workflowId))
  return (
    <aside style={{ width: '100%', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: 0 }}>
      <header style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Add member (Workflow)</span>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {workflows.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No workflows. Create one in the Workflow tab.</div>
        ) : workflows.map(w => {
          const added = memberWfIds.has(w.id)
          return (
            <button key={w.id} disabled={disabled} onClick={() => onAdd(w.id)} title={added ? 'Add again — or drag onto the canvas' : 'Add as member — or drag onto the canvas'}
              draggable={!disabled}
              onDragStart={e => { e.dataTransfer.setData(WORKFLOW_DND_MIME, w.id); e.dataTransfer.setData('text/plain', w.title); e.dataTransfer.effectAllowed = 'copy' }}
              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px', fontSize: 12,
                border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'grab', opacity: disabled ? 0.5 : 1 }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 10, width: 10 }} title="drag">⠿</span>
              <span style={{ color: added ? '#3fb950' : 'var(--text-muted)', fontSize: 11, width: 12 }}>{added ? '✓' : '+'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
              <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{w.nodes?.length ?? 0}n</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
