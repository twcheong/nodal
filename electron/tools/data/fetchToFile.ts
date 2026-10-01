// ── fetch-to-file ────────────────────────────────────────────────────
// Structural problem this solves: the model's context sits on the data
// path. A normal fetch returns the response body as a tool result, so
// every byte fetched lands in the transcript and is re-sent on every
// later turn — cost then grows with (items × context), not items.
//
// This tool walks a paginated HTTP resource and writes each response
// straight to disk. It returns counts only; the body is never handed
// back to the caller. It knows nothing about what the bytes mean —
// that is the workflow's business, not the tool's.
//
// Path-jailing is the caller's job (layers 2 and 3 both resolve first),
// per the convention in electron/tools/files/*.

import fs from 'node:fs'
import path from 'node:path'

export type Pagination =
  /** Single request. */
  | { mode: 'none' }
  /** ?page=1,2,3… — the common CMS/storefront shape. */
  | { mode: 'page';   param: string; start?: number; step?: number }
  /** ?offset=0,100,200… paired with a fixed page size. */
  | { mode: 'offset'; param: string; size: number }
  /** Cursor echoed inside the response body (YouTube, Notion, Graph APIs). */
  | { mode: 'cursor'; param: string; cursorPath: string }
  /** RFC 5988 `Link: <…>; rel="next"` header (GitHub and most standard REST). */
  | { mode: 'link' }

export interface FetchToFilePayload {
  url:         string
  pagination?: Pagination
  /** Hard ceiling on requests. Always enforced — default 50. */
  maxPages?:   number
  /** Dotted path to the array of items in a JSON body, e.g. "products"
   *  or "data.items". Used to count items and to detect the last page. */
  itemsPath?:  string
  /** Stop once a page yields fewer than this many items (usually the
   *  page size). Only meaningful together with `itemsPath`. */
  minItemsPerPage?: number
  headers?:    Record<string, string>
  /** Politeness delay between requests. Default 250ms. */
  delayMs?:    number
  timeoutMs?:  number
}

export type StopReason =
  | 'single' | 'empty-page' | 'short-page' | 'no-next-cursor'
  | 'max-pages' | 'http-error' | 'request-error'

export interface FetchToFileResult {
  requests:  number
  files:     string[]
  bytes:     number
  /** Only present when `itemsPath` was supplied and the body parsed as JSON. */
  items?:    number
  lastCursor?: string
  stoppedBy: StopReason
  errors:    string[]
}

const DEFAULT_MAX_PAGES = 50
const DEFAULT_DELAY_MS  = 250
const DEFAULT_TIMEOUT   = 60_000
const HARD_MAX_PAGES    = 500

/** Minimal dotted-path getter: "a.b[0].c". Deliberately not full JSONPath —
 *  the tool only needs to find one array and one cursor string. */
function atPath(root: unknown, dotted: string): unknown {
  if (!dotted) return root
  let cur: unknown = root
  for (const seg of dotted.split('.')) {
    const m = /^([^[\]]*)((\[\d+\])*)$/.exec(seg)
    if (!m) return undefined
    if (m[1]) {
      if (cur === null || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[m[1]]
    }
    for (const idx of m[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(idx)]
    }
  }
  return cur
}

function withParam(url: string, param: string, value: string | number): string {
  const u = new URL(url)
  u.searchParams.set(param, String(value))
  return u.toString()
}

/** Parse `Link: <https://…?page=2>; rel="next", <…>; rel="last"`. */
function nextFromLinkHeader(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part.trim())
    if (m) return m[1]
  }
  return null
}

function extensionFor(contentType: string | null): string {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('csv'))  return 'csv'
  if (ct.includes('xml'))  return 'xml'
  if (ct.includes('html')) return 'html'
  if (ct.includes('text')) return 'txt'
  return 'bin'
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Walk `payload.url` page by page, writing each response body to
 * `<destDirAbs>/p001.<ext>`. Never returns response bodies.
 *
 * @param destDirAbs  Absolute, already path-jailed destination directory.
 * @param destRelDir  The same directory as a workspace-relative path, used
 *                    only to build the returned file list.
 */
