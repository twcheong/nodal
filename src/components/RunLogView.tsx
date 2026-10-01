// ─────────────────────────────────────────────────────────────────────────────
// RunLogView.tsx — run 실행 로그 뷰어 모달 (Epic 3).
//
// 데이터 소스: 내 run = 로컬 상세(runs/<startedAt>.json), 팀원 실패 run =
// org_workflow_runs.fail_log(클립본). 팀원 성공 run 은 상세가 러너 머신에만
// 있으므로 요약+안내만. 실패 run 은 상단에 에러 요약(분류·제안)과, 그 워크플로의
// 최신 run 인 경우 "Retry from failed node" 를 노출한다.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { marked } from 'marked'
import { safeHtml } from '../lib/safeHtml'
import { categorizeError, suggestNextAction, runDetailToCsv } from '../lib/runLogs'
import { useConfirm } from './TwixyConfirm'

interface Props {
  // 로컬 로드 파라미터 (내 run). 팀원 run 은 fallbackDetail 로 직접 주입.
  wfId:      string
  startedAt: number
  isMine:    boolean
  // 팀원 실패 run 의 fail_log 를 RunDetail 근사 형태로 변환해 넘김 (없으면 null).
  fallbackDetail?: TwixyRunDetail | null
  // Retry 노출 조건: 이 run 이 해당 워크플로의 최신 run 이고 실패했을 때.
  canRetry:  boolean
  workflow?: TwixyWorkflow
  onRetryFromNode?: (wf: TwixyWorkflow, nodeId: string) => void
  // 워크플로로 이동 (로컬에 존재하는 내 워크플로일 때만 넘겨짐).
  onOpenWorkflow?: (wfId: string) => void
  onClose:   () => void
}

