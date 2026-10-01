// In-place OOXML surgery on an existing .pptx — the design-PRESERVING edit
// path. (The design-REPLACING path is tool_read_pptx → tool_write_pptx, which
// re-renders content in our own system.)
//
// Anthropic's pptx skill does this with unzip → edit XML → zip plus helper
// scripts (add_slide.py for duplication bookkeeping, clean.py for orphans).
// This module is those helpers as one transaction:
//
//   replaceText · setText · setNotes · duplicateSlide · insertSlide ·
//   deleteSlide · reorderSlides   (.potx sources are converted via outRelPath)
//
//   insertSlide is add_slide.py's LAYOUT mode: a new page built from one of
//   the deck's own slideLayouts, so it inherits the original design without a
//   source slide to clone. setText is the paragraph-level rewrite replaceText
//   cannot do — it re-emits a text shape's paragraphs, copying the first
//   paragraph's pPr/rPr so spacing and font survive (Anthropic's rule: one
//   <a:p> per item, never concatenate). A final sweep drops orphaned media /
//   notes / chart parts the way clean.py does — counted, never guessed.
//
// Edits are STRING surgery on the raw XML, not a parse→serialize round-trip:
// our scanner (ooxml.ts) reads but deliberately does not write, and
// re-serializing someone else's deck is how foreign markup gets mangled. Every
// operation touches the minimum bytes and leaves everything else — masters,
// themes, media, animations — untouched, which is the entire point of this
// path.
//
// SAFETY: all ops run on an in-memory zip; the result is written to a temp
// file, re-read with our own scanner (readPptx), and only then moved over the
// destination. A failed verify leaves the original untouched and reports why.
//
// KNOWN LIMITS (v1, stated loudly rather than discovered sadly):
//   · replaceText matches within one <a:t> run. Text that PowerPoint split
//     across runs (mixed formatting mid-word) is reported as such, with the
//     paragraph text, so the caller can pick a shorter find string.
//   · duplicateSlide shares chart/SmartArt/media PARTS with the source (same
//     behavior as Anthropic's add_slide.py) — editing one edits both. The
//     duplicate drops the notes link rather than sharing a notes part.
//   · deleteSlide removes the slide, its rels, its notes part and the
//     content-type overrides. Media is left in place — a media part can be
//     shared by other slides and counting references across every part is not
//     worth the corruption risk; the cost is file size, not correctness.

import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'

export type PptxEditOp =
  | { op: 'replaceText'; slide: number; find: string; replace: string }
  | { op: 'setText'; slide: number; shape: number; paragraphs: string[] }
  | { op: 'setNotes'; slide: number; notes: string }
  | { op: 'duplicateSlide'; slide: number; after?: number }
  | { op: 'insertSlide'; layout: number | string; after?: number; fill?: { title?: string; subtitle?: string; body?: string[] } }
  | { op: 'deleteSlide'; slide: number }
  | { op: 'reorderSlides'; order: number[] }

/** A slideLayout the deck ships — what insertSlide can build from. */
export type LayoutInfo = { index: number; name: string; placeholders: string[] }

export type EditPptxResult = {
  relPath: string
  slideCount: number
  applied: string[]
}

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

// ── presentation.xml bookkeeping ─────────────────────────────────────────────

type SlideRef = { sldIdTag: string; numId: string; rId: string; target: string }

async function text(zip: JSZip, p: string): Promise<string> {
  const f = zip.file(p)
  if (!f) throw new Error(`missing part: ${p}`)
  return f.async('string')
}

/** Slide order as PowerPoint shows it: sldIdLst entries → rels targets. */
async function slideRefs(zip: JSZip): Promise<SlideRef[]> {
  const pres = await text(zip, 'ppt/presentation.xml')
  const rels = await text(zip, 'ppt/_rels/presentation.xml.rels')

  const relOf = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\s[^>]*\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && target) relOf.set(id, target.replace(/^\//, '').replace(/^(?!ppt\/)/, 'ppt/'))
  }

  const lst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres)?.[1]
  if (!lst) throw new Error('presentation.xml has no <p:sldIdLst> — not a presentation?')

  const refs: SlideRef[] = []
  for (const m of lst.matchAll(/<p:sldId\s[^>]*\/>/g)) {
    const numId = /\bid="(\d+)"/.exec(m[0])?.[1]
    const rId = /r:id="([^"]+)"/.exec(m[0])?.[1]
    const target = rId ? relOf.get(rId) : undefined
    if (!numId || !rId || !target) throw new Error(`unparseable sldId entry: ${m[0]}`)
    refs.push({ sldIdTag: m[0], numId, rId, target })
  }
  return refs
}

