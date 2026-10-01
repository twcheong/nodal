// ─────────────────────────────────────────────────────────────────────────────
// WorkflowNodeCard.tsx — 노드 1개 시각화.
//
// 헤더(접힌 상태):
//   [shape with order]  [Tool tag]  ───── one-line description
//                                                         (펼침 아이콘)
//
// 펼친 상태:
//   ↑ 헤더 그대로
//   ─ Detail
//   ─ Tool Skills (칩들)
//   ─ L7 subtasks (번호 리스트)
//   ─ Input scope (테이블)
//   ─ Output scope (테이블)
//
// 노드 모양 (PDF 0613):
//   - Action     = ⭕ circle  (Tool 태그 표시)
//   - Review     = 🔺 triangle ([Human Review])
//   - Validation = ⬛ square   ([Validation])
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { FileText, MoreHorizontal } from 'lucide-react'
import { marked } from 'marked'
import { safeHtml } from '../../lib/safeHtml'
import { findTool, findSkill, nodeShapeFor, nodeTagFor } from '../../lib/workflowTools'
import { DisplayCost } from '../../lib/useDisplayUsd'
import type { NodeRunMetrics, ReviewAction } from '../../hooks/useWorkflowTest'

interface Props {
  node:     TwixyWorkflowNode
  order:    number
  isLast:   boolean
  expanded: boolean
  onToggle: () => void
  runMetrics?: NodeRunMetrics
  onReviewDecision?: (nodeId: string, action: ReviewAction, comment?: string) => void
  // 직전 노드의 LLM 응답 — 이 노드가 review 라면 사람이 검토할 내용.
  previousOutput?:     string
  previousNodeTitle?:  string
  // (옵션) 마지막 run 기반으로 이 노드부터 재실행 — 앞 노드 결과는 보존/재사용.
  onRunFromHere?: () => void
  // (옵션) 이 노드 아래 화살표의 (+) — 이 노드 다음에 Human Review 삽입.
  onInsertReviewAfter?: () => void
  // (옵션) 이 노드 삭제 — NodeCanvas 가 review 노드에만 내려준다 ((+)로 쉽게
  // 넣은 만큼 쉽게 뺄 수 있게).
  onDelete?: () => void
}

const SHAPE_SIZE = 36
const ACCENT_BY_TYPE: Record<WorkflowNodeType, string> = {
  action:     'var(--accent)',
  review:     '#f59e0b',  // amber — 사람 개입
  validation: '#10b981',  // emerald — 검증
}

