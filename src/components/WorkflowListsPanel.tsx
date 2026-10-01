// ─────────────────────────────────────────────────────────────────────────────
// WorkflowListsPanel.tsx — 우측 사이드 패널. VS Code 파일 트리처럼 이름만.
// 항목 클릭 시 activeWorkflowId 변경, + 버튼은 모달로 title 만 입력해 생성.
// v1 은 정렬·검색·드래그 없이 단순 리스트.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react'
import { ListFilter, Tag as TagIcon } from 'lucide-react'
import { TagSelectMenu } from './workflow/TagSelectMenu'
import { DEFAULT_TAGS } from '../lib/sharedWorkflows'
import { useConfirm } from './TwixyConfirm'
import { workflowDotColor, markWorkflowOpened } from '../lib/workflowDots'

type SortMode = 'default' | 'recent' | 'oldest'

interface Props {
  workflows: TwixyWorkflow[]
  activeId: string | null
  isLoading: boolean
  collapsed: boolean
  onSelect: (id: string) => void
  onCreate: (title: string) => Promise<TwixyWorkflow | null>
  onDelete: (id: string) => Promise<boolean>
  // 기존 태그 "선택" 저장 (생성 아님) — 미지정이면 WF 탭 태그는 읽기 전용.
  onUpdateTags?: (id: string, tags: string[]) => Promise<void> | void
  onToggleCollapse: () => void
  // 'overlay' = 우측 사이드바(채팅 뷰 안), 폭 220 + 좌측 보더 + collapse 토글.
  // 'embedded' = 워크플로 뷰 좌측 컬럼 안에 내장, 폭은 부모가 정함, collapse 없음.
  variant?: 'overlay' | 'embedded'
  // Test 실행 중인 워크플로 id 들 — 리스트에 초록 점으로 표시 (병렬 실행 트래킹).
  runningIds?: string[]
  // 백그라운드 run 이 끝난 워크플로 id → 결과. 완료/실패 배지 표시.
  // 해당 워크플로를 클릭(select)하면 부모가 이 맵에서 제거 → 배지 사라짐.
  finishedStatus?: Record<string, 'done' | 'failed'>
}

