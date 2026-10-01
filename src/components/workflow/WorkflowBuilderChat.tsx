// ─────────────────────────────────────────────────────────────────────────────
// WorkflowBuilderChat.tsx — Workflow 뷰 우측 채팅 영역.
// useWorkflowClaw 의 별도 세션을 사용해 메인 채팅과 분리된 워크플로 빌더와
// 대화한다. 메시지 리스트 + 입력창만 — Plan mode, quick actions, tool stats
// 등 무거운 기능은 의도적으로 생략 (간결함 우선).
// ─────────────────────────────────────────────────────────────────────────────

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { safeHtml } from '../../lib/safeHtml'
import { useWorkflowClaw } from '../../hooks/useWorkflowClaw'
import { parseWorkflowSpecFromText, stripWorkflowSpecBlock, type ParsedWorkflowSpec } from '../../lib/parseWorkflowSpec'
import { nodeTagFor } from '../../lib/workflowTools'
import { formatDisplayUsd } from '../../lib/useDisplayUsd'

// Imperative handle exposed to WorkflowView so test-runner failures can pipe
// straight into the builder chat as a "fix this" prompt — the user sees the
// failure surface in chat and the builder LLM replies with a workflow-spec
// patch that the existing SaveSpecPanel can Approve.
export interface WorkflowBuilderChatHandle {
  requestFixForFailedNode: (args: {
    workflow:   TwixyWorkflow
    nodeId:     string
    nodeTitle:  string
    nodeDetail?: string
    error:      string
  }) => void
  // Post-success log review — picks apart a successful test run for wasteful
  // or redundant steps and proposes a `workflow-spec` patch (or "no changes
  // needed") that the user can Approve via the existing SaveSpecPanel.
  requestAutoReview: (args: {
    workflow: TwixyWorkflow
    runSummary: Array<{
      order:      number
      nodeId:     string
      title:      string
      type:       'action' | 'review' | 'validation'
      tool?:      string
      toolSkills?: string[]
      status:     string
      durationMs?: number
      costUsd?:   number
      tokensIn?:  number
      tokensOut?: number
      output?:    string
      // 런타임 자동 분할이 개입한 노드 — 이번 run 은 살렸지만 스펙상 너무 크다.
      autoSlice?: { attempts: number; portion: string }
    }>
    totals: { ms?: number; usd?: number; tokensIn?: number; tokensOut?: number }
  }) => void
}

// LLM 에 보낼 때 author/createdAt 같은 메타는 잘라낸다 — 그 정보는 빌더 추론에
// 도움 안 되고 토큰만 잡아먹음.
function clip(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '…'
}

// "106259ms" → "1m 46s 259ms" 형태. 사람이 읽기 좋은 분/초/ms 분해.
function formatDurationMSM(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.floor(ms / 1000)
  const remMs    = Math.round(ms - totalSec * 1000)
  if (totalSec < 60) return `${totalSec}s ${remMs}ms`
  const m = Math.floor(totalSec / 60)
  const s = totalSec - m * 60
  return `${m}m ${s}s ${remMs}ms`
}

function toSnapshotForLlm(wf: TwixyWorkflow): Record<string, unknown> {
  return {
    title:       wf.title,
    description: wf.description,
    prompt:      wf.prompt,
    inputs:      wf.inputs,
    nodes:       wf.nodes,
  }
}

interface Props {
  activeWorkflow: TwixyWorkflow | null
  // 빌더 응답의 workflow-spec 블록을 "create new" 로 처리 — onSelect 까지 wiring.
  onSaveSpec?:    (spec: ParsedWorkflowSpec) => Promise<TwixyWorkflow | null>
  // 빌더 응답의 workflow-spec 을 현재 활성 워크플로에 "update" 적용.
  // 호출 측은 적용 직전 스냅샷을 보관해 undo 가능하도록.
  onUpdateActive?: (spec: ParsedWorkflowSpec) => Promise<{ workflow: TwixyWorkflow; snapshot: TwixyWorkflow } | null>
  // Undo: 보관된 스냅샷을 풀 overwrite 복원.
  onUndo?:        (snapshot: TwixyWorkflow) => Promise<TwixyWorkflow | null>
}