function refAt(refs: SlideRef[], oneBased: number): SlideRef {
  const r = refs[oneBased - 1]
  if (!r) throw new Error(`slide ${oneBased} does not exist (deck has ${refs.length})`)
  return r
}

/** The slide's own rels part path (ppt/slides/slideN.xml → ppt/slides/_rels/slideN.xml.rels). */
const relsPathOf = (slidePath: string) =>
  path.posix.join(path.posix.dirname(slidePath), '_rels', path.posix.basename(slidePath) + '.rels')

// ── operations ───────────────────────────────────────────────────────────────

async function opReplaceText(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'replaceText' }>): Promise<string> {
  const ref = refAt(refs, o.slide)
  const xml = await text(zip, ref.target)

  let hits = 0
  const RUN_RE = /(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/g
  const out = xml.replace(RUN_RE, (whole, open: string, body: string, close: string) => {
    // Compare on the DECODED text the model saw in the outline.
    const decoded = body
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    if (!decoded.includes(o.find)) return whole
    hits++
    const next = decoded.split(o.find).join(o.replace)
    // Leading/trailing whitespace is dropped by consumers unless preserved.
    const needsPreserve = /^\s|\s$/.test(next)
    const openTag = needsPreserve && !open.includes('xml:space')
      ? open.replace(/>$/, ' xml:space="preserve">') : open
    return openTag + escXml(next) + close
  })

  if (hits === 0) {
    // Say WHY it missed: run-split text is the common case, and "not found" is
    // exactly the kind of silent-ish failure this codebase bans.
    const plain = xml.replace(/<[^>]+>/g, '')
    const inPlain = plain.includes(o.find)
    throw new Error(
      inPlain
        ? `"${o.find}" exists on slide ${o.slide} but is split across formatting runs — use a shorter fragment that sits inside one run`
        : `"${o.find}" not found on slide ${o.slide}`,
    )
  }
  zip.file(ref.target, out)
  return `slide ${o.slide}: replaced ${hits} occurrence(s) of "${o.find.slice(0, 30)}"`
}

async function opSetNotes(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'setNotes' }>): Promise<string> {
  const ref = refAt(refs, o.slide)
  const relsPath = relsPathOf(ref.target)
  const rels = zip.file(relsPath) ? await text(zip, relsPath) : ''
  const notesTarget = /Target="([^"]*notesSlides[^"]*)"/.exec(rels)?.[1]
  if (!notesTarget) {
    throw new Error(
      `slide ${o.slide} has no notes part. Creating one from scratch needs a notesMaster wire-up — ` +
      'edit a deck that already has notes, or re-render via tool_write_pptx where notes are first-class.',
    )
  }
  const notesPath = path.posix.normalize(path.posix.join(path.posix.dirname(relsPath), '..', notesTarget)).replace(/^\/+/, '')
  const xml = await text(zip, notesPath)

  // Replace the paragraphs of the BODY placeholder only — the other shapes on
  // a notes slide (slide image, page number) must survive.
  const bodyShape = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?type="body"[\s\S]*?<\/p:sp>/.exec(xml)?.[0]
  if (!bodyShape) throw new Error(`notes part of slide ${o.slide} has no body placeholder`)
  const txBody = /<p:txBody>[\s\S]*?<\/p:txBody>/.exec(bodyShape)?.[0]
  if (!txBody) throw new Error(`notes body of slide ${o.slide} has no txBody`)

  const bodyPr = /<a:bodyPr[^>]*\/>|<a:bodyPr[\s\S]*?<\/a:bodyPr>/.exec(txBody)?.[0] ?? '<a:bodyPr/>'
  const paras = o.notes.split('\n').map((line) => `<a:p><a:r><a:t>${escXml(line)}</a:t></a:r></a:p>`).join('')
  const newTxBody = `<p:txBody>${bodyPr}<a:lstStyle/>${paras}</p:txBody>`

  zip.file(notesPath, xml.replace(txBody, newTxBody))
  return `slide ${o.slide}: notes replaced`
}

