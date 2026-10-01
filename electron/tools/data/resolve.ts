// Shared request-shape → jailed-options resolution for the data tools.
//
// The IPC handler (renderer) and the bridge handler (LLM) are independent
// entry points and each must jail paths itself — but the jailing *rules*
// should not be written twice, so they live here and both call in.
//
// Reads use resolveInsideWorkspace (anywhere under the workspace);
// writes use resolveInsideDesignated (the user's configured buckets), the
// same split the file tools already use.

import path from 'node:path'
import { resolveInsideWorkspace } from '../files/safePath'
import { resolveInsideDesignated, designatedError } from '../files/designatedPaths'
import type { FetchToFilePayload } from './fetchToFile'
import { TABLE_IDENT, type QueryDataOptions, type QueryOutputFormat } from './queryData'

/** Wire shape for `tool_fetch_to_file`. */
export interface FetchToFileRequest extends FetchToFilePayload {
  /** Workspace-relative destination directory, e.g. "data/raw/sukoshi". */
  destDir: string
}

/** Wire shape for `tool_query_data`. */
export interface QueryDataRequest {
  sql:     string
  /** table name → workspace-relative source file. */
  inputs:  Record<string, string>
  /** Workspace-relative output file. Omit to get rows back inline. */
  output?: string
  maxInlineRows?: number
}

export function resolveFetchRequest(
  workspace: string,
  req: FetchToFileRequest,
): { destDirAbs: string; destRelDir: string; payload: FetchToFilePayload } {
  if (!req?.destDir || typeof req.destDir !== 'string') throw new Error('destDir is required')
  if (!req?.url || typeof req.url !== 'string') throw new Error('url is required')
  let parsed: URL
  try { parsed = new URL(req.url) } catch { throw new Error('url must be absolute') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be http(s)')
  }
  const destDirAbs = resolveInsideDesignated(workspace, req.destDir)
  if (!destDirAbs) throw new Error(designatedError())
  const { destDir: _drop, ...payload } = req
  return { destDirAbs, destRelDir: req.destDir, payload }
}

const FORMAT_BY_EXT: Record<string, QueryOutputFormat> = {
  '.csv':  'csv',
  '.json': 'json',
  '.xlsx': 'xlsx',
}

export function resolveQueryRequest(
  workspace: string,
  req: QueryDataRequest,
): QueryDataOptions {
  if (!req?.sql || typeof req.sql !== 'string') throw new Error('sql is required')
  const entries = Object.entries(req.inputs ?? {})
  // 에러 문구에 교정법을 내장한다 — 실측된 실패 모드: 실행기가 DuckDB 관용구
  // (`FROM 'file.csv'`)대로 경로를 SQL 에 넣고 inputs 를 비워 보낸 뒤, 막히면
  // "파일시스템이 잠겼다/미지원" 으로 오독하고 이 툴 자체를 포기했다. 문구가
  // 다음 호출을 고치게 만들어야 한다.
  const HOW = 'File paths are not readable from SQL. Register every file in `inputs` (e.g. {"src": "data/reports/merged.csv"}) and reference it as a table: SELECT * FROM src.'
  if (entries.length === 0) throw new Error(`inputs is empty — ${HOW}`)
  // SQL 안의 따옴표 경로 리터럴('x/y.csv' 등)은 실행 전에 잡아 같은 안내로
  // 거부 — 실행 단계까지 가면 DuckDB 의 "Permission Error: Cannot access
  // file" 이 나오는데, 그건 환경 고장처럼 읽혀 교정으로 이어지지 않는다.
  const pathLiteral = /['"][^'"\n]*\.(json|csv|parquet|xlsx)['"]/i.exec(req.sql)
  if (pathLiteral) {
    throw new Error(`SQL references a file path (${pathLiteral[0]}) — ${HOW}`)
  }

  const inputs = entries.map(([table, spec]) => {
    if (!TABLE_IDENT.test(table)) {
      throw new Error(`invalid table name "${table}" — letters, digits and underscore only`)
    }
    // "book.xlsx#Sheet2" — 워크북은 시트가 여럿인 게 기본이라, 첫 시트만 쓸 수
    // 있으면 나머지는 존재하지 않는 것과 같다. 경로 자체엔 '#' 가 못 들어가므로
    // 여기서 떼고 나서 jail 을 통과시킨다.
    const hash = spec.indexOf('#')
    const relPath = hash === -1 ? spec : spec.slice(0, hash)
    const sheet   = hash === -1 ? undefined : spec.slice(hash + 1) || undefined

    const absPath = resolveInsideWorkspace(workspace, relPath)
    if (!absPath) throw new Error(`input path outside workspace: ${relPath}`)
    return { table, absPath, sheet }
  })

  if (!req.output) return { sql: req.sql, inputs, maxInlineRows: req.maxInlineRows }

  const format = FORMAT_BY_EXT[path.extname(req.output).toLowerCase()]
  if (!format) throw new Error('output must end in .csv, .json or .xlsx')
  const absPath = resolveInsideDesignated(workspace, req.output)
  if (!absPath) throw new Error(designatedError())
  return { sql: req.sql, inputs, output: { absPath, relPath: req.output, format } }
}