export const WorkflowBuilderChat = forwardRef<WorkflowBuilderChatHandle, Props>(function WorkflowBuilderChat(
  { activeWorkflow, onSaveSpec, onUpdateActive, onUndo },
  ref,
) {
  // workflowId 를 hook 에 넘기면 hook 이 알아서 disk 에서 그 워크플로의 채팅
  // history 를 load + sendMessage 마다 append. 워크플로 갈아탈 때 자동으로
  // 다른 history 로 전환됨 — 옛 "워크플로 바뀌면 채팅 reset" 로직은 제거.
  const { messages, isThinking, error, sendMessage, resetChat } = useWorkflowClaw(activeWorkflow?.id ?? null)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 활성 워크플로의 항상 최신 스냅샷 — onSubmit 안에서 closure 스테일 회피.
  const activeRef = useRef<TwixyWorkflow | null>(activeWorkflow)
  useEffect(() => { activeRef.current = activeWorkflow }, [activeWorkflow])

  // 새 메시지가 오면 가장 아래로 스크롤.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, isThinking])

  // 활성 워크플로가 있으면 user 메시지마다 현재 상태를 컨텍스트로 prepend.
  // 빌더 LLM 이 "지금 어떤 워크플로가 캔버스에 떠 있는지" 알게 해 수정 요구를
  // 정확히 그 워크플로에 맞춰 응답. onSubmit 과 sendUserMessage(handle)가 공유.
  const buildLlmPayload = (text: string): string => {
    const wf = activeRef.current
    return wf
      ? [
          '[Current workflow loaded in canvas]',
          '```json',
          JSON.stringify(toSnapshotForLlm(wf), null, 2),
          '```',
          '',
          text,
        ].join('\n')
      : text
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || isThinking) return
    setDraft('')
    // Pass the user-visible text separately so the snapshot prelude stays out
    // of the chat bubble (LLM still gets the full payload).
    await sendMessage(buildLlmPayload(text), text)
  }

  // Test-runner failure → builder chat. The LLM gets the full snapshot +
  // failed-node detail + error so it can propose a workflow-spec patch; the
  // visible bubble only shows a short Korean summary so the chat stays
  // readable.
  useImperativeHandle(ref, () => ({
    requestFixForFailedNode: ({ workflow, nodeId, nodeTitle, nodeDetail, error: errMsg }) => {
      const snapshotJson = JSON.stringify(toSnapshotForLlm(workflow), null, 2)
      const failedNode = workflow.nodes.find(n => n.id === nodeId)
      const failedNodeJson = failedNode ? JSON.stringify(failedNode, null, 2) : '(node not found in workflow)'
      // Timeout = the node ran one agent turn past the ~9-min ceiling. The fix
      // is almost never "make it faster" — it's to SPLIT the node into smaller
      // batched nodes so each finishes well under the budget. Tell the builder
      // that explicitly (see WORKFLOW_SOUL "Node time budget").
      const looksLikeTimeout = /timeout|timed out|turn_timeout/i.test(errMsg)
      const timeoutGuidance = looksLikeTimeout
        ? [
            '',
            '## This is a TIMEOUT',
            'The node ran a single agent turn past the ~9-minute limit — almost',
            'always because it loops over many items (N pages/profiles/rows) in',
            'one turn. Do NOT just raise a limit. SPLIT this node into batched',
            'nodes so each processes a bounded slice (~10–15 chrome page visits',
            'per node) and finishes in a few minutes, then a final node merges',
            'the batches. Preserve the original inputScope/outputScope shape',
            'across the batch nodes.',
          ].join('\n')
        : ''
      const llmPayload = [
        '[Workflow test failed — please diagnose and propose a fix]',
        '',
        '## Current workflow',
        '```json',
        snapshotJson,
        '```',
        '',
        '## Failed node',
        `Title: ${nodeTitle}`,
        nodeDetail ? `Detail: ${nodeDetail}` : '',
        '',
        '```json',
        failedNodeJson,
        '```',
        '',
        '## Error',
        '```',
        errMsg,
        '```',
        timeoutGuidance,
        '',
        'Diagnose the root cause in 1–2 short sentences, then return an updated `workflow-spec` JSON block that fixes it. Keep all unrelated nodes/inputs identical so the user can Approve the patch with confidence.',
      ].filter(Boolean).join('\n')

      const display = [
        `❌ Node "${nodeTitle}" failed.`,
        '',
        '**Error:**',
        '```',
        errMsg.length > 600 ? errMsg.slice(0, 600) + '…' : errMsg,
        '```',
        '',
        'Asking the builder for a fix…',
      ].join('\n')

      void sendMessage(llmPayload, display)
    },

    requestAutoReview: ({ workflow, runSummary, totals }) => {
      const snapshotJson = JSON.stringify(toSnapshotForLlm(workflow), null, 2)
      const lines = runSummary.map(r => {
        const cost = typeof r.costUsd === 'number' ? `$${r.costUsd.toFixed(4)}` : '—'
        const dur  = typeof r.durationMs === 'number' ? `${r.durationMs}ms` : '—'
        const tok  = (r.tokensIn ?? 0) + '/' + (r.tokensOut ?? 0)
        const tool = r.tool ? ` [${r.tool}${r.toolSkills?.length ? '/' + r.toolSkills.join(',') : ''}]` : ''
        const out  = r.output ? `\n  output: ${clip(r.output, 600)}` : ''
        const slice = r.autoSlice
          ? `\n  ⚠ RUNTIME-SLICED: this node hit the node time limit ${r.autoSlice.attempts}×`
            + ` and only completed after being cut down to ${r.autoSlice.portion} of its scope.`
          : ''
        return `${r.order}. ${r.title}${tool} (${r.type}) — ${r.status} · ${dur} · ${cost} · ${tok} tok${slice}${out}`
      }).join('\n')

      const llmPayload = [
        '[Workflow test SUCCEEDED — please review for wasted or redundant steps]',
        '',
        '## Current workflow',
        '```json',
        snapshotJson,
        '```',
        '',
        '## Run summary',
        `Totals: ${formatDurationMSM(totals.ms ?? 0)} · $${(totals.usd ?? 0).toFixed(4)} · ${totals.tokensIn ?? 0}/${totals.tokensOut ?? 0} tokens`,
        '',
        lines,
        '',
        '## Your job',
        'If any node above is marked RUNTIME-SLICED, fix that FIRST: it only finished',
        'because the runner cut its scope down mid-run, so the spec as written does not',
        'fit the time budget and the run is not reproducible. Prefer removing the volume',
        '(a tool that handles the whole set in one node) over adding batch nodes; split',
        'into bounded batches only if per-item work is genuinely unavoidable. Size the',
        'batches from the portion that actually completed.',
        '',
        'Otherwise look for things like:',
        '- Nodes whose output was empty, trivial, or duplicated by a later node',
        '- Tool/toolSkill choices that were overkill (e.g. chrome when web-fetch would work)',
        '- Sequential nodes that could collapse into one without losing observability',
        '- Missing `outputScope` declarations that left the LLM guessing',
        '- L7 `detail` checklists that drove unnecessary tool calls',
        '',
        '## Human Review nodes',
        'This run just completed successfully, so the optional "Human Review" pause nodes',
        'have served their purpose — they only exist to let the user check output while',
        'they are still making sure the workflow works. In your reply, briefly tell the',
        'user, in plain non-technical language (no jargon like "QA"), that since the',
        'workflow ran all the way through cleanly, they can now safely REMOVE the Human',
        'Review steps (× on the card) so it runs on its own next time — unless they still',
        'want to check each step by hand. Do NOT delete them yourself; just suggest it.',
        '',
        'If you find genuine improvements, return ONE updated `workflow-spec` block with the smallest possible change set (keep unrelated nodes/IDs identical so the user can Approve with confidence). If the run already looks clean, reply with one short sentence saying so (and the Human Review note above) and DO NOT return a spec block.',
      ].join('\n')

      // display 는 사용자가 보는 문자열이라 markup 적용. 위 llmPayload 의
      // 비용 수치는 모델의 비용 분석 입력이므로 raw 원가 그대로 둔다.
      void (async () => {
        const cost = await formatDisplayUsd(totals.usd ?? 0)
        const display = [
          '🔍 Test succeeded — auto-reviewing the run log…',
          '',
          `Totals: ${formatDurationMSM(totals.ms ?? 0)} · ${cost}`,
          '',
          'Asking the builder to check for wasted or redundant steps. If anything stands out, I\'ll propose a fix.',
        ].join('\n')

        void sendMessage(llmPayload, display)
      })()
    },
  }), [sendMessage])

  const placeholderHint = useMemo(() => {
    if (activeWorkflow) {
      return `Ask the builder to refine "${activeWorkflow.title}"…`
    }
    return 'Describe the workflow you want to build…'
  }, [activeWorkflow])

  return (
    <section style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
    }}>
      <header style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            flex: 1,
          }}>
            Workflow Builder
          </span>
          {messages.length > 0 && (
            <button
              onClick={resetChat}
              title="Reset chat"
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 10,
                padding: 0,
              }}
            >
              ↺
            </button>
          )}
        </div>
        {/* 캔버스와 채팅이 같은 워크플로를 가리키는지 사용자가 한눈에 알도록.
            워크플로 전환 시 채팅이 자동 리셋되므로 항상 정렬된 상태. */}
        <div style={{
          fontSize: 10,
          color: activeWorkflow ? 'var(--accent)' : 'var(--text-muted)',
          fontFamily: activeWorkflow ? 'var(--font-mono)' : 'var(--font-sans)',
          fontStyle: activeWorkflow ? 'normal' : 'italic',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activeWorkflow
            ? `Editing: ${activeWorkflow.title}`
            : 'No workflow selected — your next draft will be created as new'}
        </div>
      </header>

      <div ref={scrollRef} style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        {messages.length === 0 && !isThinking && (
          <div style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
          }}>
            What do you want to build?
            <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Describe the workflow in one or two sentences. I'll draft it
              first, then ask about anything that's still ambiguous.
            </span>
          </div>
        )}

        {messages.map(m => (
          <MessageBubble
            key={m.id}
            role={m.role}
            content={m.content}
            activeWorkflow={activeWorkflow}
            onSaveSpec={onSaveSpec}
            onUpdateActive={onUpdateActive}
            onUndo={onUndo}
          />
        ))}

        {isThinking && (
          <div style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            Thinking…
          </div>
        )}

        {error && (
          <div style={{
            fontSize: 11,
            color: 'var(--red)',
            padding: '4px 6px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(248, 113, 113, 0.08)',
          }}>
            {error}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Korean/CJK IME: while a character is still composing, Enter
            // must NOT submit — it's ending the composition, not sending.
            // Otherwise the last jamo/pinyin stays behind in the input.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void onSubmit(e as unknown as React.FormEvent)
            }
          }}
          placeholder={placeholderHint}
          rows={3}
          style={{
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 8px',
            fontFamily: 'var(--font-sans)',
            fontSize: 12,
            resize: 'none',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || isThinking}
          style={{
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            padding: '5px 10px',
            cursor: !draft.trim() || isThinking ? 'not-allowed' : 'pointer',
            opacity: !draft.trim() || isThinking ? 0.5 : 1,
            alignSelf: 'flex-end',
          }}
        >
          Send
        </button>
      </form>
    </section>
  )
})

