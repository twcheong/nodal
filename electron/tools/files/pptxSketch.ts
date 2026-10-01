// Foreign deck → wireframe contact sheet, so the MODEL (and the user) can see
// the SHAPE of a deck we did not write.
//
// Our painter (shared/deck/preview/svg.ts) renders OUR spec and nothing else,
// which left the original-design edit path blind: tool_edit_pptx could move
// and duplicate slides, but nobody could tell which slide was "the two-column
// one with the picture". Anthropic's pptx skill solves this with
// LibreOffice → PDF → thumbnails. We do not ship LibreOffice (hundreds of MB
// in a signed .dmg for one feature), so this is the cheap approximation:
//
//   every shape becomes a box in its real position and size, in ITS OWN
//   COLOUR, with the first lines of text drawn inside. Pictures stay hatched
//   and charts stay labelled — those we cannot draw — but fills, outlines,
//   text colour and the slide background are the deck's own. Not the picture,
//   but close enough to say "slide 1 is the dark cover", "slide 4 is the four
//   blue cards", "slide 5 is the green bar chart".
//
//   Colour matters more than it sounds: the first version painted everything
//   one grey and a deck that speaks in colour came back unreadable — every
//   card, bar and table header the same box. Fills are resolved through the
//   real chain (explicit srgbClr/schemeClr → style fillRef → none), theme
//   colours through clrMap + clrScheme, with lumMod/lumOff/shade/tint applied.
//   A shape with NO fill draws no box at all — its text floats, the way it
//   does on the slide.
//
// Geometry comes from the slide's own <a:xfrm>, falling back through the
// placeholder chain (slide ph → layout ph by idx/type → master ph by type)
// the way PowerPoint resolves it. Groups map their children through the
// group's chOff/chExt → off/ext transform. Anything we cannot place is listed
// in the summary but not drawn — a wrong box is worse than a missing one.

import fs from 'node:fs'
import JSZip from 'jszip'
import { type Node, parseXml, findAll, firstChild, paragraphText } from './ooxml'
import { slideOrder } from './pptxRead'
import { composeSheet, rasterize, stripEmojiForPango } from './pptxPreview'
import { listLayouts, type LayoutInfo } from './pptxEdit'

const EMU_PER_PT = 12700

// ── Colour ───────────────────────────────────────────────────────────────────

/** Theme colour scheme + the master's clrMap, which renames bg1/tx1 → lt1/dk1. */
type Palette = { scheme: Map<string, string>; clrMap: Record<string, string> }

const PRESET: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3',
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')

function toRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** OOXML colour transforms, in the order PowerPoint applies them. */
function applyMods(hexIn: string, mods: Node): string {
  let [r, g, b] = toRgb(hexIn)
  const pct = (tag: string) => {
    const v = findAll(mods, tag)[0]?.attrs.val
    return v === undefined ? undefined : Number(v) / 100000
  }
  const shade = pct('shade'), tint = pct('tint')
  if (shade !== undefined) { r *= shade; g *= shade; b *= shade }
  if (tint !== undefined) { r = r * tint + 255 * (1 - tint); g = g * tint + 255 * (1 - tint); b = b * tint + 255 * (1 - tint) }
  const lumMod = pct('lumMod'), lumOff = pct('lumOff')
  if (lumMod !== undefined || lumOff !== undefined) {
    const [h, sat, l] = rgb2hsl(r, g, b)
    const nl = clamp(l * (lumMod ?? 1) + (lumOff ?? 0), 0, 1)
    ;[r, g, b] = hsl2rgb(h, sat, nl)
  }
  return hex2(r) + hex2(g) + hex2(b)
}

