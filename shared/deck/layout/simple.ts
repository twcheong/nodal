// Layout for the plain content kinds: text · bullets · quote · image · table.
//
// See shared/deck/page.ts (purity) and ./common.ts (colour-role rule).

import { PAGE_H, PAGE_W } from '../page'
import { CAPS, type SlideSpec } from '../spec'
import type { El, LayoutWarning, TableCell } from '../el'
import { contentBand, headerEl, padNum, rowBand, type LayoutCtx } from './common'
import { paintBlock } from './blocks'

export type LayoutResult = { els: El[]; warnings: LayoutWarning[] }

/** Split body at the paragraph break nearest the midpoint (pure, deterministic).
 *  No `\n\n`? Fall back to the sentence end nearest the midpoint. */
function splitBody(body: string): [string, string] | null {
  const half = body.length / 2
  const breaks = [...body.matchAll(/\n\n+/g)].map((m) => m.index!)
  const cut = breaks.length
    ? breaks.reduce((a, b) => (Math.abs(b - half) < Math.abs(a - half) ? b : a))
    : [...body.matchAll(/[.!?。]\s/g)].map((m) => m.index! + 1).reduce((a, b) => (Math.abs(b - half) < Math.abs(a - half) ? b : a), -1)
  if (cut <= 0) return null
  return [body.slice(0, cut).trim(), body.slice(cut).trim()]
}