function MessageBubble({ role, content, activeWorkflow, onSaveSpec, onUpdateActive, onUndo }: {
  role: 'user' | 'assistant' | 'system'
  content: string
  activeWorkflow:  TwixyWorkflow | null
  onSaveSpec?:     (spec: ParsedWorkflowSpec) => Promise<TwixyWorkflow | null>
  onUpdateActive?: (spec: ParsedWorkflowSpec) => Promise<{ workflow: TwixyWorkflow; snapshot: TwixyWorkflow } | null>
  onUndo?:         (snapshot: TwixyWorkflow) => Promise<TwixyWorkflow | null>
}) {
  const isUser = role === 'user'
  const baseStyle: React.CSSProperties = {
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    maxWidth: '92%',
    background: isUser ? 'var(--accent-dim)' : 'var(--bg-elevated)',
    color: isUser ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    padding: '6px 9px',
    fontSize: 12,
    lineHeight: 1.5,
    wordBreak: 'break-word',
    userSelect: 'text' as const,
  }
  // 어시스턴트 응답에서 workflow-spec 블록 탐지 — 있으면 그 메시지 아래에 인라인
  // "Create from this spec" 액션 패널을 붙여 클릭 한 번으로 워크플로 생성.
  const spec = !isUser ? parseWorkflowSpecFromText(content) : null

  if (!isUser) {
    // spec 이 있으면 prose 만 마크다운으로 렌더하고 raw JSON 블록은 숨김 — 그
    // 자리는 NodePreview 가 실제 캔버스와 같은 모양으로 채운다.
    const prose = spec ? stripWorkflowSpecBlock(content) : content
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'flex-start', maxWidth: '92%' }}>
        {prose.trim() && (
          <div
            className="md-render"
            style={{ ...baseStyle, alignSelf: 'stretch', maxWidth: '100%' }}
            dangerouslySetInnerHTML={{
              __html: safeHtml(marked(prose, { breaks: true, gfm: true })),
            }}
          />
        )}
        {spec && spec.nodes.length > 0 && (
          <SpecNodePreview spec={spec} />
        )}
        {spec && (onSaveSpec || onUpdateActive) && (
          <SaveSpecPanel
            spec={spec}
            activeWorkflow={activeWorkflow}
            onCreate={onSaveSpec}
            onUpdateActive={onUpdateActive}
            onUndo={onUndo}
          />
        )}
      </div>
    )
  }
  return (
    <div style={{ ...baseStyle, whiteSpace: 'pre-wrap' }}>
      {content}
    </div>
  )
}

