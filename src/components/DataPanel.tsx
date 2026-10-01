// ═════════════════════════════════════════════════════════════════════════════
// DataPanel.tsx — 워크스페이스 파일 브라우저 + 인라인 뷰어/편집기.
//
// 좌측: 섹션(Raw / Saved / Insights / Strategies / Reports) 트리
// 우측: 선택된 파일을 포맷에 맞춰 렌더
//   · .csv / .tsv / .json / .md → TableView (표)
//   · 이미지 확장자           → 이미지 프리뷰
//   · .md                     → Tiptap WYSIWYG 편집기
//   · 그 외                   → 텍스트 뷰어
//
// 컨텍스트 메뉴로 제공하는 액션:
//   · Open in Finder/Explorer · Rename · Delete · Move · Smart Export (→ 챗 스킬)
//   · Visualize (→ DashboardPanel)
//
// 외부에 노출되는 유틸:
//   · buildTable(name, content) — 파일 내용을 파싱해 TableData 생성
//   · toCSV / downloadCSV       — 표 → CSV 내보내기 (본체는 lib/csvExport, 여기서는 재-export)
// ═════════════════════════════════════════════════════════════════════════════

import { useEffect, useLayoutEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { Languages, FileDown, MessageCircle, Sparkles, Star, FolderOpen, Trash2, Folder, FileText, FileBox, BarChart3, Download } from 'lucide-react'
import { marked } from 'marked'
import { safeHtml } from '../lib/safeHtml'
import Papa from 'papaparse'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { Markdown } from '@tiptap/markdown'
// TableData · toCSV · downloadCSV 의 본체는 lib/csvExport. ChatPanel 이 그 둘 때문에 이 파일을
// 정적으로 import 하면 tiptap 까지 초기 JS 에 묶인다 — 그래서 컴포넌트 밖으로 뺐다.
// 아래 재-export 는 기존 import 경로(DataPanel.test, DashboardPanel) 호환용.
import { toCSV, downloadCSV, type TableData } from '../lib/csvExport'
export { toCSV, downloadCSV, type TableData }

// list-dir IPC 가 반환하는 파일/폴더 엔트리 1개.
interface Entry {
  name: string
  isDir: boolean
  path: string
  mtimeMs?: number
  // 루트 탐색기에서 "섹션 폴더"를 나타낼 때만 설정 — 클릭 시 그 섹션으로 진입.
  section?: DataSection
}

// 좌측 사이드바에 표시되는 5개 섹션 식별자.
type DataSection = 'raw' | 'insights' | 'saved' | 'strategies' | 'reports'

// 섹션 메타데이터 — id/라벨/아이콘/실제 워크스페이스 하위 경로.
const sections: { id: DataSection; label: string; icon: string; dir: string }[] = [
  { id: 'raw',        label: 'Raw Data',   icon: '⊞', dir: 'data/raw' },
  { id: 'saved',      label: 'Key Data',   icon: '◧', dir: 'data/saved' },
  { id: 'insights',   label: 'Insights',   icon: '◈', dir: 'data/insights' },
  { id: 'strategies', label: 'Strategies', icon: '◎', dir: 'strategies' },
  { id: 'reports',    label: 'Reports',    icon: '⊙', dir: 'data/reports' },
]

// 특정 섹션 루트에 합쳐 표시할 추가 디렉터리.
// 예: raw 섹션에서 exports/ 를 같이 보여줘 사용자가 수집/내보낸 파일을 한 화면에서 관리할 수 있게 함.
const MERGED_DIRS: Partial<Record<DataSection, string[]>> = {
  raw: ['exports'],
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'])
const TABLE_EXTS = new Set(['csv', 'tsv', 'json', 'md', 'markdown'])
const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
const isImage = (name: string) => IMAGE_EXTS.has(ext(name))
const isTableable = (name: string) => TABLE_EXTS.has(ext(name))

// ── Table parsers — 파일 내용을 공통 TableData 형태로 변환 ──────────────────
// CSV / JSON / Markdown 각각 파싱 후 TableView 가 바로 렌더할 수 있는 구조로 정규화.
// MAX_ROWS 로 행 수를 제한해 거대한 파일에서도 UI 멈춤 없이 프리뷰 가능.

const MAX_ROWS = 200

function parseCSV(text: string, delim?: string): TableData {
  const result = Papa.parse<string[]>(text.trim(), {
    delimiter:       delim,   // undefined = auto-detect
    skipEmptyLines:  true,
    header:          false,
  })
  const all     = result.data as string[][]
  const headers = all[0]?.map(String) ?? []
  const dataRows = all.slice(1)
  const truncated = dataRows.length > MAX_ROWS
  const rows = dataRows.slice(0, MAX_ROWS).map(r => {
    // Pad/trim to header length
    const out = r.map(String)
    while (out.length < headers.length) out.push('')
    return out.slice(0, headers.length)
  })
  return { headers, rows, truncated }
}

function parseJSON(text: string): TableData | null {
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
      const headers = Object.keys(data[0])
      const rows    = data.slice(0, MAX_ROWS).map(
        (row: Record<string, unknown>) => headers.map(h => String(row[h] ?? ''))
      )
      return { headers, rows, truncated: data.length > MAX_ROWS }
    }
    // Single object → key-value table
    if (typeof data === 'object' && !Array.isArray(data)) {
      return {
        headers:   ['Key', 'Value'],
        rows:      Object.entries(data as Record<string, unknown>)
                     .slice(0, MAX_ROWS)
                     .map(([k, v]) => [k, JSON.stringify(v)]),
        truncated: Object.keys(data as object).length > MAX_ROWS,
      }
    }
    return null
  } catch { return null }
}

function parseMarkdownAll(text: string): TableData[] {
  const lines = text.split(/\r?\n/)
  const splitRow = (l: string) => {
    let s = l.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|'))   s = s.slice(0, -1)
    return s.split('|').map(c => c.trim())
  }
  const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l)

  const tables: TableData[] = []
  let i = 0
  while (i < lines.length - 1) {
    if (lines[i].includes('|') && isSep(lines[i + 1])) {
      const headers = splitRow(lines[i])
      const rows: string[][] = []
      let truncated = false
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        if (rows.length >= MAX_ROWS) { truncated = true; break }
        const cells = splitRow(lines[j])
        while (cells.length < headers.length) cells.push('')
        rows.push(cells.slice(0, headers.length))
        j++
      }
      tables.push({ headers, rows, truncated })
      i = j
    } else {
      i++
    }
  }
  return tables
}

