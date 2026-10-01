// ─────────────────────────────────────────────────────────────────────────────
// TestOverlay — 워크플로 테스트 진행상황 전용 floating overlay.
//
// 메인 윈도우의 WorkflowView 가 testState 를 push 하면 그대로 미러링.
// 사이드탭과 같이 always-on-top + visibleOnFullScreen → 사용자가 다른 앱에서
// 작업 중에도 작은 창으로 진행상황을 볼 수 있다.
//
// 액션:
//   - Stop  : 현재 테스트 중단 (메인 윈도우에 IPC 로 전달)
//   - Focus : 메인 윈도우의 워크플로 뷰로 포커스 이동
//   - X     : overlay 닫기
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { DisplayCost } from '../lib/useDisplayUsd'

// useWorkflowTest 의 타입과 동일해야 함 — 단일 진실 소스가 메인 hook 이지만
// overlay 는 그 모듈을 import 하지 않고 형태만 미러링한다 (overlay 가 hook
// 자체를 실행하지 않으므로 종속성 끊김).
type NodeRunStatus = 'pending' | 'running' | 'awaiting-review' | 'done' | 'failed' | 'skipped' | 'aborted'
type ReviewAction = 'approve' | 'note' | 'skip'
interface NodeRunMetrics {
  status:      NodeRunStatus
  startedAt?:  number
  endedAt?:    number
  durationMs?: number
  costUsd?:    number
  tokensIn?:   number
  tokensOut?:  number
  reason?:     string
  output?:     string
}
interface WorkflowSnapshotNode {
  id:    string
  title: string
  type:  'action' | 'review' | 'validation'
}
// 라이브 활동: 메인 채팅에서 일어나는 현재 진행상황을 그대로 미러링.
// 사용자가 "Twixy 가 지금 뭘 하고 있는지" 한눈에 보도록 — 사이드탭 overlay 와
// 유사한 UX 지만 워크플로 테스트 컨텍스트에 한정한 슬라이스만 전송.
interface LiveToolActivity {
  name:           string
  detail?:        string
  isSubagent:     boolean
  subagentLabel?: string
}
interface LiveMessage {
  id:      string
  role:    'user' | 'assistant' | 'system'
  content: string
  ts:      number
}
interface TestOverlaySnapshot {
  workflowTitle: string
  nodes:         WorkflowSnapshotNode[]
  isRunning:     boolean
  startedAt?:    number
  endedAt?:      number
  totalCost:     number
  totalMs:       number
  totalTokensIn: number
  totalTokensOut: number
  nodeStates:    Record<string, NodeRunMetrics>
  // 라이브 활동: 테스트 시작 이후 메인 채팅의 메시지 슬라이스 + 현재 툴 호출.
  toolActivity?: LiveToolActivity | null
  isThinking?:   boolean
  liveMessages?: LiveMessage[]
}

const EMPTY: TestOverlaySnapshot = {
  workflowTitle: '—',
  nodes:         [],
  isRunning:     false,
  totalCost:     0,
  totalMs:       0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  nodeStates:    {},
  toolActivity:  null,
  isThinking:    false,
  liveMessages:  [],
}

declare global {
  interface Window {
    twixyTestOverlay?: {
      requestSync: () => Promise<TestOverlaySnapshot | null>
      onSync:      (cb: (snap: TestOverlaySnapshot) => void) => () => void
      stop:        () => Promise<void>
      focusMain:   () => Promise<void>
      close:       () => Promise<void>
      sendReviewDecision: (payload: { nodeId: string; action: ReviewAction; comment?: string }) => Promise<void>
    }
  }
}

