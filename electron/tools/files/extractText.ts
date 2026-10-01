// ─────────────────────────────────────────────────────────────────────────────
// extractText.ts — 파일 → 텍스트 인제스트 레이어 (확장자별 extractor 레지스트리).
//
// 왜 존재하나:
//   tool-less 플래너(builder)도, openclaw 러너의 read 툴도 바이너리 문서
//   (.xlsx/.pdf/…)를 못 연다. 그래서 유저가 참조한 파일을 "AI 가 읽을 수 있는
//   텍스트"로 바꿔 프롬프트에 첨부해야 한다. 예전엔 이 로직이 xlsx 전용으로
//   useCopilotChat + useWorkflowTest 두 곳에 흩어져 있었다.
//
//   이 모듈은 그걸 한 곳에 모은다: extension → extractor 함수의 레지스트리.
//   새 파일 타입 지원 = REGISTRY 에 한 줄 + extractor 함수 하나 추가. 렌더러는
//   `window.twixy.extractFileText(relPath)` 하나만 부른다 (타입 몰라도 됨).
//
//   설계 결정: 이건 결정적 "서비스"지 워크플로 노드도 LLM 에이전트도 아니다.
//   유저에게 안 보이고, 변환은 코드가 LLM 보다 빠르고 싸고 정확하다. OCR/요약처럼
//   LLM 판단이 필요한 경우에만 별도 노드/에이전트로 승격한다.
//
// ── 잘림에 대한 규칙 (2026-08 실사고에서 나옴) ────────────────────────────────
//   60행짜리 인스타 인벤토리가 문자 상한에 걸려 43행에서 잘렸고, 모델은 그걸
//   "44~60번 포스트는 수집되지 않았다"로 읽고 43행짜리 파일을 새로 썼다. 잘린 건
//   화면인데 결론은 데이터에 대해 났다.
//
//   그래서 이 모듈이 지키는 세 가지:
//     1. shape 를 데이터보다 먼저 — 전체 행/페이지/슬라이드 수를 내용과 별도로
//        선언한다. 세어보게 두지 않는다.
//     2. 단위 경계에서 자른다 — 행/페이지/블록 중간에서 끊지 않는다. 반쪽 행은
//        파싱 에러가 아니라 조용한 오독을 만든다.
//     3. 잘린 사실을 끝에 명시한다 — 맨 위 헤더는 무시되기 쉽다. 데이터가 끝나는
//        바로 그 지점에 "여기서 끝난 게 아니다"를 적는다.
//
//   표는 특히 위험하다. 산문은 40번째 문단이 없으면 요약이 조금 나빠질 뿐이지만,
//   표는 "내가 본 마지막 행 = 존재하는 마지막 행"으로 읽혀 사실 오류가 된다.
//   그래서 표에는 query-data(전량이 진실인 경로)로 가라는 지시까지 붙인다.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { readXlsx } from './xlsx'
import { readPptx, pptxToText } from './pptxRead'
import { readDocx, docxBlockToText } from './docxRead'
import { ATTACH_PER_FILE_CAP, INGEST_EXTS } from '../../../shared/fileTypes'

export interface ExtractResult {
  ok:        boolean
  kind:      string    // 'xlsx' | 'docx' | 'pptx' | 'pdf' | 'text' | 'unsupported' | 'error'
  text:      string
  truncated: boolean
  note?:     string    // 사람이 읽을 안내 (미지원 사유 등) — 데이터 대신 프롬프트에 노출됨
}

const DEFAULT_MAX_CHARS = ATTACH_PER_FILE_CAP

// extractor 한 개: 절대경로 + 상한(문자) → 텍스트 결과.
type Extractor = (abs: string, maxChars: number) => Promise<Omit<ExtractResult, 'ok'>>

// ── 잘림 유틸 ────────────────────────────────────────────────────────────────

/**
 * `units` 를 상한까지 이어붙이고, 남은 게 있으면 무엇이 얼마나 빠졌는지 끝에
 * 적는다. `header` 는 상한과 무관하게 항상 살린다 — shape 정보가 예산 때문에
 * 밀려나면 이 함수의 존재 이유가 사라진다.
 *
 * `total` 을 따로 받는 이유: units 자체가 이미 상류에서 잘려 있을 수 있다
 * (예: readXlsx 의 행 상한). 그때 units.length 를 전체라고 말하면 두 번째
 * 거짓말이 된다.
 */
const MARKER_RESERVE = 320   // 아래 마커 문구가 들어갈 여유분