/** Resolve the colour inside a fill/line container (solidFill, fillRef, bgRef…). */
function resolveColor(container: Node, pal: Palette): string | undefined {
  for (const c of [...container.children]) {
    const tag = c.tag.replace(/^.*:/, '')
    let base: string | undefined
    if (tag === 'srgbClr') base = c.attrs.val
    else if (tag === 'sysClr') base = c.attrs.lastClr
    else if (tag === 'prstClr') base = PRESET[c.attrs.val ?? '']
    else if (tag === 'schemeClr') {
      // clrMap renames the slide-facing names (bg1/tx1) to scheme slots (lt1/dk1).
      const want = c.attrs.val ?? ''
      base = pal.scheme.get(pal.clrMap[want] ?? want) ?? pal.scheme.get(want)
    }
    if (!base || !/^[0-9A-Fa-f]{6}$/.test(base)) continue
    return '#' + applyMods(base, c)
  }
  return undefined
}

function parseScheme(themeXml: string): Map<string, string> {
  const out = new Map<string, string>()
  const root = parseXml(themeXml)
  const cs = findAll(root, 'clrScheme')[0]
  if (!cs) return out
  for (const slot of cs.children) {
    const name = slot.tag.replace(/^.*:/, '')
    const c = slot.children[0]
    if (!c) continue
    const v = c.tag.endsWith('srgbClr') ? c.attrs.val : c.attrs.lastClr
    if (v && /^[0-9A-Fa-f]{6}$/.test(v)) out.set(name, v)
  }
  return out
}

const luminance = (hexOrCss: string): number => {
  const h = hexOrCss.replace('#', '')
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) return 1
  const [r, g, b] = toRgb(h)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}
/** Ink that stays readable on `bg`. */
const readableOn = (bg: string) => (luminance(bg) > 0.55 ? '#1a2024' : '#f4f7f8')

export type ShapeCounts = { text: number; pic: number; chart: number; table: number; other: number }
export type SlideSketchSummary = { slide: number; title?: string; shapes: ShapeCounts; unplaced: number }
/** `pages` is one image per slide, larger than a sheet cell — the panel's page view. */
export type SketchResult = { png: Buffer; pages: Buffer[]; slideCount: number; summary: SlideSketchSummary[]; layouts: LayoutInfo[] }

/** Width of a single-slide render. A sheet cell is ~290px; reading one slide needs more. */
export const PAGE_W = 1000

/** "3 text · 1 pic · 1 table" — for outlines the model reads. */
export function shapesLabel(c: ShapeCounts): string {
  const parts: string[] = []
  if (c.text) parts.push(`${c.text} text`)
  if (c.pic) parts.push(`${c.pic} pic`)
  if (c.chart) parts.push(`${c.chart} chart`)
  if (c.table) parts.push(`${c.table} table`)
  if (c.other) parts.push(`${c.other} shape`)
  return parts.length ? parts.join(' · ') : 'empty'
}

// ── Geometry ─────────────────────────────────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number }   // EMU, slide space
type Xform = (b: Box) => Box