export function WorkflowNodeCard({
  node, order, isLast, expanded, onToggle, runMetrics, onReviewDecision,
  previousOutput, previousNodeTitle, onRunFromHere, onInsertReviewAfter, onDelete,
}: Props) {
  const shape   = nodeShapeFor(node.type)
  const tagText = nodeTagFor(node)
  const accent  = ACCENT_BY_TYPE[node.type]

  const statusBorder = runMetrics?.status === 'running' ? '#3b82f6'
                    : runMetrics?.status === 'awaiting-review' ? '#f59e0b'
                    : runMetrics?.status === 'done'    ? '#10b981'
                    : runMetrics?.status === 'failed'  ? 'var(--red)'
                    : runMetrics?.status === 'skipped' ? 'var(--text-muted)'
                    : runMetrics?.status === 'aborted' ? '#f59e0b'
                    : null
  const awaitingReview = runMetrics?.status === 'awaiting-review'
  return (
    <div>
      <article
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 12,
          background: 'var(--bg-elevated)',
          border: `1px solid ${statusBorder ?? (expanded ? accent : 'var(--border)')}`,
          borderRadius: 'var(--radius-md)',
          padding: 12,
          cursor: 'pointer',
          maxWidth: 860,
          transition: 'border-color 0.15s',
        }}
      >
        {/* Left rail — shape + order */}
        <NodeShape shape={shape} order={order} accent={accent} />

        {/* Body */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '1px 7px',
              borderRadius: 'var(--radius-sm)',
              background: `${accent}22`,
              color: accent,
              fontWeight: 600,
            }}>
              [{tagText}]
            </span>
            <span style={{
              fontSize: 13,
              color: 'var(--text-primary)',
              fontWeight: 500,
            }}>
              {node.title}
            </span>
            {runMetrics && <RunBadges metrics={runMetrics} />}
            {/* write 또는 data 노드가 done 이면 산출물 파일을 시스템 기본 앱으로
                여는 버튼. data/query 노드도 xlsx/csv 를 최종 산출물로 쓰므로 포함.
                output 텍스트에서 알려진 확장자 (pdf/xlsx/pptx/md/csv/json/html/docx)
                의 path 를 추출해 거기로 OpenFile IPC 호출. 추출 실패 시 버튼 X —
                data/collect 처럼 파일 경로가 없는 노드는 자동으로 안 뜬다. */}
            {(node.tool === 'write' || node.tool === 'data') && runMetrics?.status === 'done' && (
              <WriteOutputOpenButton outputText={runMetrics.output ?? ''} node={node} />
            )}
            {/* 이 노드부터 재실행 — 마지막 run 이 있고 실행 중이 아닐 때만 주입됨 */}
            {onRunFromHere && (
              <button
                onClick={e => { e.stopPropagation(); onRunFromHere() }}
                title="Re-run from this node — earlier nodes' results are kept and replayed as context"
                style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)', lineHeight: 1.4,
                  padding: '1px 7px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}
              >⟲ from here</button>
            )}
            {/* 우상단 컨트롤 그룹 — 삭제(×, review 노드에만)와 펼치기(▸/▾)를
                함께 오른쪽 끝에 모은다. */}
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {/* 노드 삭제 — review 노드에만 내려온다. (+)만큼 가볍게 제거. */}
              {onDelete && (
                <button
                  onClick={e => { e.stopPropagation(); onDelete() }}
                  title="Remove this Human Review step"
                  style={{
                    width: 18, height: 18, padding: 0, lineHeight: 1, fontSize: 12,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-muted)', background: 'transparent',
                    border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer', flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = '#f87171' }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
                >×</button>
              )}
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {expanded ? '▾' : '▸'}
              </span>
            </span>
          </header>

          {!expanded && node.detail && (
            // review 노드는 "부가 안내(fine print)" 성격이라 더 작고 은은하게 —
            // 매번 읽을 정보는 아니고 모르는 사람을 위한 것. 2줄까지 허용.
            <p style={node.type === 'review' ? {
              fontSize: 10.5,
              color: 'var(--text-muted)',
              opacity: 0.75,
              fontStyle: 'italic',
              lineHeight: 1.4,
              margin: 0,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            } : {
              fontSize: 12,
              color: 'var(--text-muted)',
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 1,
              WebkitBoxOrient: 'vertical',
            }}>
              {node.detail}
            </p>
          )}

          {expanded && <ExpandedBody node={node} />}

          {awaitingReview && onReviewDecision && (
            <ReviewControls
              nodeTitle={node.title}
              previousOutput={previousOutput}
              previousNodeTitle={previousNodeTitle}
              onDecision={(action, comment) => onReviewDecision(node.id, action, comment)}
            />
          )}

          {/* 실패/중단 이유를 카드에 직접 노출 — 호버 title 만으론 진단이 어려워 추가. */}
          {runMetrics && (runMetrics.status === 'failed' || runMetrics.status === 'aborted') && runMetrics.reason && (
            <FailureReason status={runMetrics.status} reason={runMetrics.reason} />
          )}
        </div>
      </article>

      {!isLast && (
        <ArrowWithInsert onInsert={onInsertReviewAfter} />
      )}
    </div>
  )
}

// ── 노드 사이 화살표 — hover 시 (+) 로 바뀌고, 클릭하면 그 위치에 Human
// Review 노드를 삽입한다. onInsert 미지정(실행 중 등)이면 평범한 ↓.
function ArrowWithInsert({ onInsert }: { onInsert?: () => void }) {
  const [hover, setHover] = useState(false)
  const showPlus = !!onInsert && hover
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '4px 0',
        color: 'var(--text-muted)',
        fontSize: 18,
        minHeight: 30,
        maxWidth: 860,
      }}
    >
      {showPlus ? (
        <button
          onClick={onInsert}
          title="Insert a Human Review step here"
          style={{
            width: 22, height: 22, padding: 0, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 600,
            color: 'var(--text-muted)', background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)', borderRadius: '50%', cursor: 'pointer',
          }}
        >＋</button>
      ) : (
        <span>↓</span>
      )}
    </div>
  )
}

// ── Write 노드의 산출물 Open 버튼 ─────────────────────────────────────────
// write 노드가 성공적으로 끝나면 산출물 파일 path 를 찾아 시스템 기본 앱으로
// open. path 소스는 (1) LLM 최종 output 텍스트, (2) 실패 시 노드 spec
// (detail + subtasks) — 요즘 SOUL 은 write 노드 detail 에 `data/reports/<file>`
// 를 적게 하므로 LLM 이 최종 응답에서 경로를 안 적어도 spec 에서 복구된다.
// 둘 다 실패하면 렌더 X (조용히 사라짐).
//
// 확장자 우선순위. "마지막 매치 = 최종 산출물" 가정이 사이드카에서 깨진다 —
// AI 가 산출물(.pdf) 뒤에 노드 메타데이터(.json)까지 적으면 json 이 뽑혔다.
// 사람이 열어볼 문서를 가장 높게, 기계용 덤프(json)를 가장 낮게 둔다.
const WRITE_EXT_RANK: Record<string, number> = {
  pdf: 3, xlsx: 3, pptx: 3, docx: 3,   // 최종 산출물
  html: 2, csv: 2, md: 2,              // 읽을 수 있는 중간물
  json: 1,                             // 보통 메타데이터/사이드카
}
const KNOWN_EXT_RE = /\.(pdf|md|json|csv|xlsx|pptx|html|docx)$/i

// 폴더 기반 가감점 — 산출물 폴더(data/reports/)가 원본 폴더(data/raw/)를 확장자와
// 무관하게 항상 이긴다. merge 류 노드(입력 .xlsx 여러 개 → 출력 .xlsx 하나)의
// 출력 텍스트가 산출물 뒤에 소스 경로를 요약하면, 동순위 last-wins 가 입력
// 파일을 칩으로 뽑던 버그(실측: sibling_accounts_merged 대신 입력 xlsx 노출).
function writePathDirRank(tok: string): number {
  if (/(^|\/)data\/reports\//i.test(tok)) return 100
  if (/(^|\/)data\/raw\//i.test(tok))     return -100
  return 0
}

// output 텍스트에서 최종 산출물 경로를 뽑는다.
//
// 이전 구현은 공백을 허용하는 하나의 정규식으로 매치했는데, 두 경로가 산문으로
// 이어지면("…json. Write to …xlsx") 중간 마침표가 경계를 깨 두 경로를 한 덩어리로
// 삼켰다 — open 에 "…json. Write to …xlsx" 가 통째로 넘어가 file-not-found (실측).
//
// 대신 공백/따옴표로 토큰을 쪼갠 뒤, 알려진 확장자로 끝나는 "경로처럼 생긴"
// 토큰만 후보로 삼아 랭크로 고른다. 이 앱의 산출물은 전부 workspace 상대
// (data/reports/… — 공백 없음)라 토큰 단위 분리가 안전하다.
function extractWritePath(text: string): string | null {
  let best: string | null = null
  // -Infinity: data/raw/ 감점(-100)을 먹은 후보만 있어도 칩은 유지된다 —
  // 감점은 "reports 가 있으면 raw 를 지운다" 는 우선순위지, raw 배제가 아니다.
  let bestRank = -Infinity
  for (const rawTok of text.split(/[\s`'"()[\]]+/)) {
    // 문장부호로 끝나는 경우(…xlsx. / …xlsx,) 확장자 판정 전에 떼어낸다.
    const tok = rawTok.replace(/[.,;:!?]+$/, '')
    const m = KNOWN_EXT_RE.exec(tok)
    if (!m) continue
    // 경로처럼 생겼는지 — `/` 를 품거나(data/reports/x, /Users/…) 최소한 파일명.
    // 순수 확장자만("xlsx")이나 프로즈 조각은 걸러진다.
    if (!tok.includes('/') && !/^[\w.-]+\.[a-z]+$/i.test(tok)) continue
    const rank = (WRITE_EXT_RANK[m[1].toLowerCase()] ?? 0) + writePathDirRank(tok)
    if (rank >= bestRank) { bestRank = rank; best = tok }
  }
  return best
}

function WriteOutputOpenButton({ outputText, node }: { outputText: string; node: TwixyWorkflowNode }) {
  // 1순위: LLM 이 실제로 쓴 경로(최종 output). 2순위: 노드 spec 의 의도된 경로.
  const specText = [node.detail ?? '', ...(node.subtasks ?? []).map(s => `${s.title ?? ''} ${s.purpose ?? ''}`)].join(' ')
  const filePath = extractWritePath(outputText) ?? extractWritePath(specText)
  // 옵션 메뉴 위치 (null = 닫힘). "..." 버튼 또는 우클릭으로 연다.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (!filePath) return null
  const fileName = filePath.split('/').pop() ?? filePath

  // OS 별 "탐색기에서 보기" 라벨.
  const revealLabel = window.twixy?.platform === 'win32' ? 'Show in Explorer'
    : window.twixy?.platform === 'darwin' ? 'Reveal in Finder'
    : 'Show in file manager'

  const openFile = async () => {
    const r = await window.twixy?.openFile?.(filePath)
    if (r && !r.ok) alert(`Could not open file: ${r.error ?? 'unknown error'}\n\nPath: ${filePath}`)
  }
  const reveal = async () => {
    const ok = await window.twixy?.revealInFinder?.(filePath)
    if (ok === false) alert(`Could not reveal file.\n\nPath: ${filePath}`)
  }
  // .md 산출물 → 같은 폴더에 <basename>.pdf 로 굽고 바로 연다. 워크플로가
  // 마크다운으로 끝났을 때 공유용 PDF 를 손으로 만들지 않아도 되게.
  const saveAsPdf = async () => {
    const md = await window.twixy?.readFile?.(filePath)
    if (!md) { alert(`Could not read file.\n\nPath: ${filePath}`); return }
    const html = marked(md) as string
    let r = await window.twixy?.exportPdfBeside?.({ html, srcPath: filePath })
    if (r?.exists) {
      const name = (r.path ?? '').split('/').pop()
      if (!window.confirm(`"${name}" already exists. Overwrite it?`)) return
      r = await window.twixy?.exportPdfBeside?.({ html, srcPath: filePath, overwrite: true })
    }
    if (!r?.ok || !r.path) { alert(`PDF export failed: ${r?.error ?? 'unknown error'}`); return }
    const opened = await window.twixy?.openFile?.(r.path)
    if (opened && !opened.ok) alert(`Saved, but could not open it: ${opened.error ?? 'unknown error'}\n\nPath: ${r.path}`)
  }
  const isMarkdown = /\.md$/i.test(filePath)
  // "..." 버튼: 그 버튼 바로 아래에 메뉴를 띄운다. 우클릭: 커서 위치에.
  const openMenuAt = (e: React.MouseEvent, atCursor: boolean) => {
    e.preventDefault(); e.stopPropagation()
    if (atCursor) { setMenu({ x: e.clientX, y: e.clientY }); return }
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4 })
  }

  return (
    <>
      {/* 파일명(클릭=열기) + "..." (클릭=옵션 메뉴). 우클릭도 메뉴를 연다. */}
      <span
        onContextMenu={(e) => openMenuAt(e, true)}
        style={{
          display: 'inline-flex', alignItems: 'center', maxWidth: 230,
          fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent)',
          background: 'transparent', border: '1px solid var(--accent-dim)', borderRadius: 'var(--radius-sm)',
        }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); void openFile() }}
          title={`Open ${filePath}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
            padding: '2px 6px 2px 8px', border: 'none', background: 'transparent',
            color: 'inherit', font: 'inherit', cursor: 'pointer',
          }}
        >
          <FileText size={11} strokeWidth={1.6} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
        </button>
        <button
          onClick={(e) => openMenuAt(e, false)}
          title="File options"
          style={{
            display: 'inline-flex', alignItems: 'center', flexShrink: 0,
            padding: '2px 6px', border: 'none', borderLeft: '1px solid var(--accent-dim)',
            background: 'transparent', color: 'inherit', cursor: 'pointer',
          }}
        >
          <MoreHorizontal size={12} strokeWidth={1.8} />
        </button>
      </span>
      {menu && (
        <>
          <div onClick={e => { e.stopPropagation(); setMenu(null) }} onContextMenu={e => { e.preventDefault(); setMenu(null) }}
            style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed', top: menu.y, left: menu.x, zIndex: 201,
              minWidth: 170, background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 4,
            }}
          >
            {([
              ['Open file', openFile],
              ...(isMarkdown ? [['Save as PDF & open', saveAsPdf] as [string, () => void]] : []),
              [revealLabel, reveal],
            ] as [string, () => void][]).map(([label, fn]) => (
              <button
                key={label}
                onClick={() => { setMenu(null); void fn() }}
                style={ctxRow}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// 우클릭 컨텍스트 메뉴 행 공통 스타일.
const ctxRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
  background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 10px', borderRadius: 5,
}

// ── Failure / abort reason — 진단을 위해 카드에 그대로 노출 ──────────────────
function FailureReason({ status, reason }: { status: 'failed' | 'aborted'; reason: string }) {
  const isFail = status === 'failed'
  return (
    <div style={{
      marginTop: 8,
      padding: '6px 8px',
      background: isFail ? 'rgba(248,113,113,0.10)' : '#f59e0b1a',
      border: `1px solid ${isFail ? 'rgba(248,113,113,0.4)' : '#f59e0b66'}`,
      borderRadius: 'var(--radius-sm)',
      fontSize: 11,
      lineHeight: 1.45,
      color: isFail ? 'var(--red)' : '#fbbf24',
      fontFamily: 'var(--font-mono)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      <span style={{ fontWeight: 600, marginRight: 6 }}>
        {isFail ? '✕ Failed:' : '↯ Aborted:'}
      </span>
      {reason}
    </div>
  )
}

// ── Review controls — awaiting-review 노드 인라인 결정 UI ─────────────────
// 메인 채팅 세션에서 직전 노드의 응답을 사람이 직접 읽고 판단한다.
//   Approve : 비용 0 / LLM 호출 없이 통과
//   Send note : textarea 에 적은 코멘트를 user 메시지로 채팅에 보내고 다음 노드로
//   Skip    : 이 노드만 건너뜀 (전체 abort 와 다름)
function ReviewControls({ nodeTitle, previousOutput, previousNodeTitle, onDecision }:
  {
    nodeTitle:         string
    previousOutput?:   string
    previousNodeTitle?: string
    onDecision:        (action: ReviewAction, comment?: string) => void
  }) {
  const [mode, setMode] = useState<'idle' | 'noting'>('idle')
  const [note, setNote] = useState('')
  const [outputExpanded, setOutputExpanded] = useState(true)
  // 디폴트는 rendered (사람이 읽기 쉬움). raw 토글로 마크다운 소스 확인 가능.
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered')

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        marginTop: 10,
        padding: 10,
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid #f59e0b66',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{
        fontSize: 11,
        color: '#fbbf24',
        fontWeight: 600,
      }}>
        ⏸ Awaiting your review — "{nodeTitle}"
      </div>

      {/* 직전 노드 출력을 인라인으로 보여주기 — 사람이 봐야 결정 가능 */}
      {previousOutput && (
        <div style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
        }}>
          <div
            onClick={() => setOutputExpanded(v => !v)}
            style={{
              padding: '5px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
              background: 'var(--bg-elevated)',
              borderBottom: outputExpanded ? '1px solid var(--border-subtle)' : 'none',
            }}
          >
            <span style={{
              fontSize: 9,
              color: 'var(--text-muted)',
              transform: outputExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.12s',
              display: 'inline-block',
              width: 8,
            }}>
              ▸
            </span>
            <span style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: 'var(--text-muted)',
              fontWeight: 600,
            }}>
              Input from {previousNodeTitle ? `"${previousNodeTitle}"` : 'previous node'}
            </span>
            {/* Rendered / Raw 토글 — 마크다운 보기 vs 원문 보기 */}
            <button
              onClick={(e) => { e.stopPropagation(); setViewMode(v => v === 'rendered' ? 'raw' : 'rendered') }}
              style={{
                fontSize: 9,
                background: 'transparent',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
                borderRadius: 3,
                padding: '1px 5px',
                cursor: 'pointer',
                marginLeft: 'auto',
              }}
            >
              {viewMode === 'rendered' ? 'Raw' : 'Rendered'}
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {previousOutput.length.toLocaleString()} chars
            </span>
          </div>
          {outputExpanded && (
            viewMode === 'rendered' ? (
              <div
                className="md-render"
                style={{
                  maxHeight: 360,
                  overflowY: 'auto',
                  padding: 12,
                  userSelect: 'text',
                } as React.CSSProperties}
                dangerouslySetInnerHTML={{
                  __html: safeHtml(marked(previousOutput, { breaks: true, gfm: true })),
                }}
              />
            ) : (
              <div style={{
                maxHeight: 360,
                overflowY: 'auto',
                padding: 10,
                fontSize: 11,
                lineHeight: 1.55,
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

      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {previousOutput
          ? 'Read the input above, then decide:'
          : 'Open the main chat to inspect the previous output, then decide:'}
      </div>

      {mode === 'idle' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            onClick={() => onDecision('approve')}
            style={primaryBtn('#10b981')}
          >
            ✅ Approve
          </button>
          <button
            onClick={() => setMode('noting')}
            style={primaryBtn('#3b82f6')}
          >
            ✏️ Send note
          </button>
          <button
            onClick={() => onDecision('skip')}
            style={secondaryBtn()}
          >
            ⤼ Skip
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. The summary section is too long, please condense it before continuing."
            rows={3}
            style={{
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 8px',
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setMode('idle'); setNote('') }}
              style={secondaryBtn()}
            >
              Cancel
            </button>
            <button
              disabled={!note.trim()}
              onClick={() => onDecision('note', note.trim())}
              style={{
                ...primaryBtn('#3b82f6'),
                opacity: note.trim() ? 1 : 0.5,
                cursor: note.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Send & continue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function primaryBtn(bg: string): React.CSSProperties {
  return {
    background: bg,
    border: 'none',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  }
}
function secondaryBtn(): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
  }
}

// ── Test-mode run badges ────────────────────────────────────────────────────
// 헤더 오른쪽에 status + duration + cost 칩으로 노드의 실시간 상태를 표시.
// running 상태일 땐 LiveElapsed 가 매초 갱신되는 경과 시간을 보여줘 "무한로딩"
// 인지 진짜 일하는 중인지 사용자가 구분 가능.
function RunBadges({ metrics }: { metrics: NodeRunMetrics }) {
  if (metrics.status === 'pending') return null

  const statusChip = (() => {
    switch (metrics.status) {
      case 'running':         return { label: 'Running…',     bg: '#3b82f622',            fg: '#60a5fa' }
      case 'awaiting-review': return { label: 'Awaiting you', bg: '#f59e0b22',            fg: '#fbbf24' }
      case 'done':            return { label: 'Done',         bg: '#10b98122',            fg: '#34d399' }
      case 'failed':          return { label: 'Failed',       bg: 'rgba(248,113,113,0.2)', fg: 'var(--red)' }
      case 'skipped':         return { label: 'Skipped',      bg: 'var(--bg-active)',     fg: 'var(--text-muted)' }
      case 'aborted':         return { label: 'Aborted',      bg: '#f59e0b22',            fg: '#fbbf24' }
      default:                return null
    }
  })()

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {statusChip && (
        <span title={metrics.reason ?? metrics.status} style={{
          fontSize: 10,
          padding: '1px 6px',
          borderRadius: 'var(--radius-sm)',
          background: statusChip.bg,
          color: statusChip.fg,
          fontWeight: 600,
        }}>
          {statusChip.label}
        </span>
      )}
      {metrics.status === 'running' && typeof metrics.startedAt === 'number' && (
        <LiveElapsed startedAt={metrics.startedAt} />
      )}
      {metrics.status !== 'running' && typeof metrics.durationMs === 'number' && (
        <span title="Wall-clock duration" style={metricChip}>
          ⏱ {formatDuration(metrics.durationMs)}
        </span>
      )}
      {typeof metrics.costUsd === 'number' && metrics.costUsd > 0 && (
        // DisplayCost handles markup IPC + loading/error state. Tooltip shows
        // token counts (raw, since markup doesn't affect token reporting).
        <span title={`${metrics.tokensIn ?? 0} in / ${metrics.tokensOut ?? 0} out tokens`} style={metricChip}>
          <DisplayCost rawUsd={metrics.costUsd} />
        </span>
      )}
    </span>
  )
}

// ── LiveElapsed — 노드가 running 인 동안 매초 갱신되는 경과 시간 칩 ──────────
// 완료된 노드의 duration 칩과 같은 중립 스타일. (예전의 60s/180s 색 변화는
// 긴 인라인 크롤이 정상인 현재 모델에서 오탐이 많아 제거 — 사용자 피드백.)
function LiveElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsedMs = Math.max(0, now - startedAt)
  return (
    <span title={`Running for ${formatDuration(elapsedMs)}`} style={metricChip}>
      ⏱ {formatDuration(elapsedMs)}
    </span>
  )
}

const metricChip: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
  padding: '1px 6px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-active)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-subtle)',
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}


// ── Shape with order number ─────────────────────────────────────────────────
function NodeShape({ shape, order, accent }: { shape: 'circle' | 'triangle' | 'square'; order: number; accent: string }) {
  const size = SHAPE_SIZE
  return (
    <div style={{
      width: size,
      height: size,
      flexShrink: 0,
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0 }}>
        {shape === 'circle' && (
          <circle cx={size / 2} cy={size / 2} r={size / 2 - 2}
            fill="none" stroke={accent} strokeWidth={1.5} />
        )}
        {shape === 'triangle' && (
          <polygon
            points={`${size / 2},2 ${size - 2},${size - 2} 2,${size - 2}`}
            fill="none" stroke={accent} strokeWidth={1.5}
          />
        )}
        {shape === 'square' && (
          <rect x={3} y={3} width={size - 6} height={size - 6}
            fill="none" stroke={accent} strokeWidth={1.5} rx={2} />
        )}
      </svg>
      <span style={{
        position: 'relative',
        fontSize: 12,
        fontWeight: 600,
        color: accent,
        // Triangle is bottom-heavy — nudge the number down so it sits inside.
        marginTop: shape === 'triangle' ? 6 : 0,
      }}>
        {order}
      </span>
    </div>
  )
}

// ── Expanded body: detail / tool skills / L7 / scopes ───────────────────────
function ExpandedBody({ node }: { node: TwixyWorkflowNode }) {
  const tool = findTool(node.tool)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 6 }}>
      {node.detail && (
        <Section label="Detail">
          {/* 긴 URL 등 공백 없는 문자열이 카드 밖으로 넘치지 않게 강제 줄바꿈. */}
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {node.detail}
          </p>
        </Section>
      )}

      {node.acceptance && (
        <Section label="Acceptance">
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {node.acceptance}
          </p>
        </Section>
      )}

      {tool && node.toolSkills && node.toolSkills.length > 0 && (
        <Section label="Tool skills">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {node.toolSkills.map(skillId => {
              const skill = findSkill(node.tool, skillId)
              return (
                <span key={skillId} title={skill?.description}
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    padding: '2px 7px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-active)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-subtle)',
                  }}>
                  {skill?.label ?? skillId}
                </span>
              )
            })}
          </div>
        </Section>
      )}

      {node.subtasks && node.subtasks.length > 0 && (
        <Section label="L7 subtasks">
          <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {node.subtasks.map(st => (
              <li key={st.id}>
                {st.title}
                {st.purpose && (
                  <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
                    — {st.purpose}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {node.inputScope && node.inputScope.length > 0 && (
          <div style={{ flex: 1, minWidth: 260 }}>
            <ScopeTable label="Input scope" fields={node.inputScope} />
          </div>
        )}
        {node.outputScope && node.outputScope.length > 0 && (
          <div style={{ flex: 1, minWidth: 260 }}>
            <ScopeTable label="Output scope" fields={node.outputScope} />
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: 'var(--text-muted)',
        marginBottom: 4,
      }}>{label}</div>
      {children}
    </section>
  )
}

function ScopeTable({ label, fields }: { label: string; fields: WorkflowScopeField[] }) {
  return (
    <Section label={label}>
      <table style={{
        borderCollapse: 'collapse',
        width: '100%',
        fontSize: 11,
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}>
        <thead>
          <tr>
            {['name', 'type', 'description'].map(h => (
              <th key={h} style={{
                textAlign: 'left',
                padding: '4px 8px',
                fontWeight: 600,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
                color: 'var(--text-muted)',
                background: 'var(--bg-surface)',
                borderBottom: '1px solid var(--border-subtle)',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i}>
              <td style={cellStyle('var(--text-primary)', 'var(--font-mono)')}>{f.name}</td>
              <td style={cellStyle('var(--accent)',       'var(--font-mono)')}>{f.type}</td>
              <td style={cellStyle('var(--text-secondary)')}>{f.description ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

function cellStyle(color: string, fontFamily?: string): React.CSSProperties {
  return {
    padding: '4px 8px',
    color,
    fontFamily,
    fontSize: 11,
    verticalAlign: 'top',
    borderTop: '1px solid var(--border-subtle)',
  }
}