function joinCapped(opts: {
  units:    string[]
  total:    number
  unit:     string           // 'rows' | 'pages' | 'slides' | 'blocks' | 'lines'
  maxChars: number
  header?:  string
  hint?:    string           // 전량을 보는 법 — 표에서 특히 중요
}): { text: string; truncated: boolean } {
  const { units, total, unit, maxChars, header, hint } = opts
  const head = header ? `${header}\n` : ''

  const shown: string[] = []
  let used = head.length
  for (const u of units) {
    // 마커가 들어갈 자리를 미리 비워둔다 — 마커까지 잘리면 아무 의미가 없다.
    if (shown.length > 0 && used + u.length + 1 > maxChars - MARKER_RESERVE) break
    shown.push(u)
    used += u.length + 1
  }
  // 첫 단위 하나도 안 들어가는 극단 (거대한 셀/페이지) — 그거라도 잘라 넣는다.
  if (shown.length === 0 && units.length > 0) {
    shown.push(units[0].slice(0, Math.max(0, maxChars - MARKER_RESERVE - head.length)))
  }

  const body = head + shown.join('\n')
  const missing = Math.max(total - shown.length, 0)
  if (missing === 0) return { text: body, truncated: false }

  const marker =
    `\n\n… [TRUNCATED — showing ${shown.length} of ${total} ${unit}. ` +
    `${missing} more ${unit} exist in the file but are not shown. ` +
    `This is a display limit, not the end of the data.` +
    (hint ? ` ${hint}` : '') + ']'
  return { text: body + marker, truncated: true }
}

/** 단위 경계가 없는 텍스트(줄 단위)용. 같은 규칙을 줄에 적용한다. */
function capLines(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const lines = text.split('\n')
  return joinCapped({ units: lines, total: lines.length, unit: 'lines', maxChars })
}

function csvCell(v: string | number | boolean | null): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  if (n === 0) return false
  let susp = 0
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c === 0) return true
    if (c < 9 || (c > 13 && c < 32)) susp++
  }
  return susp / n > 0.3
}
function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8')
  return buf.toString('utf8')
}

// CommonJS 로 컴파일되는 electron main 에서 ESM-only 모듈(pdfjs-dist 5.x)을
// 로드하기 위한 우회 — tsc 가 import() 를 require() 로 다운레벨하지 못하게 한다.
const importESM = new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>

// ── extractor 구현들 ─────────────────────────────────────────────────────────

// xlsx (OOXML) → 시트별 CSV. 행 단위로 자르고, 전체 행 수를 반드시 함께 낸다.
const XLSX_HINT =
  'Use the query-data tool (SQL over the file) to read or aggregate the full table — it is not limited by this budget.'

const extractXlsx: Extractor = async (abs, maxChars) => {
  // 상류 상한을 크게 두는 이유: 여기서 잘리면 아래 joinCapped 가 total 을
  // 알 수 없어 "몇 행이 빠졌는지"를 못 적는다. actualRowCount 가 진실을 준다.
  const { sheets } = await readXlsx(abs, { maxRowsPerSheet: 5_000 })
  const parts: string[] = []
  let truncated = false

  // 시트가 여러 개면 예산을 나눠 준다 — 첫 시트가 다 먹고 나머지가 통째로
  // 사라지면, 모델은 그 시트들이 없는 줄 안다.
  const per = Math.max(1_000, Math.floor(maxChars / Math.max(sheets.length, 1)))

  for (const s of sheets) {
    const [headerRow, ...dataRows] = s.rows
    const totalData = Math.max(s.actualRowCount - 1, dataRows.length)
    const header =
      `# Sheet "${s.name}" — ${totalData} data rows × ${s.columnCount} columns` +
      `\n${headerRow ? headerRow.map(csvCell).join(',') : '(no header row)'}`

    const r = joinCapped({
      units:    dataRows.map((row) => row.map(csvCell).join(',')),
      total:    totalData,
      unit:     'rows',
      maxChars: per,
      header,
      hint:     XLSX_HINT,
    })
    parts.push(r.text)
    truncated ||= r.truncated
  }
  return { text: parts.join('\n\n'), truncated, kind: 'xlsx' }
}

// pdf → 페이지별 텍스트. pdfjs-dist(legacy build)를 동적 import.
const extractPdf: Extractor = async (abs, maxChars) => {
  const data = new Uint8Array(fs.readFileSync(abs))
  const pdfjs = await importESM('pdfjs-dist/legacy/build/pdf.mjs')
  const getDocument = pdfjs.getDocument as (args: unknown) => { promise: Promise<PdfDoc> }
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise

  const pages: string[] = []
  let acc = 0
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items.map(it => it.str ?? '').join(' ').trim()
      pages.push(`# Page ${i}\n${pageText}`)
      acc += pageText.length
      if (acc > maxChars) break     // 남은 페이지는 안 읽는다 (파싱 비용 절약)
    }
  } finally {
    try { await doc.destroy?.() } catch { /* ignore */ }
  }

  return {
    ...joinCapped({
      units:    pages,
      total:    doc.numPages,
      unit:     'pages',
      maxChars,
      header:   `# PDF — ${doc.numPages} pages`,
    }),
    kind: 'pdf',
  }
}

// .docx → 제목/문단/목록/표를 마크다운으로. 블록 경계에서 자른다.
const extractDocx: Extractor = async (abs, maxChars) => {
  const r = await readDocx(abs)
  return {
    ...joinCapped({
      units:    r.blocks.map(docxBlockToText),
      total:    r.blocks.length,
      unit:     'blocks',
      maxChars,
      header:   `# Word document — ${r.paragraphCount} paragraphs, ${r.tableCount} tables, ~${r.wordCount} words`,
    }),
    kind: 'docx',
  }
}

