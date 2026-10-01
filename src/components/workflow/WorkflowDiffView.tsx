// ─────────────────────────────────────────────────────────────────────────────
// WorkflowDiffView.tsx — 워크플로 노드 목록 / 두 버전 나란히(side-by-side) 비교.
//
//   WorkflowNodeList : 단일 워크플로 스텝 목록 (읽기 전용)
//   WorkflowDiffView : [left] vs [right] 2단 비교 — 노드를 id 로 매칭해
//                      added(초록)/removed(빨강)/changed(주황) 표시.
//
// Team Dashboard 버전 상세 모달과 WF 탭 Update 팝업에서 공용으로 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

const tagFor = (t?: string) =>
  t === 'review' ? { label: 'Review', c: '#f59e0b' }
  : t === 'validation' ? { label: 'Validation', c: '#3fb950' }
  : { label: 'Action', c: 'var(--accent)' }

function NodeCard({ n, idx, accent = 'var(--border-subtle)', badge = null }: {
  n: TwixyWorkflowNode; idx: number; accent?: string; badge?: string | null
}) {
  const tg = tagFor(n.type)
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderLeft: `3px solid ${accent}`, borderRadius: 8 }}>
      <span style={{ flexShrink: 0, width: 19, height: 19, borderRadius: '50%', border: `1.5px solid ${tg.c}`, color: tg.c, fontSize: 10.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{idx + 1}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: tg.c }}>{tg.label}</span>
          {n.tool && <span style={{ fontSize: 8.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '0 4px' }}>{n.tool}</span>}
          {badge && <span style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: accent, border: `1px solid ${accent}`, borderRadius: 4, padding: '0 4px' }}>{badge}</span>}
          <span style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500 }}>{n.title}</span>
        </div>
        {n.detail && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{n.detail}</div>}
      </div>
    </div>
  )
}

export function WorkflowNodeList({ nodes }: { nodes: TwixyWorkflowNode[] }) {
  if (!nodes.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>This workflow has no steps.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {nodes.map((n, i) => <NodeCard key={n.id ?? i} n={n} idx={i} />)}
    </div>
  )
}

type DiffStatus = 'same' | 'changed' | 'only'
function nodeDiff(n: TwixyWorkflowNode, otherById: Map<string, TwixyWorkflowNode>): DiffStatus {
  const o = otherById.get(n.id)
  if (!o) return 'only'
  return JSON.stringify(o) === JSON.stringify(n) ? 'same' : 'changed'
}
function diffColor(status: DiffStatus, side: 'left' | 'right'): { c: string; badge: string | null } {
  return status === 'same' ? { c: 'var(--border-subtle)', badge: null }
    : status === 'changed' ? { c: '#d29922', badge: 'changed' }
    : side === 'left' ? { c: '#f85149', badge: 'removed' }
    : { c: '#3fb950', badge: 'added' }
}

export function WorkflowDiffView({ left, right, leftLabel, rightLabel }: {
  left?:  TwixyWorkflow | null
  right?: TwixyWorkflow | null
  leftLabel:  string
  rightLabel: string
}) {
  const leftNodes  = left?.nodes ?? []
  const rightNodes = right?.nodes ?? []
  const leftById  = new Map(leftNodes.map(n => [n.id, n]))
  const rightById = new Map(rightNodes.map(n => [n.id, n]))
  const cols = [
    { side: 'left'  as const, label: leftLabel,  list: leftNodes,  other: rightById },
    { side: 'right' as const, label: rightLabel, list: rightNodes, other: leftById },
  ]
  return (
    <div>
      {/* 범례 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        <span style={{ color: '#3fb950' }}>■ added</span>
        <span style={{ color: '#f85149' }}>■ removed</span>
        <span style={{ color: '#d29922' }}>■ changed</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {cols.map(({ side, label, list, other }) => (
          <div key={side} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 8 }}>{label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.length === 0
                ? <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No steps.</div>
                : list.map((n, i) => {
                    const d = diffColor(nodeDiff(n, other), side)
                    return <NodeCard key={n.id ?? i} n={n} idx={i} accent={d.c} badge={d.badge} />
                  })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
