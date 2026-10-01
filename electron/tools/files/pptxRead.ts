// Read an existing .pptx back into our deck spec.
//
// WHAT THIS IS AND IS NOT: a PowerPoint file can contain arbitrary shapes,
// masters, SmartArt and grouping that our 14 slide kinds cannot express. This
// importer takes the CONTENT — per-slide text, its outline level, tables,
// speaker notes — and re-expresses it in our design system. It is a re-render,
// not a pixel-faithful copy, and that is the useful direction: it turns
// someone else's deck into something the Content mode can edit and re-theme.
//
// XML: a purpose-built scanner rather than a new XML dependency. OOXML written
// by PowerPoint is machine-generated and well-formed, and we only need element
// nesting plus three attributes. The scanner is verified by round-tripping our
// OWN writer's output (scripts/deck/roundtrip.ts). It now lives in ooxml.ts
// because docxRead.ts needs exactly the same thing.

import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { type Node, parseXml, findAll, firstChild, paragraphText } from './ooxml'
import type { SlideSpec, WritePptxPayload } from '../../../shared/deck/spec'

export type ImportedSlide = {
  index: number
  /** first paragraph of the first text box — PowerPoint's de-facto title */
  title?: string
  /** every remaining paragraph, in reading order */
  body: { text: string; level: number }[]
  table?: { headers: string[]; rows: string[][] }
  notes?: string
  /** Text shapes in document order — the addressing space of tool_edit_pptx's
   *  setText (`shape` is 1-based into THIS list). `first` is the first
   *  paragraph, so a model can say "shape 2, the one starting 'Agenda'". */
  textShapes: { shape: number; first: string; paragraphs: number }[]
}

export type ReadPptxResult = {
  slideCount: number
  slides: ImportedSlide[]
  /** best-effort mapping into our spec, ready for the Content-mode editor */
  payload: WritePptxPayload
}

function paragraphLevel(p: Node): number {
  const pPr = firstChild(p, 'pPr')
  const lvl = pPr?.attrs.lvl
  return lvl ? Number(lvl) || 0 : 0
}

// ── Slide extraction ─────────────────────────────────────────────────────────