function parseMarkdown(text: string): TableData | null {
  const all = parseMarkdownAll(text)
  return all[0] ?? null
}

// 파일명 확장자에 따라 적절한 파서를 골라 호출하는 공개 팩토리.
// ChatPanel / DashboardPanel 에서도 재사용한다.
export function buildTable(name: string, content: string): TableData | null {
  const e = ext(name)
  if (e === 'csv')      return parseCSV(content, ',')
  if (e === 'tsv')      return parseCSV(content, '\t')
  if (e === 'json')     return parseJSON(content)
  if (e === 'md' || e === 'markdown') return parseMarkdown(content)
  return null
}

// ── Tiptap WYSIWYG markdown editor — .md 파일 편집용 ─────────────────────
// Tiptap StarterKit + Table + Markdown 확장으로 리치 편집 + 마크다운 왕복 보존.
// 부모(DataPanel) 가 ref 를 통해 getMarkdown/setMarkdown 을 호출할 수 있도록 imperative handle 노출.

export interface MdEditorHandle { save: () => void }

const MdEditor = forwardRef<MdEditorHandle, {
  initialContent: string
  onDirty: () => void
  onSave: (md: string) => Promise<void>
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
}>(function MdEditor({ initialContent, onDirty, onSave, saveStatus }, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown,
    ],
    content: initialContent,
    contentType: 'markdown',  // tells Markdown extension to parse initial content as markdown
    editorProps: {
      attributes: {
        class: 'md-render',
        style: 'min-height:200px; padding:4px 2px;',
      },
    },
    onUpdate: () => onDirty(),
  })

  // Re-parse when file changes
  const prevContent = useRef(initialContent)
  useEffect(() => {
    if (!editor || initialContent === prevContent.current) return
    prevContent.current = initialContent
    editor.commands.setContent(initialContent, { contentType: 'markdown' })
  }, [initialContent, editor])

  const handleSave = async () => {
    if (!editor) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md: string = (editor as any).getMarkdown()
    await onSave(md)
  }

  useImperativeHandle(ref, () => ({ save: handleSave }), [editor])

  return (
    <EditorContent editor={editor} style={{ flex: 1, overflowY: 'auto' }} />
  )
})

// ── Context menu — 파일 우클릭 메뉴 ──────────────────────────────────────
// Smart Export / Visualize / Rename / Delete 등 파일별 액션 제공.
// 좌표(x, y)는 화면 절대 좌표. 클릭 바깥 감지로 자동 닫힘.

interface CtxMenu { x: number; y: number; entry: Entry }

function ContextMenu({
  menu, section, isTwixyHosting, onVisualize, onExportCSV, onExportPDF, onLangCorrect, onAskAbout, onReveal, onPromoteToKey, onDelete, onClose,
}: {
  menu:            CtxMenu
  section:         DataSection
  isTwixyHosting?: boolean
  onVisualize?:    (e: Entry) => void
  onExportCSV:     (e: Entry) => void
  onExportPDF:     (e: Entry) => void
  onSmartExport:   (e: Entry) => void
  onLangCorrect:   (e: Entry) => void
  onAskAbout:      (e: Entry) => void
  onReveal:        (e: Entry) => void
  onPromoteToKey:  (e: Entry) => void
  onPropose:       (e: Entry) => void
  onProposeDelete: (e: Entry) => void
  onDelete:        (e: Entry) => void
  onClose:         () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose()
    }
    // tiny delay so the originating right-click doesn't immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', close), 50)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [onClose])

  // 실제 메뉴 크기를 재서 화면 밖으로 넘치면 위/왼쪽으로 뒤집는다.
  // (아래쪽에서 우클릭하면 커서 위로 펼쳐져 잘리지 않음.)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const pad = 8
    const w = el.offsetWidth, h = el.offsetHeight
    let nx = menu.x, ny = menu.y
    if (nx + w > window.innerWidth  - pad) nx = Math.max(pad, window.innerWidth  - w - pad)
    if (ny + h > window.innerHeight - pad) ny = Math.max(pad, menu.y - h)  // 위로 펼침
    setPos({ x: nx, y: ny })
  }, [menu.x, menu.y])
  const { x, y } = pos

  const item: React.CSSProperties = {
    display:      'flex',
    alignItems:   'center',
    gap:           8,
    width:        '100%',
    padding:      '7px 12px',
    border:       'none',
    background:   'transparent',
    color:        'var(--text)',
    fontSize:      12,
    textAlign:    'left',
    cursor:       'pointer',
    borderRadius: 'var(--radius-sm)',
  }

  return (
    <div
      ref={ref}
      style={{
        position:     'fixed',
        top:           y,
        left:          x,
        zIndex:        9999,
        background:   'var(--bg-surface)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow:    '0 8px 28px rgba(0,0,0,0.45)',
        minWidth:      160,
        padding:       4,
      }}
    >
      {!menu.entry.isDir && (
        <button
          style={item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onAskAbout(menu.entry); onClose() }}
        >
          <MessageCircle size={13} strokeWidth={1.7} /> Ask about this
        </button>
      )}
      {onVisualize && (
        <button
          style={item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onVisualize(menu.entry); onClose() }}
        >
          <BarChart3 size={13} strokeWidth={1.7} /> Visualize
        </button>
      )}
      {isTableable(menu.entry.name) && (
        <button
          style={item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onExportCSV(menu.entry); onClose() }}
        >
          <Download size={13} strokeWidth={1.7} /> Export as CSV
        </button>
      )}
      {(ext(menu.entry.name) === 'md' || ext(menu.entry.name) === 'markdown') && (
        <button
          style={item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onExportPDF(menu.entry); onClose() }}
        >
          <Download size={13} strokeWidth={1.7} /> Export as PDF
        </button>
      )}
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
      {isTwixyHosting && !menu.entry.isDir && (
        <button
          style={item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onClose(); onLangCorrect(menu.entry) }}
          title="Fix language hallucinations using the sub-agent model"
        >
          <Languages size={13} strokeWidth={1.7} /> Correct Language
        </button>
      )}
      {section === 'raw' && !menu.entry.isDir && (
        <button
          style={item}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onPromoteToKey(menu.entry); onClose() }}
          title="Promote this file from Raw Data to Key Data (manual curation)"
        >
          <Star size={13} strokeWidth={1.7} /> Move to Key Data
        </button>
      )}
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
      <button
        style={item}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        onClick={() => { onReveal(menu.entry); onClose() }}
      >
        <FolderOpen size={13} strokeWidth={1.7} /> Open in Finder
      </button>
      <button
        style={{ ...item, color: 'var(--danger)' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(181, 72, 47,0.12)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        onClick={() => { onDelete(menu.entry); onClose() }}
      >
        <Trash2 size={13} strokeWidth={1.7} /> Delete
      </button>
    </div>
  )
}

