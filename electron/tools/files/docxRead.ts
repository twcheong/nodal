// ─────────────────────────────────────────────────────────────────────────────
// docxRead.ts — .docx (WordprocessingML) → 구조 있는 블록.
//
// 왜 새로 필요한가: .docx 는 인제스트 레지스트리에 아예 없었다. 확장자가 등록되지
// 않으면 extractPlainText 로 떨어지고, zip 바이너리라 looksBinary() 에 걸려
// "binary file — cannot read as text" 만 남았다. 유저가 워드 문서를 첨부하면
// 아무 일도 일어나지 않았다는 뜻이다.
//
// 왜 mammoth 같은 라이브러리를 안 쓰나: pptxRead 가 이미 같은 종류의 OOXML 을
// 읽고 있고, 그 스캐너(ooxml.ts)면 충분하다. jszip 도 이미 의존성에 있다.
// 문서를 HTML 로 바꾸는 게 목적이 아니라 모델이 읽을 구조를 뽑는 게 목적이라,
// 스타일 충실도는 필요 없다.
//
// 무엇을 취하고 무엇을 버리나: 본문 흐름(제목/문단/목록/표)만 문서 순서대로
// 가져온다. 머리말·꼬리말·주석·필드코드는 버린다 — 모델 입장에선 페이지마다
// 반복되는 노이즈고, 그걸 넣으면 정작 본문이 예산에서 밀린다.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import JSZip from 'jszip'
import { type Node, parseXml, local, findAll, firstChild, paragraphText } from './ooxml'

export type DocxBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para';    text: string }
  | { kind: 'list';    level: number; text: string }
  | { kind: 'table';   headers: string[]; rows: string[][] }

export type ReadDocxResult = {
  blocks: DocxBlock[]
  paragraphCount: number
  tableCount: number
  wordCount: number
}

const HEADING_STYLE_RE = /^heading\s*([1-9])$/i

/**
 * Heading level, or 0 for body text.
 *
 * Two signals because neither alone is reliable: `w:pStyle` carries the style
 * ID, which is "Heading2" for English Word but localised in some builds, while
 * `w:outlineLvl` is a numeric property Word writes on heading styles
 * regardless of language. Style name first, outline level as the fallback.
 */
function headingLevel(pPr: Node | undefined): number {
  if (!pPr) return 0
  const style = firstChild(pPr, 'pStyle')?.attrs['w:val'] ?? ''
  const m = HEADING_STYLE_RE.exec(style)
  if (m) return Number(m[1])
  if (/^title$/i.test(style)) return 1
  if (/^subtitle$/i.test(style)) return 2

  const outline = firstChild(pPr, 'outlineLvl')?.attrs['w:val']
  if (outline != null) {
    const n = Number(outline)
    if (Number.isFinite(n) && n >= 0 && n <= 8) return n + 1
  }
  return 0
}

/** List indent level, or undefined when the paragraph is not a list item. */
function listLevel(pPr: Node | undefined): number | undefined {
  const numPr = pPr && firstChild(pPr, 'numPr')
  if (!numPr) return undefined
  const ilvl = firstChild(numPr, 'ilvl')?.attrs['w:val']
  const n = Number(ilvl ?? 0)
  return Number.isFinite(n) ? n : 0
}

function readTable(tbl: Node): DocxBlock | undefined {
  // Cell text joins its paragraphs with a space: a cell that wraps onto several
  // paragraphs is still one value, and a newline here would break the markdown
  // row it ends up in.
  const rows = findAll(tbl, 'tr').map((tr) =>
    findAll(tr, 'tc').map((tc) => findAll(tc, 'p').map(paragraphText).filter(Boolean).join(' ')),
  )
  if (rows.length === 0) return undefined
  return { kind: 'table', headers: rows[0], rows: rows.slice(1) }
}

export async function readDocx(safePath: string): Promise<ReadDocxResult> {
  const zip = await JSZip.loadAsync(fs.readFileSync(safePath))
  const part = zip.files['word/document.xml']
  if (!part) throw new Error('No word/document.xml — is this a valid .docx?')

  const body = firstChild(parseXml(await part.async('string')), 'document')?.children
    .find((c) => local(c.tag) === 'body')
  if (!body) throw new Error('No <w:body> — is this a valid .docx?')

  // Walk the body's DIRECT children so document order survives. findAll(root,'p')
  // would flatten every table cell's paragraphs into the same stream and lose
  // which table they belonged to.
  const blocks: DocxBlock[] = []
  let paragraphCount = 0
  let tableCount = 0

  for (const child of body.children) {
    const name = local(child.tag)
    if (name === 'tbl') {
      const t = readTable(child)
      if (t) { blocks.push(t); tableCount++ }
      continue
    }
    if (name !== 'p') continue          // sectPr, bookmarks, … — no content

    const text = paragraphText(child)
    if (!text) continue                 // empty paragraphs are spacing, not content
    paragraphCount++

    const pPr = firstChild(child, 'pPr')
    const h = headingLevel(pPr)
    if (h > 0) { blocks.push({ kind: 'heading', level: h, text }); continue }
    const l = listLevel(pPr)
    if (l !== undefined) { blocks.push({ kind: 'list', level: l, text }); continue }
    blocks.push({ kind: 'para', text })
  }

  const wordCount = blocks.reduce((n, b) => {
    const s = b.kind === 'table'
      ? [b.headers.join(' '), ...b.rows.map((r) => r.join(' '))].join(' ')
      : b.text
    return n + (s.trim() ? s.trim().split(/\s+/).length : 0)
  }, 0)

  return { blocks, paragraphCount, tableCount, wordCount }
}

/** One block → markdown. Kept per-block so the caller can cut on a block
 *  boundary and still render a well-formed document. */
export function docxBlockToText(b: DocxBlock): string {
  switch (b.kind) {
    case 'heading': return `${'#'.repeat(Math.min(b.level, 6))} ${b.text}`
    case 'list':    return `${'  '.repeat(b.level)}- ${b.text}`
    case 'para':    return b.text
    case 'table': {
      const lines = [
        `| ${b.headers.join(' | ')} |`,
        `| ${b.headers.map(() => '---').join(' | ')} |`,
        ...b.rows.map((r) => `| ${r.join(' | ')} |`),
      ]
      return lines.join('\n')
    }
  }
}