export async function fetchToFile(
  destDirAbs: string,
  destRelDir: string,
  payload: FetchToFilePayload,
): Promise<FetchToFileResult> {
  const pg        = payload.pagination ?? { mode: 'none' as const }
  const maxPages  = Math.min(Math.max(1, payload.maxPages ?? DEFAULT_MAX_PAGES), HARD_MAX_PAGES)
  const delayMs   = Math.max(0, payload.delayMs ?? DEFAULT_DELAY_MS)
  const timeoutMs = Math.max(1_000, payload.timeoutMs ?? DEFAULT_TIMEOUT)

  fs.mkdirSync(destDirAbs, { recursive: true })

  const files: string[] = []
  const errors: string[] = []
  let bytes = 0
  let items = 0
  let sawJsonItems = false
  let requests = 0
  let lastCursor: string | undefined
  let stoppedBy: StopReason = 'max-pages'

  let url: string | null = payload.url
  let pageNo = pg.mode === 'page' ? (pg.start ?? 1) : 0
  let offset = 0

  for (let i = 0; i < maxPages && url; i++) {
    // Build this iteration's URL from the pagination mode. 'cursor' and
    // 'link' modes carry the whole next URL in `url` already.
    let target = url
    if (pg.mode === 'page')   target = withParam(url, pg.param, pageNo)
    if (pg.mode === 'offset') target = withParam(url, pg.param, offset)

    let res: Response
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      res = await fetch(target, {
        headers: { 'User-Agent': 'Twixy/1.0', ...(payload.headers ?? {}) },
        signal:  ac.signal,
      })
    } catch (err) {
      errors.push(`${target}: ${String((err as Error)?.message ?? err)}`)
      stoppedBy = 'request-error'
      break
    } finally {
      clearTimeout(timer)
    }
    requests++

    if (!res.ok) {
      errors.push(`${target}: HTTP ${res.status}`)
      stoppedBy = 'http-error'
      break
    }

    const buf = Buffer.from(await res.arrayBuffer())
    const ext = extensionFor(res.headers.get('content-type'))
    const name = `p${String(i + 1).padStart(3, '0')}.${ext}`
    fs.writeFileSync(path.join(destDirAbs, name), buf)
    files.push(path.posix.join(destRelDir.split(path.sep).join('/'), name))
    bytes += buf.length

    // Body is inspected only to count items and find the next cursor. It is
    // never returned, and a parse failure is not fatal.
    let body: unknown
    if (ext === 'json') {
      try { body = JSON.parse(buf.toString('utf8')) } catch { /* not our problem */ }
    }

    let pageItems: number | null = null
    if (body !== undefined && payload.itemsPath !== undefined) {
      const arr = atPath(body, payload.itemsPath)
      if (Array.isArray(arr)) { pageItems = arr.length; items += arr.length; sawJsonItems = true }
    }

    if (pg.mode === 'none') { stoppedBy = 'single'; break }

    if (pageItems === 0) { stoppedBy = 'empty-page'; break }
    if (pageItems !== null && payload.minItemsPerPage !== undefined
        && pageItems < payload.minItemsPerPage) { stoppedBy = 'short-page'; break }

    // Advance.
    if (pg.mode === 'page')   { pageNo += pg.step ?? 1 }
    if (pg.mode === 'offset') { offset += pg.size }
    if (pg.mode === 'cursor') {
      const c = atPath(body, pg.cursorPath)
      if (typeof c !== 'string' || !c) { stoppedBy = 'no-next-cursor'; break }
      lastCursor = c
      url = withParam(payload.url, pg.param, c)
    }
    if (pg.mode === 'link') {
      const next = nextFromLinkHeader(res.headers.get('link'))
      if (!next) { stoppedBy = 'no-next-cursor'; break }
      url = next
    }

    if (delayMs) await sleep(delayMs)
  }

  return {
    requests,
    files,
    bytes,
    ...(sawJsonItems ? { items } : {}),
    ...(lastCursor ? { lastCursor } : {}),
    stoppedBy,
    errors,
  }
}