/** Shape offset/extent in EMU, when the shape declares one. */
function shapeBox(sp: Node): { x: number; y: number } | undefined {
  const off = findAll(sp, 'off')[0]
  if (!off) return undefined
  const x = Number(off.attrs.x), y = Number(off.attrs.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

const NUMERIC_RE = /^[0-9]{1,4}$/

/**
 * A page-number badge is a short numeric label in the bottom band of the
 * slide. Dropping it matters: otherwise every imported slide gains a stray
 * "7" bullet, and the classifier sees one more paragraph than the slide
 * really has. The convention is near-universal, so this is safe for foreign
 * decks too — and it is deliberately narrow (numeric only, bottom 12%).
 */
function isPageBadge(text: string, box: { x: number; y: number } | undefined, slideH: number): boolean {
  return NUMERIC_RE.test(text) && !!box && box.y > slideH * 0.88
}

function readTable(slide: Node): ImportedSlide['table'] {
  const tbl = findAll(slide, 'tbl')[0]
  if (!tbl) return undefined
  const rows = findAll(tbl, 'tr').map((tr) =>
    findAll(tr, 'tc').map((tc) => findAll(tc, 'p').map(paragraphText).filter(Boolean).join(' ')),
  )
  if (rows.length === 0) return undefined
  return { headers: rows[0], rows: rows.slice(1) }
}

function readSlide(xml: string, notesXml: string | undefined, index: number, slideH: number): ImportedSlide {
  const root = parseXml(xml)
  // Shapes in document order; each text box contributes its paragraphs.
  const paras: { text: string; level: number }[] = []
  const textShapes: ImportedSlide['textShapes'] = []
  for (const sp of findAll(root, 'sp')) {
    const txBody = firstChild(sp, 'txBody') ?? findAll(sp, 'txBody')[0]
    if (!txBody) continue
    const box = shapeBox(sp)
    // Every shape with a txBody counts for addressing, even an empty one —
    // setText must see the same numbering as this list.
    const ps = findAll(txBody, 'p')
    const texts = ps.map(paragraphText)
    textShapes.push({ shape: textShapes.length + 1, first: texts.find(Boolean) ?? '', paragraphs: ps.length })
    for (let i = 0; i < ps.length; i++) {
      const text = texts[i]
      if (!text || isPageBadge(text, box, slideH)) continue
      paras.push({ text, level: paragraphLevel(ps[i]) })
    }
  }

  const table = readTable(root)
  // The notes MASTER carries a slide-number placeholder, so a notes part is
  // never empty even when the author wrote nothing — drop bare numerics.
  const notes = notesXml
    ? findAll(parseXml(notesXml), 'p').map(paragraphText)
        .filter((t) => t && !NUMERIC_RE.test(t)).join(' ').trim() || undefined
    : undefined

  const [first, ...rest] = paras
  return { index, title: first?.text, body: rest, table, notes, textShapes }
}

// ── Mapping into our spec ────────────────────────────────────────────────────

/**
 * Heuristic classification. Deliberately conservative: when in doubt produce
 * `bullets`/`text`, which always render, rather than guessing a rich kind and
 * getting it wrong. The author can then re-shape individual slides in Content
 * mode, which is far cheaper than un-picking a bad guess.
 */
const TOC_TITLE_RE = /^(contents?|agenda|목\s*차|차\s*례|overview)$/i

function toSlideSpec(s: ImportedSlide, isFirst: boolean): SlideSpec {
  const notes = s.notes
  const bodyTexts = s.body.map((b) => b.text)

  if (s.table && s.table.headers.length > 0) {
    return { kind: 'table', title: s.title, headers: s.table.headers, rows: s.table.rows, notes }
  }

  // ── Conventional shapes, recognised because they are conventions in ANY
  // deck — not just ours. Everything else falls through to bullets/text.

  // "Contents" / "목차" + a list, often numbered → toc. Numbers are dropped;
  // our toc renders its own.
  if (s.title && TOC_TITLE_RE.test(s.title) && bodyTexts.length >= 2) {
    const sections = bodyTexts.filter((t) => !NUMERIC_RE.test(t) && !/^\d{1,2}[.)]$/.test(t))
    if (sections.length >= 2) return { kind: 'toc', sections, notes }
  }

  // A numeric title ("01") over a short line is a section divider.
  if (s.title && NUMERIC_RE.test(s.title) && bodyTexts.length >= 1 && bodyTexts[0].length <= 60) {
    return { kind: 'section', number: s.title, title: bodyTexts[0], intro: bodyTexts[1], notes }
  }

  // Title with nothing under it: the opening slide is a cover, later ones read
  // as section dividers.
  if (s.title && bodyTexts.length === 0) {
    return isFirst
      ? { kind: 'cover', title: s.title, notes }
      : { kind: 'section', number: s.index + 1, title: s.title, notes }
  }
  if (isFirst && s.title && bodyTexts.length <= 2 && bodyTexts.every((t) => t.length <= 80)) {
    return { kind: 'cover', title: s.title, subtitle: bodyTexts[0], date: bodyTexts[1], notes }
  }
  if (!s.title && bodyTexts.length === 0) {
    return { kind: 'text', body: '(빈 슬라이드)', notes }
  }
  // One long paragraph reads as prose; several short ones as bullets.
  const longProse = bodyTexts.length === 1 && bodyTexts[0].length > 120
  if (longProse) return { kind: 'text', title: s.title, body: bodyTexts[0], notes }
  return { kind: 'bullets', title: s.title, bullets: bodyTexts, notes }
}

/**
 * Slide part paths in PRESENTATION order (sldIdLst → rels targets), falling
 * back to filename-number order when presentation.xml is unparseable.
 *
 * The old filename sort was correct for OUR writer (pptxgenjs numbers slides
 * in order) but wrong in general: PowerPoint orders slides by `sldIdLst`, and
 * a deck that was reordered or edited (tool_edit_pptx inserts slideN+1 at an
 * arbitrary position) has file numbers that no longer match display order.
 * The edit round-trip caught exactly this — a reorder that PowerPoint would
 * show, and this scanner claimed did not happen.
 */
export async function slideOrder(zip: JSZip): Promise<string[]> {
  const byNumber = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]))

  try {
    const pres = await zip.files['ppt/presentation.xml'].async('string')
    const rels = await zip.files['ppt/_rels/presentation.xml.rels'].async('string')
    const relOf = new Map<string, string>()
    for (const m of rels.matchAll(/<Relationship\s[^>]*\/>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0])?.[1]
      const target = /Target="([^"]+)"/.exec(m[0])?.[1]
      if (id && target) relOf.set(id, 'ppt/' + target.replace(/^\/?(ppt\/)?/, ''))
    }
    const lst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres)?.[1] ?? ''
    const ordered: string[] = []
    for (const m of lst.matchAll(/<p:sldId\s[^>]*\/>/g)) {
      const rId = /r:id="([^"]+)"/.exec(m[0])?.[1]
      const target = rId ? relOf.get(rId) : undefined
      if (target && zip.files[target]) ordered.push(target)
    }
    // Trust the list only when it accounts for every slide part — a partial
    // parse silently dropping slides is worse than filename order.
    if (ordered.length === byNumber.length && ordered.length > 0) return ordered
  } catch { /* fall through */ }
  return byNumber
}

