// ─────────────────────────────────────────────────────────────────────────────
// SkillReader.tsx — Workflow 탭의 Tool Skill 클릭 시 뜨는 가벼운 read-only
// 모달. WORKFLOW_TOOLS 카탈로그의 Tool Skill 중 backing dir (skills/<id>/) 이
// 있는 것만 호출된다. SKILL.md 가 있으면 마크다운으로 렌더 (workflow 노드의
// detail / subtasks 채울 때 runbook 참고), 없으면 .tskill source 로 폴백.
//
// 모달 자체는 fixed positioning + 백드롭, react portal 안 씀 — 호출 측 컴포넌트
// 트리 안에서 렌더하지만 z-index 1000 으로 워크플로 뷰 위 모든 것 덮음.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { marked } from 'marked'
import { safeHtml } from '../../lib/safeHtml'

interface Props {
  open:     boolean
  skillId:  string | null  // catalog id (== skills/<id>/)
  label:    string         // display label, e.g. "Instagram Saved"
  onClose:  () => void
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'md';   content: string }
  | { kind: 'tskill'; content: string }
  | { kind: 'error'; message: string }

export function SkillReader({ open, skillId, label, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' })

  // 모달이 열릴 때마다 SKILL.md → .tskill 순으로 시도. skillId 가 바뀌면 (사용자가
  // 모달 닫지 않고 다른 skill 누른 케이스에 대비) 다시 fetch.
  useEffect(() => {
    if (!open || !skillId) {
      setState({ kind: 'idle' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const mdPath = `skills/${skillId}/SKILL.md`
        const md = await window.twixy?.readFile?.(mdPath)
        if (cancelled) return
        if (typeof md === 'string' && md.trim()) {
          setState({ kind: 'md', content: md })
          return
        }
        // SKILL.md 없음 → .tskill 폴백
        const src = await window.twixy?.readSkillSource?.(skillId)
        if (cancelled) return
        if (src && (src as { ok?: boolean }).ok && (src as { source?: string }).source) {
          setState({ kind: 'tskill', content: (src as { source: string }).source })
          return
        }
        setState({ kind: 'error', message: 'No SKILL.md or .tskill source found for this skill.' })
      } catch (e) {
        if (!cancelled) {
          setState({ kind: 'error', message: (e as Error)?.message ?? 'Failed to load skill' })
        }
      }
    })()
    return () => { cancelled = true }
  }, [open, skillId])

  // Esc 로 닫기
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !skillId) return null

  const sourceTag = state.kind === 'md'
    ? 'SKILL.md (compiled)'
    : state.kind === 'tskill'
      ? '.tskill (source)'
      : ''

  return (
    <div
      onClick={onClose}  // 백드롭 클릭으로 닫기
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}  // 모달 본체 클릭은 닫지 않음
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          width: '100%',
          maxWidth: 820,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <header style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            📄 {label}
          </span>
          {sourceTag && (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-muted)',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-active)',
              border: '1px solid var(--border-subtle)',
            }}>
              {sourceTag}
            </span>
          )}
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 16,
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '12px 16px',
        }}>
          {state.kind === 'loading' && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Loading…
            </div>
          )}
          {state.kind === 'error' && (
            <div style={{
              fontSize: 12,
              color: 'var(--red)',
              padding: 8,
              border: '1px solid rgba(248,113,113,0.4)',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(248,113,113,0.08)',
            }}>
              {state.message}
            </div>
          )}
          {state.kind === 'md' && (
            <div
              className="md-render"
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--text-primary)',
                userSelect: 'text',
              }}
              dangerouslySetInnerHTML={{
                __html: safeHtml(marked(state.content, { breaks: true, gfm: true })),
              }}
            />
          )}
          {state.kind === 'tskill' && (
            // .tskill 폴백은 syntax highlighting 없이 plain pre — SkillsPanel 의
            // highlightTSL 은 그쪽 컴포넌트 안에 갇혀 있어 export 안 됨. 가독성이
            // 부족해지면 그때 헬퍼를 lib 로 빼서 공유.
            <pre style={{
              margin: 0,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text',
            }}>
              {state.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