function readXfrm(n: Node): Box | undefined {
  // <a:xfrm> lives under spPr (sp/pic), grpSpPr (group) or p:xfrm (graphicFrame).
  const xfrm = findAll(n, 'xfrm').find((x) => {
    // Nearest xfrm to this shape, not one of a nested child's — findAll walks
    // depth-first, so the first hit with off+ext is this shape's own for
    // sp/pic/graphicFrame. Groups are handled by the caller via readGroupXfrm.
    return !!firstChild(x, 'off') && !!firstChild(x, 'ext')
  })
  if (!xfrm) return undefined
  const off = firstChild(xfrm, 'off')!, ext = firstChild(xfrm, 'ext')!
  const b = { x: Number(off.attrs.x), y: Number(off.attrs.y), w: Number(ext.attrs.cx), h: Number(ext.attrs.cy) }
  return [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : undefined
}

/** A group's own frame plus the child-space it maps from. */
function readGroupXfrm(grp: Node): { frame: Box; child: Box } | undefined {
  const grpSpPr = firstChild(grp, 'grpSpPr')
  const xfrm = grpSpPr ? firstChild(grpSpPr, 'xfrm') : undefined
  if (!xfrm) return undefined
  const off = firstChild(xfrm, 'off'), ext = firstChild(xfrm, 'ext')
  const chOff = firstChild(xfrm, 'chOff'), chExt = firstChild(xfrm, 'chExt')
  if (!off || !ext || !chOff || !chExt) return undefined
  const frame = { x: Number(off.attrs.x), y: Number(off.attrs.y), w: Number(ext.attrs.cx), h: Number(ext.attrs.cy) }
  const child = { x: Number(chOff.attrs.x), y: Number(chOff.attrs.y), w: Number(chExt.attrs.cx), h: Number(chExt.attrs.cy) }
  return [frame, child].every((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite)) ? { frame, child } : undefined
}

// ── Placeholder chain ────────────────────────────────────────────────────────

type PhKey = { type: string; idx?: string }
type PhMap = { byIdx: Map<string, Box>; byType: Map<string, Box> }

function phOf(sp: Node): PhKey | undefined {
  const ph = findAll(sp, 'ph')[0]
  if (!ph) return undefined
  // A placeholder with no type is a body placeholder — that is the spec default.
  return { type: ph.attrs.type ?? 'body', idx: ph.attrs.idx }
}

function collectPh(root: Node): PhMap {
  const byIdx = new Map<string, Box>(), byType = new Map<string, Box>()
  for (const sp of findAll(root, 'sp')) {
    const key = phOf(sp)
    const box = key ? readXfrm(sp) : undefined
    if (!key || !box) continue
    if (key.idx !== undefined && !byIdx.has(key.idx)) byIdx.set(key.idx, box)
    if (!byType.has(key.type)) byType.set(key.type, box)
  }
  return { byIdx, byType }
}

function resolvePh(key: PhKey, chain: PhMap[]): Box | undefined {
  // idx is the precise link (slide ↔ layout); type is the looser fallback
  // (layout ↔ master, or a slide that only names the type).
  for (const m of chain) {
    if (key.idx !== undefined) { const b = m.byIdx.get(key.idx); if (b) return b }
  }
  const aliases = key.type === 'ctrTitle' ? ['ctrTitle', 'title'] : key.type === 'subTitle' ? ['subTitle', 'body'] : [key.type]
  for (const m of chain) for (const t of aliases) { const b = m.byType.get(t); if (b) return b }
  return undefined
}

/** Follow a part's rels to the first target matching `re` (normalised to a zip path). */
async function relTarget(zip: JSZip, partPath: string, re: RegExp): Promise<string | undefined> {
  const relsPath = partPath.replace(/\/([^/]+)$/, '/_rels/$1.rels')
  const f = zip.files[relsPath]
  if (!f) return undefined
  const rels = await f.async('string')
  for (const m of rels.matchAll(/<Relationship\s[^>]*\/>/g)) {
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (target && re.test(target)) {
      // Targets are relative to the part's directory ("../slideLayouts/x.xml").
      const dir = partPath.replace(/\/[^/]+$/, '/')
      const segs = (dir + target).split('/')
      const out: string[] = []
      for (const s of segs) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s) }
      return out.join('/')
    }
  }
  return undefined
}

// ── Shape walk ───────────────────────────────────────────────────────────────

type Paint = { fill?: string; line?: string; ink?: string; linkInk?: string }
/** One paragraph, with the two things that move it on the slide. */
type Para = { text: string; algn?: string; link?: true }
type Drawn =
  | ({ kind: 'text'; box: Box; paras: Para[]; title: boolean; anchor?: string } & Paint)
  | ({ kind: 'pic' | 'chart' | 'other'; box: Box } & Paint)
  | ({ kind: 'table'; box: Box; cols: number; rows: number } & Paint)
  | ({ kind: 'line'; box: Box } & Paint)

