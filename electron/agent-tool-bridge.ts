// ── Agent Tool Bridge (loopback HTTP) ─────────────────────────────────
// OpenClaw runs as a separate node subprocess (gateway on port 18789).
// Its built-in tools are hardcoded inside the npm package — there is no
// public extension API to register custom tools. To make our Electron-side
// `tool-write-pdf` / `tool-write-xlsx` / Google Workspace / Gmail handlers
// callable by the LLM, we patch openclaw's `createOpenClawTools()` to
// inject 12 thin tool definitions whose `execute()` POSTs JSON over HTTP
// to this bridge running on 127.0.0.1.
//
// Security model:
//   - Bound strictly to 127.0.0.1 (loopback only).
//   - Authenticated by a per-launch random Bearer token, given to the
//     openclaw subprocess via TWIXY_TOOL_BRIDGE_TOKEN env. No other
//     process on the machine can call these endpoints without snooping
//     the env of the openclaw process (already a trust boundary).
//   - Port: TWIXY_TOOL_BRIDGE_PORT (env). Picked dynamically on bind.
//
// All path inputs go through resolveInsideWorkspace() — same
// workspace-jail guard the IPC handlers use.

import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'

import { writePdf,  type WritePdfPayload  } from './tools/files/pdf'
import { writeXlsx, readXlsx, type WriteXlsxPayload } from './tools/files/xlsx'
import { writePptx, type WritePptxPayload } from './tools/files/pptx'
import { readPptx } from './tools/files/pptxRead'
import { renderDeckSheet } from './tools/files/pptxPreview'
import { verifyWritten } from './tools/files/pptxVerify'
import { editPptx, type PptxEditOp } from './tools/files/pptxEdit'
import { resolveInsideWorkspace } from './tools/files/safePath'
import { resolveInsideDesignated, designatedError } from './tools/files/designatedPaths'
import { sketchDeck, shapesLabel } from './tools/files/pptxSketch'
import { renderDeckTrue } from './tools/files/pptxRender'

// 브릿지 툴 id 는 toolPermissions.ts 가 단일 출처다 (정책 계산의 입력이라 정책과 같은 파일).
// 여기서는 기존 import 경로를 유지하기 위해 다시 내보내기만 한다.
export { BRIDGE_TOOL_IDS } from './toolPermissions'

/** 덱 그림: LibreOffice 가 있으면 실물 렌더, 없으면 와이어프레임. 그림이 실패해도
 *  읽기/편집은 계속돼야 하므로 전부 best-effort. */
async function deckImage(abs: string, sketchPng: Buffer): Promise<Buffer> {
  try {
    const real = await renderDeckTrue(abs)
    return real ? real.png : sketchPng
  } catch { return sketchPng }
}
import { fetchToFile } from './tools/data/fetchToFile'
import { queryData } from './tools/data/queryData'
import {
  resolveFetchRequest, resolveQueryRequest,
  type FetchToFileRequest, type QueryDataRequest,
} from './tools/data/resolve'
import {
  connect    as googleConnect,
  disconnect as googleDisconnect,
  status     as googleStatus,
  getAuthorizedClient as googleAuthClient,
} from './google/oauth'
import { readGdoc,   writeGdoc,   type WriteGdocPayload   } from './google/docs'
import { readGsheet, writeGsheet, type WriteGsheetPayload } from './google/sheets'
import { sendEmailWithScopeCheck, readGmailWithScopeCheck, type SendEmailPayload } from './google/gmail'
import { readKakaoOcr } from './logbook-bridge'

export interface BridgeDeps {
  getWorkspace: () => string
  getTwixyMetaDir: () => string
}

export interface BridgeHandle {
  port:  number
  token: string
  close: () => Promise<void>
}

type Json = Record<string, unknown>
type ToolHandler = (body: Json, deps: BridgeDeps) => Promise<unknown>

// ── 12 tool handlers ────────────────────────────────────────────────
// Mirror the `ipcMain.handle('tool-*', ...)` bodies; we deliberately
// duplicate the path-jail step rather than invoke ipcRenderer because
// the openclaw subprocess has no electron context.