/** Next free slideN.xml number — max over existing parts, not the count (deletions leave holes). */
function nextSlideNumber(zip: JSZip): number {
  const nums = Object.keys(zip.files)
    .map((f) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(f)?.[1])
    .filter(Boolean).map(Number)
  return (nums.length ? Math.max(...nums) : 0) + 1
}

/**
 * Every registration a new slide part needs, in one place: content-type
 * override, presentation rel, sldIdLst entry at position `afterIdx` (0 =
 * front). duplicateSlide and insertSlide differ only in how they make the part.
 */
async function registerNewSlide(zip: JSZip, refs: SlideRef[], newTarget: string, afterIdx: number): Promise<void> {
  const newNum = Number(/slide(\d+)\.xml$/.exec(newTarget)![1])
  const ctPath = '[Content_Types].xml'
  const ct = await text(zip, ctPath)
  zip.file(ctPath, ct.replace(
    '</Types>',
    `<Override PartName="/${newTarget}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
  ))

  const presRelsPath = 'ppt/_rels/presentation.xml.rels'
  const presRels = await text(zip, presRelsPath)
  const maxRid = Math.max(...[...presRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])))
  const newRid = `rId${maxRid + 1}`
  zip.file(presRelsPath, presRels.replace(
    '</Relationships>',
    `<Relationship Id="${newRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newNum}.xml"/></Relationships>`,
  ))

  const pres = await text(zip, 'ppt/presentation.xml')
  const maxNumId = Math.max(255, ...refs.map((r) => Number(r.numId)))
  const entry = `<p:sldId id="${maxNumId + 1}" r:id="${newRid}"/>`
  const updated = afterIdx === 0
    ? pres.replace(/<p:sldIdLst>/, `<p:sldIdLst>${entry}`)
    : pres.replace(refs[afterIdx - 1].sldIdTag, refs[afterIdx - 1].sldIdTag + entry)
  zip.file('ppt/presentation.xml', updated)
}

async function opDuplicate(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'duplicateSlide' }>): Promise<string> {
  const src = refAt(refs, o.slide)
  const afterIdx = o.after !== undefined ? o.after : o.slide
  if (afterIdx < 0 || afterIdx > refs.length) throw new Error(`after=${o.after} out of range`)

  const newTarget = `ppt/slides/slide${nextSlideNumber(zip)}.xml`
  zip.file(newTarget, await text(zip, src.target))

  // Rels: copy, minus any notesSlide link — a notes part belongs to ONE slide.
  const srcRels = relsPathOf(src.target)
  if (zip.file(srcRels)) {
    const rels = (await text(zip, srcRels)).replace(/<Relationship\s[^>]*notesSlide[^>]*\/>/g, '')
    zip.file(relsPathOf(newTarget), rels)
  }

  await registerNewSlide(zip, refs, newTarget, afterIdx)
  return `slide ${o.slide} duplicated → position ${afterIdx + 1} (shares chart/media parts with the original)`
}

// ── layouts ──────────────────────────────────────────────────────────────────

const layoutParts = (zip: JSZip) => Object.keys(zip.files)
  .filter((f) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))
  .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]))

type LayoutPh = { attrs: string; type: string; name: string }

function layoutPlaceholders(xml: string): LayoutPh[] {
  const out: LayoutPh[] = []
  for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const ph = /<p:ph\b([^>]*?)\/?>/.exec(sp[0])
    if (!ph) continue
    const attrs = ph[1].trim()
    const type = /\btype="([^"]+)"/.exec(attrs)?.[1] ?? 'body'   // no type = body, per spec
    const name = /<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(sp[0])?.[1] ?? type
    out.push({ attrs, type, name })
  }
  return out
}

/** The deck's layouts, 1-based, with their placeholder kinds — the menu for insertSlide. */
export async function listLayouts(zip: JSZip): Promise<LayoutInfo[]> {
  const parts = layoutParts(zip)
  const out: LayoutInfo[] = []
  for (let i = 0; i < parts.length; i++) {
    const xml = await text(zip, parts[i])
    const name = /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? `Layout ${i + 1}`
    out.push({ index: i + 1, name, placeholders: layoutPlaceholders(xml).map((p) => p.type) })
  }
  return out
}

const BODY_TYPES = new Set(['body', 'obj'])
/** Placeholder kinds a fresh slide instantiates. Footer/date/number come from the master; pic/chart/tbl/media need content we cannot fake. */
const INSTANTIATE = new Set(['title', 'ctrTitle', 'subTitle', 'body', 'obj'])

const paraXml = (t: string) => `<a:p><a:r><a:rPr lang="en-US"/><a:t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${escXml(t)}</a:t></a:r></a:p>`

async function opInsert(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'insertSlide' }>): Promise<string> {
  const afterIdx = o.after !== undefined ? o.after : refs.length
  if (afterIdx < 0 || afterIdx > refs.length) throw new Error(`after=${o.after} out of range`)

  const parts = layoutParts(zip)
  if (parts.length === 0) throw new Error('deck has no slideLayouts — insertSlide needs one; duplicate an existing slide instead')
  let part: string | undefined
  if (typeof o.layout === 'number') {
    part = parts[o.layout - 1]
    if (!part) throw new Error(`layout ${o.layout} does not exist (deck has ${parts.length})`)
  } else {
    const want = o.layout.trim().toLowerCase()
    for (const p of parts) {
      const name = /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(await text(zip, p))?.[1] ?? ''
      if (name.trim().toLowerCase() === want) { part = p; break }
    }
    if (!part) throw new Error(`no layout named "${o.layout}" — read the deck's layouts list and use the exact name or its number`)
  }
  const layoutXml = await text(zip, part)
  const phs = layoutPlaceholders(layoutXml)

  // One <p:sp> per placeholder we instantiate; geometry is inherited (no spPr
  // xfrm) exactly as PowerPoint's own "New Slide" does it.
  let id = 2
  const shapes: string[] = []
  const skipped: string[] = []
  let titleDone = false, subtitleDone = false, bodyDone = false
  for (const ph of phs) {
    if (!INSTANTIATE.has(ph.type)) { skipped.push(ph.type); continue }
    let paras = '<a:p><a:endParaRPr lang="en-US"/></a:p>'
    if ((ph.type === 'title' || ph.type === 'ctrTitle') && !titleDone && o.fill?.title !== undefined) { paras = paraXml(o.fill.title); titleDone = true }
    else if (ph.type === 'subTitle' && !subtitleDone && o.fill?.subtitle !== undefined) { paras = paraXml(o.fill.subtitle); subtitleDone = true }
    else if (BODY_TYPES.has(ph.type) && !bodyDone && o.fill?.body?.length) { paras = o.fill.body.map(paraXml).join(''); bodyDone = true }
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="${escXml(ph.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
      `<p:nvPr><p:ph ${ph.attrs}/></p:nvPr></p:nvSpPr><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`,
    )
  }
  const slideXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

  const newTarget = `ppt/slides/slide${nextSlideNumber(zip)}.xml`
  zip.file(newTarget, slideXml)
  zip.file(relsPathOf(newTarget),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/${path.posix.basename(part)}"/>` +
    '</Relationships>')
  await registerNewSlide(zip, refs, newTarget, afterIdx)

  const unfilled: string[] = []
  if (o.fill?.title !== undefined && !titleDone) unfilled.push('title')
  if (o.fill?.subtitle !== undefined && !subtitleDone) unfilled.push('subtitle')
  if (o.fill?.body?.length && !bodyDone) unfilled.push('body')
  const layoutName = /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(layoutXml)?.[1] ?? path.posix.basename(part)
  return `new slide from layout "${layoutName}" → position ${afterIdx + 1} (${shapes.length} placeholders` +
    (skipped.length ? `; ${[...new Set(skipped)].join('/')} placeholders left to the layout` : '') +
    (unfilled.length ? `; NOTE this layout has no ${unfilled.join('/')} placeholder — that text was not placed` : '') + ')'
}