/** Explicit fill on the shape, else its style fillRef, else none (draw no box). */
function fillOf(sp: Node, pal: Palette): { fill?: string; picture?: true } {
  const spPr = firstChild(sp, 'spPr')
  if (spPr) {
    if (firstChild(spPr, 'noFill')) return {}
    if (firstChild(spPr, 'blipFill')) return { picture: true }
    const sf = firstChild(spPr, 'solidFill')
    if (sf) return { fill: resolveColor(sf, pal) }
    const gf = firstChild(spPr, 'gradFill')
    // A gradient reads as its first stop at thumbnail size.
    if (gf) { const gs = findAll(gf, 'gs')[0]; if (gs) return { fill: resolveColor(gs, pal) } }
  }
  // <p:style><a:fillRef idx="N"><a:schemeClr…>> — how most PowerPoint autoshapes
  // get their colour. idx 0 means "no fill" in the style table.
  const style = firstChild(sp, 'style')
  const fr = style ? firstChild(style, 'fillRef') : undefined
  if (fr && Number(fr.attrs.idx ?? '0') > 0) return { fill: resolveColor(fr, pal) }
  return {}
}

function lineOf(sp: Node, pal: Palette): string | undefined {
  const spPr = firstChild(sp, 'spPr')
  const ln = spPr ? firstChild(spPr, 'ln') : undefined
  if (ln) {
    if (firstChild(ln, 'noFill')) return undefined
    const sf = firstChild(ln, 'solidFill')
    if (sf) return resolveColor(sf, pal)
  }
  const style = firstChild(sp, 'style')
  const lr = style ? firstChild(style, 'lnRef') : undefined
  if (lr && Number(lr.attrs.idx ?? '0') > 0) return resolveColor(lr, pal)
  return undefined
}

/**
 * Colour of the first run that actually SHOWS text.
 *
 * Not merely the first rPr with a fill: decks carry empty runs whose colour is
 * whatever was last typed, and reading those produced dark-on-dark text
 * (measured on a Google-Slides export whose empty leading run matched the
 * shape's own fill). A run with no visible text tells us nothing about ink.
 */
function inkOf(sp: Node, pal: Palette): string | undefined {
  const txBody = firstChild(sp, 'txBody') ?? findAll(sp, 'txBody')[0]
  if (!txBody) return undefined
  for (const r of findAll(txBody, 'r')) {
    const t = firstChild(r, 't')
    if (!t || !t.text.trim()) continue
    const rPr = firstChild(r, 'rPr')
    const sf = rPr ? firstChild(rPr, 'solidFill') : undefined
    if (sf) { const c = resolveColor(sf, pal); if (c) return c }
  }
  return undefined
}

/**
 * The deck's own ink, unless it would be unreadable on what we actually drew.
 *
 * A wireframe exists to be read at thumbnail size. Where the source relies on
 * something we do not render (a gradient, a picture behind the text, an
 * overlay) its stated colour can land on top of our flat fill with no contrast
 * left — so fall back to plain readable ink rather than draw an invisible line.
 */
function inkFor(stated: string | undefined, behind: string): string {
  if (!stated) return readableOn(behind)
  return Math.abs(luminance(stated) - luminance(behind)) < 0.22 ? readableOn(behind) : stated
}

/**
 * Paragraphs with the two properties that decide where the text actually sits:
 * `algn` (pPr) and whether any run is a hyperlink. Both were ignored before —
 * a deck whose table cells are all algn="ctr" came out uniformly left-ragged,
 * and its 15 links rendered as plain body text.
 */