// ── 채팅 인라인 노드 프리뷰 (compact) ──────────────────────────────────────
// 320px 폭 채팅에 맞춰 캔버스 카드보다 훨씬 축소된 행 단위 프리뷰. 한 줄에
// shape + 순번 + tag + 제목 + (선택) tool 칩만. detail/L7/scope 같은 무거운
// 정보는 캔버스 카드에서 확인 — 채팅에선 "어떤 노드가 어떤 순서로 있는지" 만
// 빠르게 보여 Update 결정 돕는 게 목적.
const COMPACT_ACCENT: Record<'action' | 'review' | 'validation', string> = {
  action:     'var(--accent)',
  review:     '#f59e0b',
  validation: '#10b981',
}
function SpecNodePreview({ spec }: { spec: ParsedWorkflowSpec }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      padding: 6,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
    }}>
      {spec.nodes.map((n, i) => (
        <CompactNodeRow key={n.id ?? `preview-${i}`} node={n} order={i + 1} />
      ))}
    </div>
  )
}

function CompactNodeRow({ node, order }: {
  node:  ParsedWorkflowSpec['nodes'][number]
  order: number
}) {
  const accent  = COMPACT_ACCENT[node.type]
  const tagText = nodeTagFor({ type: node.type, tool: node.tool, toolSkills: node.toolSkills } as TwixyWorkflowNode)
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 4px',
      minWidth: 0,
    }}>
      <CompactShape type={node.type} order={order} accent={accent} />
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        padding: '0 5px',
        borderRadius: 3,
        background: `${accent}22`,
        color: accent,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        {tagText}
      </span>
      <span style={{
        fontSize: 11,
        color: 'var(--text-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        flex: 1,
      }}>
        {node.title}
      </span>
    </div>
  )
}