// ── setText ──────────────────────────────────────────────────────────────────

async function opSetText(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'setText' }>): Promise<string> {
  const ref = refAt(refs, o.slide)
  const xml = await text(zip, ref.target)
  // Text shapes in document order — the same order the outline lists them.
  const sps = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].filter((m) => /<p:txBody>/.test(m[0]))
  const hit = sps[o.shape - 1]
  if (!hit) throw new Error(`slide ${o.slide} has ${sps.length} text shape(s); shape ${o.shape} does not exist`)
  const sp = hit[0]
  const txBody = /<p:txBody>[\s\S]*?<\/p:txBody>/.exec(sp)![0]
  const bodyPr = /<a:bodyPr\b[^>]*\/>|<a:bodyPr\b[\s\S]*?<\/a:bodyPr>/.exec(txBody)?.[0] ?? '<a:bodyPr/>'
  const lstStyle = /<a:lstStyle\b[^>]*\/>|<a:lstStyle\b[\s\S]*?<\/a:lstStyle>/.exec(txBody)?.[0] ?? '<a:lstStyle/>'
  // Template from the FIRST paragraph: its pPr (indent, bullet, spacing) and
  // its first run's rPr (font, size, colour). Copying the sibling is what keeps
  // the shape looking like it did; a bare <a:p> would fall back to the layout.
  const firstP = /<a:p>[\s\S]*?<\/a:p>|<a:p\b[^>]*>[\s\S]*?<\/a:p>/.exec(txBody)?.[0] ?? ''
  const pPr = /<a:pPr\b[^>]*\/>|<a:pPr\b[\s\S]*?<\/a:pPr>/.exec(firstP)?.[0] ?? ''
  const firstR = /<a:r>[\s\S]*?<\/a:r>|<a:r\b[^>]*>[\s\S]*?<\/a:r>/.exec(firstP)?.[0] ?? ''
  const rPr = /<a:rPr\b[^>]*\/>|<a:rPr\b[\s\S]*?<\/a:rPr>/.exec(firstR)?.[0] ?? ''
  const was = (txBody.match(/<a:p\b/g) ?? []).length
  const paras = o.paragraphs.map((t) =>
    `<a:p>${pPr}<a:r>${rPr}<a:t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${escXml(t)}</a:t></a:r></a:p>`).join('')
  const newSp = sp.replace(txBody, `<p:txBody>${bodyPr}${lstStyle}${paras}</p:txBody>`)
  zip.file(ref.target, xml.replace(sp, newSp))
  return `slide ${o.slide} shape ${o.shape}: ${o.paragraphs.length} paragraph(s) written (was ${was})`
}

