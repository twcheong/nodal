// ── query-data ───────────────────────────────────────────────────────
// Structural problem this solves: reshaping data means loading it, and
// loading it normally means routing it through the model's context. This
// runs the reshape on disk instead and returns only the result — or, for
// results too large to be worth reading, only a row count.
//
// SQL rather than a bespoke mapping DSL: extract, filter, aggregate, join,
// dedupe and format-convert are all one language the model already knows,
// and it does not grow a new option every time a workflow needs something.
// The tool knows nothing about what the columns mean.
//
// ── Sandbox ─────────────────────────────────────────────────────────
// The SQL string is model-authored, so it is treated as untrusted. DuckDB's
// NODE_FS runtime otherwise resolves any path the query names — verified:
// `read_csv_auto('/etc/passwd')`, `COPY … TO '/tmp/x'` and `ATTACH` all
// reach the real filesystem. The containment is therefore structural, not
// a denylist:
//
//   1. Inputs are read by THIS process from already-jailed paths and handed
//      to DuckDB as in-memory buffers.
//   2. Each buffer is materialised into a real table, then unregistered.
//   3. `SET enable_external_access=false` — after this the engine itself
//      refuses every filesystem operation (confirmed for path reads,
//      COPY TO and ATTACH).
//   4. The user's SQL then runs against tables only. It has no file to
//      name, and naming one is a hard engine error rather than a parse
//      we had to anticipate.
//   5. Output is written by this process through the caller's jail.
//
// Consequence: inputs must fit in memory. Fine at this app's scale;
// documented rather than worked around.

import fs from 'node:fs'
import path from 'node:path'
import { writeXlsx, readXlsx } from '../files/xlsx'

export type QueryOutputFormat = 'csv' | 'json' | 'xlsx'

export interface QueryInput {
  /** SQL table name the query will reference. Caller validates the ident. */
  table:   string
  /** Absolute, already path-jailed source file. */
  absPath: string
  /** Spreadsheet sources only — worksheet name. Defaults to the first sheet. */
  sheet?:  string
}

export interface QueryDataOptions {
  sql:    string
  inputs: QueryInput[]
  /** Omit to get rows back inline (capped). Supply to write a file instead. */
  output?: {
    absPath: string
    relPath: string
    format:  QueryOutputFormat
  }
  /** Cap on rows returned inline when `output` is omitted. Default 50. */
  maxInlineRows?: number
}

export interface QueryDataResult {
  rows:      number
  columns:   string[]
  output?:   string
  bytes?:    number
  inline?:   Record<string, unknown>[]
  truncated?: boolean
}

const DEFAULT_MAX_INLINE = 50
const HARD_MAX_INLINE    = 1_000

/** Table identifiers are interpolated into DDL, so they are restricted to a
 *  plain ident rather than escaped. */
export const TABLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

interface DuckDbModule {
  createDuckDB(bundles: unknown, logger: unknown, runtime: unknown): Promise<DuckDbBindings>
  VoidLogger: new () => unknown
  NODE_RUNTIME: unknown
}
interface DuckDbBindings {
  instantiate(onProgress: () => void): Promise<unknown>
  open(config: Record<string, unknown>): void
  connect(): DuckDbConn
  registerFileBuffer(name: string, buf: Uint8Array): void
  dropFile(name: string): void
}
interface DuckDbConn {
  query(sql: string): { toArray(): Array<{ toJSON(): Record<string, unknown> }> }
  close(): void
}

/** Resolve the duckdb-wasm dist dir, accounting for asar packaging (the
 *  .wasm files are unpacked by electron-builder's asarUnpack). */