export function TestOverlay() {
  const [snap, setSnap] = useState<TestOverlaySnapshot>(EMPTY)
  const [now, setNow]   = useState(Date.now())

  useEffect(() => {
    const bridge = window.twixyTestOverlay
    if (!bridge) return
    // Pull cached snapshot the moment the overlay mounts.
    bridge.requestSync().then(s => { if (s) setSnap(s) }).catch(() => { /* ignore */ })
    // Subscribe to incoming pushes from the main window.
    const off = bridge.onSync(setSnap)
    return off
  }, [])

  // Live tick for elapsed time when running.
  useEffect(() => {
    if (!snap.isRunning) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [snap.isRunning])

  const elapsedMs = snap.isRunning && snap.startedAt
    ? Math.max(0, now - snap.startedAt)
    : snap.totalMs
  // Progress count: terminal-state nodes (done OR skipped) — Human Review 가
  // 스킵된 경우에도 "지나간" 노드이므로 진행률에 포함시켜야 6/6 으로 마감된다.
  const doneCount = snap.nodes.filter(n => {
    const st = snap.nodeStates[n.id]?.status
    return st === 'done' || st === 'skipped'
  }).length
  const runningNode  = snap.nodes.find(n => snap.nodeStates[n.id]?.status === 'running')
  const awaitingNodeIdx = snap.nodes.findIndex(n => snap.nodeStates[n.id]?.status === 'awaiting-review')
  const awaitingNode = awaitingNodeIdx >= 0 ? snap.nodes[awaitingNodeIdx] : undefined
  const prevForAwaiting = awaitingNodeIdx > 0 ? snap.nodes[awaitingNodeIdx - 1] : undefined
  const prevOutputForAwaiting = prevForAwaiting ? snap.nodeStates[prevForAwaiting.id]?.output : undefined
  const progress = snap.nodes.length > 0 ? doneCount / snap.nodes.length : 0

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(15,15,15,0.96)',
      color: 'var(--text-primary)',
      WebkitAppRegion: 'drag',
    } as React.CSSProperties}>
      <Header
        title={snap.workflowTitle}
        isRunning={snap.isRunning}
        onClose={() => window.twixyTestOverlay?.close()}
        onFocus={() => window.twixyTestOverlay?.focusMain()}
      />

      {/* Awaiting-review banner — 사람이 결정해야 다음으로 진행 */}
      {awaitingNode && (
        <ReviewBanner
          nodeId={awaitingNode.id}
          nodeTitle={awaitingNode.title}
          previousOutput={prevOutputForAwaiting}
          previousNodeTitle={prevForAwaiting?.title}
        />
      )}

      {/* Progress ring + summary */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}>
        <ProgressRing
          fraction={progress}
          isRunning={snap.isRunning}
          totalNodes={snap.nodes.length}
          doneCount={doneCount}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {snap.isRunning ? 'Running' : (snap.endedAt ? 'Last run' : 'Idle')}
          </div>
          {runningNode && (
            <div style={{
              fontSize: 12,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              ▶ {runningNode.title}
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
            <span title="Wall-clock">⏱ {fmtMs(elapsedMs)}</span>
            <span title="USD cost so far (end-user pricing)">
              <DisplayCost rawUsd={snap.totalCost} showZero />
            </span>
            {(snap.totalTokensIn + snap.totalTokensOut) > 0 && (
              <span style={{ color: 'var(--text-muted)' }}>
                {(snap.totalTokensIn + snap.totalTokensOut).toLocaleString()} tok
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Node list — 컴팩트하게 자기 콘텐츠만큼만, 나머지는 활동 패널이 채움 */}
      <div style={{
        maxHeight: '40%',
        overflowY: 'auto',
        padding: '8px 0',
        borderBottom: '1px solid var(--border-subtle)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}>
        {snap.nodes.length === 0 ? (
          <div style={{
            padding: 16,
            fontSize: 12,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            textAlign: 'center',
          }}>
            No workflow selected
          </div>
        ) : (
          snap.nodes.map((node, idx) => (
            <NodeRow key={node.id} order={idx + 1} node={node} m={snap.nodeStates[node.id]} />
          ))
        )}
      </div>

      {/* Live activity — 툴 사용 + Twixy 메시지 미러링 */}
      <LiveActivity
        toolActivity={snap.toolActivity ?? null}
        isThinking={!!snap.isThinking}
        messages={snap.liveMessages ?? []}
      />

      {/* Stop button */}
      {snap.isRunning && (
        <div style={{ padding: 10, borderTop: '1px solid var(--border-subtle)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => window.twixyTestOverlay?.stop()}
            style={{
              width: '100%',
              background: 'var(--red)',
              border: 'none',
              color: '#fff',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 10px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ■ Stop test
          </button>
        </div>
      )}
    </div>
  )
}

function Header({ title, isRunning, onClose, onFocus }:
  { title: string; isRunning: boolean; onClose: () => void; onFocus: () => void }) {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 10px',
      borderBottom: '1px solid var(--border-subtle)',
      background: 'var(--bg-surface)',
    }}>
      {isRunning && (
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--accent)',
          boxShadow: '0 0 6px var(--accent)',
        }} />
      )}
      <span style={{
        flex: 1,
        fontSize: 11,
        color: 'var(--text-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginRight: 6 }}>
          Test
        </span>
        {title}
      </span>
      <button
        title="Focus main window"
        onClick={onFocus}
        style={{
          ...iconBtn,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        ⌂
      </button>
      <button
        title="Close overlay"
        onClick={onClose}
        style={{
          ...iconBtn,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        ✕
      </button>
    </header>
  )
}

function ProgressRing({ fraction, isRunning, totalNodes, doneCount }:
  { fraction: number; isRunning: boolean; totalNodes: number; doneCount: number }) {
  const size   = 56
  const stroke = 4
  const r      = (size - stroke) / 2
  const c      = 2 * Math.PI * r
  const offset = c * (1 - Math.max(0, Math.min(1, fraction)))
  const color  = isRunning ? 'var(--accent)' : (fraction >= 1 ? 'var(--accent)' : 'var(--text-muted)')

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r}
          stroke="var(--border)" strokeWidth={stroke} fill="none" />
        <circle cx={size/2} cy={size/2} r={r}
          stroke={color} strokeWidth={stroke} fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.2s' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
      }}>
        {doneCount}/{totalNodes}
      </div>
    </div>
  )
}

function NodeRow({ order, node, m }:
  { order: number; node: WorkflowSnapshotNode; m: NodeRunMetrics | undefined }) {
  const status = m?.status ?? 'pending'
  const shape = node.type === 'review' ? '▲' : node.type === 'validation' ? '■' : '●'
  const statusColor =
    status === 'running'         ? 'var(--accent)' :
    status === 'awaiting-review' ? 'var(--warning)' :
    status === 'done'            ? 'var(--accent)' :
    status === 'failed'          ? 'var(--red)' :
    status === 'skipped'         ? 'var(--text-muted)' :
    status === 'aborted'         ? 'var(--warning)' :
    'var(--text-muted)'
  const showReason = (status === 'failed' || status === 'aborted') && m?.reason
  return (
    <div style={{
      borderLeft: `2px solid ${status === 'pending' ? 'transparent' : statusColor}`,
      background: status === 'running' ? 'rgba(13, 92, 80, 0.08)' : 'transparent',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 12px',
        fontSize: 11,
      }}>
        <span style={{ color: 'var(--text-muted)', width: 14, textAlign: 'right' }}>
          {order}.
        </span>
        <span style={{ color: statusColor, fontSize: 12 }}>
          {shape}
        </span>
        <span style={{
          flex: 1,
          color: status === 'pending' ? 'var(--text-muted)' : 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {node.title}
        </span>
        {status === 'running' && (
          <span style={{ fontSize: 9, color: 'var(--accent)' }}>running…</span>
        )}
        {status === 'awaiting-review' && (
          <span style={{ fontSize: 9, color: 'var(--warning)' }}>awaiting you…</span>
        )}
        {typeof m?.durationMs === 'number' && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {fmtMs(m.durationMs)}
          </span>
        )}
        {typeof m?.costUsd === 'number' && m.costUsd > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            <DisplayCost rawUsd={m.costUsd} />
          </span>
        )}
      </div>
      {showReason && (
        <div style={{
          padding: '0 12px 6px 28px',
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: status === 'failed' ? 'var(--red)' : 'var(--warning)',
          opacity: 0.95,
          wordBreak: 'break-word',
        }}>
          {status === 'failed' ? '✕ ' : '↯ '}{m?.reason}
        </div>
      )}
    </div>
  )
}

// ── Review banner — awaiting-review 상태일 때 prominently 노출 ──────────────
// 사용자가 메인 채팅으로 가서 직전 노드의 출력을 보고 결정. 오버레이에서 바로
// 결정할 수 있게 3 버튼 제공. Send note 누르면 textarea 가 나타나 코멘트 입력.
function ReviewBanner({ nodeId, nodeTitle, previousOutput, previousNodeTitle }:
  { nodeId: string; nodeTitle: string; previousOutput?: string; previousNodeTitle?: string }) {
  const [mode, setMode] = useState<'idle' | 'noting'>('idle')
  const [note, setNote] = useState('')
  const [outputOpen, setOutputOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered')

  const send = (action: ReviewAction, comment?: string) => {
    window.twixyTestOverlay?.sendReviewDecision({ nodeId, action, comment })
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        padding: 10,
        background: 'rgba(245, 158, 11, 0.12)',
        borderBottom: '1px solid #b07d1866',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        WebkitAppRegion: 'no-drag',
        maxHeight: '60%',
      } as React.CSSProperties}
    >
      <div style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>
        ⏸ Review needed — "{nodeTitle}"
      </div>

      {/* 직전 노드 출력 — overlay 에서도 사람이 바로 보고 결정 */}
      {previousOutput && (
        <div style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}>
          <div
            onClick={() => setOutputOpen(v => !v)}
            style={{
              padding: '4px 7px',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
              background: 'var(--bg-elevated)',
              borderBottom: outputOpen ? '1px solid var(--border-subtle)' : 'none',
            }}
          >
            <span style={{
              fontSize: 8,
              color: 'var(--text-muted)',
              transform: outputOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.12s',
              width: 8,
            }}>▸</span>
            <span style={{
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: 'var(--text-muted)',
              fontWeight: 600,
            }}>
              Input from {previousNodeTitle ? `"${previousNodeTitle}"` : 'previous'}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); setViewMode(v => v === 'rendered' ? 'raw' : 'rendered') }}
              style={{
                fontSize: 8,
                background: 'transparent',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
                borderRadius: 3,
                padding: '0 4px',
                cursor: 'pointer',
                marginLeft: 'auto',
              }}
            >
              {viewMode === 'rendered' ? 'Raw' : 'MD'}
            </button>
            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
              {previousOutput.length.toLocaleString()}c
            </span>
          </div>
          {outputOpen && (
            viewMode === 'rendered' ? (
              <div
                className="md-render"
                style={{
                  maxHeight: 280,
                  overflowY: 'auto',
                  padding: 10,
                  userSelect: 'text',
                  fontSize: 11,
                } as React.CSSProperties}
                dangerouslySetInnerHTML={{
                  __html: marked(previousOutput, { breaks: true, gfm: true }) as string,
                }}
              />
            ) : (
              <div style={{
                maxHeight: 280,
                overflowY: 'auto',
                padding: 8,
                fontSize: 10,
                lineHeight: 1.5,
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text',
                fontFamily: 'var(--font-mono)',
              } as React.CSSProperties}>
                {previousOutput}
              </div>
            )
          )}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
        {previousOutput
          ? 'Read the input above, then decide:'
          : '(Previous output not captured — check the main chat.)'}
      </div>

      {mode === 'idle' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <button onClick={() => send('approve')}    style={miniBtn('var(--accent)')}>✅ Approve</button>
          <button onClick={() => setMode('noting')}  style={miniBtn('var(--accent)')}>✏️ Send note</button>
          <button onClick={() => send('skip')}       style={miniBtnGhost()}>⤼ Skip</button>
          <button
            onClick={() => window.twixyTestOverlay?.focusMain()}
            style={miniBtnGhost()}
            title="Bring Twixy main window to the front"
          >
            ⌂ Main
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Tell Twixy what to fix or reconsider…"
            rows={3}
            style={{
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '5px 7px',
              fontFamily: 'var(--font-sans)',
              fontSize: 11,
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
            <button onClick={() => { setMode('idle'); setNote('') }} style={miniBtnGhost()}>
              Cancel
            </button>
            <button
              disabled={!note.trim()}
              onClick={() => { send('note', note.trim()); setNote(''); setMode('idle') }}
              style={{
                ...miniBtn('var(--accent)'),
                opacity: note.trim() ? 1 : 0.5,
                cursor: note.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function miniBtn(bg: string): React.CSSProperties {
  return {
    background: bg,
    border: 'none',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    padding: '3px 8px',
    fontSize: 10,
    fontWeight: 600,
    cursor: 'pointer',
  }
}
function miniBtnGhost(): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: '3px 8px',
    fontSize: 10,
    cursor: 'pointer',
  }
}

// ── Live activity — tool use + Twixy 응답 미러링 ────────────────────────────
function LiveActivity({
  toolActivity, isThinking, messages,
}: {
  toolActivity: LiveToolActivity | null
  isThinking:   boolean
  messages:     LiveMessage[]
}) {
  const scrollRef = useScrollOnUpdate([messages.length, toolActivity?.name, isThinking])

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      WebkitAppRegion: 'no-drag',
    } as React.CSSProperties}>
      <header style={{
        padding: '8px 12px 4px',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: 'var(--text-muted)',
      }}>
        Live activity
      </header>

      {/* Tool / thinking chip */}
      <div style={{ padding: '0 12px 6px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {toolActivity ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            background: '#0d5c5022',
            color: 'var(--accent)',
            border: '1px solid #0d5c5044',
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: 'var(--accent)', boxShadow: '0 0 4px var(--accent)',
            }} />
            {toolActivity.isSubagent ? '↳ ' : ''}{toolActivity.name}
            {toolActivity.subagentLabel && (
              <span style={{ color: 'var(--text-muted)' }}>· {toolActivity.subagentLabel}</span>
            )}
            {toolActivity.detail && (
              <span style={{
                color: 'var(--text-muted)',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>· {toolActivity.detail}</span>
            )}
          </span>
        ) : isThinking ? (
          <span style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            Thinking…
          </span>
        ) : (
          <span style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            Idle
          </span>
        )}
      </div>

      {/* Recent messages */}
      <div ref={scrollRef} style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '4px 12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        {messages.length === 0 ? (
          <div style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            No messages yet.
          </div>
        ) : (
          messages.map(m => <ActivityBubble key={m.id} m={m} />)
        )}
      </div>
    </div>
  )
}

function ActivityBubble({ m }: { m: LiveMessage }) {
  const isUser = m.role === 'user'
  return (
    <div style={{
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      maxWidth: '94%',
      background: isUser ? 'var(--accent-dim)' : 'var(--bg-elevated)',
      color: isUser ? 'var(--text-primary)' : 'var(--text-secondary)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
      padding: '5px 8px',
      fontSize: 11,
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      <div style={{
        fontSize: 9,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginBottom: 2,
      }}>
        {isUser ? 'You' : (m.role === 'assistant' ? 'Twixy' : 'System')}
      </div>
      {m.content}
    </div>
  )
}

function useScrollOnUpdate(deps: unknown[]) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}

// ── helpers ─────────────────────────────────────────────────────────────────
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}
// fmtUsd 는 DisplayCost (lib/useDisplayUsd) 로 흡수됨.

const iconBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
}