// ── orphan sweep ─────────────────────────────────────────────────────────────

/**
 * Drop parts nothing references any more — clean.py's job. Every *.rels in the
 * package is a reference list; a media/notes/chart/embedding part that appears
 * in none of them is unreachable. Slides are judged by presentation.xml.rels
 * only. Counted from actual references, never inferred from an op.
 */
async function cleanOrphans(zip: JSZip): Promise<number> {
  const referenced = new Set<string>()
  for (const relsPath of Object.keys(zip.files).filter((f) => f.endsWith('.rels'))) {
    const ownerDir = relsPath.replace(/_rels\/[^/]+\.rels$/, '')
    const rels = await text(zip, relsPath)
    for (const m of rels.matchAll(/<Relationship\s[^>]*\/>/g)) {
      if (/TargetMode="External"/.test(m[0])) continue
      const target = /Target="([^"]+)"/.exec(m[0])?.[1]
      if (!target) continue
      const abs = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(ownerDir, target))
      referenced.add(abs)
    }
  }
  const candidates = Object.keys(zip.files).filter((f) =>
    /^ppt\/(media|notesSlides|charts|embeddings|slides)\/[^/]+$/.test(f) && !f.endsWith('.rels'))
  const removed: string[] = []
  for (const part of candidates) {
    if (referenced.has(part)) continue
    removed.push(part)
    zip.remove(part)
    const rels = relsPathOf(part)
    if (zip.file(rels)) zip.remove(rels)
  }
  if (removed.length) {
    const ctPath = '[Content_Types].xml'
    let ct = await text(zip, ctPath)
    for (const p of removed) ct = ct.replace(new RegExp(`<Override PartName="/${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`), '')
    zip.file(ctPath, ct)
  }
  return removed.length
}

async function opDelete(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'deleteSlide' }>): Promise<string> {
  if (refs.length === 1) throw new Error('cannot delete the only slide')
  const ref = refAt(refs, o.slide)

  // sldIdLst entry + presentation rel.
  const pres = await text(zip, 'ppt/presentation.xml')
  zip.file('ppt/presentation.xml', pres.replace(ref.sldIdTag, ''))
  const presRelsPath = 'ppt/_rels/presentation.xml.rels'
  const presRels = await text(zip, presRelsPath)
  zip.file(presRelsPath, presRels.replace(new RegExp(`<Relationship\\s[^>]*Id="${ref.rId}"[^>]*/>`), ''))

  // The slide part, its rels, its notes part (+ rels), and their CT overrides.
  const removed: string[] = [ref.target]
  const relsPath = relsPathOf(ref.target)
  if (zip.file(relsPath)) {
    const rels = await text(zip, relsPath)
    const notesTarget = /Target="([^"]*notesSlides[^"]*)"/.exec(rels)?.[1]
    if (notesTarget) {
      const notesPath = path.posix.normalize(path.posix.join('ppt/slides', notesTarget)).replace(/^\/+/, '')
      removed.push(notesPath)
      if (zip.file(relsPathOf(notesPath))) zip.remove(relsPathOf(notesPath))
    }
    zip.remove(relsPath)
  }
  for (const p of removed) zip.remove(p)

  const ctPath = '[Content_Types].xml'
  let ct = await text(zip, ctPath)
  for (const p of removed) ct = ct.replace(new RegExp(`<Override PartName="/${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`), '')
  zip.file(ctPath, ct)

  return `slide ${o.slide} deleted`
}