function shapeParas(sp: Node): Para[] {
  const txBody = firstChild(sp, 'txBody') ?? findAll(sp, 'txBody')[0]
  if (!txBody) return []
  const out: Para[] = []
  for (const p of findAll(txBody, 'p')) {
    const text = paragraphText(p)
    if (!text) continue
    const algn = firstChild(p, 'pPr')?.attrs.algn
    // PowerPoint styles a hyperlink run from the theme even with no explicit
    // rPr — the <a:hlinkClick> is the whole signal.
    const link = findAll(p, 'hlinkClick').length > 0 ? (true as const) : undefined
    out.push({ text, ...(algn ? { algn } : {}), ...(link ? { link } : {}) })
  }
  return out
}

/** Vertical anchor of the text body — "ctr" centres the block, "b" bottoms it. */
function anchorOf(sp: Node): string | undefined {
  const txBody = firstChild(sp, 'txBody') ?? findAll(sp, 'txBody')[0]
  const bodyPr = txBody ? firstChild(txBody, 'bodyPr') : undefined
  return bodyPr?.attrs.anchor
}

/**
 * What is actually painted behind `box` — the last filled shape already drawn
 * that contains its centre, else the slide background.
 *
 * Measured bug this fixes: a dark cover panel is one shape, and the title on
 * top of it is another with NO fill of its own. Judging the title's contrast
 * against the (light) slide background flipped its white ink to dark, and the
 * cover came out with invisible text — worse than before the contrast guard.
 */
function behindOf(box: Box, out: Drawn[], slideBg: string): string {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i]
    if (!d.fill) continue
    const b = d.box
    if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return d.fill
  }
  return slideBg
}

function walk(
  parent: Node, xform: Xform, chain: PhMap[], out: Drawn[], unplaced: { n: number }, slideH: number,
  pal: Palette, bg: string,
): void {
  for (const n of parent.children) {
    const tag = n.tag.replace(/^.*:/, '')
    if (tag === 'grpSp') {
      const g = readGroupXfrm(n)
      const inner: Xform = g
        ? (b) => xform({
            x: g.frame.x + (b.x - g.child.x) * (g.child.w ? g.frame.w / g.child.w : 1),
            y: g.frame.y + (b.y - g.child.y) * (g.child.h ? g.frame.h / g.child.h : 1),
            w: b.w * (g.child.w ? g.frame.w / g.child.w : 1),
            h: b.h * (g.child.h ? g.frame.h / g.child.h : 1),
          })
        : xform
      walk(n, inner, chain, out, unplaced, slideH, pal, bg)
      continue
    }
    if (tag === 'sp') {
      const key = phOf(n)
      const box = readXfrm(n) ?? (key ? resolvePh(key, chain) : undefined)
      const paras = shapeParas(n)
      if (!box) { if (paras.length || key) unplaced.n++; continue }
      const b = xform(box)
      const f = fillOf(n, pal)
      const line = lineOf(n, pal)
      if (key?.type === 'pic' || f.picture) { out.push({ kind: 'pic', box: b, line }); continue }
      if (paras.length === 0) {
        // Nothing to say and nothing to paint — drawing a grey box here is pure
        // noise; the original shows nothing there either.
        if (!f.fill && !line) continue
        out.push({ kind: 'other', box: b, fill: f.fill, line })
        continue
      }
      const title = key?.type === 'title' || key?.type === 'ctrTitle' || (b.y < slideH * 0.2 && out.every((d) => d.kind !== 'text' || !d.title))
      // Contrast is judged against what is really behind this text — its own
      // fill if it has one, else whatever shape it sits on, else the slide.
      const behind = f.fill ?? behindOf(b, out, bg)
      const hlink = pal.scheme.get(pal.clrMap['hlink'] ?? 'hlink')
      out.push({
        kind: 'text', box: b, paras, title, anchor: anchorOf(n),
        fill: f.fill, line,
        ink: inkFor(inkOf(n, pal), behind),
        ...(hlink ? { linkInk: inkFor('#' + hlink, behind) } : {}),
      })
      continue
    }
    if (tag === 'pic') {
      const box = readXfrm(n)
      if (!box) { unplaced.n++; continue }
      out.push({ kind: 'pic', box: xform(box) })
      continue
    }
    if (tag === 'graphicFrame') {
      const box = readXfrm(n)
      if (!box) { unplaced.n++; continue }
      void bg
      const tbl = findAll(n, 'tbl')[0]
      if (tbl) {
        const cols = findAll(tbl, 'gridCol').length || 1
        const rows = findAll(tbl, 'tr').length || 1
        out.push({ kind: 'table', box: xform(box), cols: Math.min(cols, 12), rows: Math.min(rows, 10) })
      } else if (findAll(n, 'chart').length) {
        out.push({ kind: 'chart', box: xform(box) })
      } else {
        out.push({ kind: 'other', box: xform(box) })
      }
      continue
    }
    if (tag === 'cxnSp') {
      const box = readXfrm(n)
      if (box) out.push({ kind: 'line', box: xform(box) })
      continue
    }
  }
}

