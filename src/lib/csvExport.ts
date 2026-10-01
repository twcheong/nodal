// ── CSV export — TableData → CSV 문자열 → 브라우저 다운로드 ─────────────
// DataPanel 에 있던 것을 옮겼다. ChatPanel 이 이 두 함수 때문에 './DataPanel' 을
// 정적으로 import 했고, 그 한 줄이 DataPanel + tiptap(prosemirror) + papaparse 를
// 초기 JS 에 묶어 두고 있었다 (sidetab 창까지). DataPanel 을 첫 방문 때 로드하려면
// 컴포넌트 밖에 있어야 한다. DataPanel 은 기존 import 경로 호환을 위해 재-export 한다.

export interface TableData {
  headers: string[]
  rows:    string[][]
  truncated: boolean
}

export function toCSV(data: TableData): string {
  const esc = (v: string) => {
    const s = v ?? ''
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [data.headers.map(esc).join(',')]
  for (const row of data.rows) lines.push(row.map(esc).join(','))
  return lines.join('\n')
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename.replace(/\.(csv|tsv|json)$/i, '') + '.csv'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
