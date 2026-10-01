// ─────────────────────────────────────────────────────────────────────────────
// FilesPanel.tsx — 좌측 사이드 패널 (Marketing IDE).
// 세로로 50/50 분할 — 위는 Files Local (per-user workspace), 아래는 Files Shared
// (team-shared root). VS Code Explorer 같은 단순 트리, 폴더 토글 + 파일 클릭.
// 파일 클릭은 기존 ChatPanel/DataPanel 의 onOpenFile 콜백을 그대로 사용한다.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'

interface Props {
  onOpenFile?: (relPath: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

type Listing = (path: string) => Promise<{ name: string; isDir: boolean }[]>

export function FilesPanel({ onOpenFile, collapsed, onToggleCollapse }: Props) {
  if (collapsed) {
    return (
      <button
        title="Show Files"
        onClick={onToggleCollapse}
        style={{
          width: 24,
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-subtle)',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          fontSize: 10,
          writingMode: 'vertical-rl',
          padding: '12px 0',
        }}
      >
        Files ▶
      </button>
    )
  }

  return (
    <aside style={{
      width: 260,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <FilesSection
        title="Files Local"
        listDir={(p) => window.twixy.listDir(p)}
        onOpenFile={onOpenFile}
        onCollapseAll={onToggleCollapse}
      />
      <div style={{ height: 1, background: 'var(--border-subtle)' }} />
      <FilesSection
        title="Files Shared"
        listDir={(p) => window.twixy.listSharedDir(p)}
        onOpenFile={onOpenFile}
      />
    </aside>
  )
}

// ── Section (Local or Shared) ───────────────────────────────────────────────
// Each section renders a tree rooted at "" with collapsible folders.
// Open folders are tracked in a Set<string> of absolute (within-root) paths.
// Children are loaded lazily on first open and cached in state.

interface SectionProps {
  title: string
  listDir: Listing
  onOpenFile?: (relPath: string) => void
  onCollapseAll?: () => void
}

function FilesSection({ title, listDir, onOpenFile, onCollapseAll }: SectionProps) {
  const [entries, setEntries]     = useState<Record<string, { name: string; isDir: boolean }[]>>({})
  const [openDirs, setOpenDirs]   = useState<Set<string>>(new Set(['']))
  const [loading, setLoading]     = useState(false)
  const [error,   setError]       = useState<string | null>(null)

  const loadDir = useCallback(async (dir: string) => {
    try {
      const list = await listDir(dir)
      setEntries(prev => ({ ...prev, [dir]: Array.isArray(list) ? list : [] }))
      setError(null)
    } catch (e) {
      setError((e as Error)?.message ?? 'list_failed')
    }
  }, [listDir])

  // initial root
  useEffect(() => {
    setLoading(true)
    loadDir('').finally(() => setLoading(false))
  }, [loadDir])

  const toggleDir = useCallback(async (dir: string) => {
    const isOpen = openDirs.has(dir)
    const next = new Set(openDirs)
    if (isOpen) {
      next.delete(dir)
    } else {
      next.add(dir)
      if (!entries[dir]) await loadDir(dir)
    }
    setOpenDirs(next)
  }, [openDirs, entries, loadDir])

  return (
    <section style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <header style={{
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
          {title}
        </span>
        {onCollapseAll && (
          <button
            title="Hide Files panel"
            onClick={onCollapseAll}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 10,
              padding: 0,
            }}
          >
            ◀
          </button>
        )}
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {loading ? (
          <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-muted)' }}>
            Loading…
          </div>
        ) : error ? (
          <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--red)' }}>
            {error}
          </div>
        ) : (
          <TreeLevel
            dir=""
            depth={0}
            entries={entries}
            openDirs={openDirs}
            toggleDir={toggleDir}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </section>
  )
}

interface TreeLevelProps {
  dir: string
  depth: number
  entries: Record<string, { name: string; isDir: boolean }[]>
  openDirs: Set<string>
  toggleDir: (dir: string) => void
  onOpenFile?: (relPath: string) => void
}

function TreeLevel({ dir, depth, entries, openDirs, toggleDir, onOpenFile }: TreeLevelProps) {
  const list = entries[dir]
  if (!list) return null
  if (list.length === 0 && depth === 0) {
    return (
      <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        (empty)
      </div>
    )
  }
  const sorted = [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return (
    <>
      {sorted.map(entry => {
        const childPath = dir ? `${dir}/${entry.name}` : entry.name
        const isOpen   = entry.isDir && openDirs.has(childPath)
        return (
          <div key={childPath}>
            <div
              onClick={() => entry.isDir ? toggleDir(childPath) : onOpenFile?.(childPath)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                paddingLeft: 10 + depth * 12,
                paddingRight: 12,
                paddingTop: 2,
                paddingBottom: 2,
                fontSize: 12,
                color: entry.isDir ? 'var(--text-secondary)' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'
                ;(e.currentTarget as HTMLDivElement).style.color = 'var(--text-primary)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                ;(e.currentTarget as HTMLDivElement).style.color = entry.isDir ? 'var(--text-secondary)' : 'var(--text-muted)'
              }}
            >
              <span style={{
                fontSize: 8,
                color: 'var(--text-muted)',
                opacity: entry.isDir ? 0.7 : 0,
                width: 8,
                display: 'inline-block',
                transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.12s',
              }}>
                ▸
              </span>
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: entry.isDir ? 500 : 400,
              }}>
                {entry.name}
              </span>
            </div>
            {entry.isDir && isOpen && (
              <TreeLevel
                dir={childPath}
                depth={depth + 1}
                entries={entries}
                openDirs={openDirs}
                toggleDir={toggleDir}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        )
      })}
    </>
  )
}