/** The slide's notes part, resolved via its own rels (never by number-matching
 *  — after an edit, slide numbers and notes numbers no longer line up). */
async function notesXmlFor(zip: JSZip, slidePath: string): Promise<string | undefined> {
  const relsPath = slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
  const relsFile = zip.files[relsPath]
  if (!relsFile) return undefined
  const target = /Target="([^"]*notesSlides[^"]*)"/.exec(await relsFile.async('string'))?.[1]
  if (!target) return undefined
  const notesPath = 'ppt/' + target.replace(/^(\.\.\/)+/, '').replace(/^\/?(ppt\/)?/, '')
  const f = zip.files[notesPath]
  return f ? f.async('string') : undefined
}

export async function readPptx(safePath: string): Promise<ReadPptxResult> {
  const zip = await JSZip.loadAsync(fs.readFileSync(safePath))

  const slideNames = await slideOrder(zip)
  if (slideNames.length === 0) throw new Error('No slides found — is this a valid .pptx?')

  // Real slide height (EMU) so the page-badge band works for 4:3 decks too.
  let slideH = 6_858_000
  const presPart = zip.files['ppt/presentation.xml']
  if (presPart) {
    const cy = /<p:sldSz[^>]*\scy="(\d+)"/.exec(await presPart.async('string'))?.[1]
    if (cy) slideH = Number(cy)
  }

  const slides: ImportedSlide[] = []
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async('string')
    const notesXml = await notesXmlFor(zip, slideNames[i])
    slides.push(readSlide(xml, notesXml, i, slideH))
  }

  const title = path.basename(safePath, '.pptx')
  return {
    slideCount: slides.length,
    slides,
    payload: { title, slides: slides.map((s, i) => toSlideSpec(s, i === 0)) },
  }
}

/** Plain-text rendering for the chat attachment path. */
export function pptxToText(r: ReadPptxResult): string {
  return r.slides.map((s) => {
    const parts = [`## Slide ${s.index + 1}${s.title ? `: ${s.title}` : ''}`]
    for (const b of s.body) parts.push(`${'  '.repeat(b.level)}- ${b.text}`)
    if (s.table) {
      parts.push(`| ${s.table.headers.join(' | ')} |`)
      for (const row of s.table.rows.slice(0, 20)) parts.push(`| ${row.join(' | ')} |`)
      if (s.table.rows.length > 20) parts.push(`… ${s.table.rows.length - 20} more rows`)
    }
    if (s.notes) parts.push(`(notes) ${s.notes}`)
    return parts.join('\n')
  }).join('\n\n')
}
