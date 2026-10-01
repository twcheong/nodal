// OrchestrationMemberCard — leaf 멤버(=Workflow 참조) 1개를 컴팩트하게 렌더.
// 워크플로의 노드(L6)를 작은 플로우로 보여주고, 실행 시 flat runState 로 상태 색 반영.
// (그룹/중첩/편집 컨트롤은 캔버스의 NodeShell·GroupBox 가 담당 — 이 카드는 표시 전용)
import { nodeShapeFor, nodeTagFor } from '../../lib/workflowTools'
import { workflowOutputFields, typeAbbrev } from '../../lib/orchestrationIO'
import { HoverTip, TipBody } from './HoverTip'
import type { MemberRunState } from '../../lib/orchestrationPatterns/types'
import type { NodeRunMetrics } from '../../hooks/useWorkflowTest'
import { DisplayCost } from '../../lib/useDisplayUsd'

interface Props {
  member:    OrchestrationMember
  workflow:  TwixyWorkflow | null
  agent?:    TwixyAiAgent | null     // team 멤버(agent leaf) 일 때
  pattern:   OrchestrationPattern   // 부모 그룹 패턴 (role/entry 배지 표시 판단)
  runState?: MemberRunState
  onOpenDetail?: () => void          // 카드 클릭 → 상세 popup
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--text-muted)', running: 'var(--accent)', done: '#3fb950',
  failed: '#f85149', aborted: '#d29922', skipped: 'var(--text-muted)',
}
const TYPE_ACCENT: Record<WorkflowNodeType, string> = {
  action: 'var(--accent)', review: '#f59e0b', validation: '#10b981',
}