export function layoutText(spec: Extract<SlideSpec, { kind: 'text' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const variant = spec.variant ?? 'rail'

  if (variant === 'panel') {
    // Title stacked in the left 28%, body inside a card on the right.
    const leftW = c.contentW * 0.28
    const cardX = s.margin + leftW + s.gap
    const cardW = c.contentW - leftW - s.gap
    const els: El[] = []
    if (spec.title) {
      els.push({
        type: 'text', rect: { x: s.margin, y: 1.45, w: leftW - 0.3, h: 2.4 }, runs: [{ text: spec.title }],
        style: { fontSize: 26, bold: true, color: r.title, fontFace: t.headFont, valign: 'top', fit: 'shrink' },
      })
    }
    els.push({ type: 'roundRect', rect: { x: cardX, y: 1.4, w: cardW, h: 5.5 }, radius: s.radiusLg, fill: { color: r.cardFill } })
    els.push({
      type: 'text', rect: { x: cardX + s.pad, y: 1.4 + s.pad, w: cardW - s.pad * 2, h: 5.5 - s.pad * 2 },
      runs: [{ text: spec.body }],
      style: { fontSize: 16, color: r.body, fontFace: t.bodyFont, valign: 'top' },
    })
    return { els, warnings: [] }
  }

  if (variant === 'twoCol') {
    const halves = splitBody(spec.body)
    if (halves) {
      const colW = (c.contentW - s.gap) / 2
      return {
        els: [
          ...headerEl(spec.title, c),
          { type: 'rect', rect: { x: s.margin, y: 1.5, w: c.contentW, h: 0.02 }, fill: { color: r.hairline } },
          {
            type: 'text', rect: { x: s.margin, y: 1.75, w: colW, h: 5.1 }, runs: [{ text: halves[0] }],
            style: { fontSize: 15, color: r.body, fontFace: t.bodyFont, valign: 'top' },
          },
          {
            type: 'text', rect: { x: s.margin + colW + s.gap, y: 1.75, w: colW, h: 5.1 }, runs: [{ text: halves[1] }],
            style: { fontSize: 15, color: r.body, fontFace: t.bodyFont, valign: 'top' },
          },
        ],
        warnings: [],
      }
    }
    // Unsplittable (one short sentence) — fall through to 'rail'.
  }

  // 'rail' (default) — today's geometry, byte-identical.
  return {
    els: [
      ...headerEl(spec.title, c),
      // The accent stripe that used to sit here is gone: a thin bar down one
      // edge is the single most recognisable "generated slide" tell. The
      // device is now WHITESPACE — the body is inset and measured, which is
      // what the conventions we follow prescribe in its place.
      {
        type: 'text',
        rect: { x: c.s.margin + 0.9, y: 1.4, w: c.contentW - 1.8, h: 5.6 },
        runs: [{ text: spec.body }],
        style: { fontSize: 16, color: c.r.body, fontFace: c.t.bodyFont, valign: 'top' },
      },
    ],
    warnings: [],
  }
}

export function layoutBullets(spec: Extract<SlideSpec, { kind: 'bullets' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = [...headerEl(spec.title, c)]
  const items = spec.bullets

  // Fallback ladder (content is never dropped to keep a variant):
  //   cards holds ≤6 · twoCol needs ≥4 · >8 of anything → compact list.
  const variant =
    spec.variant === 'cards' && items.length > 6 ? 'rows'
    : spec.variant === 'twoCol' && items.length < 4 ? 'rows'
    : (spec.variant ?? 'rows')

  if (variant === 'cards' ) {
    // 4 items → 2×2, not 3+1 (a lone card on the last row reads as a mistake).
    const cols = items.length <= 3 ? Math.max(items.length, 1) : items.length === 4 ? 2 : 3
    const rowsN = Math.ceil(items.length / cols)
    const cardW = (c.contentW - s.gap * (cols - 1)) / cols
    const bandC = contentBand(!!spec.title, c)
    const cardH = (bandC.h - s.gap * (rowsN - 1)) / rowsN
    items.forEach((b, i) => {
      const x = s.margin + (i % cols) * (cardW + s.gap)
      const y = bandC.y + Math.floor(i / cols) * (cardH + s.gap)
      els.push({ type: 'roundRect', rect: { x, y, w: cardW, h: cardH }, radius: s.radiusLg, fill: { color: r.cardFill } })
      els.push({
        type: 'text', rect: { x: x + s.pad, y: y + s.pad * 0.7, w: cardW - s.pad * 2, h: 0.55 }, runs: [{ text: padNum(i + 1) }],
        style: { fontSize: 26, bold: true, color: t.accent, fontFace: t.headFont },
      })
      els.push({
        type: 'text', rect: { x: x + s.pad, y: y + s.pad * 0.7 + 0.65, w: cardW - s.pad * 2, h: cardH - s.pad * 1.4 - 0.65 },
        runs: [{ text: b }],
        // Cards fill the band, so a one-line item pinned to the top left two
        // inches of empty card under it. Centre it in the space below the
        // numeral instead.
        style: { fontSize: 15, color: r.onLight, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
      })
    })
    return { els, warnings: [] }
  }

  if (variant === 'numbered' && items.length <= CAPS.bulletDotRows) {
    // Editorial: big accent numerals, hairline rules between rows. Pairs with sharp.
    const bandN = contentBand(!!spec.title, c)
    const { y0: ny0, rowH } = rowBand(items.length, bandN, 1.3)
    items.forEach((b, i) => {
      const y = ny0 + i * rowH
      if (i > 0) els.push({ type: 'rect', rect: { x: s.margin, y: y - 0.005, w: c.contentW, h: 0.012 }, fill: { color: r.hairline } })
      els.push({
        type: 'text', rect: { x: s.margin, y, w: 0.9, h: rowH }, runs: [{ text: padNum(i + 1) }],
        style: { fontSize: 30, bold: true, color: t.accent, fontFace: t.headFont, valign: 'middle' },
      })
      els.push({
        type: 'text', rect: { x: s.margin + 1.1, y, w: c.contentW - 1.3, h: rowH }, runs: [{ text: b }],
        style: { fontSize: 17, color: r.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
      })
    })
    return { els, warnings: [] }
  }

  if (variant === 'twoCol') {
    const colW = (c.contentW - s.gap) / 2
    const perCol = Math.ceil(items.length / 2)
    const bandT = contentBand(!!spec.title, c)
    const { y0: ty0, rowH } = rowBand(perCol, bandT, 1.15)
    items.forEach((b, i) => {
      const col = Math.floor(i / perCol)
      const row = i % perCol
      const x = s.margin + col * (colW + s.gap)
      const y = ty0 + row * rowH
      els.push({ type: 'ellipse', rect: { x: x + 0.05, y: y + rowH / 2 - 0.08, w: 0.16, h: 0.16 }, fill: { color: t.accent } })
      els.push({
        type: 'text', rect: { x: x + 0.45, y, w: colW - 0.6, h: rowH }, runs: [{ text: b }],
        style: { fontSize: 15, color: r.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
      })
    })
    return { els, warnings: [] }
  }

  if (items.length > CAPS.bulletDotRows) {
    // Too many for dot rows — plain compact list.
    const bandL = contentBand(!!spec.title, c)
    els.push({
      type: 'text',
      rect: { x: c.s.margin, y: bandL.y, w: c.contentW, h: bandL.h },
      runs: items.map((b) => ({ text: b, bullet: true, paraSpaceAfter: 8 })),
      style: { fontSize: 15, color: c.r.body, fontFace: c.t.bodyFont, valign: 'top' },
    })
    return { els, warnings: [] }
  }

  // 'rows' (default) — accent dots, balanced in the band.
  const bandR = contentBand(!!spec.title, c)
  const { y0: ry0, rowH } = rowBand(items.length, bandR, 1.25)
  items.forEach((b, i) => {
    const y = ry0 + i * rowH
    els.push({ type: 'ellipse', rect: { x: c.s.margin + 0.1, y: y + rowH / 2 - 0.08, w: 0.16, h: 0.16 }, fill: { color: c.t.accent } })
    els.push({
      type: 'text',
      rect: { x: c.s.margin + 0.55, y, w: c.contentW - 0.75, h: rowH },
      runs: [{ text: b }],
      style: { fontSize: items.length > 6 ? 15 : 17, color: c.r.body, fontFace: c.t.bodyFont, valign: 'middle', fit: 'shrink' },
    })
  })
  return { els, warnings: [] }
}

export function layoutQuote(spec: Extract<SlideSpec, { kind: 'quote' }>, c: LayoutCtx): LayoutResult {
  const els: El[] = [
    // Corner ghost — counterweight to the big “ mark; the page is mostly
    // whitespace, so it carries the theme colour without touching the text.
    { type: 'ellipse', rect: { x: PAGE_W - 2.6, y: PAGE_H - 2.6, w: 4, h: 4 }, fill: { color: c.t.accent, transparency: 88 } },
    {
      type: 'text',
      rect: { x: 0.7, y: 0.7, w: 2, h: 1.8 },
      runs: [{ text: '“' }],
      style: { fontSize: 120, bold: true, color: c.t.accent, fontFace: c.t.headFont, transparency: c.r.quoteAlpha },
    },
    {
      type: 'text',
      rect: { x: 1.5, y: 2.2, w: 10.3, h: 2.8 },
      runs: [{ text: spec.text }],
      style: { fontSize: 26, italic: true, color: c.r.title, fontFace: c.t.headFont, align: 'center', valign: 'middle', fit: 'shrink' },
    },
  ]
  if (spec.attribution) {
    els.push({
      type: 'text',
      rect: { x: 1.5, y: 5.2, w: 10.3, h: 0.5 },
      runs: [{ text: `- ${spec.attribution}` }],
      style: { fontSize: 14, color: c.r.muted, fontFace: c.t.bodyFont, align: 'center' },
    })
  }
  return { els, warnings: [] }
}

export function layoutImage(spec: Extract<SlideSpec, { kind: 'image' }>, c: LayoutCtx): LayoutResult {
  if (spec.variant === 'hero') {
    // HERO: the photo IS the page, the words sit on a plate over its foot.
    //
    // The catalogue we follow lists "image with content overlay" and demands a
    // visual on every page; this is the face that lets one photo carry a slide
    // instead of sitting in a box with a caption underneath.
    //
    // The plate is not decoration, it is the contrast guarantee. A global
    // semi-transparent scrim CANNOT keep text readable — we never see the
    // photo, and a bright sky under the title beats any tint you pick (tried
    // it: the title vanished on the night theme). A near-opaque plate in the
    // theme's own `primary` with `onPrimary` text is the pair the cover already
    // contrast-checks, so readability stops depending on the picture.
    // scripts/deck/structure-check.ts proves the 8% bleed-through cannot break
    // it, against the brightest possible photo, on every theme.
    const { s, t, r } = c
    const capH = spec.caption ? 0.5 : 0
    const titleH = spec.title ? 1.15 : 0
    const plateH = s.pad * 2 + titleH + capH + (capH && titleH ? 0.12 : 0)
    const plateY = PAGE_H - plateH
    const textW = PAGE_W - s.margin * 2
    const els: El[] = [
      { type: 'image', rect: { x: 0, y: 0, w: PAGE_W, h: PAGE_H }, path: spec.imagePath, sizing: 'cover' },
    ]
    if (titleH || capH) {
      els.push({ type: 'rect', rect: { x: 0, y: plateY, w: PAGE_W, h: plateH }, fill: { color: t.primary, transparency: 8 } })
    }
    let y = plateY + s.pad
    if (spec.title) {
      els.push({
        type: 'text', rect: { x: s.margin, y, w: textW, h: titleH }, runs: [{ text: spec.title }],
        style: { fontSize: 40, bold: true, color: r.onPrimary, fontFace: t.headFont, valign: 'middle', fit: 'shrink' },
      })
      y += titleH + 0.12
    }
    if (spec.caption) {
      els.push({
        type: 'text', rect: { x: s.margin, y, w: textW, h: capH }, runs: [{ text: spec.caption }],
        style: { fontSize: 14, color: r.onPrimary, fontFace: t.bodyFont, valign: 'middle', maxLines: 1, fit: 'shrink' },
      })
    }
    return { els, warnings: [] }
  }
  if ((spec.variant ?? 'full') === 'bleed') {
    // HALF-BLEED: the picture owns one whole side edge-to-edge, the words own
    // the other. The missing page type from the layout catalogue we follow —
    // our only image face used to be "picture in a box under a title", which
    // is the least designed of the four it lists.
    const { s, t, r } = c
    const half = PAGE_W * 0.46
    const textX = half + s.margin
    const textW = PAGE_W - half - s.margin * 2
    const band = contentBand(false, c)
    const els: El[] = [
      { type: 'image', rect: { x: 0, y: 0, w: half, h: PAGE_H }, path: spec.imagePath, sizing: 'cover' },
    ]
    // Content is stacked and centred against the picture, not hung off a title
    // band — the point of the face is the edge-to-edge photo beside a column.
    let y = band.y + 0.6
    if (spec.title) {
      els.push({
        type: 'text', rect: { x: textX, y, w: textW, h: 2.2 }, runs: [{ text: spec.title }],
        style: { fontSize: 36, bold: true, color: r.title, fontFace: t.headFont, valign: 'top', fit: 'shrink' },
      })
      y += 2.4
    }
    if (spec.caption) {
      els.push({
        type: 'text', rect: { x: textX, y, w: textW, h: 2.0 }, runs: [{ text: spec.caption }],
        style: { fontSize: 16, color: r.body, fontFace: t.bodyFont, valign: 'top' },
      })
    }
    return { els, warnings: [] }
  }

  // FULL: 액자에 넣은 한 장. 액자를 **사진 비율에 맞춘다** — 고정 11.3×5.2
  // (2.17:1) 상자에 세로 사진을 넣으면 좌우로 6인치가 죽는다. 비율을 모르면
  // (스크립트/픽스처) 예전 상자 그대로.
  const bandIm = contentBand(!!spec.title, c)
  const capH2 = spec.caption ? 0.5 : 0
  const maxW = c.contentW
  const maxH = bandIm.h - capH2
  const ar = c.aspect(spec.imagePath)
  const frame = ar
    ? (maxW / ar <= maxH ? { w: maxW, h: maxW / ar } : { w: maxH * ar, h: maxH })
    : { w: 11.3, h: 5.2 }
  const els: El[] = [
    ...headerEl(spec.title, c),
    {
      type: 'image',
      rect: ar
        ? { x: (PAGE_W - frame.w) / 2, y: bandIm.y + (maxH - frame.h) / 2, w: frame.w, h: frame.h }
        : { x: 1, y: 1.4, w: 11.3, h: 5.2 },
      path: spec.imagePath, sizing: 'contain',
    },
  ]
  if (spec.caption) {
    els.push({
      type: 'text',
      rect: { x: c.s.margin, y: 6.8, w: c.contentW, h: 0.4 },
      runs: [{ text: spec.caption }],
      style: { fontSize: 12, italic: true, color: c.r.muted, fontFace: c.t.bodyFont, align: 'center' },
    })
  }
  return { els, warnings: [] }
}

export function layoutTable(spec: Extract<SlideSpec, { kind: 'table' }>, c: LayoutCtx): LayoutResult {
  const warnings: LayoutWarning[] = []
  const truncated = spec.rows.length > CAPS.tableRows
  const kept = truncated ? spec.rows.slice(0, CAPS.tableRows) : spec.rows

  // 'kv' is only meaningful for two columns — anything else falls back to grid.
  const variant = spec.variant === 'kv' && spec.headers.length !== 2 ? 'grid' : (spec.variant ?? 'grid')

  if (variant === 'kv') {
    // No table El at all: the grid's kv block painter, split into two columns.
    // Zero new pixels to maintain.
    const els: El[] = [...headerEl(spec.title, c)]
    const pairs = kept.map((r) => ({ k: r[0] == null ? '' : String(r[0]), v: r[1] == null ? '' : String(r[1]) }))
    const half = Math.ceil(pairs.length / 2)
    const colW = (c.contentW - c.s.gap) / 2
    els.push(...paintBlock({ type: 'kv', rows: pairs.slice(0, half) }, { x: c.s.margin, y: 1.5, w: colW, h: 5.3 }, c))
    if (pairs.length > half) {
      els.push(...paintBlock({ type: 'kv', rows: pairs.slice(half) }, { x: c.s.margin + colW + c.s.gap, y: 1.5, w: colW, h: 5.3 }, c))
    }
    if (truncated) {
      warnings.push({ code: 'rowsTruncated', kept: CAPS.tableRows, dropped: spec.rows.length - CAPS.tableRows })
    }
    return { els, warnings }
  }

  const header: TableCell[] = spec.headers.map((h) => ({ text: h, bold: true, fill: { color: c.r.cardFill }, color: c.r.onLight, fontFace: c.t.headFont }))
  const body: TableCell[][] = kept.map((r, ri) =>
    r.map((cell) => ({
      text: cell == null ? '' : String(cell),
      // zebra: borderless, alternating soft fills instead of ruled lines.
      ...(variant === 'zebra' && ri % 2 === 1 ? { fill: { color: c.r.cardFill, transparency: 55 } } : {}),
    })),
  )

  if (truncated) {
    const dropped = spec.rows.length - CAPS.tableRows
    body.push(spec.headers.map((_, i) => ({ text: i === 0 ? `… ${dropped} more rows — see the XLSX for full data` : '' })))
    warnings.push({ code: 'rowsTruncated', kept: CAPS.tableRows, dropped })
  }

  // Rows share the band: a 4-row table used to render ~1" tall and leave five
  // inches empty. Clamped so a 2-row table does not become two fat ribbons and
  // a 15-row one still fits.
  const bandTb = contentBand(!!spec.title, c)
  const totalRows = body.length + 1
  const rowH = Math.max(0.3, Math.min(0.95, bandTb.h / totalRows))
  const tableH = rowH * totalRows
  return {
    els: [
      ...headerEl(spec.title, c),
      {
        type: 'table',
        rect: { x: c.s.margin, y: bandTb.y + Math.max(0, (bandTb.h - tableH) / 2), w: c.contentW, h: tableH },
        rowH,
        rows: [header, ...body],
        fontSize: kept.length > 8 ? 11 : 13,
        fontFace: c.t.bodyFont,
        color: c.r.body,
        border: variant === 'zebra' ? { pt: 0, color: c.t.line } : { pt: 0.5, color: c.t.line },
      },
    ],
    warnings,
  }
}