async function opReorder(zip: JSZip, refs: SlideRef[], o: Extract<PptxEditOp, { op: 'reorderSlides' }>): Promise<string> {
  const n = refs.length
  const sorted = [...o.order].sort((a, b) => a - b)
  if (o.order.length !== n || sorted.some((v, i) => v !== i + 1)) {
    throw new Error(`order must be a permutation of 1..${n}, got [${o.order.join(', ')}]`)
  }
  const pres = await text(zip, 'ppt/presentation.xml')
  const lstMatch = /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/.exec(pres)!
  const newLst = `<p:sldIdLst>${o.order.map((i) => refs[i - 1].sldIdTag).join('')}</p:sldIdLst>`
  zip.file('ppt/presentation.xml', pres.replace(lstMatch[0], newLst))
  return `slides reordered to [${o.order.join(', ')}]`
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Apply `ops` in sequence. `srcAbs` may be .pptx or .potx; `destAbs` is where
 * the result lands (same path = in-place for .pptx). The write is atomic-ish:
 * temp file → verify with the caller-provided reader → rename.
 */
export async function editPptx(
  srcAbs: string,
  destAbs: string,
  ops: PptxEditOp[],
  verify: (absPath: string) => Promise<{ slideCount: number }>,
): Promise<EditPptxResult & { verifiedSlides: number }> {
  if (ops.length === 0) throw new Error('no operations given')
  const zip = await JSZip.loadAsync(fs.readFileSync(srcAbs))

  // .potx → .pptx: swap the main content type, or PowerPoint opens it as a
  // template again.
  if (srcAbs.toLowerCase().endsWith('.potx')) {
    if (srcAbs === destAbs) throw new Error('editing a .potx in place is not allowed — give a .pptx output path')
    const ctPath = '[Content_Types].xml'
    const ct = await text(zip, ctPath)
    zip.file(ctPath, ct.replace(
      'presentationml.template.main+xml',
      'presentationml.presentation.main+xml',
    ))
  }

  const applied: string[] = []
  for (const op of ops) {
    // Refs are re-read every op: duplicate/delete/reorder change the list, and
    // 1-based indices in later ops refer to the CURRENT deck, not the original.
    const refs = await slideRefs(zip)
    switch (op.op) {
      case 'replaceText': applied.push(await opReplaceText(zip, refs, op)); break
      case 'setText': applied.push(await opSetText(zip, refs, op)); break
      case 'setNotes': applied.push(await opSetNotes(zip, refs, op)); break
      case 'duplicateSlide': applied.push(await opDuplicate(zip, refs, op)); break
      case 'insertSlide': applied.push(await opInsert(zip, refs, op)); break
      case 'deleteSlide': applied.push(await opDelete(zip, refs, op)); break
      case 'reorderSlides': applied.push(await opReorder(zip, refs, op)); break
    }
  }
  // Sweep AFTER every structural op — a part dropped by delete may be re-referenced by a later duplicate.
  const orphans = await cleanOrphans(zip)
  if (orphans) applied.push(`cleaned ${orphans} orphaned part(s) no slide references any more`)

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const tmp = destAbs + '.editing'
  fs.writeFileSync(tmp, buf)
  try {
    const check = await verify(tmp)
    fs.renameSync(tmp, destAbs)
    return { relPath: destAbs, slideCount: check.slideCount, applied, verifiedSlides: check.slideCount }
  } catch (err) {
    fs.unlinkSync(tmp)
    throw new Error(`edit produced a file that does not read back — original left untouched. ${String(err instanceof Error ? err.message : err)}`)
  }
}