export function WorkflowListsPanel({
  workflows,
  activeId,
  isLoading,
  collapsed,
  onSelect,
  onCreate,
  onDelete,
  onUpdateTags,
  onToggleCollapse,
  variant = 'overlay',
  runningIds = [],
  finishedStatus = {},
}: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle]     = useState('')
  const [busy, setBusy]             = useState(false)
  const { confirm, confirmDialog }  = useConfirm()
  // 필터/정렬 (헤더 필터 버튼).
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [sortMode, setSortMode]     = useState<SortMode>('default')
  // 태그 선택 메뉴가 열린 워크플로 id (행 아래로 펼침).
  const [editTagsId, setEditTagsId] = useState<string | null>(null)

  // 태그 선택 가능 여부(저장 콜백 유무). 생성은 불가 — WF 탭은 기존 태그만 고른다.
  const canEditTags = !!onUpdateTags

  // 전체 워크플로에서 쓰인 태그 모음 (필터 옵션).
  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const wf of workflows) for (const t of wf.tags ?? []) s.add(t)
    return [...s].sort()
  }, [workflows])

  // 선택 팔레트 = 기본 태그 ∪ 이미 쓰인 태그 (소문자·중복 제거). WF 탭은 여기서만 고른다.
  const tagPalette = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = []
    for (const t of [...DEFAULT_TAGS, ...allTags]) {
      const n = t.trim().toLowerCase()
      if (n && !seen.has(n)) { seen.add(n); out.push(n) }
    }
    return out
  }, [allTags])

  // 필터(선택 태그 중 하나라도 가진 것) + 정렬(날짜) 적용.
  const visibleWorkflows = useMemo(() => {
    let list = workflows
    if (filterTags.length) {
      list = list.filter(wf => (wf.tags ?? []).some(t => filterTags.includes(t)))
    }
    if (sortMode === 'recent' || sortMode === 'oldest') {
      const dir = sortMode === 'recent' ? -1 : 1
      list = [...list].sort((a, b) => dir * ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? -1 : (a.updatedAt ?? '') > (b.updatedAt ?? '') ? 1 : 0))
    }
    return list
  }, [workflows, filterTags, sortMode])

  const filtersActive = filterTags.length > 0 || sortMode !== 'default'

  // 'embedded' 모드는 collapse 자체를 무시 — 워크플로 뷰의 좌측 상단에서는
  // 항상 펼쳐져 있어야 한다.
  if (collapsed && variant === 'overlay') {
    return (
      <button
        title="Show Workflow Lists"
        onClick={onToggleCollapse}
        style={{
          width: 24,
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-subtle)',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          fontSize: 10,
          writingMode: 'vertical-rl',
          padding: '12px 0',
        }}
      >
        ◀ Workflows
      </button>
    )
  }

  const submitCreate = async () => {
    const t = newTitle.trim()
    if (!t) return
    setBusy(true)
    try {
      const wf = await onCreate(t)
      if (wf) {
        setNewTitle('')
        setShowCreate(false)
        onSelect(wf.id)
      }
    } finally {
      setBusy(false)
    }
  }

  const isEmbedded = variant === 'embedded'
  return (
    <aside style={{
      width: isEmbedded ? '100%' : 220,
      background: 'var(--bg-surface)',
      borderLeft: isEmbedded ? undefined : '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      minHeight: 0,
    }}>
      {confirmDialog}
      <header style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          flex: 1,
        }}>
          Workflows
        </span>
        {/* 필터/정렬 — 태그별·날짜별 보기. 활성 필터가 있으면 accent 로 강조. */}
        {(
          <button
            title="Filter & sort"
            onClick={() => setFilterOpen(v => !v)}
            style={{
              border: 'none', background: filterOpen ? 'var(--bg-active)' : 'transparent',
              color: filtersActive || filterOpen ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer', padding: '2px 4px', borderRadius: 'var(--radius-sm)',
              display: 'flex', alignItems: 'center',
            }}
          >
            <ListFilter size={13} strokeWidth={1.6} />
          </button>
        )}
        {filterOpen && (
          <FilterMenu
            allTags={allTags}
            filterTags={filterTags}
            sortMode={sortMode}
            onToggleTag={(t) => setFilterTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}
            onSort={setSortMode}
            onClear={() => { setFilterTags([]); setSortMode('default') }}
            onClose={() => setFilterOpen(false)}
          />
        )}
        {!isEmbedded && (
          <button
            title="Hide"
            onClick={onToggleCollapse}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 10,
              padding: 0,
            }}
          >
            ▶
          </button>
        )}
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {isLoading ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)' }}>
            Loading…
          </div>
        ) : workflows.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            No workflows yet
          </div>
        ) : visibleWorkflows.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            No workflows match this filter
          </div>
        ) : (
          visibleWorkflows.map(wf => {
            const isActive = wf.id === activeId
            const isRunning = runningIds.includes(wf.id)
            // 완료/실패 배지는 실행 중이 아닐 때만 (running dot 과 겹치지 않게).
            const finished = !isRunning ? finishedStatus[wf.id] : undefined
            return (
              <div key={wf.id}>
                <div
                  onClick={() => { markWorkflowOpened(wf.id); onSelect(wf.id) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 14px',
                    fontSize: 12,
                    cursor: 'pointer',
                    background: isActive ? 'var(--bg-active)' : 'transparent',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                  onMouseEnter={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'
                  }}
                  onMouseLeave={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                  }}
                >
                  {/* 상태 점 — new(초록)/unseen(흰)/seen(회색). 작은 5px 원. */}
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: workflowDotColor(wf.id), flexShrink: 0, display: 'inline-block' }} />
                  <span style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {wf.title}
                  </span>
                  {isRunning && (
                    <span title="Test running" style={{
                      flexShrink: 0, width: 7, height: 7, borderRadius: '50%',
                      background: 'var(--accent)',
                      animation: 'spin 0.9s ease-in-out infinite alternate',
                      display: 'inline-block',
                    }} />
                  )}
                  {finished && (
                    <span
                      title={finished === 'done' ? 'Test finished' : 'Test failed'}
                      style={{
                        flexShrink: 0,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 12, height: 12, borderRadius: '50%',
                        fontSize: 8, lineHeight: 1, fontWeight: 700,
                        color: '#fff',
                        background: finished === 'done' ? 'var(--accent)' : 'var(--danger)',
                      }}
                    >
                      {finished === 'done' ? '✓' : '!'}
                    </span>
                  )}
                  {/* 태그 — 예전 RSCH/EXEC 배지 자리. 클릭하면 아래에 기존 태그 선택
                      메뉴가 펼쳐진다(생성 불가 — 새 태그는 Team Dashboard 에서만). 최대 1개. */}
                  {wf.tags?.length ? (
                    <span
                      onClick={canEditTags ? (e => { e.stopPropagation(); setEditTagsId(editTagsId === wf.id ? null : wf.id) }) : undefined}
                      title={canEditTags ? `Tag: ${wf.tags[0]} · click to change (pick from existing)` : `Tag: ${wf.tags[0]}`}
                      style={{ display: 'flex', alignItems: 'center', flexShrink: 0, maxWidth: 96, cursor: canEditTags ? 'pointer' : 'default' }}
                    >
                      <TagChip label={wf.tags[0]} />
                    </span>
                  ) : (
                    <span
                      onClick={canEditTags ? (e => { e.stopPropagation(); setEditTagsId(editTagsId === wf.id ? null : wf.id) }) : undefined}
                      title={canEditTags ? 'Pick a tag (existing only · create new in Team Dashboard)' : 'No tag'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
                        fontSize: 8.5, color: 'var(--text-muted)', opacity: 0.6,
                        border: '1px dashed var(--border-subtle)', borderRadius: 4,
                        padding: '0 4px', lineHeight: '14px', cursor: canEditTags ? 'pointer' : 'default',
                      }}
                    >
                      <TagIcon size={8} strokeWidth={1.8} /> tag
                    </span>
                  )}
                  <button
                    title="Delete"
                    onClick={async e => {
                      e.stopPropagation()
                      const ok = await confirm({ title: 'Delete workflow', message: `Delete "${wf.title}"?\n\nThis can't be undone.`, danger: true, confirmLabel: 'Delete' })
                      if (!ok) return
                      await onDelete(wf.id)
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: 0,
                      visibility: isActive ? 'visible' : 'hidden',
                    }}
                  >
                    ×
                  </button>
                </div>
                {/* 기존 태그 선택 메뉴 (생성 불가). 행 아래 in-flow → 스크롤 클리핑 없음. */}
                {canEditTags && editTagsId === wf.id && (
                  <div
                    onClick={e => e.stopPropagation()}
                    style={{ padding: '8px 14px 10px 22px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)' }}
                  >
                    <TagSelectMenu
                      options={tagPalette}
                      current={wf.tags ?? []}
                      onPick={(t) => {
                        const cur = wf.tags ?? []
                        const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]
                        void onUpdateTags?.(wf.id, next)   // 멀티 선택 — 메뉴 유지, 바깥 클릭/×로 닫힘
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <footer style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: 8,
      }}>
        {showCreate ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              type="text"
              autoFocus
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              placeholder="Workflow title"
              onKeyDown={e => {
                // Korean/CJK IME: don't submit while composing (else the
                // last jamo of the workflow title stays behind).
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitCreate()
                else if (e.key === 'Escape') { setShowCreate(false); setNewTitle('') }
              }}
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                fontSize: 12,
                padding: '5px 8px',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                disabled={busy || !newTitle.trim()}
                onClick={submitCreate}
                style={{
                  flex: 1,
                  background: 'var(--accent)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  color: '#fff',
                  fontSize: 11,
                  padding: '4px 6px',
                  cursor: busy || !newTitle.trim() ? 'not-allowed' : 'pointer',
                  opacity: busy || !newTitle.trim() ? 0.5 : 1,
                }}
              >
                Create
              </button>
              <button
                onClick={() => { setShowCreate(false); setNewTitle('') }}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  fontSize: 11,
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px dashed var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 11,
              padding: '5px 8px',
              cursor: 'pointer',
            }}
          >
            + New Workflow
          </button>
        )}
      </footer>
    </aside>
  )
}

