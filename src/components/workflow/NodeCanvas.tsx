// ─────────────────────────────────────────────────────────────────────────────
// NodeCanvas.tsx — Workflow 뷰 가운데 영역. 활성 워크플로의 노드들을
// 좌→우 흐름으로 시각화 (PDF 0613: react-flow 사용 금지).
//
// v1: 단일 워크플로우, 노드는 읽기 전용 뷰어. 멀티 탭은 v1.5.
// Test Mode: useWorkflowTest 가 실 메인 채팅 세션으로 순차 실행 — 각 노드별
// 실제 wall-clock duration + USD 비용을 카드에 직접 표시.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, type ReactNode } from 'react'
import { Folder } from 'lucide-react'
import { WorkflowNodeCard } from './WorkflowNodeCard'
import { DisplayCost } from '../../lib/useDisplayUsd'
import { ContextChip } from './ContextChip'
import { HoverTip } from '../orchestration/HoverTip'
import { typeAbbrev } from '../../lib/orchestrationIO'
import type { WorkflowTestState, ReviewAction } from '../../hooks/useWorkflowTest'
import type { ContextUsage } from '../../hooks/useWorkflowTestSession'

interface Props {
  workflow: TwixyWorkflow | null
  testState: WorkflowTestState
  onTestStart: (inputs: Record<string, string>) => void
  onTestStop:  () => void
  onTestReset: () => void
  // (옵션) 실패/중단된 run 을 실패 지점부터 재개 — 완료 노드는 보존되고 그
  // 출력이 recap 으로 러너에 전달된다. 입력값은 직전 run 것 재사용.
  onTestResume?: () => void
  // (옵션) 마지막 run 기반으로 특정 노드부터 재실행 — 노드 카드의 "⟲ from here".
  onTestRunFromNode?: (nodeId: string) => void
  // (옵션) 노드 사이 화살표의 (+) — 해당 위치에 Human Review 노드 삽입.
  onInsertReviewNode?: (afterIndex: number) => void
  // (옵션) 노드 삭제 — review 노드에만 적용된다 (쉬운 제거 UI).
  onDeleteNode?: (nodeId: string) => void
  onReviewDecision?: (nodeId: string, action: ReviewAction, comment?: string) => void
  // Test session context — 누적 토큰 시각화 + 사용자 reset.
  contextUsage:    ContextUsage | null
  onResetContext:  () => void | Promise<void>
  // 워크플로 파일 수준 패치(예: outputDir 저장 폴더 지정).
  onPatchWorkflow?: (patch: { outputDir?: string }) => void | Promise<void>
  // (옵션) 인앱 확인 다이얼로그 — 미지정 시 네이티브 window.confirm 폴백.
  confirm?: (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  // 상단 툴바에 in-flow 로 배치되는 슬롯 — absolute 오버레이 대신 flex 흐름에
  // 넣어 어떤 폭에서도 서로 겹치지 않게 한다.
  headerLeft?:  ReactNode   // 제목 옆 (예: 팀 공유 컨트롤)
  headerRight?: ReactNode   // 액션 클러스터 옆 (예: browser 프리뷰 토글)
  banner?:      ReactNode   // 툴바 바로 아래 전체폭 알림 (예: 오래된 사본 배너)
  // 타입 배지(RSCH/EXEC) 노출 여부. WF 탭에선 숨기고(false) Copilot 탭에선 표시(기본).
  showTypeBadge?: boolean
}

export function NodeCanvas({
  workflow, testState, onTestStart, onTestStop, onTestReset, onTestResume, onTestRunFromNode, onInsertReviewNode, onDeleteNode, onReviewDecision,
  contextUsage, onResetContext, onPatchWorkflow, confirm,
  headerLeft, headerRight, banner, showTypeBadge = true,
}: Props) {
  // 확인 다이얼로그 — prop 이 있으면 인앱, 없으면 네이티브 폴백 (WorkflowView 호환).
  const askConfirm = (title: string, message: string, danger = false): Promise<boolean> =>
    confirm ? confirm({ title, message, danger }) : Promise.resolve(window.confirm(`${title}\n${message}`))
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showInputs, setShowInputs] = useState(false)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})

  // 활성 워크플로가 바뀌면 인풋 폼 닫고 default 값으로 초기화.
  useEffect(() => {
    setShowInputs(false)
    if (workflow?.inputs) {
      const next: Record<string, string> = {}
      for (const inp of workflow.inputs) {
        next[inp.id] = String(inp.observed ?? '')
      }
      setInputValues(next)
    } else {
      setInputValues({})
    }
  }, [workflow?.id])

  if (!workflow) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 13,
        fontStyle: 'italic',
      }}>
        Select a workflow from the left panel
      </div>
    )
  }

  const hasInputs = workflow.inputs && workflow.inputs.length > 0

  const onTestClick = () => {
    if (testState.isRunning) {
      onTestStop()
      return
    }
    if (hasInputs && !showInputs) {
      setShowInputs(true)
      return
    }
    onTestStart(inputValues)
    setShowInputs(false)
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Canvas tab strip + Test button */}
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        padding: '0 6px 0 4px',
        flexShrink: 0,
        flexWrap: 'nowrap',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          fontSize: 12,
          color: 'var(--text-primary)',
          borderRight: '1px solid var(--border-subtle)',
          background: 'var(--bg-elevated)',
          minWidth: 0,          // allow this block to shrink so the action
                                // cluster on the right is never pushed off
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>{workflow.title}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
            · {workflow.nodes.length} node{workflow.nodes.length === 1 ? '' : 's'}
          </span>
          {/* 타입 배지 — WF 탭은 숨기고(showTypeBadge=false) Copilot 탭에선 표시.
              타입은 노드에서 자동 도출되는 읽기 전용 값. research=데이터 생성 / execution=행동. */}
          {showTypeBadge && (() => { const t = workflow.type ?? 'execution'; const r = t === 'research'; return (
            <HoverTip side="bottom" style={{ marginLeft: 4, display: 'inline-flex' }}
              content={<span style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Workflow type (auto) · <b style={{ color: '#3fb950' }}>Research</b> produces output (data) · <b style={{ color: '#d29922' }}>Execution</b> performs an action</span>}>
              <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, padding: '1px 6px', borderRadius: 4, color: r ? '#3fb950' : '#d29922', background: r ? 'rgba(63,185,80,0.12)' : 'rgba(210,153,34,0.12)' }}>{typeAbbrev(t)}</span>
            </HoverTip>
          ) })()}
          {/* 산출물 저장 폴더 — write 또는 data 노드가 있는(파일을 만드는)
              워크플로에서만. data/query 도 xlsx/csv 를 여기에 쓴다. 직접 폴더 지정. */}
          {workflow.nodes.some(n => n.tool === 'write' || n.tool === 'data') && onPatchWorkflow && (
            <HoverTip side="bottom" style={{ marginLeft: 2, display: 'inline-flex' }}
              content={<span style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Output folder (workflow-level) · files this workflow writes are saved here. Must be <b>inside data/</b> — writes elsewhere are blocked. Click to choose.</span>}>
              <button
                onClick={async () => {
                  const res = await window.twixy?.pickOutputDir?.()
                  if (!res) return  // cancelled
                  if (!res.ok) {
                    alert('The output folder must be inside data/.\n\nWorkflow file writes are sandboxed to the data/ folder. Pick a folder inside data/ (e.g. data/reports).')
                    return
                  }
                  await onPatchWorkflow({ outputDir: res.relPath })
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, fontFamily: 'var(--font-mono)', maxWidth: 150, flexShrink: 1, minWidth: 0, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${workflow.outputDir ? 'var(--border)' : 'var(--accent)'}`, background: workflow.outputDir ? 'var(--bg-base)' : 'var(--accent-dim)', color: workflow.outputDir ? 'var(--text-secondary)' : 'var(--accent)' }}>
                <Folder size={11} strokeWidth={1.6} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workflow.outputDir || 'Set output folder'}</span>
              </button>
            </HoverTip>
          )}
        </div>

        {/* 제목 옆 in-flow 슬롯 (팀 공유 컨트롤 등). 슬롯 컴포넌트가 자체 간격을
            소유 — null 을 렌더하면 DOM 자체가 없어 빈 간격도 남지 않는다. */}
        {headerLeft}

        <div style={{ flex: 1, minWidth: 8 }} />

        {/* Right-side action cluster — flexShrink:0 so the Stop/Test button is
            NEVER pushed off-screen no matter how wide the title/output-folder
            get. Secondary controls collapse away during a run. */}
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 2 }}>
          {(testState.startedAt || testState.isRunning) && (
            <TestSummaryChip testState={testState} />
          )}
          {(testState.isRunning || testState.endedAt) && (
            <button
              onClick={() => window.twixy?.openTestOverlay?.()}
              title="Open progress overlay"
              style={{ ...smallBtn('transparent', 'var(--text-muted)'), margin: '6px 0' }}
            >
              ⤢
            </button>
          )}
          {testState.endedAt && !testState.isRunning && (
            <button
              onClick={onTestReset}
              title="Clear last test results"
              style={smallBtn('transparent', 'var(--text-muted)')}
            >
              ↺
            </button>
          )}
          {/* browser 프리뷰 토글 — popout(⤢)·refresh(↺) 아이콘 오른쪽에 아이콘으로. */}
          {headerRight}
          {/* Test session context usage — 클릭으로 reset */}
          <ContextChip usage={contextUsage} onReset={onResetContext} />
          {/* Auto-review 는 항시 활성 (UI 토글 제거 — 성공 run 은 항상 빌더가 검토) */}
          {/* Resume — 실패/중단 run 이 있을 때만. 완료 노드는 건너뛰고 재개. */}
          {!testState.isRunning && !!onTestResume && !!testState.endedAt
            && Object.values(testState.nodeStates).some(s => s.status === 'failed' || s.status === 'aborted') && (
            <button
              onClick={() => {
                void askConfirm('Resume this run?', 'Resume from the failed node — completed nodes are kept and their outputs are replayed to the runner.')
                  .then(ok => { if (ok) onTestResume() })
              }}
              title="Resume from the failed node — completed nodes are kept and their outputs are replayed to the runner"
              style={{
                ...smallBtn('#f59e0b', '#fff'),
                fontWeight: 600,
                margin: '6px 0 6px 2px',
              }}
            >
              ⟲ Resume
            </button>
          )}
          <button
            onClick={onTestClick}
            title={testState.isRunning ? 'Stop test' : 'Run real LLM test (uses main chat session)'}
            style={{
              ...smallBtn(testState.isRunning ? 'var(--red)' : '#10b981', '#fff'),
              fontWeight: 600,
              margin: '6px 0 6px 2px',
            }}
          >
            {testState.isRunning
              ? <>■ Stop</>
              : <><span style={{ fontSize: 9, marginRight: 4 }}>▶</span>Start</>}
          </button>
        </div>
      </div>

      {/* 툴바 바로 아래 전체폭 알림 슬롯 (예: 오래된 사본 배너). */}
      {banner}

      {/* Canvas body */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowX: 'auto',
        overflowY: 'auto',
        padding: '20px 24px',
      }}>
        {workflow.description && (
          <div style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 16,
            lineHeight: 1.5,
            maxWidth: 720,
          }}>
            {workflow.description}
          </div>
        )}

        {showInputs && hasInputs && (
          <InputsForm
            inputs={workflow.inputs!}
            values={inputValues}
            onChange={(id, v) => setInputValues(prev => ({ ...prev, [id]: v }))}
            onConfirm={() => { onTestStart(inputValues); setShowInputs(false) }}
            onCancel={() => setShowInputs(false)}
          />
        )}

        {!showInputs && hasInputs && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            marginBottom: 18,
          }}>
            <span style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: 'var(--text-muted)',
              marginRight: 4,
            }}>
              Workflow inputs:
            </span>
            {workflow.inputs!.map(inp => (
              <span key={inp.id} style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                padding: '2px 7px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
              }}>
                {`{{${inp.id}}}`} · {inp.label}
              </span>
            ))}
          </div>
        )}

        {workflow.nodes.length === 0 ? (
          <div style={{
            padding: 20,
            fontSize: 12,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            This workflow has no nodes yet
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 18,
            minWidth: 'min-content',
          }}>
            {workflow.nodes.map((node, idx) => {
              const prevNode = idx > 0 ? workflow.nodes[idx - 1] : null
              const prevMetrics = prevNode ? testState.nodeStates[prevNode.id] : undefined
              return (
                <WorkflowNodeCard
                  key={node.id}
                  node={node}
                  order={idx + 1}
                  isLast={idx === workflow.nodes.length - 1}
                  expanded={expandedId === node.id}
                  onToggle={() => setExpandedId(expandedId === node.id ? null : node.id)}
                  runMetrics={testState.nodeStates[node.id]}
                  onReviewDecision={onReviewDecision}
                  previousOutput={prevMetrics?.output}
                  previousNodeTitle={prevNode?.title}
                  // "이 노드부터 재실행" — 마지막 run 이 있고 지금 도는 중이 아닐 때만.
                  // 실수 방지: 실행 전에 한 번 확인.
                  onRunFromHere={
                    onTestRunFromNode && !testState.isRunning && testState.startedAt
                      ? () => {
                          void askConfirm('Re-run from this node?', `Re-run from node ${idx + 1} "${node.title}" — earlier nodes' results are kept and replayed as context.`)
                            .then(ok => { if (ok) onTestRunFromNode(node.id) })
                        }
                      : undefined
                  }
                  // 노드 사이 (+) — Human Review 삽입. 실행 중엔 비활성.
                  onInsertReviewAfter={
                    onInsertReviewNode && !testState.isRunning
                      ? () => onInsertReviewNode(idx)
                      : undefined
                  }
                  // review 노드는 × 로 즉시 제거 가능 ((+)와 대칭). 실행 중 비활성.
                  onDelete={
                    onDeleteNode && node.type === 'review' && !testState.isRunning
                      ? () => onDeleteNode(node.id)
                      : undefined
                  }
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Test summary chip — total time + cost while/after running ───────────────
function TestSummaryChip({ testState }: { testState: WorkflowTestState }) {
  const totalMs = testState.isRunning && testState.startedAt
    ? Date.now() - testState.startedAt  // live total during run
    : testState.totalMs
  const time = formatDuration(totalMs)
  const tokens = testState.totalTokensIn + testState.totalTokensOut
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '0 12px',
      margin: '6px 0',
      fontSize: 11,
      color: 'var(--text-secondary)',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <span title="Total wall-clock time">⏱ {time}</span>
      <span title="Total USD cost (delta from baseline, end-user pricing)">
        <DisplayCost rawUsd={testState.totalCost} showZero />
      </span>
      {tokens > 0 && (
        <span style={{ color: 'var(--text-muted)' }} title="Total tokens (in + out)">
          {tokens.toLocaleString()} tok
        </span>
      )}
      {testState.isRunning && <BlinkDot />}
    </div>
  )
}

function BlinkDot() {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%',
      background: 'var(--accent)',
      animation: 'spin 0.9s ease-in-out infinite alternate',
      display: 'inline-block',
    }} />
  )
}

// ── Inputs form (collected before test starts) ──────────────────────────────
function InputsForm({
  inputs, values, onChange, onConfirm, onCancel,
}: {
  inputs: TwixyModuleParam[]
  values: Record<string, string>
  onChange: (id: string, v: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div style={{
      marginBottom: 18,
      padding: 12,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      maxWidth: 540,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginBottom: 10,
      }}>
        Provide workflow inputs to run the test
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {inputs.map(inp => (
          <label key={inp.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {inp.label}
              <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontFamily: 'var(--font-mono)' }}>
                {`{{${inp.id}}}`} · {inp.valueType}
              </span>
            </span>
            <input
              type="text"
              value={values[inp.id] ?? ''}
              onChange={e => onChange(inp.id, e.target.value)}
              placeholder={String(inp.observed ?? '')}
              style={{
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '5px 8px',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button
          onClick={onConfirm}
          style={{
            background: '#10b981',
            border: 'none',
            color: '#fff',
            borderRadius: 'var(--radius-sm)',
            padding: '5px 12px',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          ▶ Start
        </button>
        <button
          onClick={onCancel}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            borderRadius: 'var(--radius-sm)',
            padding: '5px 12px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────

function smallBtn(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    border: 'none',
    color: fg,
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 2,
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}
