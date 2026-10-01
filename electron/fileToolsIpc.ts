// ── 문서·데이터 툴 IPC (main.ts 에서 이동) ───────────────────────────────────
//
// pdf · xlsx · pptx · 텍스트 추출 · fetch-to-file · query-data 의 IPC 래퍼 11개.
// 실제 구현은 이미 tools/files/* · tools/data/* 에 있고 여기는 얇은 래퍼라, 바깥에서
// 필요한 건 워크스페이스 경로뿐이다 (Stage 4 슬라이스 2).
//
// 핸들러 본문은 들여쓰기 말고 그대로다 — register 첫 줄의 구조분해가 본문의
// getWorkspace() 호출을 그대로 받는다.
import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writePdf, type WritePdfPayload } from './tools/files/pdf'
import { readXlsx, writeXlsx, type WriteXlsxPayload } from './tools/files/xlsx'
import { extractFileText } from './tools/files/extractText'
import { writePptx, type WritePptxPayload } from './tools/files/pptx'
import { renderDeckSheet } from './tools/files/pptxPreview'
import { verifyWritten } from './tools/files/pptxVerify'
import { readPptx } from './tools/files/pptxRead'
import { editPptx, type PptxEditOp } from './tools/files/pptxEdit'
import { sketchDeck, shapesLabel } from './tools/files/pptxSketch'
import { renderDeckTrue } from './tools/files/pptxRender'
import { resolveInsideWorkspace } from './tools/files/safePath'
import { resolveInsideDesignated, designatedError } from './tools/files/designatedPaths'
import { fetchToFile } from './tools/data/fetchToFile'
import { queryData } from './tools/data/queryData'
import {
  resolveFetchRequest, resolveQueryRequest,
  type FetchToFileRequest, type QueryDataRequest,
} from './tools/data/resolve'

export interface FileToolsDeps {
  getWorkspace: () => string
}