export function RunLogView({ wfId, startedAt, isMine, fallbackDetail, canRetry, workflow, onRetryFromNode, onOpenWorkflow, onClose }: Props) {
  const { confirm, confirmDialog } = useConfirm()
  const [detail, setDetail] = useState<TwixyRunDetail | null>(fallbackDetail ?? null)
  const [loading, setLoading] = useState(isMine)
  const [openNode, setOpenNode] = useState<string | null>(null)

  useEffect(() => {
    if (!isMine) return
    let cancelled = false
    ;(async () => {
      try {
        const d = await window.twixy?.workflowRunDetailLoad?.(wfId, startedAt)
        if (!cancelled) setDetail(d ?? fallbackDetail ?? null)
      } catch {
        if (!cancelled) setDetail(fallbackDetail ?? null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfId, startedAt, isMine])

  const failedNode = detail?.nodes.find(n => n.status === 'failed')
  const category = failedNode ? categorizeError(failedNode.reason, failedNode.toolCalls) : null

  function download(name: string, content: string, type: string) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([content], { type }))
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
    {confirmDialog}
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 92vw)', maxHeight: '84vh', overflow: 'auto',
          background: 'var(--bg-base)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '18px 20px',
        }}
      >
        {/* 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail?.wfTitle ?? 'Run log'}
          </div>
          {workflow && onOpenWorkflow && (
            <button
              onClick={() => { onOpenWorkflow(workflow.id); onClose() }}
              style={{ ...miniBtn, color: 'var(--accent, #0d5c50)', fontWeight: 600 }}
              title="Go to this workflow"
            >
              Open workflow
            </button>
          )}
          {detail && (
            <>
              <button onClick={() => download(`run-${startedAt}.json`, JSON.stringify(detail, null, 2), 'application/json')} style={miniBtn}>
                JSON
              </button>
              <button onClick={() => download(`run-${startedAt}.csv`, runDetailToCsv(detail), 'text/csv')} style={miniBtn}>
                CSV
              </button>
            </>
          )}
          <button onClick={onClose} style={miniBtn}>✕</button>
        </div>
        {detail && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
            {detail.status.toUpperCase()} · {new Date(detail.startedAt).toLocaleString()} · {fmtDur(detail.totals.ms)}
            {detail.totals.usd > 0 ? ` · $${detail.totals.usd.toFixed(3)}` : ''}
            {` · ${(detail.totals.tokensIn + detail.totals.tokensOut).toLocaleString()} tokens`}
          </div>
        )}

        {/* 에러 요약 (3.2) */}
        {detail && failedNode && category && (
          <div style={{
            border: '1px solid var(--red)', borderRadius: 8, padding: '10px 12px',
            marginBottom: 14, fontSize: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ color: 'var(--red)', fontWeight: 700 }}>Failed at “{failedNode.title}”</span>
              <span style={{
                fontSize: 10, fontWeight: 600, color: 'var(--red)', border: '1px solid var(--red)',
                borderRadius: 20, padding: '1px 8px', textTransform: 'uppercase',
              }}>
                {category} error
              </span>
              {failedNode.endedAt && (
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(failedNode.endedAt).toLocaleTimeString()}</span>
              )}
            </div>
            <div style={{ color: 'var(--text)', marginBottom: 6, whiteSpace: 'pre-wrap' }}>{failedNode.reason ?? 'Unknown error'}</div>
            <div style={{ color: 'var(--text-muted)' }}>→ {suggestNextAction(category)}</div>
            {canRetry && workflow && onRetryFromNode && (
              <button
                onClick={() => {
                  void confirm({ title: 'Retry from failed node?', message: `Re-run "${detail?.wfTitle ?? 'this workflow'}" from the failed step?\n\nEarlier steps are kept and replayed as context.`, confirmLabel: 'Retry' })
                    .then(ok => { if (ok) { onRetryFromNode(workflow, failedNode.nodeId); onClose() } })
                }}
                style={{ ...miniBtn, marginTop: 8, color: 'var(--accent, #0d5c50)', fontWeight: 600 }}
              >
                ↻ Retry from failed node
              </button>
            )}
          </div>
        )}

        {/* 본문 */}
        {loading ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading log…</p>
        ) : !detail ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {isMine
              ? 'No detailed log found for this run (it may predate execution logging).'
              : 'Full logs live on the runner’s machine. Only failed runs share their detailed log with the team.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {detail.nodes.map((n, i) => {
              const open = openNode === n.nodeId
              const color = n.status === 'failed' ? 'var(--red)' : n.status === 'done' ? 'var(--green, #0d5c50)' : 'var(--text-muted)'
              return (
                <div key={n.nodeId} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)' }}>
                  <div
                    onClick={() => setOpenNode(open ? null : n.nodeId)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', fontSize: 12 }}
                  >
                    <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>{i + 1}.</span>
                    <span style={{ color, fontWeight: 600, minWidth: 60, textTransform: 'uppercase', fontSize: 10 }}>{n.status}</span>
                    <span style={{ color: 'var(--text)', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {n.title}
                    </span>
                    {n.tool && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{n.tool}</span>}
                    <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {typeof n.durationMs === 'number' ? fmtDur(n.durationMs) : '—'}
                      {typeof n.costUsd === 'number' && n.costUsd > 0 ? ` · $${n.costUsd.toFixed(3)}` : ''}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
                  </div>
                  {open && (
                    <div style={{ padding: '0 12px 10px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {n.reason && <LogBlock label="Reason" text={n.reason} color="var(--red)" />}
                      {(n.toolCalls ?? []).length > 0 && (
                        <div>
                          <div style={blockLabel}>Tool calls ({n.toolCalls!.length})</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {n.toolCalls!.map((t, j) => (
                              <div key={j} style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {t.name}{t.detail ? ` — ${t.detail}` : ''}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {n.prompt && <LogBlock label="Instruction sent" text={n.prompt} mono />}
                      {n.output && <LogBlock label="Output" text={n.output} markdown />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
    </>
  )
}

function LogBlock({ label, text, mono = false, markdown = false, color }: { label: string; text: string; mono?: boolean; markdown?: boolean; color?: string }) {
  const boxStyle: React.CSSProperties = {
    margin: 0, padding: '6px 8px', background: 'var(--bg-base)', borderRadius: 6,
    border: '1px solid var(--border)', maxHeight: 220, overflow: 'auto', fontSize: 10.5,
    color: color ?? 'var(--text)',
  }
  return (
    <div>
      <div style={blockLabel}>{label}</div>
      {markdown ? (
        // 로그 output 은 대개 마크다운(보고서) — 렌더해서 보여준다.
        <div
          className="md-render"
          style={{ ...boxStyle, lineHeight: 1.5, wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{ __html: safeHtml(marked(text, { breaks: true, gfm: true })) }}
        />
      ) : (
        <pre style={{
          ...boxStyle, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: mono ? 'monospace' : 'inherit',
        }}>
          {text}
        </pre>
      )}
    </div>
  )
}

const blockLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: 0.4, marginBottom: 3,
}

function fmtDur(ms: number): string {
  if (!ms || ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

const miniBtn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text)',
  borderRadius: 7,
  padding: '3px 9px',
  fontSize: 11,
  cursor: 'pointer',
}