function CompactShape({ type, order, accent }: {
  type:   'action' | 'review' | 'validation'
  order:  number
  accent: string
}) {
  const size = 18
  return (
    <span style={{
      position: 'relative',
      width: size,
      height: size,
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0 }}>
        {type === 'action' && (
          <circle cx={size / 2} cy={size / 2} r={size / 2 - 1.5} fill="none" stroke={accent} strokeWidth={1.2} />
        )}
        {type === 'review' && (
          <polygon points={`${size / 2},1.5 ${size - 1.5},${size - 1.5} 1.5,${size - 1.5}`}
            fill="none" stroke={accent} strokeWidth={1.2} />
        )}
        {type === 'validation' && (
          <rect x={2} y={2} width={size - 4} height={size - 4} fill="none" stroke={accent} strokeWidth={1.2} rx={1.5} />
        )}
      </svg>
      <span style={{
        position: 'relative',
        fontSize: 9,
        fontWeight: 600,
        color: accent,
        marginTop: type === 'review' ? 3 : 0,
        lineHeight: 1,
      }}>
        {order}
      </span>
    </span>
  )
}

// ── workflow-spec 액션 패널 — 채팅 안에서 캔버스로 직행 ────────────────────
// 활성 워크플로가 있으면 디폴트는 "Update active". 새 워크플로로 만들고 싶을 땐
// "+ New" 보조 버튼. Update 성공 시 직전 스냅샷을 보관해 ↺ Undo 가능.
function SaveSpecPanel({ spec, activeWorkflow, onCreate, onUpdateActive, onUndo }: {
  spec:            ParsedWorkflowSpec
  activeWorkflow:  TwixyWorkflow | null
  onCreate?:       (spec: ParsedWorkflowSpec) => Promise<TwixyWorkflow | null>
  onUpdateActive?: (spec: ParsedWorkflowSpec) => Promise<{ workflow: TwixyWorkflow; snapshot: TwixyWorkflow } | null>
  onUndo?:         (snapshot: TwixyWorkflow) => Promise<TwixyWorkflow | null>
}) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved-update' | 'saved-create' | 'undone' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<TwixyWorkflow | null>(null)

  const canUpdate = !!(activeWorkflow && onUpdateActive)
  const canCreate = !!onCreate

  const doUpdate = async () => {
    if (!canUpdate || !onUpdateActive) return
    setStatus('saving')
    setErrorMsg(null)
    try {
      const result = await onUpdateActive(spec)
      if (result) {
        setSnapshot(result.snapshot)
        setStatus('saved-update')
      } else {
        setStatus('error')
        setErrorMsg('Update returned null')
      }
    } catch (e) {
      setStatus('error')
      setErrorMsg((e as Error)?.message ?? 'unknown error')
    }
  }

  const doCreate = async () => {
    if (!canCreate || !onCreate) return
    setStatus('saving')
    setErrorMsg(null)
    try {
      const wf = await onCreate(spec)
      if (wf) {
        setStatus('saved-create')
      } else {
        setStatus('error')
        setErrorMsg('Create returned null')
      }
    } catch (e) {
      setStatus('error')
      setErrorMsg((e as Error)?.message ?? 'unknown error')
    }
  }

  const doUndo = async () => {
    if (!snapshot || !onUndo) return
    setStatus('saving')
    try {
      const wf = await onUndo(snapshot)
      if (wf) {
        setStatus('undone')
        setSnapshot(null)
      } else {
        setStatus('error')
        setErrorMsg('Undo returned null')
      }
    } catch (e) {
      setStatus('error')
      setErrorMsg((e as Error)?.message ?? 'unknown error')
    }
  }

  const subtitle = `"${spec.title}" · ${spec.nodes.length} node${spec.nodes.length === 1 ? '' : 's'}` +
    (spec.inputs.length > 0 ? ` · ${spec.inputs.length} input${spec.inputs.length === 1 ? '' : 's'}` : '')

  return (
    <div style={{
      padding: '8px 10px',
      background: 'rgba(124,106,255,0.10)',
      border: '1px solid var(--accent-dim)',
      borderRadius: 'var(--radius-sm)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 2 }}>
            ⊕ Workflow draft detected
          </div>
          <div style={{
            color: 'var(--text-muted)',
            fontSize: 10,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {subtitle}
          </div>
          {canUpdate && status === 'idle' && (
            <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 3 }}>
              Default: overwrite <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>"{activeWorkflow.title}"</span>
            </div>
          )}
          {status === 'error' && errorMsg && (
            <div style={{ color: 'var(--red)', fontSize: 10, marginTop: 3 }}>
              {errorMsg}
            </div>
          )}
        </div>

        {/* 액션 버튼들 — 상태에 따라 표시 분기 */}
        {status === 'saved-update' && (
          <button
            onClick={doUndo}
            title={`Revert "${activeWorkflow!.title}" to its previous state`}
            style={{
              background: 'transparent',
              border: '1px solid #f59e0b',
              color: '#fbbf24',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            ↺ Undo
          </button>
        )}
        {(status === 'idle' || status === 'error') && canUpdate && (
          <button
            onClick={doUpdate}
            style={primaryBtnStyle()}
          >
            ✎ Update
          </button>
        )}
        {(status === 'idle' || status === 'error') && canCreate && (
          <button
            onClick={doCreate}
            title="Create as a brand new workflow instead of updating"
            style={canUpdate ? secondaryBtnStyle() : primaryBtnStyle()}
          >
            ⊕ {canUpdate ? 'New' : 'Create'}
          </button>
        )}
        {(status === 'saved-update' || status === 'saved-create' || status === 'undone' || status === 'saving') && (
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: status === 'undone' ? '#fbbf24' : status === 'saving' ? 'var(--text-muted)' : '#10b981',
            whiteSpace: 'nowrap',
            padding: '4px 8px',
          }}>
            {status === 'saving'      ? 'Saving…'
             : status === 'saved-update' ? '✓ Updated'
             : status === 'saved-create' ? '✓ Created'
             : '↺ Reverted'}
          </span>
        )}
      </div>
    </div>
  )
}

function primaryBtnStyle(): React.CSSProperties {
  return {
    background: 'var(--accent)',
    border: 'none',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}
function secondaryBtnStyle(): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}
