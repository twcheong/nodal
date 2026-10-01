// ─────────────────────────────────────────────────────────────────────────────
// OrchestrationDetailModal — 캔버스에서 워크플로/AI Agent 노드를 클릭하면 뜨는 상세 popup.
// 오케스트레이션 탭을 벗어나지 않고(메인 맥락 유지) 자세히 본다. 워크플로는 "Open in
// Workflow tab" 으로 편집하러 이동. AI Agent 는 옵션들을 펼쳐 보고, 각 옵션 워크플로를
// 다시 상세로 열거나 Workflow 탭으로 보낼 수 있다(편집은 캔버스에서 인라인).
// ─────────────────────────────────────────────────────────────────────────────
import { nodeTagFor } from '../../lib/workflowTools'
import { workflowOutputFields, typeAbbrev, workflowType } from '../../lib/orchestrationIO'

const TYPE_COLOR = (t: string) => (t === 'research' ? '#3fb950' : '#d29922')

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 600, maxWidth: '94vw', maxHeight: '88vh', overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 8px)', boxShadow: '0 8px 32px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}

const sectionLabel: React.CSSProperties = { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 4 }
const chip: React.CSSProperties = { fontSize: 9.5, fontFamily: 'var(--font-mono)', padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }
const primaryBtn: React.CSSProperties = { border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: 12, fontWeight: 600, padding: '6px 12px', cursor: 'pointer' }
const ghostBtn: React.CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }

function TypeBadge({ type }: { type: string }) {
  return <span title={type} style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, padding: '2px 6px', borderRadius: 4, color: TYPE_COLOR(type), background: type === 'research' ? 'rgba(63,185,80,0.12)' : 'rgba(210,153,34,0.12)' }}>{typeAbbrev(type)}</span>
}

function Header({ kind, title, type, onClose }: { kind: string; title: string; type?: string; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--accent)' }}>{kind}</span>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      {type && <TypeBadge type={type} />}
      <button onClick={onClose} title="Close" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>×</button>
    </div>
  )
}

// ── Workflow 상세 ────────────────────────────────────────────────────────────
export function WorkflowDetailModal({ workflow, onOpenWorkflow, onClose }: {
  workflow: TwixyWorkflow; onOpenWorkflow?: (id: string) => void; onClose: () => void
}) {
  const inputs = workflow.inputs ?? []
  const outFields = workflowOutputFields(workflow)
  const t = workflowType(workflow)
  return (
    <Overlay onClose={onClose}>
      <Header kind="Workflow" title={workflow.title} type={t} onClose={onClose} />
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {workflow.description && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{workflow.description}</div>}
        <div>
          <div style={sectionLabel}>Input</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {inputs.length ? inputs.map(i => <span key={i.id} style={chip}>{i.id} <span style={{ color: 'var(--accent)' }}>({i.valueType})</span></span>) : <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No declared inputs</span>}
          </div>
        </div>
        <div>
          <div style={sectionLabel}>Nodes ({workflow.nodes?.length ?? 0})</div>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(workflow.nodes ?? []).map((n, i) => (
              <li key={n.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '8px 10px', background: 'var(--bg-base)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9.5, color: 'var(--text-muted)', width: 16 }}>{i + 1}.</span>
                  <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 600 }}>[{nodeTagFor(n)}]</span>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{n.title}</span>
                </div>
                {n.detail && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>{n.detail}</div>}
                {n.acceptance && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>✓ {n.acceptance}</div>}
                {(n.inputScope?.length || n.outputScope?.length) ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {n.inputScope?.map(f => <span key={'i' + f.name} style={{ ...chip, fontSize: 9 }}>in: {f.name}</span>)}
                    {n.outputScope?.map(f => <span key={'o' + f.name} style={{ ...chip, fontSize: 9, color: '#3fb950' }}>out: {f.name}</span>)}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <div style={sectionLabel}>Output</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {outFields.length ? outFields.map(f => <span key={f.name} style={chip}>{f.name} <span style={{ color: '#3fb950' }}>({f.type})</span></span>) : <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No output (action workflow)</span>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', position: 'sticky', bottom: 0, background: 'var(--bg-surface)' }}>
        <button onClick={onClose} style={ghostBtn}>Close</button>
        {onOpenWorkflow && <button onClick={() => { onOpenWorkflow(workflow.id); onClose() }} style={primaryBtn}>Open in Workflow tab to edit ↗</button>}
      </div>
    </Overlay>
  )
}

// ── AI Agent 상세 ────────────────────────────────────────────────────────────
export function AgentDetailModal({ agent, wfById, onOpenWorkflow, onViewWorkflow, onClose }: {
  agent: TwixyAiAgent; wfById: Map<string, TwixyWorkflow>
  onOpenWorkflow?: (id: string) => void; onViewWorkflow: (wf: TwixyWorkflow) => void; onClose: () => void
}) {
  const options = agent.options ?? []
  return (
    <Overlay onClose={onClose}>
      <Header kind="AI Agent" title={agent.title} type={agent.agentType} onClose={onClose} />
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {agent.description && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{agent.description}</div>}
        <div>
          <div style={sectionLabel}>Criteria — picks one option</div>
          <div style={{ fontSize: 12, color: agent.criteria ? 'var(--text-secondary)' : 'var(--text-muted)', lineHeight: 1.5, fontStyle: agent.criteria ? 'normal' : 'italic', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '8px 10px', background: 'var(--bg-base)' }}>
            {agent.criteria || 'No criteria set — defaults to the first option. Set it on the canvas.'}
          </div>
        </div>
        <div>
          <div style={sectionLabel}>Options ({options.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {options.length === 0 ? <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No options — add workflows to this agent on the canvas.</span>
              : options.map(opt => {
                const wf = opt.workflowId ? wfById.get(opt.workflowId) : undefined
                const label = opt.label || wf?.title || (opt.children?.length ? 'Sub-chain' : opt.workflowId || 'option')
                return (
                  <div key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '7px 10px', background: 'var(--bg-base)' }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                    {wf && <TypeBadge type={workflowType(wf)} />}
                    {wf && <button onClick={() => onViewWorkflow(wf)} style={{ ...ghostBtn, padding: '3px 8px', fontSize: 11 }}>View</button>}
                  </div>
                )
              })}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', position: 'sticky', bottom: 0, background: 'var(--bg-surface)' }}>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Edit options &amp; criteria directly on the canvas.</span>
        <button onClick={onClose} style={ghostBtn}>Close</button>
      </div>
    </Overlay>
  )
}