// ── SVG ──────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pt = (emu: number) => emu / EMU_PER_PT

function textBlock(d: Extract<Drawn, { kind: 'text' }>): string {
  const x = pt(d.box.x), y = pt(d.box.y), w = pt(d.box.w), h = pt(d.box.h)
  const shown = d.paras.slice(0, 3)
  const more = d.paras.length - shown.length
  // Fit: the box height divided over the lines we draw, capped so a huge title
  // box does not shout and a thin footer does not vanish.
  const fs = Math.max(6, Math.min(d.title ? 18 : 12, h / (shown.length * 1.35)))
  const pad = 3
  const lineH = fs * 1.15
  const maxChars = Math.max(4, Math.floor((w - pad * 2) / (fs * 0.55)))
  const ink = d.ink ?? '#2a3338'

  // Vertical anchor — PowerPoint centres a lot of table-cell text, and drawing
  // every block from the top made those slides look mis-aligned against the real deck.
  const blockH = shown.length * lineH + (more > 0 ? fs : 0)
  const top = d.anchor === 'ctr' ? y + Math.max(pad, (h - blockH) / 2)
    : d.anchor === 'b' ? y + Math.max(pad, h - blockH - pad)
    : y + pad

  const rows = shown.map((p, i) => {
    const clipped = p.text.length > maxChars ? p.text.slice(0, maxChars - 1) + '…' : p.text
    // Horizontal alignment from the paragraph itself.
    const [tx, anchor] = p.algn === 'ctr' ? [x + w / 2, 'middle']
      : p.algn === 'r' ? [x + w - pad, 'end']
      : [x + pad, 'start']
    const colour = p.link ? (d.linkInk ?? ink) : ink
    return `<text x="${tx.toFixed(1)}" y="${(top + lineH * (i + 1) - fs * 0.25).toFixed(1)}" font-size="${fs.toFixed(1)}"` +
      ` text-anchor="${anchor}" font-family="Helvetica, Arial, sans-serif"` +
      `${d.title ? ' font-weight="bold"' : ''}${p.link ? ' text-decoration="underline"' : ''} fill="${colour}">${esc(clipped)}</text>`
  })
  const extra = more > 0
    ? `<text x="${(x + pad).toFixed(1)}" y="${(top + lineH * shown.length + fs * 0.75).toFixed(1)}" font-size="6" fill="${ink}" opacity="0.6">+${more} more</text>`
    : ''
  // No fill and no outline on the slide → no box here either. The original
  // shows bare text; a box around every paragraph was the loudest wrong note
  // in the first version.
  const boxed = d.fill || d.line
    ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"` +
      ` fill="${d.fill ?? 'none'}" stroke="${d.line ?? 'none'}" stroke-width="0.8"/>`
    : ''
  return boxed + rows.join('') + extra
}