const HANDLERS: Record<string, ToolHandler> = {
  'write-pdf': async (body, { getWorkspace }) => {
    const { relPath, payload } = body as { relPath: string; payload: WritePdfPayload }
    const safe = resolveInsideDesignated(getWorkspace(), relPath)
    if (!safe) throw new Error(designatedError())
    const { bytes } = await writePdf(safe, payload)
    return { relPath, bytes }
  },
  'write-xlsx': async (body, { getWorkspace }) => {
    const { relPath, payload } = body as { relPath: string; payload: WriteXlsxPayload }
    const safe = resolveInsideDesignated(getWorkspace(), relPath)
    if (!safe) throw new Error(designatedError())
    const { bytes } = await writeXlsx(safe, payload)
    return { relPath, bytes }
  },
  'read-xlsx': async (body, { getWorkspace }) => {
    const { relPath, maxRowsPerSheet } = body as { relPath: string; maxRowsPerSheet?: number }
    const safe = resolveInsideWorkspace(getWorkspace(), relPath)
    if (!safe) throw new Error('path outside workspace')
    if (!fs.existsSync(safe)) throw new Error('file not found')
    const result = await readXlsx(safe, { maxRowsPerSheet })
    return { relPath, ...result }
  },
  'read-pptx': async (body, { getWorkspace }) => {
    const { relPath } = body as { relPath: string }
    const safe = resolveInsideWorkspace(getWorkspace(), relPath)
    if (!safe) throw new Error('path outside workspace')
    if (!fs.existsSync(safe)) throw new Error('file not found')
    const { slideCount, slides, payload } = await readPptx(safe)
    // Hand back BOTH the readable outline and the spec, so the model can either
    // reason about the content or feed the payload straight into a rewrite.
    // Plus the deck's SHAPE: a wireframe contact sheet and a per-slide shape
    // count, so a model deciding what to duplicate or reorder is not blind
    // (our painter cannot draw a foreign deck). Best-effort — never fails the read.
    const sk = await sketchDeck(safe).catch(() => null)
    const img = sk ? await deckImage(safe, sk.png) : null
    const shaped = slides.map((s) => ({ ...s, ...(sk ? { shapes: shapesLabel(sk.summary[s.index]?.shapes ?? { text: 0, pic: 0, chart: 0, table: 0, other: 0 }) } : {}) }))
    return {
      relPath, slideCount, slides: shaped, payload,
      // The menu for insertSlide — a new page must come from one of THESE.
      ...(sk ? { layouts: sk.layouts } : {}),
      ...(img ? { __images: [{ b64: img.toString('base64'), mimeType: 'image/png' }] } : {}),
    }
  },
  'edit-pptx': async (body, { getWorkspace }) => {
    // Design-PRESERVING edits on an existing deck (ours or anyone's): the
    // original masters/theme/media stay byte-identical except where an op
    // touches. The design-REPLACING path stays read-pptx → write-pptx.
    const { relPath, outRelPath, ops } = body as { relPath: string; outRelPath?: string; ops: PptxEditOp[] }
    const src = resolveInsideWorkspace(getWorkspace(), relPath)
    if (!src) throw new Error('path outside workspace')
    if (!fs.existsSync(src)) throw new Error('file not found')
    // In-place by default; .potx must name a .pptx output (content-type swap).
    const dest = outRelPath ? resolveInsideDesignated(getWorkspace(), outRelPath) : src
    if (!dest) throw new Error(designatedError())
    const r = await editPptx(src, dest, ops, async (p) => ({ slideCount: (await readPptx(p)).slideCount }))
    // Text outline of the result — the model cannot see a foreign deck (our
    // painter only renders OUR spec), so the outline is the after-picture.
    const after = await readPptx(dest)
    // The after-picture, now literally: a wireframe sheet of the edited deck
    // next to the text outline, so "did the reorder land" is a look, not a guess.
    const sk = await sketchDeck(dest).catch(() => null)
    const img = sk ? await deckImage(dest, sk.png) : null
    return {
      relPath: outRelPath ?? relPath,
      slideCount: r.slideCount,
      applied: r.applied,
      outline: after.slides.map((s) => ({
        slide: s.index + 1, title: s.title, texts: s.body.length, textShapes: s.textShapes,
        ...(sk ? { shapes: shapesLabel(sk.summary[s.index]?.shapes ?? { text: 0, pic: 0, chart: 0, table: 0, other: 0 }) } : {}),
      })),
      ...(sk ? { layouts: sk.layouts } : {}),
      ...(img ? { __images: [{ b64: img.toString('base64'), mimeType: 'image/png' }] } : {}),
    }
  },
  'write-pptx': async (body, { getWorkspace }) => {
    const { relPath, payload } = body as { relPath: string; payload: WritePptxPayload }
    const safe = resolveInsideDesignated(getWorkspace(), relPath)
    if (!safe) throw new Error(designatedError())
    const { bytes, warnings, structure } = await writePptx(safe, payload, { workspace: getWorkspace() })
    // Text feedback: what the layout engine noticed — clamped collections,
    // truncated tables, overflow, plus deck-level structure problems.
    const notes = warnings.map((w) =>
      w.code === 'clamped' ? `${w.what}: kept ${w.kept}, dropped ${w.dropped} (over the per-slide cap)`
      : w.code === 'rowsTruncated' ? `table: kept ${w.kept} rows, dropped ${w.dropped} — point at the XLSX for the rest`
      : w.code === 'overflow' ? `${w.what}: overflows its box by ${w.overBy.toFixed(2)}in — shorten it`
      : `${w.what}: shrunk ${w.from}pt → ${w.to}pt to fit`)
    // Visual feedback: a numbered contact sheet of the whole deck. The patch's
    // bridge wrapper turns `__images` into image content blocks, so the model
    // SEES the deck it just wrote and can fix what text alone cannot describe
    // (overlaps, unreadable contrast, three identical layouts in a row). A
    // failed render must never fail the write — the sheet is advisory.
    let images: { b64: string; mimeType: string }[] | undefined
    try {
      const { png } = await renderDeckSheet(payload, { workspace: getWorkspace() })
      images = [{ b64: png.toString('base64'), mimeType: 'image/png' }]
    } catch { /* sheet is best-effort; text feedback above still applies */ }
    // Self-check: read the file we just wrote back with our own importer and
    // assert every visible string survived. A failure never deletes the file —
    // it is reported so neither the model nor the user trusts a corrupt export.
    const verify = await verifyWritten(safe, payload)
    return {
      relPath, bytes,
      verified: verify.ok ? `${verify.slides} slides, ${verify.strings} strings read back OK` : false,
      ...(verify.ok ? {} : { verifyFailed: verify.reason }),
      ...(notes.length ? { warnings: notes } : {}),
      ...(structure.length ? { structure } : {}),
      ...(images ? { __images: images } : {}),
    }
  },

  // ── Data tools ──────────────────────────────────────────────────
  // These exist so bulk data never becomes conversation. They return
  // counts; the fetched bytes and the queried rows stay on disk.
  'fetch-to-file': async (body, { getWorkspace }) => {
    const { destDirAbs, destRelDir, payload } = resolveFetchRequest(getWorkspace(), body as unknown as FetchToFileRequest)
    return await fetchToFile(destDirAbs, destRelDir, payload)
  },
  'query-data': async (body, { getWorkspace }) => {
    return await queryData(resolveQueryRequest(getWorkspace(), body as unknown as QueryDataRequest))
  },

  // Google Workspace
  'google-status':     async (_body, { getTwixyMetaDir }) => googleStatus(getTwixyMetaDir()),
  'google-connect':    async (_body, { getTwixyMetaDir }) => googleConnect(getTwixyMetaDir()),
  'google-disconnect': async (_body, { getTwixyMetaDir }) => { googleDisconnect(getTwixyMetaDir()); return { ok: true } },
  'write-gdoc': async (body, { getTwixyMetaDir }) => {
    const auth = googleAuthClient(getTwixyMetaDir())
    return await writeGdoc(auth, body as WriteGdocPayload)
  },
  'read-gdoc': async (body, { getTwixyMetaDir }) => {
    const auth = googleAuthClient(getTwixyMetaDir())
    const { documentId } = body as { documentId: string }
    return await readGdoc(auth, documentId)
  },
  'write-gsheet': async (body, { getTwixyMetaDir }) => {
    const auth = googleAuthClient(getTwixyMetaDir())
    return await writeGsheet(auth, body as WriteGsheetPayload)
  },
  'read-gsheet': async (body, { getTwixyMetaDir }) => {
    const auth = googleAuthClient(getTwixyMetaDir())
    const { spreadsheetId, range } = body as { spreadsheetId: string; range?: string }
    return await readGsheet(auth, spreadsheetId, { range })
  },
  // Gmail send — reuses the Google Workspace tokens above. Scope-checked:
  // throws a "설정 > 연동에서 Google 권한을 갱신하세요" error when the stored
  // token predates the gmail.send scope.
  'send-email': async (body, { getTwixyMetaDir }) => {
    return await sendEmailWithScopeCheck(getTwixyMetaDir(), body as SendEmailPayload)
  },
  // Gmail read — reuses the Google Workspace tokens. Scope-checked against
  // gmail.readonly (throws the "설정 > 연동에서 Google 권한을 갱신하세요" hint
  // when the stored token predates the scope). Single handler: when `id` is
  // present it returns the full message, otherwise it lists/searches.
  'read-gmail': async (body, { getTwixyMetaDir }) => {
    const { query, maxResults, id } = body as { query?: string; maxResults?: number; id?: string }
    return await readGmailWithScopeCheck(getTwixyMetaDir(), { query, maxResults, id })
  },

  // logbook OCR — read recent KakaoTalk chat captured from the screen.
  // Read-only; no workspace path involved, so no path-jail step. Throws on
  // failure so the bridge wraps it into { ok:false, error } for the LLM.
  'read-kakao': async (body) => {
    const { sinceMinutes, limit } = body as { sinceMinutes?: number; limit?: number }
    const mins = typeof sinceMinutes === 'number' && sinceMinutes > 0 ? sinceMinutes : 10
    const until = Date.now() / 1000
    const since = until - mins * 60
    const result = await readKakaoOcr({ since, until, limit })
    if (!result.ok) throw new Error(result.error ?? 'logbook_unreachable')
    return { lines: result.lines ?? [], sinceMinutes: mins }
  },
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export async function startAgentToolBridge(deps: BridgeDeps): Promise<BridgeHandle> {
  const token = randomBytes(32).toString('hex')

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const auth = req.headers['authorization']
        if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), token)) {
          res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return
        }
        const m = /^\/tool\/([a-z0-9-]+)$/.exec(req.url ?? '')
        if (!m) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'unknown route' })); return }
        const name = m[1]
        const handler = HANDLERS[name]
        if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: `unknown tool: ${name}` })); return }

        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Json = {}
        if (raw) {
          try { body = JSON.parse(raw) as Json }
          catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid json body' })); return }
        }

        try {
          const result = await handler(body, deps)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, result }))
        } catch (err) {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }))
        }
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('bridge: failed to bind')
  const port = addr.port

  return {
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