// ── 태그 칩 (리스트 행) ───────────────────────────────────────────────────────
function TagChip({ label }: { label: string }) {
  return (
    <span style={{
      flexShrink: 0, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize: 8.5, fontWeight: 600, letterSpacing: 0.2,
      color: 'var(--text-secondary)', background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '0 5px', lineHeight: '14px',
    }}>
      {label}
    </span>
  )
}

// ── 필터/정렬 드롭다운 (헤더) ─────────────────────────────────────────────────
function FilterMenu({
  allTags, filterTags, sortMode, onToggleTag, onSort, onClear, onClose,
}: {
  allTags:    string[]
  filterTags: string[]
  sortMode:   SortMode
  onToggleTag: (t: string) => void
  onSort:     (m: SortMode) => void
  onClear:    () => void
  onClose:    () => void
}) {
  return (
    <>
      {/* 바깥 클릭 닫기용 오버레이 */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div style={{
        position: 'absolute', top: '100%', right: 8, marginTop: 4, zIndex: 41,
        width: 210, background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 10,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div>
          <div style={menuLabel}>Sort by date</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {([['default', 'Default'], ['recent', 'Newest'], ['oldest', 'Oldest']] as [SortMode, string][]).map(([m, lbl]) => (
              <button key={m} onClick={() => onSort(m)} style={pillStyle(sortMode === m)}>{lbl}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={menuLabel}>Filter by tag</div>
          {allTags.length === 0 ? (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>No tags yet</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {allTags.map(t => (
                <button key={t} onClick={() => onToggleTag(t)} style={pillStyle(filterTags.includes(t))}>{t}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onClear} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer', padding: 0 }}>
            Clear all
          </button>
          <button onClick={onClose} style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 10, borderRadius: 'var(--radius-sm)', padding: '3px 10px', cursor: 'pointer' }}>
            Done
          </button>
        </div>
      </div>
    </>
  )
}

const menuLabel: React.CSSProperties = {
  fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4,
  color: 'var(--text-muted)', marginBottom: 5,
}
function pillStyle(on: boolean): React.CSSProperties {
  return {
    fontSize: 10, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'var(--accent)' : 'transparent',
    color: on ? '#fff' : 'var(--text-secondary)',
  }
}