function block(d: Drawn): string {
  if (d.kind === 'text') return textBlock(d)
  const x = pt(d.box.x), y = pt(d.box.y), w = pt(d.box.w), h = pt(d.box.h)
  const r = (fill: string, stroke: string) =>
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`
  const label = (t: string, on: string) =>
    `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 + 3).toFixed(1)}" font-size="${Math.max(6, Math.min(11, h / 3)).toFixed(1)}"` +
    ` text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="${readableOn(on)}" opacity="0.75">${t}</text>`
  switch (d.kind) {
    case 'pic': {
      // We cannot draw the picture, so it stays a hatched plate — but in the
      // deck's own neutral so a photo on a dark slide still reads as dark.
      const fill = d.fill ?? '#d7dde0'
      const stroke = d.line ?? '#9aa5ab'
      return r(fill, stroke) +
        `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="${stroke}" stroke-width="0.5"/>` +
        `<line x1="${(x + w).toFixed(1)}" y1="${y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="${stroke}" stroke-width="0.5"/>` +
        label('img', fill)
    }
    case 'chart': {
      const fill = d.fill ?? '#dbe6e9'
      return r(fill, d.line ?? '#8fa3aa') + label('chart', fill)
    }
    case 'table': {
      const fill = d.fill ?? '#f2f4f5'
      const stroke = d.line ?? '#8fa3aa'
      const grid: string[] = []
      for (let c = 1; c < d.cols; c++) { const gx = x + (w * c) / d.cols; grid.push(`<line x1="${gx.toFixed(1)}" y1="${y.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="${stroke}" stroke-width="0.4"/>`) }
      for (let rr = 1; rr < d.rows; rr++) { const gy = y + (h * rr) / d.rows; grid.push(`<line x1="${x.toFixed(1)}" y1="${gy.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${stroke}" stroke-width="0.4"/>`) }
      return r(fill, stroke) + grid.join('')
    }
    case 'line':
      return `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="${d.line ?? '#8a949a'}" stroke-width="0.8"/>`
    default:
      // walk() only emits `other` when there IS a fill or a line.
      return r(d.fill ?? 'none', d.line ?? 'none')
  }
}