export function OrchestrationMemberCard({ member, workflow, agent, pattern, runState, onOpenDetail }: Props) {
  // ── team 멤버(AI Agent leaf) 카드 ──
  if (member.agentId) {
    const status = runState?.status ?? 'pending'
    const color = STATUS_COLOR[status] ?? 'var(--text-muted)'
    const aMissing = !agent
    const title = member.label || agent?.title || member.agentId
    const isResearch = agent?.agentType === 'research'
    return (
      <div style={{ border: `1px solid ${status === 'running' ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-md, 8px)', background: 'var(--bg-surface)', width: '100%', overflow: 'hidden' }}>
        <Port label="input" kind="in" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'var(--bg-elevated)' }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>Agent</span>
          <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: aMissing ? '#f85149' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          {agent && <span title={agent.agentType} style={{ flexShrink: 0, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, padding: '1px 5px', borderRadius: 4, color: isResearch ? '#3fb950' : '#d29922', background: isResearch ? 'rgba(63,185,80,0.12)' : 'rgba(210,153,34,0.12)' }}>{typeAbbrev(agent.agentType)}</span>}
          <span style={{ fontSize: 9.5, color }}>● {status}</span>
          {runState?.durationMs != null && <span style={metaChip}>{(runState.durationMs / 1000).toFixed(1)}s</span>}
        </div>
        {aMissing
          ? <div style={{ padding: 10, fontSize: 11, color: '#f85149' }}>Agent not found ({member.agentId})</div>
          : <div style={{ padding: '7px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{(agent?.options?.length ?? 0)} option{(agent?.options?.length ?? 0) === 1 ? '' : 's'} · criteria picks 1</div>}
        {isResearch && <Port label="output" kind="out" />}
      </div>
    )
  }

  const title = member.label || workflow?.title || member.workflowId
  const nodes = workflow?.nodes ?? []
  const status = runState?.status ?? 'pending'
  const color = STATUS_COLOR[status] ?? 'var(--text-muted)'
  const missing = !workflow
  // input 포트는 항상(워크플로 inputs = INPUT contract). output 은 write 노드 있을 때만,
  // 라벨/툴팁은 write 노드 outputScope(= OUTPUT contract)에서 가져온다.
  const inputs = workflow?.inputs ?? []
  const inLabel = inputs.length ? `input: ${inputs.map(x => x.id).slice(0, 2).join(', ')}${inputs.length > 2 ? '…' : ''}` : 'input'
  const inLines = inputs.length ? inputs.map(x => `${x.id} (${x.valueType})${x.label && x.label !== x.id ? ' — ' + x.label : ''}`) : ['No declared inputs']
  const outFields = workflowOutputFields(workflow)
  const hasOutput = !!nodes.some(n => n.tool === 'write')
  const outLabel = outFields.length ? `output: ${outFields.map(f => f.name).slice(0, 2).join(', ')}${outFields.length > 2 ? '…' : ''}` : 'output'
  const outLines = outFields.length ? outFields.map(f => `${f.name} (${f.type})`) : ['No declared fields']
  return (
    <div onClick={onOpenDetail} title={onOpenDetail && !missing ? 'Click for details' : undefined}
      style={{ border: `1px solid ${status === 'running' ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-md, 8px)', background: 'var(--bg-surface)', width: '100%', overflow: 'hidden', cursor: onOpenDetail && !missing ? 'pointer' : 'default' }}>
      <HoverTip side="top" content={<TipBody heading="Input" lines={inLines} accent="var(--accent)" />}>
        <Port label={inLabel} kind="in" />
      </HoverTip>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: nodes.length ? '1px solid var(--border-subtle)' : 'none', background: 'var(--bg-elevated)' }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>L5</span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: missing ? '#f85149' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {member.role && pattern === 'roundtable' && <span style={chip('var(--bg-active)', 'var(--text-secondary)')}>{member.role}</span>}
        <span style={{ fontSize: 9.5, color }}>● {status}</span>
        {runState?.durationMs != null && <span style={metaChip}>{(runState.durationMs / 1000).toFixed(1)}s</span>}
        {runState?.cost != null && runState.cost > 0 && <span style={metaChip}><DisplayCost rawUsd={runState.cost} /></span>}
        {!missing && <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{nodes.length}n</span>}
      </div>
      {missing ? (
        <div style={{ padding: 10, fontSize: 11, color: '#f85149' }}>Workflow not found ({member.workflowId})</div>
      ) : nodes.length === 0 ? (
        <div style={{ padding: 10, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No nodes.</div>
      ) : (
        <div style={{ padding: '7px 10px' }}>
          {nodes.map((n, i) => (
            <CompactNode key={n.id} node={n} order={i + 1} isLast={i === nodes.length - 1} metrics={runState?.nodeStates?.[n.id]} />
          ))}
        </div>
      )}
      {hasOutput && (
        <HoverTip content={<TipBody heading="Output" lines={outLines} accent="#3fb950" />}>
          <Port label={outLabel} kind="out" />
        </HoverTip>
      )}
    </div>
  )
}

// 모든 워크플로의 input/output 포트 표시 — 상단 in / 하단 out.
function Port({ label, kind }: { label: string; kind: 'in' | 'out' }) {
  const color = kind === 'in' ? 'var(--accent)' : '#3fb950'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 10px', background: 'var(--bg-base)',
      borderTop: kind === 'out' ? '1px solid var(--border-subtle)' : 'none', borderBottom: kind === 'in' ? '1px solid var(--border-subtle)' : 'none' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 8.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}

function CompactNode({ node, order, isLast, metrics }: { node: TwixyWorkflowNode; order: number; isLast: boolean; metrics?: NodeRunMetrics }) {
  const shape = nodeShapeFor(node.type)
  const tag = nodeTagFor(node)
  const accent = TYPE_ACCENT[node.type]
  const runColor = metrics ? (STATUS_COLOR[metrics.status] ?? null) : null
  const stroke = runColor && metrics?.status !== 'pending' ? runColor : accent
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
        <MiniShape shape={shape} order={order} stroke={stroke} />
        <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: accent, fontWeight: 600, flexShrink: 0 }}>[{tag}]</span>
        <span style={{ flex: 1, fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.detail || node.title}>{node.title}</span>
        {metrics && metrics.status !== 'pending' && <span style={{ fontSize: 9, color: runColor ?? 'var(--text-muted)', flexShrink: 0 }} title={metrics.reason ?? metrics.status}>●</span>}
      </div>
      {!isLast && <div style={{ width: 1, height: 9, background: 'var(--border)', marginLeft: 10 }} />}
    </div>
  )
}
function MiniShape({ shape, order, stroke }: { shape: 'circle' | 'triangle' | 'square'; order: number; stroke: string }) {
  const s = 20
  return (
    <div style={{ width: s, height: s, flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ position: 'absolute', inset: 0 }}>
        {shape === 'circle' && <circle cx={s / 2} cy={s / 2} r={s / 2 - 1.5} fill="none" stroke={stroke} strokeWidth={1.4} />}
        {shape === 'triangle' && <polygon points={`${s / 2},1.5 ${s - 1.5},${s - 1.5} 1.5,${s - 1.5}`} fill="none" stroke={stroke} strokeWidth={1.4} />}
        {shape === 'square' && <rect x={2} y={2} width={s - 4} height={s - 4} fill="none" stroke={stroke} strokeWidth={1.4} rx={2} />}
      </svg>
      <span style={{ position: 'relative', fontSize: 9, fontWeight: 600, color: stroke, marginTop: shape === 'triangle' ? 4 : 0 }}>{order}</span>
    </div>
  )
}
function chip(bg: string, fg: string): React.CSSProperties {
  return { fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.3 }
}
const metaChip: React.CSSProperties = { fontSize: 9.5, fontFamily: 'var(--font-mono)', padding: '1px 5px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-active)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }
