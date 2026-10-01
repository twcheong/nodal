// ═════════════════════════════════════════════════════════════════════════════
// ChatPanel.tsx — 메인 대화 UI 패널 (가장 큰 컴포넌트, ~1600줄).
//
// 역할:
//   1) useOpenClaw 에서 받은 messages 를 말풍선 목록으로 렌더
//   2) 사용자 입력 + 전송/중단 버튼, 퀵 액션 버튼
//   3) "생각 중" 인디케이터 + 실시간 툴 활동 표시 (toolActivity/toolStats)
//   4) 툴 호출 이력을 그룹핑해 접을 수 있는 액션 서브그룹으로 표시
//   5) 히스토리 드로어 — 이전 세션 로그 파일 읽기
//   6) 메시지 내 파일 경로 자동 링크화 → 클릭 시 onOpenFile 로 DataPanel 연결
//   7) 파일 드래그앤드롭 / 붙여넣기 → ChatPanel 내부에서 처리 후 chip 으로 전환
//
// 주요 내부 컴포넌트:
//   · MessageBubble     — 말풍선 1개 렌더 (user/assistant/system 스타일 분기)
//   · ThinkingDots      — 타이핑 인디케이터
//   · ToolActionGroup   — 툴 호출 그룹 (예: read 가 연속 3번이면 하나로 묶기)
//   · ToolSubGroup      — 같은 종류 툴 호출을 접었다 폈다
//
// 렌더러 유틸:
//   · friendlyTool      — raw tool name → 사용자용 친숙 레이블
//   · addWorkspaceLinks — 마크다운 내 워크스페이스 파일 경로 자동 링크화
//   · renderFileChips   — :open:relative/path 형식을 chip 으로 변환
// ═════════════════════════════════════════════════════════════════════════════

import React, { useRef, useEffect, useState, KeyboardEvent, useCallback } from 'react'
import type { ChatMessage, ChatMessageAction } from '../hooks/useOpenClaw'
import { toCSV, downloadCSV } from '../lib/csvExport'
import { friendlyTool } from '../lib/friendlyTool'
import { marked } from 'marked'
import { safeHtml } from '../lib/safeHtml'
import { PlanCard } from './PlanCard'
import { useFileDropZone } from '../hooks/useFileDropZone'

interface ToolStats {
  count: number
  startedAt: number | null
  lastName: string | null
  lastIsSubagent: boolean
}

interface PlanHandlers {
  onBuild:     (planId: string) => void
  onPause:     (planId: string) => void
  onResume:    (planId: string) => void
  onDelete:    (planId: string) => void
  onRevealRun: (planId: string) => void
}

interface Props {
  messages: ChatMessage[]
  isThinking: boolean
  toolActivity?: { name: string; sessionKey?: string; isSubagent: boolean; subagentLabel?: string; detail?: string; callId?: string } | null
  toolStats?: ToolStats
  onSend: (text: string) => void
  onStop?: () => void
  onNewChat?: () => void
  onOpenFile?: (relPath: string) => void
  pendingChip?: { path: string; name: string } | null
  onChipConsumed?: () => void
  projectDir?: string | null
  projectDirLoading?: boolean
  projectDirSetting?: boolean
  onPickProjectDir?: () => Promise<boolean>
  // Planning Mode — composer 토글 + PlanCard 렌더 활성화. 미지정 시 평문 채팅 동작.
  planMode?: boolean
  onTogglePlanMode?: () => void
  planHandlers?: PlanHandlers
  planGenerating?: boolean
  onMessageAction?: (action: ChatMessageAction, msgId: string) => void
  // Execution Plan import (raw JSON text). Creates a draft plan for review.
  onImportExecutionPlan?: (jsonText: string) => void
}

// friendlyTool 의 본체는 lib/friendlyTool (sidetab 창이 이 파일을 통째로 끌고 가지 않게). 아래는 기존 경로 호환용 재-export.
export { friendlyTool }

// 초기 빈 상태에서 노출되는 퀵 액션 버튼. 클릭 시 prompt 를 입력창에 자동 채움.
// 각 항목은 대표적인 사용 시나리오 1개씩을 매핑 (Scout/Strategy/Watchtower/Analytics).
const QUICK_ACTIONS = [
  { label: '📊 Collect Data', prompt: 'Collect my last 30 Instagram posts' },
  { label: '🎯 Generate Strategy', prompt: 'Create a content strategy for this week based on my collected data' },
  { label: '👁 Set Up Monitoring', prompt: 'Monitor my Instagram followers and engagement daily at 9am' },
  { label: '📈 Analytics Report', prompt: 'Analyze last week\'s campaign results and generate a report' },
]

// MessageBubble — 단일 메시지를 말풍선으로 렌더.
// role 에 따라 스타일이 갈린다: user=오른쪽 강조, assistant=좌측 기본, system=중앙 안내.
// assistant 본문은 마크다운 → HTML 변환 + 워크스페이스 파일 자동링크 적용.
function MessageBubble({
  msg, onOpenFile, onMessageAction,
}: {
  msg: ChatMessage
  onOpenFile?: (relPath: string) => void
  onMessageAction?: (action: ChatMessageAction, msgId: string) => void
}) {
  const isUser   = msg.role === 'user'
  const isSystem = msg.role === 'system'
  const [raw, setRaw]       = useState(false)
  const [copied, setCopied] = useState(false)
  const [hover, setHover]   = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // btnHover 는 system-message early-return 뒤(line ~170)에 있던 hook을
  // Rules of Hooks 준수를 위해 위로 끌어올렸다. 동일 msg.id 에서 isSystem
  // 이 바뀌는 일은 없어 런타임 #300 까진 안 났지만 ESLint
  // react-hooks/rules-of-hooks 가 정적으로 잡아주는 패턴이라 정리.
  const [btnHover, setBtnHover] = useState<string | null>(null)

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleExportMd = () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `twixy-${isUser ? 'user' : 'assistant'}-${ts}.md`
    window.twixy.exportMd(msg.content, filename)
  }

  if (isSystem) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '2px 16px' }}>
        <div
          style={{
            background:   'var(--bg-secondary)',
            border:       '1px solid color-mix(in srgb, #b07d18 30%, transparent)',
            borderRadius: 12,
            padding:      '10px 14px',
            maxWidth:     '80%',
            fontSize:     13,
            color:        'var(--text-primary)',
            lineHeight:   1.5,
          }}
        >
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: safeHtml(marked.parse(msg.content)) }}
          />
          {msg.actions && msg.actions.length > 0 && !dismissed && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {msg.actions.map(action => (
                <button
                  key={action.actionId}
                  onClick={() => {
                    setDismissed(true)
                    onMessageAction?.(action, msg.id)
                  }}
                  style={{
                    padding:      '5px 14px',
                    borderRadius: 8,
                    border:       action.primary ? 'none' : '1px solid var(--border)',
                    background:   action.primary ? 'var(--accent)' : 'transparent',
                    color:        action.primary ? '#fff' : 'var(--text-secondary)',
                    fontSize:     12,
                    fontWeight:   action.primary ? 600 : 400,
                    cursor:       'pointer',
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const actionBtn = (id: string, onClick: () => void, label: string, icon: React.ReactNode, active = false) => {
    const isHovered = btnHover === id
    return (
      <button
        key={id}
        onClick={onClick}
        style={{
          border:         'none',
          background:     isHovered ? 'var(--bg-hover)' : active ? 'var(--accent-dim)' : 'transparent',
          color:          active ? 'var(--accent)' : 'var(--text-muted)',
          height:         24,
          minWidth:       24,
          borderRadius:   5,
          cursor:         'pointer',
          display:        'flex',
          alignItems:     'center',
          gap:             4,
          padding:        isHovered ? '0 7px' : '0 6px',
          fontSize:       10,
          opacity:        hover ? 1 : 0,
          transition:     'opacity 0.1s, background 0.1s',
          flexShrink:     0,
          whiteSpace:     'nowrap',
        }}
        onMouseEnter={() => setBtnHover(id)}
        onMouseLeave={() => setBtnHover(null)}
      >
        {icon}
        {isHovered && <span style={{ fontSize: 10, lineHeight: 1 }}>{label}</span>}
      </button>
    )
  }

  return (
    <div
      style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', paddingInline: 16, paddingBlock: 4 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* action buttons — float above bubble on the right */}
      <div style={{
        display:       'flex',
        alignItems:    'center',
        gap:            2,
        alignSelf:     'flex-start',
        paddingTop:    4,
        marginLeft:    isUser ? 6 : 0,
        // for assistant bubbles keep buttons on right side of bubble row
        ...(isUser ? { marginRight: 6, order: 0 } : { marginLeft: 6, order: 1 }),
      }}>
        {actionBtn('copy', handleCopy, copied ? 'Copied!' : 'Copy',
          copied
            ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5L4.5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="4.5" y="1.5" width="6" height="7.5" rx="1" stroke="currentColor" strokeWidth="1"/><rect x="1.5" y="3.5" width="6" height="7.5" rx="1" stroke="currentColor" strokeWidth="1"/></svg>,
          copied,
        )}
        {actionBtn('export', handleExportMd, 'Export .md',
          /* ↱ icon: vertical line up from bottom, then turn right */
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 11V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M3 4h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M7 2l2 2-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>

      <div style={{
        maxWidth: '75%',
        background: isUser ? 'var(--accent-dim)' : 'var(--bg-elevated)',
        border: `1px solid ${isUser ? 'var(--accent-dim)' : 'var(--border)'}`,
        borderRadius: isUser
          ? 'var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg)'
          : 'var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--radius-sm)',
        padding: '10px 14px',
        color: isUser ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 12,
        lineHeight: 1.6,
        userSelect: 'text',
        order: isUser ? 1 : 0,
      }}>
        {raw ? (
          <pre style={{
            fontFamily: 'var(--font-mono)',
            fontSize:    12,
            color:      'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak:  'break-word',
            margin:      0,
          }}>{msg.content}</pre>
        ) : (
          <div
            className="message-content"
            dangerouslySetInnerHTML={{ __html: safeHtml(renderMessage(msg.content)) }}
            onClick={e => {
              const el = (e.target as HTMLElement).closest('[data-ws-path]') as HTMLElement | null
              if (el) {
                const relPath = el.getAttribute('data-ws-path')
                if (relPath) onOpenFile?.(relPath)
              }
              const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
              if (a?.href && !a.getAttribute('data-ws-path')) {
                e.preventDefault()
                window.twixy.openExternal(a.href)
              }
            }}
          />
        )}
        {!isUser && (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            {msg.tokens != null && (
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.5 }}>
                {msg.tokens >= 1000 ? `${(msg.tokens / 1000).toFixed(1)}K tok` : `${msg.tokens} tok`}
              </span>
            )}
            <button
              onClick={() => setRaw(r => !r)}
              title="Toggle raw markdown"
              style={{
                border:       'none',
                background:   raw ? 'var(--bg-active)' : 'transparent',
                color:        'var(--text-muted)',
                fontSize:      10,
                padding:      '1px 5px',
                borderRadius: '3px',
                cursor:       'pointer',
                fontFamily:   'var(--font-mono)',
                opacity:       0.5,
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
            >
              {raw ? 'MD' : 'Raw'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}


// 타이핑 인디케이터 — "..." 점 3개가 순차 애니메이션.
// isThinking 이 true 인 동안 assistant 말풍선 자리에 표시.
function ThinkingDots() {
  return (
    <div style={{
      paddingInline: 16,
      paddingBlock:   8,
      display:       'flex',
      alignItems:    'center',
      gap:            10,
    }}>
      <div style={{
        background:   'var(--bg-elevated)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding:      '10px 14px',
        display:      'flex',
        gap:           4,
        alignItems:   'center',
      }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{
            width:        6,
            height:       6,
            borderRadius: '50%',
            background:   'var(--accent)',
            display:      'inline-block',
            animation:    `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
    </div>
  )
}

// recent-files IPC 응답 1건. 파일 메타를 @chip 첨부 드롭다운에 표시할 때 사용.
interface RecentFile { name: string; path: string; mtime: number; dir: string }

// ── 히스토리 드로어 타입 — 과거 세션 목록/상세 ──────────────────────
// list-session-logs IPC 가 반환하는 세션 메타 (날짜, 경로, 프리뷰, 토큰 합계).
interface SessionMeta { date: string; sessionId: string; filePath: string; mtimeMs: number; preview: string; totalTokens?: number }
// read-session-log IPC 가 반환하는 개별 메시지/툴 엔트리.
interface SessionEntry { role: string; text: string; tools: string[]; timestamp: string }

// ── Tool action group — 툴 호출 이력을 카테고리별로 접어서 표시 ───────

const TOOL_GROUP_META: Record<string, { label: string; icon: string; color: string }> = {
  browser:         { label: 'Browser',      icon: '⊙', color: 'var(--accent)' },
  web_fetch:       { label: 'Web',          icon: '↗', color: 'var(--accent)' },
  web_search:      { label: 'Web search',   icon: '⌕', color: 'var(--accent)' },
  read:            { label: 'Files',        icon: '▤', color: 'var(--accent)' },
  write:           { label: 'Files',        icon: '▤', color: 'var(--accent)' },
  edit:            { label: 'Files',        icon: '▤', color: 'var(--accent)' },
  glob:            { label: 'Files',        icon: '▤', color: 'var(--accent)' },
  grep:            { label: 'Files',        icon: '▤', color: 'var(--accent)' },
  sessions_spawn:  { label: 'Sub-agent',    icon: '⇢', color: 'var(--warning)' },
  sessions_yield:  { label: 'Sub-agent',    icon: '⇢', color: 'var(--warning)' },
  memory_search:   { label: 'Memory',       icon: '◈', color: 'var(--accent)' },
  exec:            { label: 'Terminal',     icon: '$', color: 'var(--danger)' },
  bash:            { label: 'Terminal',     icon: '$', color: 'var(--danger)' },
}

// 툴 이름 → 그룹 키 매핑. read/write/edit 등 유사 계열을 한 묶음으로 합쳐 "파일 작업" 처럼 표시.
function toolGroupKey(tool: string): string {
  if (['read','write','edit','glob','grep'].includes(tool)) return 'files'
  if (['web_fetch','web_search'].includes(tool)) return 'web'
  if (['sessions_spawn','sessions_yield'].includes(tool)) return 'subagent'
  if (['exec','bash'].includes(tool)) return 'terminal'
  return tool
}

function toolGroupLabel(key: string, items: { tool: string }[]): string {
  const firstMeta = TOOL_GROUP_META[items[0]?.tool]
  if (key === 'files') return `${items.length} file operation${items.length === 1 ? '' : 's'}`
  if (key === 'web')   return `${items.length} web request${items.length === 1 ? '' : 's'}`
  if (key === 'browser') return `${items.length} browser action${items.length === 1 ? '' : 's'}`
  if (key === 'subagent') return 'Sub-agent task'
  if (key === 'terminal') return `${items.length} command${items.length === 1 ? '' : 's'}`
  return firstMeta?.label ?? key
}

// 동일 그룹의 툴 호출들을 하나의 접이식 블록으로 묶어 표시.
// forceOpen=true 면 부모가 전체 펼침을 요청한 상태 (초기 렌더 직후 등).
function ToolSubGroup({ groupKey, items, forceOpen }: { groupKey: string; items: { text: string; tool: string }[]; forceOpen: boolean }) {
  const [open, setOpen] = useState(forceOpen)
  useEffect(() => { if (!forceOpen) setOpen(false) }, [forceOpen])

  const meta  = TOOL_GROUP_META[items[0]?.tool] ?? { icon: '○', color: 'var(--text-muted)', label: groupKey }
  const label = toolGroupLabel(groupKey, items)

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: 'none', background: 'transparent',
          padding: '3px 0', fontSize: 11, cursor: 'pointer', width: '100%', textAlign: 'left',
        }}
      >
        <span style={{ color: meta.color, fontSize: 12, flexShrink: 0 }}>{meta.icon}</span>
        <span style={{ color: 'var(--text-muted)', flex: 1 }}>{label}</span>
        <span style={{ opacity: 0.4, fontSize: 10, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 2, marginBottom: 4,
          paddingLeft: 16,
          borderLeft: `2px solid ${meta.color}40`,
          display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          {items.map((item, i) => (
            <div key={i} style={{
              fontSize: 10.5, color: 'var(--text-muted)',
              padding: '2px 0',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {item.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 메시지 1개에 딸린 모든 툴 호출을 받아 그룹 키별로 분류한 뒤 ToolSubGroup 으로 렌더.
// defaultOpen=true 면 처음부터 열린 상태로 시작.
function ToolActionGroup({ items, defaultOpen }: { items: { text: string; tool: string }[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  useEffect(() => { if (!defaultOpen) setOpen(false) }, [defaultOpen])

  // Group items by tool category
  const groups = new Map<string, { text: string; tool: string }[]>()
  for (const item of items) {
    const key = toolGroupKey(item.tool)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  // Summary label for header: e.g. "3 browser · 2 files · 1 web"
  const parts = [...groups.entries()].map(([key, g]) => toolGroupLabel(key, g))
  const headerLabel = parts.length === 1 && items.length === 1
    ? items[0].text
    : `${items.length} action${items.length === 1 ? '' : 's'} — ${parts.join(' · ')}`

  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '80%' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)',
          borderRadius: 'var(--radius-sm)', padding: '4px 10px',
          fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer',
          width: '100%', textAlign: 'left',
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      >
        <span style={{ opacity: 0.5, fontSize: 10 }}>◎</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {headerLabel}
        </span>
        <span style={{ opacity: 0.5, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 4, padding: '6px 10px',
          border: '1px solid var(--border-subtle)', borderTop: 'none',
          borderBottomLeftRadius: 'var(--radius-sm)', borderBottomRightRadius: 'var(--radius-sm)',
          background: 'var(--bg-surface)',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {[...groups.entries()].map(([key, g]) => (
            <ToolSubGroup key={key} groupKey={key} items={g} forceOpen={defaultOpen ?? false} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── ChatPanel 본체 ────────────────────────────────────────────────────
// 이 컴포넌트는 전체 UI 의 무게중심이라 ~1100 줄을 차지한다.
// 대략적인 내부 구조:
//   · 상단 툴바 (New Chat / History drawer)
//   · 스크롤 가능한 메시지 목록 (MessageBubble 반복 + isThinking 인디케이터)
//   · 툴 활동 상태 배지 (toolActivity / toolStats)
//   · 하단 입력 영역 (드래그앤드롭, 파일 chip, 전송/중단 버튼)
//   · 히스토리 드로어 (SessionMeta 목록 + 선택 시 SessionEntry 전체 렌더)
//   · Planning Mode 활성 시 PlanCard / 플래너 라우팅
export function ChatPanel({ messages, isThinking, toolActivity, toolStats, onSend, onStop, onNewChat, onOpenFile, pendingChip, onChipConsumed, projectDir, projectDirLoading, projectDirSetting, onPickProjectDir, planMode, onTogglePlanMode, planHandlers, planGenerating, onMessageAction, onImportExecutionPlan }: Props) {
  const execPlanFileRef = useRef<HTMLInputElement | null>(null)
  // ── History sidebar state ──────────────────────────────────────
  const [sidebarOpen,    setSidebarOpen]    = useState(false)
  const [sessions,       setSessions]       = useState<SessionMeta[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [selectedSession, setSelectedSession] = useState<SessionMeta | null>(null)
  const [historyEntries,  setHistoryEntries]  = useState<SessionEntry[]>([])
  const [historyLoading,  setHistoryLoading]  = useState(false)
  const [suggestConfirm,  setSuggestConfirm]  = useState(false)
  const historyBottomRef = useRef<HTMLDivElement>(null)

  // ── Run.md preview pane ───────────────────────────────────────
  // Right-side collapsible pane that renders run.md as markdown.
  // Opens when "View run log" on a finished plan is clicked. Auto-
  // refreshes via plan-changed subscription so live runs update.
  const [previewPlanId,  setPreviewPlanId]  = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState<boolean>(false)
  const [previewError,   setPreviewError]   = useState<string | null>(null)
  const [previewWidth,   setPreviewWidth]   = useState<number>(420)
  const previewResizingRef = useRef(false)

  const loadPreview = useCallback(async (planId: string) => {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const text = await window.twixy.planReadRun(planId)
      setPreviewContent(text ?? '')
    } catch (err) {
      setPreviewError((err as Error).message ?? 'Failed to load run.md')
      setPreviewContent('')
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const openPreview = useCallback((planId: string) => {
    setPreviewPlanId(planId)
    void loadPreview(planId)
  }, [loadPreview])

  const closePreview = useCallback(() => {
    setPreviewPlanId(null)
    setPreviewContent('')
    setPreviewError(null)
  }, [])

  // Refresh preview when its plan emits a change (running plans).
  useEffect(() => {
    if (!previewPlanId) return
    const off = window.twixy.onPlanChanged(({ id }) => {
      if (id === previewPlanId) void loadPreview(previewPlanId)
    })
    return off
  }, [previewPlanId, loadPreview])

  // Drag-to-resize the preview pane via its left grip.
  const startPreviewResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    previewResizingRef.current = true
    const startX = e.clientX
    const startW = previewWidth
    const onMove = (ev: MouseEvent) => {
      if (!previewResizingRef.current) return
      const next = Math.max(280, Math.min(window.innerWidth - 360, startW - (ev.clientX - startX)))
      setPreviewWidth(next)
    }
    const onUp = () => {
      previewResizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [previewWidth])

  // ── Live browser action log ────────────────────────────────────
  // Each thinking session creates a "batch" anchored to the message index
  // that existed when the first tool action fired. Batches are rendered
  // inline right after their anchor message, so actions appear attached to
  // the "Let me check…" bubble that triggered them.
  interface ActionBatch { anchorIndex: number; items: { detail: string; tool: string }[] }
  const [actionBatches, setActionBatches] = useState<ActionBatch[]>([])
  const currentBatchIdxRef = useRef<number | null>(null)
  const seenActionsRef     = useRef(new Set<string>())
  const messagesLenRef     = useRef(messages.length)
  const isNewThinkingRef   = useRef(false)  // true = next tool event should open a new batch

  // Keep messages length ref up to date
  useEffect(() => { messagesLenRef.current = messages.length }, [messages.length])

  // Mark when a new thinking session starts so the next tool event opens a fresh batch
  const prevThinkingRef2 = useRef(false)
  useEffect(() => {
    if (isThinking && !prevThinkingRef2.current) {
      isNewThinkingRef.current = true
      seenActionsRef.current.clear()
    }
    prevThinkingRef2.current = isThinking
  }, [isThinking])

  useEffect(() => {
    if (!toolActivity) return
    // Use callId as dedup key so retries of the same URL each get their own entry
    const key = toolActivity.callId ?? `${toolActivity.name}:${toolActivity.detail}`
    if (seenActionsRef.current.has(key)) return
    seenActionsRef.current.add(key)

    const item = { detail: toolActivity.detail ?? toolActivity.name, tool: toolActivity.name }

    if (isNewThinkingRef.current) {
      // First tool of this thinking session — create a new batch anchored to
      // the last message currently visible (the "Let me try…" bubble).
      isNewThinkingRef.current = false
      const anchorIndex = messagesLenRef.current - 1
      setActionBatches(prev => {
        currentBatchIdxRef.current = prev.length
        return [...prev, { anchorIndex, items: [item] }]
      })
    } else if (currentBatchIdxRef.current !== null) {
      setActionBatches(prev => prev.map((b, i) =>
        i === currentBatchIdxRef.current ? { ...b, items: [...b.items, item] } : b
      ))
    }
  }, [toolActivity])

  const loadSessions = useCallback(async () => {
    try {
      const list = await window.twixy.listSessionLogs()
      setSessions(list)
    } catch { /* non-critical */ }
    setSessionsLoaded(true)
  }, [])

  // Load sessions when sidebar first opens
  useEffect(() => {
    if (sidebarOpen && !sessionsLoaded) loadSessions()
  }, [sidebarOpen, sessionsLoaded, loadSessions])

  const openSession = useCallback(async (s: SessionMeta) => {
    setSelectedSession(s)
    setHistoryLoading(true)
    try {
      const entries = await window.twixy.readSessionLog(s.filePath)
      setHistoryEntries(entries)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const closeHistory = useCallback(() => {
    setSelectedSession(null)
    setHistoryEntries([])
  }, [])

  // Group sessions by date
  const sessionsByDate = sessions.reduce<Record<string, SessionMeta[]>>((acc, s) => {
    acc[s.date] = acc[s.date] ?? []
    acc[s.date].push(s)
    return acc
  }, {})

  // Tick once per second while thinking so the elapsed timer in the
  // progress pill ("Thinking 47s · 12 calls") actually advances. Without
  // this the component would only re-render on RPC events, leaving long
  // quiet stretches looking frozen.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isThinking) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [isThinking])
  const elapsedSec = toolStats?.startedAt ? Math.floor((Date.now() - toolStats.startedAt) / 1000) : 0
  const lastLabel = toolActivity
    ? (toolActivity.subagentLabel
        ? `Sub-agent: ${toolActivity.subagentLabel} — ${friendlyTool(toolActivity.name, false)}`
        : friendlyTool(toolActivity.name, toolActivity.isSubagent))
    : (toolStats?.lastName ? friendlyTool(toolStats.lastName, toolStats.lastIsSubagent) : 'Thinking')
  // ── Rich contenteditable input with inline file chips ──────────
  // We use a contenteditable div instead of a <textarea> so file references
  // can be rendered as real chip DOM nodes inline at the cursor, while the
  // surrounding body remains plain text. On send we serialize the editor's
  // children back to a "@path" string so the LLM sees the exact same input
  // shape as before.
  const editorRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Korean IME + Enter race: isComposing alone doesn't always block
  // the duplicate keydown that fires around a composition commit.
  // Timestamp guard catches the second firing.
  const lastSendAtRef = useRef(0)
  const [inputEmpty, setInputEmpty] = useState(true)

  const updateEmpty = useCallback(() => {
    const el = editorRef.current
    if (!el) return setInputEmpty(true)
    const hasChip = !!el.querySelector('[data-chip-path]')
    const text = (el.textContent || '').replace(/\u00a0/g, ' ').trim()
    setInputEmpty(!hasChip && text.length === 0)
  }, [])

  const serializeEditor = (): string => {
    const el = editorRef.current
    if (!el) return ''
    let out = ''
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += (n.textContent || '').replace(/\u00a0/g, ' ')
        return
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return
      const e = n as HTMLElement
      const p = e.getAttribute('data-chip-path')
      if (p) { out += `@${p}`; return }
      if (e.tagName === 'BR') { out += '\n'; return }
      // Block-level elements (DIV/P) inserted by the browser when pressing
      // Enter — emit a newline before their contents (except the first one).
      const isBlock = e.tagName === 'DIV' || e.tagName === 'P'
      if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n'
      n.childNodes.forEach(walk)
    }
    el.childNodes.forEach(walk)
    return out
  }

  const placeCaretAfter = (node: Node) => {
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.setStartAfter(node)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const buildChip = (filePath: string): HTMLSpanElement => {
    const span = document.createElement('span')
    span.setAttribute('data-chip-path', filePath)
    span.contentEditable = 'false'
    span.title = filePath
    span.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;max-width:240px;' +
      'padding:2px 4px 2px 8px;background:var(--accent-dim);color:var(--accent);' +
      'border:1px solid var(--accent-dim);border-radius:999px;font-size:11px;' +
      'font-weight:500;line-height:1.4;vertical-align:baseline;margin:0 2px;' +
      'user-select:none;'
    const icon = document.createElement('span')
    icon.textContent = '📎'
    icon.style.cssText = 'font-size:10px;opacity:0.8;'
    const label = document.createElement('span')
    label.textContent = filePath.split('/').pop() || filePath
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '×'
    close.contentEditable = 'false'
    close.style.cssText =
      'width:16px;height:16px;border-radius:50%;border:none;background:transparent;' +
      'color:var(--accent);cursor:pointer;display:inline-flex;align-items:center;' +
      'justify-content:center;font-size:12px;padding:0;flex-shrink:0;'
    close.onmousedown = (ev) => { ev.preventDefault(); ev.stopPropagation() }
    close.onclick = (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      span.remove()
      updateEmpty()
    }
    span.appendChild(icon)
    span.appendChild(label)
    span.appendChild(close)
    return span
  }

  const insertChipAtCursor = (filePath: string) => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    let range: Range
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0)
      range.deleteContents()
    } else {
      range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
    }
    const chip = buildChip(filePath)
    // Use a regular space (not nbsp) and a SEPARATE empty text node for the
    // caret. Korean IME composition breaks if the caret sits at the end of
    // the same text node that begins right after a contentEditable=false
    // chip — the first jamo lands in a fresh text node and never composes
    // into a syllable. Giving the caret its own empty text node fixes it.
    const space = document.createTextNode(' ')
    const caretHome = document.createTextNode('')
    range.insertNode(caretHome)
    range.insertNode(space)
    range.insertNode(chip)
    const sel2 = window.getSelection()
    if (sel2) {
      const r = document.createRange()
      r.setStart(caretHome, 0)
      r.collapse(true)
      sel2.removeAllRanges()
      sel2.addRange(r)
    }
    updateEmpty()
  }

  // ── Pre-populate editor with a file chip (e.g. from "Ask about this document") ──
  useEffect(() => {
    if (!pendingChip) return
    const el = editorRef.current
    if (!el) return
    // Clear existing content, insert chip, then focus
    el.innerHTML = ''
    const chip = buildChip(pendingChip.path)
    const space = document.createTextNode(' ')
    el.appendChild(chip)
    el.appendChild(space)
    // Place caret after the space
    const r = document.createRange()
    r.setStart(space, 1)
    r.collapse(true)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
    el.focus()
    updateEmpty()
    onChipConsumed?.()
  }, [pendingChip]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── @-mention file picker ────────────────────────────────────────
  const [mention, setMention] = useState<{
    open: boolean
    query: string
    files: RecentFile[]
    selected: number
  }>({ open: false, query: '', files: [], selected: 0 })

  // Where the active "@query" lives in the DOM, so we can delete it cleanly
  // when the user picks a file from the dropdown.
  const mentionAnchorRef = useRef<{ node: Text; atOffset: number } | null>(null)

  const loadRecent = useCallback(async () => {
    try {
      const files = await window.twixy.recentFiles(50)
      setMention(m => ({ ...m, files }))
    } catch { /* ignore */ }
  }, [])

  const closeMention = () => {
    mentionAnchorRef.current = null
    setMention(m => (m.open ? { ...m, open: false, query: '', selected: 0 } : m))
  }

  const filteredFiles = mention.files
    .filter(f => !mention.query || f.name.toLowerCase().includes(mention.query.toLowerCase()))
    .slice(0, 8)

  const insertMention = (file: RecentFile) => {
    const anchor = mentionAnchorRef.current
    if (anchor) {
      const sel = window.getSelection()
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null
      const endOffset = r && r.endContainer === anchor.node
        ? r.endOffset
        : (anchor.node.textContent?.length ?? 0)
      const delRange = document.createRange()
      try {
        delRange.setStart(anchor.node, anchor.atOffset)
        delRange.setEnd(anchor.node, endOffset)
        delRange.deleteContents()
        sel?.removeAllRanges()
        sel?.addRange(delRange)
      } catch { /* ignore */ }
    }
    closeMention()
    insertChipAtCursor(file.path)
  }

  const detectMention = () => {
    const el = editorRef.current
    if (!el) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) { closeMention(); return }
    const r = sel.getRangeAt(0)
    if (!el.contains(r.startContainer)) { closeMention(); return }
    if (r.startContainer.nodeType !== Node.TEXT_NODE) { closeMention(); return }
    const node = r.startContainer as Text
    const upto = (node.textContent || '').slice(0, r.startOffset)
    const m = upto.match(/(?:^|\s)@(\S*)$/)
    if (!m) { closeMention(); return }
    const query = m[1]
    const atOffset = r.startOffset - query.length - 1
    mentionAnchorRef.current = { node, atOffset }
    if (!mention.open) void loadRecent()
    setMention(s => ({ ...s, open: true, query, selected: 0 }))
  }

  const onEditorInput = () => {
    updateEmpty()
    detectMention()
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  const handleSend = useCallback(() => {
    if (isThinking) return
    if (!projectDir) {
      onPickProjectDir?.()
      return
    }
    const now = Date.now()
    if (now - lastSendAtRef.current < 300) return
    const text = serializeEditor().trim()
    if (!text) return
    lastSendAtRef.current = now
    onSend(text)
    if (editorRef.current) editorRef.current.innerHTML = ''
    mentionAnchorRef.current = null
    setMention(m => ({ ...m, open: false, query: '', selected: 0 }))
    setInputEmpty(true)
  }, [isThinking, onSend, projectDir, onPickProjectDir])

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mention.open && filteredFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMention(m => ({ ...m, selected: (m.selected + 1) % filteredFiles.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMention(m => ({ ...m, selected: (m.selected - 1 + filteredFiles.length) % filteredFiles.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredFiles[mention.selected])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMention()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const isEmpty = messages.length === 0

  // ── Drag & drop CSV / Excel files ───────────────────────────────
  const isAcceptedFile = (f: File) => {
    const n = f.name.toLowerCase()
    return n.endsWith('.csv') || n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.tsv') || n.endsWith('.pdf') || n.endsWith('.pptx')
  }

  // 드랍 파일 임포트. 오버레이 on/off 는 useFileDropZone 이 판정한다 (창 밖으로
  // 나간 드래그, 다른 곳에 떨어진 드래그까지 커버 — 예전 카운터는 계속 떠 있었다).
  const importDroppedFiles = async (accepted: File[]) => {
    // Electron exposes the absolute path on File. Reference each file via @path
    // so the agent can read it (same convention as the @-mention picker).
    const w = window as unknown as {
      twixy?: {
        importDroppedFile?: (p: { name: string; bytes: ArrayBuffer }) =>
          Promise<{ ok: boolean; path?: string; relPath?: string; name?: string }>
      }
    }
    const imported: string[] = []
    for (const f of accepted) {
      try {
        const bytes = await f.arrayBuffer()
        const res = await w.twixy?.importDroppedFile?.({ name: f.name, bytes })
        // Prefer the workspace-relative path so the chat shows
        // "@data/raw/foo.csv" instead of the full /Users/.../twixy/... path,
        // matching the @-mention picker convention.
        const ref = res?.ok ? (res.relPath || res.path) : undefined
        if (ref) imported.push(ref)
      } catch (err) {
        console.warn('[chat] drop import failed:', err)
      }
    }
    if (imported.length === 0) return
    editorRef.current?.focus()
    for (const p of imported) insertChipAtCursor(p)
  }
  const { isDragging, dropHandlers } = useFileDropZone({ accept: isAcceptedFile, onFiles: importDroppedFiles })

  const exportChatCSV = () => {
    const rows = messages
      .filter(m => m.role !== 'system')
      .map(m => [
        new Date(m.timestamp).toISOString(),
        m.role,
        m.content,
      ])
    const csv = toCSV({
      headers: ['timestamp', 'role', 'content'],
      rows,
      truncated: false,
    })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    downloadCSV(`twixy-chat-${stamp}.csv`, csv)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 }}>
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
      minWidth: 0,
    }}
      {...dropHandlers}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        minHeight: 36,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* History sidebar toggle */}
          <button
            onClick={() => { setSidebarOpen(v => !v); if (selectedSession) closeHistory() }}
            title={sidebarOpen ? 'Close history' : 'Chat history'}
            style={{
              border: 'none',
              background: sidebarOpen ? 'var(--accent-dim)' : 'transparent',
              color: sidebarOpen ? 'var(--accent)' : 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)',
              width: 28,
              height: 28,
              cursor: 'pointer',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            ☰
          </button>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {selectedSession ? selectedSession.date : 'Chat'}
          </span>
          {selectedSession && (
            <button
              onClick={closeHistory}
              style={{
                border: 'none',
                background: 'var(--accent-dim)',
                color: 'var(--accent)',
                fontSize: 11,
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              ← Back to current chat
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Project directory badge */}
          {!projectDirLoading && (
            onPickProjectDir ? (
              projectDir ? (
                <button
                  onClick={onPickProjectDir}
                  disabled={projectDirSetting}
                  title={projectDir}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '3px 8px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-muted)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 11,
                    cursor: 'pointer',
                    maxWidth: 160,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M1 3.5A1.5 1.5 0 012.5 2H5l1 1.5H9.5A1.5 1.5 0 0111 5v4A1.5 1.5 0 019.5 10.5h-7A1.5 1.5 0 011 9V3.5z" stroke="currentColor" strokeWidth="1" fill="none"/>
                  </svg>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {projectDirSetting ? 'Changing…' : projectDir.split(/[\\/]/).filter(Boolean).pop()}
                  </span>
                </button>
              ) : (
                <button
                  onClick={onPickProjectDir}
                  disabled={projectDirSetting}
                  style={{
                    padding: '3px 10px',
                    border: '1px solid var(--accent)',
                    background: 'transparent',
                    color: 'var(--accent)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 11,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {projectDirSetting ? 'Opening…' : 'Choose Project Folder'}
                </button>
              )
            ) : null
          )}

          <button
            onClick={() => { setActionBatches([]); currentBatchIdxRef.current = null; seenActionsRef.current.clear(); onNewChat?.() }}
            title="Start a new chat"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              border: '1px solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            + New Chat
          </button>

          {onImportExecutionPlan && (
            <>
              <input
                ref={execPlanFileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  void f.text().then(t => onImportExecutionPlan(t))
                }}
              />
              <button
                onClick={() => execPlanFileRef.current?.click()}
                title="Import an Execution Plan (JSON) as a draft to review and run"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                ⇧ Import Plan
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body — sidebar + chat area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ── Left sidebar ── */}
      {sidebarOpen && (
        <div style={{
          width: 220,
          flexShrink: 0,
          borderRight: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 12px 8px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              History
            </span>
            <button
              onClick={loadSessions}
              title="Refresh"
              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: 2 }}
            >
              ⟳
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {!sessionsLoaded ? (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 24 }}>Loading…</p>
            ) : sessions.length === 0 ? (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '24px 12px', lineHeight: 1.5 }}>
                No sessions yet.<br />Start chatting to build history.
              </p>
            ) : (
              Object.entries(sessionsByDate).map(([date, items]) => (
                <div key={date}>
                  <p style={{
                    margin: 0,
                    padding: '8px 12px 4px',
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--text-muted)',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    position: 'sticky',
                    top: 0,
                    background: 'var(--bg-surface)',
                  }}>
                    {date}
                  </p>
                  {items.map(s => (
                    <button
                      key={s.sessionId}
                      onClick={() => openSession(s)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        border: 'none',
                        borderBottom: '1px solid var(--border-subtle)',
                        background: selectedSession?.sessionId === s.sessionId ? 'var(--accent-dim)' : 'transparent',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                      }}
                      onMouseEnter={e => { if (selectedSession?.sessionId !== s.sessionId) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover)' }}
                      onMouseLeave={e => { if (selectedSession?.sessionId !== s.sessionId) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                    >
                      <span style={{ fontSize: 10, color: selectedSession?.sessionId === s.sessionId ? 'var(--accent)' : 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                        <span>{new Date(s.mtimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {s.totalTokens != null && (
                          <span>{s.totalTokens >= 1000 ? `${(s.totalTokens / 1000).toFixed(1)}K tok` : `${s.totalTokens} tok`}</span>
                        )}
                      </span>
                      <span style={{
                        fontSize: 12,
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'block',
                        maxWidth: '100%',
                      }}>
                        {s.preview || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Empty session</span>}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* ── Suggest a skill ── */}
          <div style={{
            padding: '10px 12px',
            borderTop: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}>
            {!suggestConfirm ? (
              <button
                onClick={() => setSuggestConfirm(true)}
                style={{
                  width: '100%',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 10px',
                  fontSize: 11,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
              >
                ✦ Suggest a skill
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Twixy will read your session history to find recurring patterns. This may take <strong style={{ color: 'var(--text)' }}>1–2 minutes</strong>.
                </p>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => {
                      setSuggestConfirm(false)
                      setSidebarOpen(false)
                      onSend(
                        'Analyze my recent session logs and suggest a custom skill based on any recurring workflow patterns you find. ' +
                        'Read the session files under logs/sessions/, identify repeated sequences of actions, ' +
                        'and if a clear pattern exists, propose a .tskill implementation.'
                      )
                    }}
                    style={{
                      flex: 1,
                      border: 'none',
                      background: 'var(--accent)',
                      color: '#fff',
                      borderRadius: 'var(--radius-sm)',
                      padding: '5px 0',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Analyze
                  </button>
                  <button
                    onClick={() => setSuggestConfirm(false)}
                    style={{
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '5px 10px',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Right: chat area ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* History view */}
      {selectedSession && (
        <div style={{ flex: 1, overflowY: 'auto', paddingBlock: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {historyLoading ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 40 }}>Loading…</p>
          ) : historyEntries.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 40 }}>No messages in this session.</p>
          ) : (
            (() => {
              // Collapse consecutive tool_action rows into expandable groups
              const grouped: Array<
                | { kind: 'message'; entry: SessionEntry; index: number }
                | { kind: 'actions'; items: { text: string; tool: string }[]; startIndex: number }
              > = []
              let i = 0
              while (i < historyEntries.length) {
                const e = historyEntries[i]
                if (e.role === 'tool_action') {
                  const batch: { text: string; tool: string }[] = []
                  while (i < historyEntries.length && historyEntries[i].role === 'tool_action') {
                    batch.push({ text: historyEntries[i].text, tool: historyEntries[i].tools[0] ?? '' })
                    i++
                  }
                  grouped.push({ kind: 'actions', items: batch, startIndex: i })
                } else {
                  grouped.push({ kind: 'message', entry: e, index: i })
                  i++
                }
              }

              return grouped.map((g, gi) => {
                if (g.kind === 'actions') {
                  return (
                    <div key={`action-${gi}`} style={{ paddingInline: 16, paddingBlock: 4 }}>
                      <ToolActionGroup items={g.items} />
                    </div>
                  )
                }
                const e = g.entry
                if (!e.text.trim() && e.tools.length === 0) return null
                // Reuse the same MessageBubble as live chat for identical rendering
                return (
                  <MessageBubble
                    key={gi}
                    msg={{
                      id: String(gi),
                      role: e.role as 'user' | 'assistant' | 'system',
                      content: e.text,
                      timestamp: e.timestamp ? new Date(e.timestamp) : new Date(0),
                    }}
                    onOpenFile={onOpenFile}
                  />
                )
              })
            })()
          )}
          <div ref={historyBottomRef} />
        </div>
      )}

      {/* Messages */}
      {!selectedSession && (
      <div style={{
        flex: 1,
        overflowY: 'auto',
        paddingBlock: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}>
        {isEmpty && (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: 'var(--text-muted)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>◎</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)' }}>
              Twixy
            </div>
            <div style={{ fontSize: 12 }}>Your personal marketing copilot</div>

            {/* Quick actions */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              marginTop: 24,
              width: 340,
            }}>
              {QUICK_ACTIONS.map(action => (
                <button
                  key={action.label}
                  onClick={() => onSend(action.prompt)}
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '10px 12px',
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.background = 'var(--bg-hover)'
                    el.style.borderColor = 'var(--accent-dim)'
                    el.style.color = 'var(--text-primary)'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.background = 'var(--bg-elevated)'
                    el.style.borderColor = 'var(--border)'
                    el.style.color = 'var(--text-secondary)'
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <React.Fragment key={msg.id}>
            {msg.planId && planHandlers ? (
              <div style={{ paddingInline: 16, paddingBlock: 4 }}>
                <PlanCard
                  planId={msg.planId}
                  generating={planGenerating && idx === messages.length - 1}
                  onBuild={planHandlers.onBuild}
                  onPause={planHandlers.onPause}
                  onResume={planHandlers.onResume}
                  onDelete={planHandlers.onDelete}
                  onRevealRun={openPreview}
                />
              </div>
            ) : (
              <MessageBubble msg={msg} onOpenFile={onOpenFile} onMessageAction={onMessageAction} />
            )}
            {actionBatches
              .filter(b => b.anchorIndex === idx && b.items.length > 0)
              .map((b, bi) => (
                <div key={bi} style={{ paddingInline: 16, paddingBlock: 4 }}>
                  <ToolActionGroup
                    items={b.items.map(a => ({ text: a.detail, tool: a.tool }))}
                    defaultOpen={isThinking && bi === actionBatches.filter(x => x.anchorIndex === idx).length - 1}
                  />
                </div>
              ))
            }
          </React.Fragment>
        ))}

        {isThinking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
            <ThinkingDots />
            <span style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              display: 'inline-flex',
              flexDirection: 'column',
              gap: 2,
            }}>
              <span>{lastLabel}…</span>
              {toolActivity?.detail && (
                <span style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  opacity: 0.85,
                  maxWidth: 340,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                }}>
                  {toolActivity.detail}
                </span>
              )}
              {(toolStats && (toolStats.count > 0 || elapsedSec > 0)) && (
                <span style={{ fontSize: 11, opacity: 0.7 }}>
                  {elapsedSec}s
                  {toolStats.count > 0 ? ` · ${toolStats.count} tool call${toolStats.count === 1 ? '' : 's'}` : ''}
                </span>
              )}
            </span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
      )} {/* end !selectedSession */}

      {/* Input — only in live chat mode */}
      {!selectedSession && (
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        position: 'relative',
      }}>
        {/* @-mention dropdown */}
        {mention.open && filteredFiles.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 16,
            right: 16,
            marginBottom: 6,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
            zIndex: 50,
            maxHeight: 280,
            overflowY: 'auto',
            padding: 4,
          }}>
            <div style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              padding: '4px 10px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>Recent files</div>
            {filteredFiles.map((f, i) => (
              <button
                key={f.path}
                onMouseDown={e => { e.preventDefault(); insertMention(f) }}
                onMouseEnter={() => setMention(m => ({ ...m, selected: i }))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  padding: '7px 10px',
                  border: 'none',
                  background: i === mention.selected ? 'var(--bg-hover)' : 'transparent',
                  color: 'var(--text)',
                  fontSize: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}>{f.name}</span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                }}>{f.dir}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '8px 12px',
          transition: 'border-color 0.15s',
        }}
          onFocusCapture={e => (e.currentTarget.style.borderColor = 'var(--accent-dim)')}
          onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--border)')}
        >
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            {inputEmpty && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                pointerEvents: 'none',
                color: 'var(--text-muted)',
                fontSize: 13.5,
                lineHeight: 1.5,
              }}>
                {isThinking ? 'Twixy is working…' : !projectDir && !projectDirLoading ? 'Choose a project folder to start…' : 'Message Twixy...'}
              </div>
            )}
            <div
              ref={editorRef}
              contentEditable={!isThinking}
              suppressContentEditableWarning
              onInput={onEditorInput}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(() => closeMention(), 150)}
              data-placeholder="Message Twixy..."
              style={{
                outline: 'none',
                color: isThinking ? 'var(--text-muted)' : 'var(--text-primary)',
                font: 'inherit',
                fontSize: 13.5,
                lineHeight: 1.5,
                minHeight: 20,
                maxHeight: 160,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                cursor: isThinking ? 'not-allowed' : 'text',
              }}
            />
          </div>
          {onTogglePlanMode && (
            <button
              onClick={onTogglePlanMode}
              title={planMode ? 'Planning mode is ON — messages generate a plan first' : 'Planning mode is OFF — messages go direct to the agent'}
              style={{
                height:       28,
                borderRadius: 8,
                border:       '1px solid ' + (planMode ? 'var(--accent-dim)' : 'var(--border)'),
                background:   planMode ? 'var(--accent-dim)' : 'transparent',
                color:        planMode ? 'var(--accent)' : 'var(--text-muted)',
                cursor:       'pointer',
                padding:      '0 10px',
                display:      'flex',
                alignItems:   'center',
                gap:          4,
                fontSize:     11,
                fontWeight:   600,
                flexShrink:   0,
                transition:   'background 0.15s, color 0.15s, border-color 0.15s',
              }}
            >
              📋 Plan {planMode ? 'ON' : 'OFF'}
            </button>
          )}
          <button
            onClick={() => window.twixy.openSidetab()}
            title="Pop out a small floating overlay that stays on top of other apps"
            style={{
              height:       28,
              borderRadius: 8,
              border:       '1px solid var(--border)',
              background:   'transparent',
              color:        'var(--text-muted)',
              cursor:       'pointer',
              padding:      '0 10px',
              display:      'flex',
              alignItems:   'center',
              gap:          4,
              fontSize:     11,
              fontWeight:   600,
              flexShrink:   0,
            }}
          >
            ⧉ Pop out
          </button>
          {isThinking ? (
            <button
              onClick={() => onStop?.()}
              title="Stop"
              style={{
                width:        28,
                height:       28,
                borderRadius:  8,
                border:       'none',
                background:   'var(--bg-active)',
                color:        'var(--text-muted)',
                cursor:       'pointer',
                display:      'flex',
                alignItems:   'center',
                justifyContent:'center',
                fontSize:      12,
                flexShrink:    0,
                transition:   'background 0.15s',
              }}
            >
              ■
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={inputEmpty}
              style={{
                width:        28,
                height:       28,
                borderRadius:  8,
                border:       'none',
                background:   !inputEmpty ? 'var(--accent)' : 'var(--bg-active)',
                color:        !inputEmpty ? 'white' : 'var(--text-muted)',
                cursor:       !inputEmpty ? 'pointer' : 'default',
                display:      'flex',
                alignItems:   'center',
                justifyContent:'center',
                fontSize:      14,
                flexShrink:    0,
                transition:   'background 0.15s',
              }}
            >
              ↑
            </button>
          )}
        </div>
        <div style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          marginTop: 6,
          paddingInline: 4,
        }}>
          Enter to send · Shift+Enter for new line
        </div>
      </div>
      )} {/* end !selectedSession input */}

      </div> {/* end right chat area */}
      </div> {/* end body row */}

      {isDragging && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(124, 58, 237, 0.12)',
          border: '2px dashed var(--accent)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 8,
          zIndex: 100,
          pointerEvents: 'none',
          color: 'var(--accent)',
          fontSize: 14,
          fontWeight: 600,
          backdropFilter: 'blur(2px)',
        }}>
          <div style={{ fontSize: 32 }}>⇩</div>
          <div>Drop CSV / Excel / PDF files to attach</div>
          <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>
            .csv · .tsv · .xls · .xlsx · .pdf
          </div>
        </div>
      )}

      <style>{`
        .file-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          max-width: 240px;
          padding: 2px 10px;
          background: rgba(20, 32, 27, 0.08);
          color: var(--accent);
          border: none;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 500;
          line-height: 1.4;
          vertical-align: baseline;
          margin: 0 2px;
        }
        .file-chip-icon { font-size: 10px; opacity: 0.8; }
        .file-chip-label {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-5px); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>

    {/* Right-side run.md preview pane */}
    <div style={{
      width: previewPlanId ? previewWidth : 0,
      flexShrink: 0,
      borderLeft: previewPlanId ? '1px solid var(--border-subtle)' : 'none',
      background: 'var(--bg-surface)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
      transition: previewResizingRef.current ? 'none' : 'width 0.2s ease',
    }}>
      {previewPlanId && (
        <>
          {/* Resize grip — drag left/right to adjust pane width */}
          <div
            onMouseDown={startPreviewResize}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: 'col-resize',
              zIndex: 2,
              background: 'transparent',
            }}
            title="Drag to resize"
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            minHeight: 36,
            flexShrink: 0,
            gap: 8,
          }}>
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              📄 run.md{previewLoading ? ' · loading…' : ''}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={() => planHandlers?.onRevealRun(previewPlanId)}
                title="Reveal in Finder"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                Open in Finder
              </button>
              <button
                onClick={closePreview}
                title="Close preview"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  fontSize: 16,
                  width: 24,
                  height: 24,
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ×
              </button>
            </div>
          </div>
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: '12px 16px',
            fontSize: 12.5,
            lineHeight: 1.55,
            color: 'var(--text-primary)',
          }}>
            {previewError ? (
              <div style={{ color: 'var(--danger)', fontSize: 12 }}>
                Failed to load: {previewError}
              </div>
            ) : !previewContent && !previewLoading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
                run.md is empty.
              </div>
            ) : (
              <div
                className="md-render"
                onClick={e => {
                  const a = (e.target as HTMLElement).closest('a')
                  if (a && (a as HTMLAnchorElement).href) {
                    e.preventDefault()
                    window.twixy.openExternal((a as HTMLAnchorElement).href)
                  }
                }}
                dangerouslySetInnerHTML={{
                  __html: safeHtml(marked(previewContent, { breaks: true, gfm: true })),
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
    </div>
  )
}

// Render `@path/to/file.ext` tokens as inline chip pills (matching the
// composer chips) so the user message bubble shows file references the same
// way they were typed, not as a long raw "@..." string.
// ── 메시지 포스트-프로세싱 유틸 ──────────────────────────────────────
// addWorkspaceLinks : 렌더된 마크다운 HTML 에서 워크스페이스 경로를 <a> 링크로 변환.
//                     클릭 시 onOpenFile 콜백으로 DataPanel 에 전달.
function addWorkspaceLinks(html: string): string {
  return html.replace(
    /~\/\.openclaw\/workspace\/twixy\/([^\s<"'`\]）)]+)/g,
    (_m, relPath) => {
      const safe = relPath.replace(/"/g, '&quot;')
      return `<span class="ws-file-link" data-ws-path="${safe}">twixy/${safe}</span>`
    }
  )
}

// renderFileChips : 어시스턴트 응답에 들어있는 `:open:path` 토큰을 클릭 가능한 파일 칩으로 변환.
// 에이전트가 "이 파일을 열어보려면 클릭" 이라는 의도로 이 토큰을 삽입할 수 있다.
function renderFileChips(html: string): string {
  return html.replace(/@([^\s@<>]+\.[A-Za-z0-9]{1,8})/g, (_m, p1) => {
    const base = p1.split('/').pop() || p1
    const safePath = p1.replace(/"/g, '&quot;')
    return (
      `<span class="file-chip" title="${safePath}">` +
        `<span class="file-chip-icon">📎</span>` +
        `<span class="file-chip-label">${base}</span>` +
      `</span>`
    )
  })
}

// renderMessage : marked 로 마크다운 → HTML 변환 후 위 두 유틸을 연쇄 적용.
// MessageBubble 이 assistant 메시지를 출력할 때 사용.
function renderMessage(text: string): string {
  const html = marked(text, { breaks: true, gfm: true }) as string
  return addWorkspaceLinks(renderFileChips(html))
}