// ── Table renderer — TableData 를 실제 <table> 로 그리는 뷰 ──────────────
// 정렬, 내보내기(CSV/번역) 버튼 포함. 행 수가 많으면 상단에 제한 알림 표시.

function TableView({
  data,
  editable = false,
  onCellChange,
  onHeaderChange,
}: {
  data: TableData
  editable?: boolean
  onCellChange?: (ri: number, ci: number, val: string) => void
  onHeaderChange?: (ci: number, val: string) => void
}) {
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [editing])

  const cellStyle: React.CSSProperties = {
    padding:      0,
    borderBottom: '1px solid var(--border-subtle)',
    maxWidth:      200,
    position:     'relative',
  }

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '100%' }}>
      {data.truncated && (
        <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--warning)' }}>
          Showing first {MAX_ROWS} rows
        </p>
      )}
      <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%', tableLayout: 'auto' }}>
        <thead>
          <tr>
            {data.headers.map((h, ci) => (
              <th key={ci} style={{
                padding:      0,
                textAlign:    'left',
                fontWeight:   600,
                background:   'var(--bg-surface)',
                borderBottom: '2px solid var(--border)',
                whiteSpace:   'nowrap',
                position:     'sticky',
                top:          0,
              }}>
                {editable ? (
                  <input
                    defaultValue={h}
                    onBlur={e => onHeaderChange?.(ci, e.target.value)}
                    style={{
                      width:      '100%',
                      padding:    '5px 10px',
                      background: 'transparent',
                      border:     'none',
                      outline:    'none',
                      color:      'var(--text-primary)',
                      fontWeight:  600,
                      fontSize:    11,
                      fontFamily: 'inherit',
                      cursor:     'text',
                    }}
                  />
                ) : (
                  <span style={{ padding: '5px 10px', display: 'block' }}>{h}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--bg-surface)' }}>
              {row.map((cell, ci) => (
                <td key={ci} style={cellStyle}>
                  {editable && editing?.ri === ri && editing?.ci === ci ? (
                    <input
                      ref={inputRef}
                      defaultValue={cell}
                      onBlur={e => { onCellChange?.(ri, ci, e.target.value); setEditing(null) }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { onCellChange?.(ri, ci, (e.target as HTMLInputElement).value); setEditing(null) }
                        if (e.key === 'Escape') setEditing(null)
                        if (e.key === 'Tab') {
                          e.preventDefault()
                          onCellChange?.(ri, ci, (e.target as HTMLInputElement).value)
                          const nextCi = ci + 1
                          if (nextCi < row.length) setEditing({ ri, ci: nextCi })
                          else if (ri + 1 < data.rows.length) setEditing({ ri: ri + 1, ci: 0 })
                          else setEditing(null)
                        }
                      }}
                      style={{
                        width:      '100%',
                        padding:    '4px 10px',
                        background: 'var(--bg-active)',
                        border:     '1px solid var(--accent)',
                        borderRadius: 0,
                        outline:    'none',
                        color:      'var(--text-primary)',
                        fontSize:    11,
                        fontFamily: 'inherit',
                      }}
                    />
                  ) : (
                    <span
                      title={cell}
                      onClick={() => editable && setEditing({ ri, ci })}
                      style={{
                        display:      'block',
                        padding:      '4px 10px',
                        color:        'var(--text-muted)',
                        overflow:     'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace:   'nowrap',
                        cursor:       editable ? 'text' : 'default',
                        minWidth:     40,
                        minHeight:    22,
                      }}
                    >{cell}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main component — DataPanel 본체 ──────────────────────────────────────
// 좌측 섹션 사이드바, 중앙 파일 트리, 우측 뷰어/편집기 3컬럼 구조.
// App.tsx 가 넘기는 fileToOpen 경로가 있으면 자동으로 그 파일을 열어둔다.

interface DataPanelProps {
  onVisualize?:    (filePath: string, fileName: string) => void
  onSmartExport?:  (filePath: string, fileName: string) => void
  onAskAbout?:     (filePath: string, fileName: string) => void
  fileToOpen?:     string | null   // relative path from workspace root e.g. "data/raw/foo.md"
  isTwixyHosting?: boolean
}

// Map a workspace-relative path to the section + subdir + filename
// ChatPanel 이 링크 클릭으로 보낸 상대 경로를 섹션+서브디렉터리+파일명으로 분해.
// 어떤 섹션에도 매칭되지 않으면 null 반환 (워크스페이스 밖 경로 방어).
function resolveFileToOpen(relPath: string): { section: DataSection; subDir: string; fileName: string } | null {
  for (const s of sections) {
    if (relPath.startsWith(s.dir + '/')) {
      const rest = relPath.slice(s.dir.length + 1)
      const parts = rest.split('/')
      const fileName = parts.pop()!
      const subDir = parts.join('/')
      return { section: s.id, subDir, fileName }
    }
  }
  return null
}

export function DataPanel({ onVisualize, onSmartExport, onAskAbout, fileToOpen, isTwixyHosting }: DataPanelProps) {
  // null = /data 루트 (섹션들을 폴더로 표시하는 파일탐색기 진입점).
  const [active, setActive]               = useState<DataSection | null>(null)
  const [currentDir, setCurrentDir]       = useState<string>('')
  const [entries, setEntries]             = useState<Entry[]>([])
  const [sortMode, setSortMode]           = useState<'name' | 'recent'>('name')
  const [selectedFile, setSelectedFile]   = useState<string | null>(null)
  const [fileContent, setFileContent]     = useState<string | null>(null)
  const [imageSrc, setImageSrc]           = useState<string | null>(null)
  const [tableData, setTableData]         = useState<TableData | null>(null)
  const [viewMode, setViewMode]           = useState<'raw' | 'table' | 'markdown' | 'edit' | 'md-edit'>('raw')
  const [editContent, setEditContent]     = useState<string>('')
  const [tableEdits, setTableEdits]       = useState<TableData | null>(null)
  const [tableDirty, setTableDirty]       = useState(false)
  const [tableEditMode, setTableEditMode] = useState(false)
  const [saveStatus, setSaveStatus]       = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [refreshKey, setRefreshKey]       = useState(0)
  const [ctxMenu, setCtxMenu]             = useState<CtxMenu | null>(null)
  const [langCorrectingPaths, setLangCorrectingPaths] = useState<Set<string>>(new Set())
  const [langCorrectConfirm, setLangCorrectConfirm]   = useState<Entry | null>(null)
  const [proposeEntry, setProposeEntry] = useState<Entry | null>(null)
  const [proposeMode,  setProposeMode]  = useState<'upsert' | 'delete'>('upsert')
  const [proposeTitle, setProposeTitle] = useState('')
  const [proposeDesc,  setProposeDesc]  = useState('')
  const [proposeBusy,  setProposeBusy]  = useState(false)
  const [proposeMsg,   setProposeMsg]   = useState<string | null>(null)
  const mdEditorRef = useRef<MdEditorHandle>(null)
  const [listWidth, setListWidth]         = useState(220)
  const isDragging                        = useRef(false)
  const dragStartX                        = useRef(0)
  const dragStartW                        = useRef(220)

  const onDividerMouseDown = (e: React.MouseEvent) => {
    isDragging.current  = true
    dragStartX.current  = e.clientX
    dragStartW.current  = listWidth
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = e.clientX - dragStartX.current
      setListWidth(Math.max(140, Math.min(480, dragStartW.current + delta)))
    }
    const onUp = () => { isDragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const activeSection = active ? sections.find(s => s.id === active) ?? null : null
  const rootDir  = activeSection?.dir ?? 'data'
  const browseDir = active ? (currentDir ? `${rootDir}/${currentDir}` : rootDir) : 'data'

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  // Open a file programmatically when requested from outside (e.g. chat click)
  useEffect(() => {
    if (!fileToOpen) return
    const resolved = resolveFileToOpen(fileToOpen)
    if (!resolved) return
    const { section, subDir, fileName } = resolved
    setActive(section)
    setCurrentDir(subDir)
    setSelectedFile(null)
    setFileContent(null)
    setImageSrc(null)
    setTableData(null)
    setViewMode('raw')
    // After the directory loads, open the file
    const timer = setTimeout(async () => {
      const dir = sections.find(s => s.id === section)!.dir
      const browsePath = subDir ? `${dir}/${subDir}` : dir
      const filePath = `${browsePath}/${fileName}`
      if (isImage(fileName)) {
        const dataUrl = await window.twixy.readImage(filePath)
        setSelectedFile(fileName)
        setImageSrc(dataUrl)
      } else {
        const content = await window.twixy.readFile(filePath)
        setSelectedFile(fileName)
        setFileContent(content)
        setEditContent(content ?? '')
        setSaveStatus('idle')
        const e = ext(fileName)
        if (e === 'md' || e === 'markdown') setViewMode('markdown')
        else if ((e === 'csv' || e === 'tsv') && content) {
          const parsed = parseCSV(content, e === 'tsv' ? '\t' : undefined)
          setTableData(parsed)
          setTableEdits(JSON.parse(JSON.stringify(parsed)))
          setTableDirty(false)
          setViewMode('table')
        }
      }
    }, 120)
    return () => clearTimeout(timer)
  }, [fileToOpen])

  // Reset on section change
  useEffect(() => {
    setCurrentDir('')
    setSelectedFile(null)
    setFileContent(null)
    setImageSrc(null)
    setTableData(null)
    setViewMode('raw')
    setEditContent('')
    setTableEdits(null)
    setTableDirty(false)
    setTableEditMode(false)
    setSaveStatus('idle')
  }, [active])

  // Load directory
  useEffect(() => {
    async function load() {
      // 루트(/data): 섹션들을 폴더로 나열 — 클릭하면 해당 섹션으로 진입.
      if (!active) {
        setEntries(sections.map(s => ({ name: s.label, isDir: true, path: s.dir, section: s.id })))
        return
      }
      const raw = await window.twixy.listDir(browseDir)
      const list: Entry[] = raw.map(e => ({
        name: e.name,
        isDir: e.isDir,
        path: `${browseDir}/${e.name}`,
        mtimeMs: e.mtimeMs,
      }))

      // Merge sibling directories (e.g. exports/ into raw) at the root level only.
      if (!currentDir) {
        const extras = MERGED_DIRS[active] ?? []
        for (const extraDir of extras) {
          const items = await window.twixy.listDir(extraDir)
          for (const e of items) {
            if (list.some(x => x.name === e.name)) continue
            list.push({ name: e.name, isDir: e.isDir, path: `${extraDir}/${e.name}`, mtimeMs: e.mtimeMs })
          }
        }
      }

      // 정렬은 렌더에서 sortMode 에 따라(sortedEntries) 적용한다.
      setEntries(list)
      setSelectedFile(null)
      setFileContent(null)
      setImageSrc(null)
      setTableData(null)
      setViewMode('raw')
    }
    load()
  }, [active, browseDir, refreshKey])

  const openEntry = async (entry: Entry) => {
    // 루트의 섹션 폴더 → 그 섹션으로 진입.
    if (entry.section) {
      setActive(entry.section)
      setCurrentDir('')
      return
    }
    if (entry.isDir) {
      setCurrentDir(currentDir ? `${currentDir}/${entry.name}` : entry.name)
      return
    }
    setSelectedFile(entry.name)
    setFileContent(null)
    setImageSrc(null)
    setTableData(null)
    setViewMode('raw')

    if (isImage(entry.name)) {
      const dataUrl = await window.twixy.readImage(entry.path)
      setImageSrc(dataUrl)
    } else {
      const content = await window.twixy.readFile(entry.path)
      setFileContent(content)
      setEditContent(content ?? '')
      setSaveStatus('idle')
      const e = ext(entry.name)
      if (e === 'md' || e === 'markdown') {
        setViewMode('markdown')
      } else if ((e === 'csv' || e === 'tsv') && content) {
        const parsed = parseCSV(content, e === 'tsv' ? '\t' : undefined)
        setTableData(parsed)
        setTableEdits(JSON.parse(JSON.stringify(parsed)))
        setTableDirty(false)
        setTableEditMode(false)
        setViewMode('table')
      }
    }
  }


  const handleVisualize = (entry: Entry) => {
    onVisualize?.(entry.path, entry.name)
  }

  const handleExportCSV = async (entry: Entry) => {
    let content = fileContent
    if (selectedFile !== entry.name || !content) {
      content = await window.twixy.readFile(entry.path)
    }
    if (!content) return

    const e = ext(entry.name)
    // For markdown: dump every table found into one CSV (separated by titled blocks)
    if (e === 'md' || e === 'markdown') {
      const tables = parseMarkdownAll(content)
      if (tables.length === 0) return
      const blocks = tables.map((t, idx) => {
        const title = `# Table ${idx + 1}`
        return [title, toCSV(t)].join('\n')
      })
      downloadCSV(entry.name, blocks.join('\n\n'))
      return
    }

    const parsed = buildTable(entry.name, content)
    if (!parsed) return
    downloadCSV(entry.name, toCSV(parsed))
  }

  const handleSmartExport = (entry: Entry) => {
    onSmartExport?.(entry.path, entry.name)
  }

  const handleAskAbout = (entry: Entry) => {
    onAskAbout?.(entry.path, entry.name)
  }

  const handleLangCorrect = async (entry: Entry) => {
    setLangCorrectingPaths(prev => new Set(prev).add(entry.path))
    try {
      const content = await window.twixy.readFile(entry.path)
      if (!content?.trim()) return
      const res = await window.twixy.correctLanguage({ text: content, userSample: '' })
      if (!res.ok || !res.text || res.text === content) return
      await window.twixy.writeFile(entry.path, res.text)
      if (res.tokensIn || res.tokensOut) {
        window.twixy.recordOpenRouterUsage({ tokensIn: res.tokensIn ?? 0, tokensOut: res.tokensOut ?? 0, usdDelta: 0 }).catch(() => {})
      }
      if (selectedFile === entry.name) {
        setFileContent(res.text)
        setEditContent(res.text)
      }
    } finally {
      setLangCorrectingPaths(prev => { const s = new Set(prev); s.delete(entry.path); return s })
    }
  }

  const handleExportPDF = async (entry: Entry) => {
    let content = fileContent
    if (selectedFile !== entry.name || !content) {
      content = await window.twixy.readFile(entry.path)
    }
    if (!content) return
    const html = marked(content) as string
    const res = await window.twixy.exportPDF(html, entry.name)
    if (res?.canceled) return
    if (!res?.ok) alert('PDF export failed')
  }

  const handleReveal = (entry: Entry) => {
    void window.twixy.revealInFinder(entry.path)
  }

  const handleDelete = async (entry: Entry) => {
    const ok = window.confirm(`Delete "${entry.name}"? This cannot be undone.`)
    if (!ok) return
    const res = await window.twixy.deleteFile(entry.path)
    if (res.ok) {
      if (selectedFile === entry.name) {
        setSelectedFile(null)
        setFileContent(null)
        setImageSrc(null)
        setTableData(null)
      }
      refresh()
    }
  }

  const openPropose = (entry: Entry) => {
    setProposeEntry(entry)
    setProposeMode('upsert')
    setProposeTitle(`Share ${entry.name}`)
    setProposeDesc('')
    setProposeMsg(null)
  }

  const openProposeDelete = (entry: Entry) => {
    setProposeEntry(entry)
    setProposeMode('delete')
    setProposeTitle(`Remove ${entry.name} from shared`)
    setProposeDesc('')
    setProposeMsg(null)
  }

  const submitPropose = async () => {
    if (!proposeEntry) return
    const title = proposeTitle.trim()
    if (!title) { setProposeMsg('Title required'); return }
    setProposeBusy(true)
    setProposeMsg(null)
    try {
      const sharedPath = `shared/${proposeEntry.path}`
      if (proposeMode === 'delete') {
        const exists = await window.twixy.mrReadShared(sharedPath)
        if (!exists.ok) { setProposeMsg('File is not in shared/'); return }
        const res = await window.twixy.mrCreate({
          title,
          description: proposeDesc.trim() || undefined,
          changes: [{ op: 'delete', path: sharedPath }],
        })
        if (!res.ok) { setProposeMsg(res.error || 'Failed to open MR'); return }
      } else {
        const bytes = await window.twixy.readFileBytes(proposeEntry.path)
        if (!bytes) { setProposeMsg('Failed to read file'); return }
        const exists = await window.twixy.mrReadShared(sharedPath)
        const op: 'add' | 'modify' = exists.ok ? 'modify' : 'add'
        const res = await window.twixy.mrCreate({
          title,
          description: proposeDesc.trim() || undefined,
          changes: [{ op, path: sharedPath, content: bytes }],
        })
        if (!res.ok) { setProposeMsg(res.error || 'Failed to open MR'); return }
      }
      setProposeMsg('Merge request opened')
      setTimeout(() => {
        setProposeEntry(null)
        setProposeMsg(null)
      }, 1200)
    } catch (err) {
      setProposeMsg((err as Error).message || 'Error')
    } finally {
      setProposeBusy(false)
    }
  }

  const handlePromoteToKey = async (entry: Entry) => {
    const res = await window.twixy.moveFile(entry.path, 'data/saved')
    if (res.ok) {
      setSelectedFile(null)
      setFileContent(null)
      setImageSrc(null)
      setTableData(null)
      refresh()
    }
  }

  const goUp = () => {
    if (currentDir) {
      const parts = currentDir.split('/')
      parts.pop()
      setCurrentDir(parts.join('/'))
    } else if (active) {
      // 섹션 루트에서 위로 → /data 루트(섹션 목록)로.
      setActive(null)
    } else {
      return
    }
    setSelectedFile(null)
    setFileContent(null)
    setImageSrc(null)
    setTableData(null)
    setViewMode('raw')
  }

  // 정렬 — 루트(섹션 폴더)는 순서 유지, 섹션 내부는 폴더 먼저 + 이름/최신.
  const sortedEntries = active
    ? [...entries].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        if (sortMode === 'recent') return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
        return a.name.localeCompare(b.name)
      })
    : entries

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Breadcrumb (파일탐색기 경로) + refresh — 탭 대신 폴더 경로로 이동. */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        borderBottom: '1px solid var(--border-subtle)',
        background:   'var(--bg-surface)',
        padding:      '8px 12px',
        gap:           4,
        fontSize:      12,
        overflowX:    'auto',
      }}>
        {(() => {
          // 경로 조각: Data(루트) / 섹션 / 하위폴더…
          const crumbs: { label: string; onClick: () => void }[] = [
            { label: 'Data', onClick: () => { setActive(null); setCurrentDir('') } },
          ]
          if (active && activeSection) {
            crumbs.push({ label: activeSection.label, onClick: () => setCurrentDir('') })
            const segs = currentDir ? currentDir.split('/') : []
            segs.forEach((seg, i) => {
              crumbs.push({ label: seg, onClick: () => setCurrentDir(segs.slice(0, i + 1).join('/')) })
            })
          }
          const last = crumbs.length - 1
          return crumbs.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              {i > 0 && <span style={{ color: 'var(--text-muted)' }}>/</span>}
              <button
                onClick={c.onClick}
                disabled={i === last}
                style={{
                  border: 'none', background: 'none', cursor: i === last ? 'default' : 'pointer',
                  padding: '2px 4px', fontSize: 12,
                  fontWeight: i === last ? 600 : 400,
                  color: i === last ? 'var(--text-primary)' : 'var(--accent)',
                }}
              >
                {c.label}
              </button>
            </span>
          ))
        })()}
        <button onClick={refresh} title="Refresh" style={{
          marginLeft:   'auto',
          padding:      '4px 8px',
          border:       'none',
          background:   'none',
          color:        'var(--text-muted)',
          cursor:       'pointer',
          fontSize:      14,
          borderRadius: 'var(--radius-sm)',
          lineHeight:    1,
          flexShrink:    0,
        }}>⟳</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* File list */}
        <div style={{ width: listWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

          {active && (
            <button onClick={goUp} style={{
              textAlign:    'left',
              padding:      '6px 10px',
              border:       'none',
              borderBottom: '1px solid var(--border-subtle)',
              background:   'var(--bg-surface)',
              color:        'var(--accent)',
              cursor:       'pointer',
              fontSize:      11,
              flexShrink:    0,
            }}>
              ← {currentDir ? `${rootDir}/${currentDir}` : 'Data'}
            </button>
          )}

          {/* 정렬 토글 — 섹션 안에서만 (이름순 / 최신순). */}
          {active && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
              <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', marginRight: 2 }}>Sort</span>
              {(['name', 'recent'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setSortMode(m)}
                  style={{
                    border: `1px solid ${sortMode === m ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: sortMode === m ? 'var(--accent)' : 'transparent',
                    color: sortMode === m ? '#fff' : 'var(--text-muted)',
                    borderRadius: 999, padding: '1px 9px', fontSize: 10, cursor: 'pointer',
                  }}
                >
                  {m === 'name' ? 'Name' : 'Recent'}
                </button>
              ))}
            </div>
          )}

          <div style={{ padding: 8, flex: 1, overflowY: 'auto' }}>
            {sortedEntries.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>
                No files yet
              </div>
            ) : (
              sortedEntries.map(entry => (
                <button
                  key={entry.name}
                  onClick={() => openEntry(entry)}
                  onContextMenu={e => {
                    // 파일·폴더 우클릭 컨텍스트 메뉴 (루트 섹션 폴더 포함).
                    e.preventDefault()
                    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
                  }}
                  style={{
                    width:         '100%',
                    textAlign:     'left',
                    padding:       '5px 8px',
                    borderRadius:  'var(--radius-sm)',
                    border:        'none',
                    background:    selectedFile === entry.name ? 'var(--bg-active)' : 'transparent',
                    color:         entry.isDir
                      ? 'var(--text-secondary)'
                      : (selectedFile === entry.name ? 'var(--text-primary)' : 'var(--text-secondary)'),
                    cursor:        'pointer',
                    fontSize:       12,
                    overflow:      'hidden',
                    textOverflow:  'ellipsis',
                    whiteSpace:    'nowrap',
                    display:       'flex',
                    alignItems:    'center',
                    gap:            5,
                  }}
                >
                  <span style={{ flexShrink: 0, display: 'inline-flex', color: 'var(--text-muted)' }}>
                    {entry.isDir ? <Folder size={13} strokeWidth={1.7} /> : <FileText size={13} strokeWidth={1.7} />}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{entry.name}</span>
                  {langCorrectingPaths.has(entry.path) && (
                    <span className="spin" style={{ flexShrink: 0, fontSize: 10, color: 'var(--accent)', display: 'inline-block' }}>⟳</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={onDividerMouseDown}
          style={{
            width:     5,
            flexShrink: 0,
            cursor:    'col-resize',
            background: 'var(--border-subtle)',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-dim)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--border-subtle)')}
        />

        {/* File content / table */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, userSelect: 'text', minWidth: 0 }}>

          {/* View mode toolbar */}
          {fileContent && (() => {
            const fExt = ext(selectedFile ?? '')
            const isMd = fExt === 'md' || fExt === 'markdown'
            const isCsv = fExt === 'csv' || fExt === 'tsv'
            const isEditing = viewMode === 'edit' || viewMode === 'md-edit' || tableEditMode
            const btnStyle = (active: boolean): React.CSSProperties => ({
              border: 'none',
              background: active ? 'var(--accent-dim)' : 'var(--bg-hover)',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '3px 10px',
              fontSize: 11,
              cursor: 'pointer',
              fontWeight: active ? 600 : 400,
            })
            const handleSave = async () => {
              if (!selectedFile) return
              setSaveStatus('saving')
              const filePath = currentDir
                ? `${rootDir}/${currentDir}/${selectedFile}`
                : `${rootDir}/${selectedFile}`
              let content: string
              if (viewMode === 'table' && tableEdits) {
                content = Papa.unparse(
                  [tableEdits.headers, ...tableEdits.rows],
                  { delimiter: fExt === 'tsv' ? '\t' : ',' }
                )
              } else {
                content = editContent
              }
              const res = await window.twixy.writeFile(filePath, content)
              if (res?.ok) {
                setFileContent(content)
                setEditContent(content)
                setTableDirty(false)
                setSaveStatus('saved')
                setTimeout(() => setSaveStatus('idle'), 2000)
              } else {
                setSaveStatus('error')
                setTimeout(() => setSaveStatus('idle'), 3000)
              }
            }
            return (
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {isMd && <button style={btnStyle(viewMode === 'markdown')} onClick={() => setViewMode('markdown')}>Preview</button>}
                {isMd && <button style={btnStyle(viewMode === 'md-edit')} onClick={() => setViewMode('md-edit')}>Edit</button>}
                {tableData && !isMd && <button style={btnStyle(viewMode === 'table' && !tableEditMode)} onClick={() => { setTableEditMode(false); setViewMode('table') }}>Table</button>}
                {isCsv && <button style={btnStyle(tableEditMode)} onClick={() => { setTableEditMode(true); setViewMode('table') }}>Edit</button>}
                <button style={btnStyle(viewMode === 'raw')} onClick={() => setViewMode('raw')}>Raw</button>
                {!isMd && !isCsv && <button style={btnStyle(viewMode === 'edit')} onClick={() => { setViewMode('edit'); setEditContent(fileContent ?? '') }}>Edit</button>}
                {/* Spacer */}
                <div style={{ flex: 1 }} />
                {/* Save */}
                {isEditing && (
                  <button
                    onClick={viewMode === 'md-edit' ? () => mdEditorRef.current?.save() : handleSave}
                    disabled={saveStatus === 'saving'}
                    style={{
                      border: 'none',
                      background: saveStatus === 'saved' ? 'rgba(13, 92, 80,0.15)' : saveStatus === 'error' ? 'rgba(181, 72, 47,0.15)' : 'var(--accent-dim)',
                      color: saveStatus === 'saved' ? 'var(--green)' : saveStatus === 'error' ? 'var(--red)' : 'var(--accent)',
                      borderRadius: 'var(--radius-sm)', padding: '3px 12px', fontSize: 11,
                      cursor: saveStatus === 'saving' ? 'default' : 'pointer', fontWeight: 600,
                    }}
                  >
                    {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : saveStatus === 'error' ? 'Error' : 'Save'}
                  </button>
                )}
                {/* Correct Language */}
                {isTwixyHosting && (() => {
                  const entry = entries.find(e => e.name === selectedFile)
                  if (!entry) return null
                  const correcting = langCorrectingPaths.has(entry.path)
                  return (
                    <button
                      disabled={correcting}
                      onClick={() => setLangCorrectConfirm(entry)}
                      style={{
                        ...btnStyle(false),
                        display: 'flex', alignItems: 'center', gap: 5,
                        opacity: correcting ? 0.6 : 1,
                        cursor: correcting ? 'default' : 'pointer',
                      }}
                    >
                      <Languages size={12} style={{ flexShrink: 0 }} />
                      {correcting ? 'Correcting…' : 'Correct Language'}
                    </button>
                  )
                })()}
                {/* Export PDF — only for md */}
                {isMd && (
                  <button
                    onClick={() => {
                      const entry = entries.find(e => e.name === selectedFile)
                      if (entry) handleExportPDF(entry)
                    }}
                    style={{ ...btnStyle(false), display: 'flex', alignItems: 'center', gap: 5 }}
                  >
                    <FileDown size={12} style={{ flexShrink: 0 }} />
                    Export PDF
                  </button>
                )}
              </div>
            )
          })()}

          {imageSrc ? (
            <img
              src={imageSrc}
              alt={selectedFile ?? ''}
              style={{ maxWidth: '100%', borderRadius: 'var(--radius)', display: 'block' }}
            />
          ) : viewMode === 'table' && tableData ? (
            <TableView
              data={tableEdits ?? tableData}
              editable={tableEditMode}
              onCellChange={(ri, ci, val) => {
                setTableEdits(prev => {
                  if (!prev) return prev
                  const rows = prev.rows.map(r => [...r])
                  rows[ri][ci] = val
                  return { ...prev, rows }
                })
                setTableDirty(true)
                setSaveStatus('idle')
              }}
              onHeaderChange={(ci, val) => {
                setTableEdits(prev => {
                  if (!prev) return prev
                  const headers = [...prev.headers]
                  headers[ci] = val
                  return { ...prev, headers }
                })
                setTableDirty(true)
                setSaveStatus('idle')
              }}
            />
          ) : viewMode === 'edit' ? (
            <textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setSaveStatus('idle') }}
              spellCheck={false}
              style={{
                width:       '100%',
                height:      '100%',
                minHeight:   400,
                background:  'var(--bg-surface)',
                color:       'var(--text-secondary)',
                border:      '1px solid var(--border)',
                borderRadius:'var(--radius-sm)',
                padding:      12,
                fontSize:     12,
                fontFamily:  'var(--font-mono)',
                lineHeight:   1.6,
                resize:      'none',
                outline:     'none',
              }}
            />
          ) : viewMode === 'md-edit' && fileContent !== null ? (
            <MdEditor
              ref={mdEditorRef}
              initialContent={fileContent}
              onDirty={() => setSaveStatus('idle')}
              onSave={async (md) => {
                if (!selectedFile) return
                setSaveStatus('saving')
                const filePath = currentDir
                  ? `${rootDir}/${currentDir}/${selectedFile}`
                  : `${rootDir}/${selectedFile}`
                const res = await window.twixy.writeFile(filePath, md)
                if (res?.ok) {
                  setFileContent(md)
                  setEditContent(md)
                  setSaveStatus('saved')
                  setTimeout(() => setSaveStatus('idle'), 2000)
                } else {
                  setSaveStatus('error')
                  setTimeout(() => setSaveStatus('idle'), 3000)
                }
              }}
              saveStatus={saveStatus}
            />
          ) : viewMode === 'markdown' && fileContent ? (
            <div
              className="md-render"
              dangerouslySetInnerHTML={{ __html: safeHtml(marked(fileContent, { breaks: true })) }}
              style={{  }}
              onClick={e => {
                const a = (e.target as HTMLElement).closest('a')
                if (a?.href) { e.preventDefault(); window.twixy.openExternal(a.href) }
              }}
            />
          ) : fileContent ? (
            <pre style={{
              fontFamily:  'var(--font-mono)',
              fontSize:     12,
              color:       'var(--text-secondary)',
              whiteSpace:  'pre-wrap',
              wordBreak:   'break-word',
              margin:       0,
            }}>
              {fileContent}
            </pre>
          ) : selectedFile ? (
            <div style={{
              display:      'flex',
              flexDirection:'column',
              alignItems:   'center',
              justifyContent:'center',
              gap:           8,
              padding:       24,
              color:        'var(--text-muted)',
              fontSize:      12,
              border:       '1px dashed var(--border-subtle)',
              borderRadius: 'var(--radius)',
            }}>
              <FileBox size={26} strokeWidth={1.4} style={{ color: 'var(--text-muted)' }} />
              <span>Binary file — preview unavailable</span>
              <span style={{ fontSize: 10 }}>
                Right-click → <em>Open in Finder</em> to inspect.
              </span>
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {active === 'raw'
                ? 'Select a file to view  •  Right-click for table / visualize options'
                : 'Select a file to view'}
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          isTwixyHosting={isTwixyHosting}
          onVisualize={onVisualize ? handleVisualize : undefined}
          onExportCSV={handleExportCSV}
          onExportPDF={handleExportPDF}
          onSmartExport={handleSmartExport}
          onAskAbout={handleAskAbout}
          onLangCorrect={e => setLangCorrectConfirm(e)}
          onReveal={handleReveal}
          onPromoteToKey={handlePromoteToKey}
          onPropose={openPropose}
          onProposeDelete={openProposeDelete}
          onDelete={handleDelete}
          section={active ?? 'raw'}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Propose to shared modal */}
      {proposeEntry && (
        <div
          onClick={() => !proposeBusy && setProposeEntry(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(420px, 90vw)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius)',
              padding: 22,
              color: 'var(--text-primary)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
              {proposeMode === 'delete' ? 'Propose delete from shared' : 'Propose to shared'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
              {proposeMode === 'delete' && <Trash2 size={12} strokeWidth={1.7} />}shared/{proposeEntry.path}
            </div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Title</label>
            <input
              value={proposeTitle}
              onChange={e => setProposeTitle(e.target.value)}
              disabled={proposeBusy}
              style={{
                width: '100%', padding: '7px 10px', fontSize: 12,
                background: 'var(--bg-active)', color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)', borderRadius: 6,
                marginBottom: 12, outline: 'none', fontFamily: 'inherit',
              }}
            />
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
              Description (optional)
            </label>
            <textarea
              value={proposeDesc}
              onChange={e => setProposeDesc(e.target.value)}
              disabled={proposeBusy}
              rows={3}
              style={{
                width: '100%', padding: '7px 10px', fontSize: 12,
                background: 'var(--bg-active)', color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)', borderRadius: 6,
                marginBottom: 12, outline: 'none', fontFamily: 'inherit', resize: 'vertical',
              }}
            />
            {proposeMsg && (
              <div style={{
                fontSize: 11, marginBottom: 12,
                color: proposeMsg === 'Merge request opened' ? 'var(--green)' : 'var(--red)',
              }}>{proposeMsg}</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setProposeEntry(null)}
                disabled={proposeBusy}
                style={{
                  padding: '7px 16px', background: 'transparent',
                  border: '1px solid var(--border-subtle)', borderRadius: 6,
                  color: 'var(--text-muted)', fontSize: 12,
                  cursor: proposeBusy ? 'default' : 'pointer',
                }}
              >Cancel</button>
              <button
                onClick={submitPropose}
                disabled={proposeBusy}
                style={{
                  padding: '7px 16px',
                  background: proposeMode === 'delete' ? 'var(--danger)' : 'var(--accent)',
                  border: 'none', borderRadius: 6, color: '#fff',
                  fontSize: 12, fontWeight: 600,
                  cursor: proposeBusy ? 'default' : 'pointer', opacity: proposeBusy ? 0.6 : 1,
                }}
              >{proposeBusy ? 'Opening…' : (proposeMode === 'delete' ? 'Open delete MR' : 'Open MR')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Language correction confirm modal */}
      {langCorrectConfirm && (
        <div
          onClick={() => setLangCorrectConfirm(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(380px, 90vw)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius)',
              padding: 24,
              color: 'var(--text-primary)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Correct Language</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{langCorrectConfirm.name}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 24, lineHeight: 1.6 }}>
              The sub-agent will scan for language mismatches and fix any incorrectly mixed-in characters. The file will be overwritten in place.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setLangCorrectConfirm(null)}
                style={{
                  padding: '7px 16px',
                  background: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  color: 'var(--text-muted)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => { handleLangCorrect(langCorrectConfirm); setLangCorrectConfirm(null) }}
                style={{
                  padding: '7px 16px',
                  background: 'var(--accent)',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Yes, correct
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
