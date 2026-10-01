import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

/**
 * Google Sheets read/write. Mirrors the local Excel module shape so the
 * same upstream payload can drive either target with minimal adaptation.
 *
 * Reads default to the first sheet, A1:ZZ500. Callers can override via
 * `range` (standard A1 notation, optionally including a sheet name).
 */

export type SheetCell = string | number | boolean | null

export type WriteSheetSpec = {
  /** Tab name. Created if absent on a fresh spreadsheet. */
  name: string
  /** First row is treated as a header row. */
  rows: SheetCell[][]
}

export type WriteGsheetPayload = {
  /** New spreadsheet title. Used for create-or-update. */
  title?:        string
  /** Existing spreadsheet to write into. If omitted, a new one is created. */
  spreadsheetId?: string
  sheets:        WriteSheetSpec[]
}

export type WriteGsheetResult = {
  spreadsheetId: string
  url:           string
  /** Tabs that were written (in order). */
  sheets:        string[]
}

export type ReadGsheetResult = {
  spreadsheetId: string
  range:         string
  rowCount:      number
  columnCount:   number
  rows:          SheetCell[][]
}

const DEFAULT_READ_RANGE = 'A1:ZZ500'

function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`
}

export async function writeGsheet(
  auth: OAuth2Client,
  payload: WriteGsheetPayload,
): Promise<WriteGsheetResult> {
  const sheets = google.sheets({ version: 'v4', auth })

  let spreadsheetId = payload.spreadsheetId
  if (!spreadsheetId) {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: payload.title ?? 'Twixy Sheet' },
        sheets: payload.sheets.map((s) => ({ properties: { title: s.name.slice(0, 100) } })),
      },
    })
    spreadsheetId = created.data.spreadsheetId ?? undefined
    if (!spreadsheetId) throw new Error('gsheet_create_failed_no_id')
  } else {
    // Make sure each requested tab exists. Add missing tabs in one batch.
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' })
    const have = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title ?? ''))
    const missing = payload.sheets.filter((s) => !have.has(s.name))
    if (missing.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: missing.map((s) => ({ addSheet: { properties: { title: s.name.slice(0, 100) } } })),
        },
      })
    }
  }

  // Bulk-write each tab. valueInputOption=RAW so numbers stay numeric and
  // strings don't get re-parsed as formulas.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: payload.sheets.map((s) => ({
        range:  `${s.name}!A1`,
        values: s.rows as unknown[][],
      })),
    },
  })

  return {
    spreadsheetId,
    url:    spreadsheetUrl(spreadsheetId),
    sheets: payload.sheets.map((s) => s.name),
  }
}

export async function readGsheet(
  auth: OAuth2Client,
  spreadsheetId: string,
  options?: { range?: string },
): Promise<ReadGsheetResult> {
  const sheets = google.sheets({ version: 'v4', auth })
  const range  = options?.range ?? DEFAULT_READ_RANGE
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId, range })
  const rows   = (res.data.values as SheetCell[][] | undefined) ?? []
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return {
    spreadsheetId,
    range:    res.data.range ?? range,
    rowCount: rows.length,
    columnCount,
    rows,
  }
}