function duckdbDistDir(): string {
  const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs')
  return path.dirname(entry).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

function loadDuckdb(): DuckDbModule {
  const dir = duckdbDistDir()
  return require(path.join(dir, 'duckdb-node-blocking.cjs')) as DuckDbModule
}

/** Pick the DuckDB reader for a source file by extension. */
function readerFor(absPath: string, alias: string): string {
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return `read_csv_auto('${alias}')`
  if (ext === '.parquet')                                 return `read_parquet('${alias}')`
  if (ext === '.xlsx' || ext === '.xlsm')                 return `read_csv_auto('${alias}')`  // 아래에서 CSV 로 변환됨
  return `read_json_auto('${alias}')`
}

/** 2D 셀 배열 → CSV 바이트. 전부 빈 행은 버린다 — 서식만 남은 꼬리 행이
 *  read_csv_auto 에는 컬럼 수가 안 맞는 행으로 보이고, 살아남더라도 모델에겐
 *  "데이터가 있는 척하는 빈 행"이 된다. */
function cellsToCsvBytes(rows: (string | number | boolean | null)[][]): Uint8Array {
  const esc = (v: string | number | boolean | null): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const kept = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
  return new TextEncoder().encode(kept.map((r) => r.map(esc).join(',')).join('\n') + '\n')
}

/**
 * 소스 파일 → DuckDB 에 등록할 바이트.
 *
 * .xlsx 는 zip 이라 어떤 DuckDB 리더도 못 읽는다. 그래서 여기서 CSV 로 바꾼다 —
 * 모델에게 "먼저 CSV 로 변환하는 노드를 하나 더 만드세요"라고 시키지 않기 위해서다.
 * 그 우회는 실제로 더 나쁜 결과를 낳았다: 변환 단계가 없으면 스프레드시트는
 * 프롬프트 덤프 경로로 밀려나고, 거기서 잘리면 모델이 "행이 거기까지만 존재한다"고
 * 결론짓는다. 표는 전량이 진실인 경로로 들어와야 한다.
 *
 * 행 상한을 두지 않는 이유도 같다. 여기서 자르면 COUNT(*) 가 거짓말을 시작한다.
 */
async function sourceBytes(input: QueryInput): Promise<Uint8Array> {
  const ext = path.extname(input.absPath).toLowerCase()
  if (ext !== '.xlsx' && ext !== '.xlsm') return new Uint8Array(fs.readFileSync(input.absPath))

  const { sheets } = await readXlsx(input.absPath, { maxRowsPerSheet: Infinity })
  const named = input.sheet
    ? sheets.find((s) => s.name === input.sheet)
    : sheets.find((s) => s.rows.length > 0) ?? sheets[0]

  if (!named) {
    const available = sheets.map((s) => s.name).join(', ') || '(none)'
    throw new Error(
      input.sheet
        ? `sheet "${input.sheet}" not found in ${path.basename(input.absPath)} — available: ${available}`
        : `no sheets in ${path.basename(input.absPath)}`,
    )
  }
  if (named.rows.length === 0) throw new Error(`sheet "${named.name}" is empty`)
  return cellsToCsvBytes(named.rows)
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const out = [columns.join(',')]
  for (const r of rows) out.push(columns.map(c => esc(r[c])).join(','))
  return out.join('\n') + '\n'
}

/** JSON/Arrow values that do not survive JSON.stringify as-is. */
function normalize(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Date)     return v.toISOString()
  if (Array.isArray(v))      return v.map(normalize)
  return v
}

export async function queryData(opts: QueryDataOptions): Promise<QueryDataResult> {
  for (const input of opts.inputs) {
    if (!TABLE_IDENT.test(input.table)) throw new Error(`invalid table name: ${input.table}`)
    if (!fs.existsSync(input.absPath))  throw new Error(`input not found: ${input.table}`)
  }

  const duckdb = loadDuckdb()
  const dist = duckdbDistDir()
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: null },
      eh:  { mainModule: path.join(dist, 'duckdb-eh.wasm'),  mainWorker: null },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  )
  await db.instantiate(() => {})
  db.open({ path: ':memory:', query: { castBigIntToDouble: true } })
  const conn = db.connect()

  try {
    // ── load phase: this process owns every path ──────────────────
    for (let i = 0; i < opts.inputs.length; i++) {
      const input = opts.inputs[i]
      const handle = `__src${i}`
      db.registerFileBuffer(handle, await sourceBytes(input))
      try {
        conn.query(`CREATE TABLE "${input.table}" AS SELECT * FROM ${readerFor(input.absPath, handle)}`)
      } finally {
        db.dropFile(handle)
      }
    }

    // ── seal: every later filesystem operation is an engine error ──
    conn.query('SET enable_external_access=false')

    // ── the untrusted part ────────────────────────────────────────
    const result = conn.query(opts.sql)
    const raw = result.toArray().map(r => r.toJSON())
    const rows: Record<string, unknown>[] = raw.map(r => {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(r)) o[k] = normalize(r[k])
      return o
    })
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []

    if (!opts.output) {
      const cap = Math.min(Math.max(1, opts.maxInlineRows ?? DEFAULT_MAX_INLINE), HARD_MAX_INLINE)
      return {
        rows: rows.length,
        columns,
        inline: rows.slice(0, cap),
        truncated: rows.length > cap,
      }
    }

    const { absPath, relPath, format } = opts.output
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    if (format === 'xlsx') {
      const sheetRows: (string | number | boolean | null)[][] = [columns]
      for (const r of rows) {
        sheetRows.push(columns.map(c => {
          const v = r[c]
          if (v === null || v === undefined) return null
          if (typeof v === 'object') return JSON.stringify(v)
          return v as string | number | boolean
        }))
      }
      await writeXlsx(absPath, { sheets: [{ name: 'Data', rows: sheetRows }] })
    } else if (format === 'csv') {
      fs.writeFileSync(absPath, toCsv(rows, columns), 'utf8')
    } else {
      fs.writeFileSync(absPath, JSON.stringify(rows, null, 2), 'utf8')
    }

    return { rows: rows.length, columns, output: relPath, bytes: fs.statSync(absPath).size }
  } finally {
    try { conn.close() } catch { /* teardown best-effort */ }
  }
}
