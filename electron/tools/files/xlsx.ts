import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'

export type SheetSpec = {
  name: string
  /** First row is treated as the header row. */
  rows: (string | number | boolean | null)[][]
}

export type WriteXlsxPayload = {
  sheets: SheetSpec[]
}

export type ReadSheetResult = {
  name: string
  /** Sheet extent — counts trailing rows that carry formatting but no value. */
  rowCount: number
  /**
   * Rows that actually hold a value. This is the number to report to a model:
   * `rowCount` overstates it whenever a sheet has styled empty rows, and a
   * reader that is told "60 rows" but shown 56 concludes 4 went missing.
   */
  actualRowCount: number
  columnCount: number
  /** Truncated to `maxRowsPerSheet` (default 200; pass Infinity for all). */
  rows: (string | number | boolean | null)[][]
  truncated: boolean
}

export type ReadXlsxResult = {
  sheets: ReadSheetResult[]
}

const DEFAULT_MAX_ROWS = 200

export async function writeXlsx(safePath: string, payload: WriteXlsxPayload): Promise<{ bytes: number }> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Twixy'
  wb.created = new Date()
  for (const spec of payload.sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31))
    if (spec.rows.length === 0) continue
    ws.addRows(spec.rows as unknown as (string | number | boolean | null)[][])
    const headerRow = ws.getRow(1)
    headerRow.font = { bold: true }
    headerRow.commit()
    ws.columns.forEach((col) => {
      let max = 10
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = String(cell.value ?? '').length
        if (len > max) max = len
      })
      col.width = Math.min(max + 2, 60)
    })
  }
  fs.mkdirSync(path.dirname(safePath), { recursive: true })
  await wb.xlsx.writeFile(safePath)
  return { bytes: fs.statSync(safePath).size }
}

export async function readXlsx(
  safePath: string,
  options?: { maxRowsPerSheet?: number },
): Promise<ReadXlsxResult> {
  const max = options?.maxRowsPerSheet ?? DEFAULT_MAX_ROWS
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(safePath)
  const sheets: ReadSheetResult[] = []
  wb.eachSheet((ws) => {
    const rows: (string | number | boolean | null)[][] = []
    let truncated = false
    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rows.length >= max) { truncated = true; return }
      const values = row.values as unknown[]
      // exceljs uses 1-based indexing for row.values; drop the leading hole.
      const arr = Array.isArray(values) ? values.slice(1) : []
      rows.push(
        arr.map((v) => {
          if (v == null) return null
          if (typeof v === 'object' && v !== null && 'text' in (v as Record<string, unknown>)) {
            return String((v as { text: unknown }).text ?? '')
          }
          if (typeof v === 'object' && v !== null && 'result' in (v as Record<string, unknown>)) {
            const r = (v as { result: unknown }).result
            return (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean') ? r : null
          }
          if (v instanceof Date) return v.toISOString()
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
          return String(v)
        }),
      )
      void rowNum
    })
    sheets.push({
      name: ws.name,
      rowCount: ws.rowCount,
      actualRowCount: ws.actualRowCount,
      columnCount: ws.columnCount,
      rows,
      truncated,
    })
  })
  return { sheets }
}