/** 문서·데이터 툴 IPC 11개를 등록한다. import 시점 부작용 없음. */
export function registerFileToolsIpc(deps: FileToolsDeps): void {
  const { getWorkspace } = deps

  // ── Document tools (file-io) ────────────────────────────────────
  // Structured PDF / Excel / PPTX writers + Excel reader. Renderer-callable
  // via `window.twixy.tools.*`; intended primary consumer is OpenClaw via
  // the eventual MCP-style tool registration. All paths are resolved inside
  // the user's workspace — absolute paths and `../` traversal are rejected
  // the same way the legacy `write-file` handler does.

  ipcMain.handle('tool-write-pdf', async (_e, payload: { relPath: string; payload: WritePdfPayload }) => {
    try {
      const safe = resolveInsideDesignated(getWorkspace(), payload.relPath)
      if (!safe) return { ok: false, error: designatedError() }
      const { bytes } = await writePdf(safe, payload.payload)
      return { ok: true, relPath: payload.relPath, bytes }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('tool-write-xlsx', async (_e, payload: { relPath: string; payload: WriteXlsxPayload }) => {
    try {
      const safe = resolveInsideDesignated(getWorkspace(), payload.relPath)
      if (!safe) return { ok: false, error: designatedError() }
      const { bytes } = await writeXlsx(safe, payload.payload)
      return { ok: true, relPath: payload.relPath, bytes }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Read an existing deck back into our spec — the Content-mode "open this
  // .pptx and let me re-theme it" path. Reads are jailed to the workspace but
  // NOT to designated buckets (same as tool-read-xlsx), so a dropped file in
  // data/raw/ is readable.
  ipcMain.handle('tool-read-pptx', async (_e, payload: { relPath: string }) => {
    try {
      const safe = resolveInsideWorkspace(getWorkspace(), payload.relPath)
      if (!safe) return { ok: false, error: 'path outside workspace' }
      if (!fs.existsSync(safe)) return { ok: false, error: 'file not found' }
      const result = await readPptx(safe)
      return { ok: true, relPath: payload.relPath, ...result }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 원본 디자인 유지 편집 — Content 모드의 ```pptx-edit``` 블록이 Apply 게이트를
  // 지나 여기로 온다. 툴브릿지의 'edit-pptx' 와 같은 규칙: 제자리 편집은 소스가
  // 워크스페이스 안이면 되고, 다른 이름으로 쓸 때만 designated 버킷을 강제한다
  // (.potx 는 outRelPath 필수 — editPptx 가 거부). 트랜잭션은 editPptx 몫:
  // 임시파일 → 재검증 → 이동, 실패 시 원본 무손상.
  ipcMain.handle('tool-edit-pptx', async (_e, payload: { relPath: string; outRelPath?: string; ops: PptxEditOp[] }) => {
    try {
      const src = resolveInsideWorkspace(getWorkspace(), payload.relPath)
      if (!src) return { ok: false, error: 'path outside workspace' }
      if (!fs.existsSync(src)) return { ok: false, error: 'file not found' }
      const dest = payload.outRelPath ? resolveInsideDesignated(getWorkspace(), payload.outRelPath) : src
      if (!dest) return { ok: false, error: designatedError() }
      const r = await editPptx(src, dest, payload.ops, async (p) => ({ slideCount: (await readPptx(p)).slideCount }))
      const after = await readPptx(dest)
      const sk = await sketchDeck(dest).catch(() => null)
      return {
        ok: true,
        relPath: payload.outRelPath ?? payload.relPath,
        slideCount: r.slideCount,
        applied: r.applied,
        outline: after.slides.map((sl) => ({
          slide: sl.index + 1, title: sl.title, texts: sl.body.length, textShapes: sl.textShapes,
          ...(sk ? { shapes: shapesLabel(sk.summary[sl.index]?.shapes ?? { text: 0, pic: 0, chart: 0, table: 0, other: 0 }) } : {}),
        })),
        ...(sk ? { layouts: sk.layouts } : {}),
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 남의 덱의 와이어프레임 시트 — 원본 유지 편집 패널의 눈. 우리 painter 는 우리
  // 스펙만 그리므로, 도형을 종류별 박스로 그린 근사 렌더를 쓴다(pptxSketch.ts).
  // PNG 는 deck-qa 폴더에 써서 `[Image: source: …]` 로 모델에게도 보여주고,
  // 패널용으로는 data URL 을 같이 돌려준다.
  ipcMain.handle('pptx-render-sketch', async (_e, req: { convId: string; relPath: string }) => {
    try {
      const safe = resolveInsideWorkspace(getWorkspace(), req.relPath)
      if (!safe) return { ok: false, error: 'path outside workspace' }
      if (!fs.existsSync(safe)) return { ok: false, error: 'file not found' }
      // 아웃라인·shapes·layouts 는 언제나 XML 분석에서 온다(진짜 렌더는 그림만
      // 준다). 그림은 LibreOffice 가 있으면 실물, 없으면 와이어프레임.
      const { png: sketchPng, pages: sketchPages, slideCount, summary, layouts } = await sketchDeck(safe)
      let png = sketchPng
      let pages = sketchPages
      let via: 'libreoffice' | 'sketch' = 'sketch'
      try {
        const real = await renderDeckTrue(safe)
        if (real) { png = real.png; pages = real.pages; via = real.via }
      } catch (err) {
        // 렌더러가 있는데 실패한 경우 — 조용히 낮추지 않고 로그로 남긴다.
        console.warn('[twixy/pptx] true render failed, falling back to the sketch:', err)
      }
      const dir = path.join(getWorkspace(), 'data', 'tmp', 'deck-qa')
      fs.mkdirSync(dir, { recursive: true })
      const abs = path.join(dir, `${req.convId.replace(/[/\\]/g, '_')}-src.png`)
      fs.writeFileSync(abs, png)
      return {
        ok: true, absPath: abs, dataUrl: `data:image/png;base64,${png.toString('base64')}`, slideCount,
        summary: summary.map((s) => ({ slide: s.slide, title: s.title, shapes: shapesLabel(s.shapes), unplaced: s.unplaced })),
        // 페이지별 보기용 — 한 장씩 크게 본다. 시트는 이걸 축소해 붙인 것.
        pages: pages.map((b) => `data:image/png;base64,${b.toString('base64')}`),
        layouts, via,
      }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('tool-read-xlsx', async (_e, payload: { relPath: string; maxRowsPerSheet?: number }) => {
    try {
      const safe = resolveInsideWorkspace(getWorkspace(), payload.relPath)
      if (!safe) return { ok: false, error: 'path outside workspace' }
      if (!fs.existsSync(safe)) return { ok: false, error: 'file not found' }
      const result = await readXlsx(safe, { maxRowsPerSheet: payload.maxRowsPerSheet })
      return { ok: true, relPath: payload.relPath, ...result }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 범용 파일→텍스트 인제스트 — 확장자별 extractor 레지스트리(extractText.ts).
  // xlsx/pdf/csv/json/... 를 AI 가 읽을 텍스트로 뽑아준다. 플래너(툴 없음)·러너
  // (바이너리 못 엶) 둘 다 이걸로 참조 파일 내용을 프롬프트에 첨부한다.
  ipcMain.handle('extract-file-text', async (_e, payload: { relPath: string; maxChars?: number }) => {
    try {
      const safe = resolveInsideWorkspace(getWorkspace(), payload.relPath)
      if (!safe) return { ok: false, error: 'path outside workspace' }
      if (!fs.existsSync(safe)) return { ok: false, error: 'file not found' }
      const r = await extractFileText(safe, { maxChars: payload.maxChars })
      return { ok: r.ok, kind: r.kind, text: r.text, truncated: r.truncated, note: r.note }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ── Data tools ────────────────────────────────────────────────────
  // Bulk ingest + on-disk reshape. Both deliberately return counts rather
  // than data: their whole purpose is to keep large payloads off the LLM's
  // context, so handing the body back would defeat them.

  ipcMain.handle('tool-fetch-to-file', async (_e, req: FetchToFileRequest) => {
    try {
      const { destDirAbs, destRelDir, payload } = resolveFetchRequest(getWorkspace(), req)
      const result = await fetchToFile(destDirAbs, destRelDir, payload)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('tool-query-data', async (_e, req: QueryDataRequest) => {
    try {
      const result = await queryData(resolveQueryRequest(getWorkspace(), req))
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('tool-write-pptx', async (_e, payload: { relPath: string; payload: WritePptxPayload }) => {
    try {
      const safe = resolveInsideDesignated(getWorkspace(), payload.relPath)
      if (!safe) return { ok: false, error: designatedError() }
      const { bytes } = await writePptx(safe, payload.payload, { workspace: getWorkspace() })
      // 방금 쓴 파일을 되읽어 검증 — 실패해도 파일은 남기고 사실만 보고.
      const verify = await verifyWritten(safe, payload.payload)
      return {
        ok: true, relPath: payload.relPath, bytes,
        verified: verify.ok, ...(verify.ok ? { slides: verify.slides } : { verifyReason: verify.reason }),
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Content 모드 시각 QA용: 덱 payload → 번호 붙은 컨택트시트 PNG.
  // 워크스페이스 **안**에 쓰는 이유: openclaw 의 프롬프트 이미지 인라이너가
  // workspaceOnly 게이트를 갖고 있어서, 밖의 경로는 [Image: source: …] 로
  // 참조해도 모델에게 인라인되지 않는다. 시트는 renderer 가 QA 후속 메시지에
  // 경로로 실어 보낸다. 청소는 호출 시 lazy — 7일 지난 시트를 지운다(시작
  // 훅에 묶으면 워크스페이스가 아직 없을 때의 순서 문제가 생긴다).
  ipcMain.handle('deck-render-sheet', async (_e, req: { convId: string; payload: WritePptxPayload }) => {
    try {
      const { png, slideCount } = await renderDeckSheet(req.payload, { workspace: getWorkspace() })
      const dir = path.join(getWorkspace(), 'data', 'tmp', 'deck-qa')
      fs.mkdirSync(dir, { recursive: true })
      const weekAgo = Date.now() - 7 * 24 * 3600_000
      for (const f of fs.readdirSync(dir)) {
        try { if (fs.statSync(path.join(dir, f)).mtimeMs < weekAgo) fs.unlinkSync(path.join(dir, f)) } catch { /* best-effort */ }
      }
      // convId 는 우리 UUID 라 경로 안전하지만, 방어적으로 슬래시만 제거.
      const abs = path.join(dir, `${req.convId.replace(/[/\\]/g, '_')}.png`)
      fs.writeFileSync(abs, png)
      return { ok: true, absPath: abs, slideCount }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })
}