function slideSketchSvg(drawn: Drawn[], slideW: number, slideH: number, width: number, bg: string): string {
  const W = pt(slideW), H = pt(slideH)
  const height = Math.round((width * H) / W)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="${bg}" stroke="#c9d1d5" stroke-width="0.8"/>` +
    drawn.map(block).join('') +
    '</svg>'
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function sketchDeck(safePath: string): Promise<SketchResult> {
  const zip = await JSZip.loadAsync(fs.readFileSync(safePath))
  const slideNames = await slideOrder(zip)
  if (slideNames.length === 0) throw new Error('No slides found — is this a valid .pptx?')

  let slideW = 12_192_000, slideH = 6_858_000
  const presPart = zip.files['ppt/presentation.xml']
  if (presPart) {
    const pres = await presPart.async('string')
    const cx = /<p:sldSz[^>]*\scx="(\d+)"/.exec(pres)?.[1], cy = /<p:sldSz[^>]*\scy="(\d+)"/.exec(pres)?.[1]
    if (cx) slideW = Number(cx)
    if (cy) slideH = Number(cy)
  }

  // Palette per master (theme + clrMap), cached — most decks have one master.
  const palCache = new Map<string, Palette>()
  const paletteFor = async (masterPart: string | undefined): Promise<Palette> => {
    const key = masterPart ?? ''
    const hit = palCache.get(key)
    if (hit) return hit
    let scheme = new Map<string, string>()
    let clrMap: Record<string, string> = {}
    if (masterPart && zip.files[masterPart]) {
      const masterXml = await zip.files[masterPart].async('string')
      const cm = /<p:clrMap\b([^>]*)\/>/.exec(masterXml)
      if (cm) for (const m of cm[1].matchAll(/(\w+)="(\w+)"/g)) clrMap[m[1]] = m[2]
      const themePart = await relTarget(zip, masterPart, /theme\//)
      if (themePart && zip.files[themePart]) scheme = parseScheme(await zip.files[themePart].async('string'))
    }
    if (scheme.size === 0) {
      // No theme found — fall back to Office defaults so schemeClr still resolves.
      scheme = new Map(Object.entries({ dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47' }))
      if (Object.keys(clrMap).length === 0) clrMap = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
    }
    const pal: Palette = { scheme, clrMap }
    palCache.set(key, pal)
    return pal
  }

  /** Slide background: the slide's own <p:bg>, else the layout's, else the master's. */
  const backgroundFor = async (parts: (string | undefined)[], pal: Palette): Promise<string> => {
    for (const part of parts) {
      if (!part || !zip.files[part]) continue
      const bgNode = findAll(parseXml(await zip.files[part].async('string')), 'bg')[0]
      if (!bgNode) continue
      const pr = firstChild(bgNode, 'bgPr')
      if (pr) {
        if (firstChild(pr, 'noFill')) continue
        const sf = firstChild(pr, 'solidFill')
        const c = sf ? resolveColor(sf, pal) : undefined
        if (c) return c
        const gf = firstChild(pr, 'gradFill')
        const gs = gf ? findAll(gf, 'gs')[0] : undefined
        const gc = gs ? resolveColor(gs, pal) : undefined
        if (gc) return gc
      }
      const ref = firstChild(bgNode, 'bgRef')
      const rc = ref ? resolveColor(ref, pal) : undefined
      if (rc) return rc
    }
    return '#ffffff'
  }

  // Layout/master placeholder maps are cached per part — most slides share one layout.
  const phCache = new Map<string, PhMap>()
  const phMapFor = async (part: string | undefined): Promise<PhMap | undefined> => {
    if (!part || !zip.files[part]) return undefined
    const hit = phCache.get(part)
    if (hit) return hit
    const m = collectPh(parseXml(await zip.files[part].async('string')))
    phCache.set(part, m)
    return m
  }

  const svgs: ((cellW: number) => string)[] = []
  const summary: SlideSketchSummary[] = []
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async('string')
    const root = parseXml(xml)
    const layoutPart = await relTarget(zip, slideNames[i], /slideLayouts\//)
    const masterPart = layoutPart ? await relTarget(zip, layoutPart, /slideMasters\//) : undefined
    const chain: PhMap[] = []
    const lm = await phMapFor(layoutPart); if (lm) chain.push(lm)
    const mm = await phMapFor(masterPart); if (mm) chain.push(mm)

    const spTree = findAll(root, 'spTree')[0] ?? root
    const pal = await paletteFor(masterPart)
    const bg = await backgroundFor([slideNames[i], layoutPart, masterPart], pal)
    const drawn: Drawn[] = []
    const unplaced = { n: 0 }
    walk(spTree, (b) => b, chain, drawn, unplaced, slideH, pal, bg)

    const counts: ShapeCounts = { text: 0, pic: 0, chart: 0, table: 0, other: 0 }
    for (const d of drawn) {
      if (d.kind === 'line') continue
      counts[d.kind]++
    }
    const titleShape = drawn.find((d): d is Extract<Drawn, { kind: 'text' }> => d.kind === 'text' && d.title)
    summary.push({ slide: i + 1, title: titleShape?.paras[0]?.text, shapes: counts, unplaced: unplaced.n })
    svgs.push((cellW) => stripEmojiForPango(slideSketchSvg(drawn, slideW, slideH, cellW, bg)))
  }

  const png = await composeSheet({ count: svgs.length, pageW: pt(slideW), pageH: pt(slideH), cell: (i, cellW) => svgs[i](cellW) })
  const pages = await Promise.all(svgs.map((f) => rasterize(f(PAGE_W), PAGE_W)))
  const layouts = await listLayouts(zip).catch(() => [] as LayoutInfo[])
  return { png, pages, slideCount: svgs.length, summary, layouts }
}