// .pptx — 슬라이드 아웃라인(제목/본문/표/노트)을 마크다운으로. 덱을 통째로
// 입력으로 쓸 수 있게 한다. 파서는 electron/tools/files/pptxRead.ts.
const extractPptx: Extractor = async (abs, maxChars) => {
  const r = await readPptx(abs)
  // pptxToText 는 덱 전체를 한 문자열로 주므로, 슬라이드 경계로 되돌려 자른다.
  const slides = pptxToText(r).split('\n\n')
  return {
    ...joinCapped({
      units:    slides,
      total:    r.slideCount,
      unit:     'slides',
      maxChars,
      header:   `# Deck — ${r.slideCount} slides`,
    }),
    kind: 'pptx',
  }
}

// 텍스트류 (csv/tsv/json/md/txt/…) → 그대로 (바이너리면 미지원).
const extractPlainText: Extractor = async (abs, maxChars) => {
  const buf = fs.readFileSync(abs)
  if (looksBinary(buf)) {
    return { text: '', truncated: false, kind: 'unsupported', note: 'binary file — cannot read as text' }
  }
  const text = decodeText(buf)
  const ext = path.extname(abs).toLowerCase()

  // csv/tsv 는 표다 — 잘릴 때 xlsx 와 같은 안내가 필요하다.
  if ((ext === '.csv' || ext === '.tsv') && text.length > maxChars) {
    const lines = text.split('\n')
    const [head, ...rows] = lines
    return {
      ...joinCapped({
        units: rows, total: rows.length, unit: 'rows', maxChars,
        header: `# ${path.basename(abs)} — ${rows.length} data rows\n${head}`,
        hint: XLSX_HINT,
      }),
      kind: 'text',
    }
  }
  return { ...capLines(text, maxChars), kind: 'text' }
}

// 구형 .xls (BIFF) — exceljs 는 못 읽는다. SheetJS(xlsx 패키지)를 넣으면 지원 가능.
const extractXlsLegacy: Extractor = async () => ({
  text: '', truncated: false, kind: 'unsupported',
  note: 'Legacy .xls is not supported — open it and Save As / export to .xlsx, then attach that.',
})

// ── 레지스트리 — 새 타입은 여기 한 줄 + extractor 하나 추가하면 끝 ────────────
// 확장자 목록 자체는 shared/fileTypes.ts 가 소유한다 (렌더러의 참조 스캔 정규식이
// 같은 목록에서 파생돼야 하기 때문 — 예전엔 .docx 가 여기 없어서 조용히 죽었다).
const REGISTRY: Record<string, Extractor> = {
  '.xlsx': extractXlsx,
  '.xlsm': extractXlsx,
  '.docx': extractDocx,
  '.pptx': extractPptx,
  '.pdf':  extractPdf,
  '.xls':  extractXlsLegacy,
  '.csv':  extractPlainText,
  '.tsv':  extractPlainText,
  '.json': extractPlainText,
  '.md':   extractPlainText,
  '.txt':  extractPlainText,
  '.log':  extractPlainText,
  '.yaml': extractPlainText,
  '.yml':  extractPlainText,
  '.html': extractPlainText,
  '.xml':  extractPlainText,
}

/** 레지스트리와 공유 목록이 어긋나면 조용히 죽는 대신 개발 중에 터진다. */
const MISSING = INGEST_EXTS.filter((e) => !(e in REGISTRY))
if (MISSING.length > 0) {
  console.warn(`[extractText] shared/fileTypes.ts lists ${MISSING.join(', ')} but REGISTRY has no extractor`)
}

/** 지원 확장자 목록 (드롭존 accept, 참조 스캔 정규식 등에서 단일 진실 공급원). */
export function supportedExtractExts(): string[] {
  return Object.keys(REGISTRY)
}

// 절대경로 파일을 텍스트로 추출. 등록 안 된 확장자는 텍스트로 시도 후 실패 시
// unsupported. 어떤 에러도 throw 하지 않고 결과 객체로 반환 (호출측 단순화).
export async function extractFileText(abs: string, opts?: { maxChars?: number }): Promise<ExtractResult> {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
  const ext = path.extname(abs).toLowerCase()
  const fn = REGISTRY[ext] ?? extractPlainText   // 미등록 → 텍스트로 시도
  try {
    const r = await fn(abs, maxChars)
    return { ok: r.kind !== 'unsupported', ...r }
  } catch (err) {
    return { ok: false, kind: 'error', text: '', truncated: false, note: String(err).slice(0, 200) }
  }
}

// pdfjs 최소 타입 (동적 import 라 any 회피용 로컬 선언).
interface PdfDoc {
  numPages: number
  getPage(i: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string }> }> }>
  destroy?(): Promise<void>
}
