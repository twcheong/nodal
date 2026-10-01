// ─────────────────────────────────────────────────────────────────────────────
// WorkflowTab.tsx — 채팅 뷰 위의 슬림 프리뷰 바.
//
// PDF 0613 반영: 본격적인 노드 시각화는 사이드바 2번째 [◇ Workflow] 풀 뷰가
// 담당한다. 여기는 "어느 워크플로가 선택돼 있는지"와 "지금 바로 Run" 만 보여주는
// 간단한 띠. N8N 가로 노드 흐름은 제거됨.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  workflow: TwixyWorkflow | null
  collapsed: boolean
  onToggleCollapse: () => void
  onExecute?: (workflow: TwixyWorkflow) => void
  // 워크플로 뷰로 이동하는 핸들러 — 프리뷰에서 "Open editor →" 클릭 시.
  onOpenEditor?: () => void
}

export function WorkflowTab({ workflow, collapsed, onToggleCollapse, onExecute, onOpenEditor }: Props) {
  return (
    <section style={{
      borderBottom: '1px solid var(--border-subtle)',
      background: 'var(--bg-surface)',
      flexShrink: 0,
    }}>
      <header style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        userSelect: 'none',
      }}>
        <div
          onClick={onToggleCollapse}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 }}
        >
          <span style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            transition: 'transform 0.15s',
            display: 'inline-block',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}>▾</span>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}>
            Workflow
          </span>
          {workflow ? (
            <>
              <span style={{
                fontSize: 12,
                color: 'var(--text-primary)',
                marginLeft: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {workflow.title}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                · {workflow.nodes.length} node{workflow.nodes.length === 1 ? '' : 's'}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No workflow selected
            </span>
          )}
        </div>
        {onOpenEditor && (
          <button
            onClick={onOpenEditor}
            title="Open Workflow editor"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 11,
              padding: '3px 8px',
              cursor: 'pointer',
            }}
          >
            Open editor →
          </button>
        )}
        {workflow && onExecute && (
          <button
            onClick={(e) => { e.stopPropagation(); onExecute(workflow) }}
            title="Run this workflow — chat will ask for required inputs"
            style={{
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              padding: '4px 10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span style={{ fontSize: 9 }}>▶</span> Run
          </button>
        )}
      </header>

      {!collapsed && workflow && (
        <div style={{ padding: '0 12px 10px' }}>
          {workflow.description && (
            <div style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              lineHeight: 1.5,
              paddingBottom: 6,
            }}>
              {workflow.description}
            </div>
          )}
          {(workflow.inputs && workflow.inputs.length > 0) && (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 4,
            }}>
              <span style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.3,
                marginRight: 4,
              }}>
                Needs:
              </span>
              {workflow.inputs.map(inp => (
                <span key={inp.id} style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-subtle)',
                }}>
                  {inp.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
