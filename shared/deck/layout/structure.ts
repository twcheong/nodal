// Layout for the deck-skeleton kinds: cover · toc · section · summary.
// These carry the deck's rhythm — a deck of 6+ slides without them reads as a
// data dump, which is exactly the "looks AI-generated" failure mode.
//
// See shared/deck/page.ts (purity) and ./common.ts (colour-role rule).

import { PAGE_W, PAGE_H } from '../page'
import { CAPS, tocEntry, type SlideSpec } from '../spec'
import { WHITE } from '../theme'
import type { El, LayoutWarning } from '../el'
import { contentBand, headerEl, padNum, rowBand, type LayoutCtx } from './common'
import { widthIn } from '../text/metrics'
import type { LayoutResult } from './simple'

/** Kicker line — letterspaced caps above the title (accent on dark grounds). */
function kickerEl(text: string, x: number, y: number, w: number, color: string, font: string): El {
  return {
    type: 'text', rect: { x, y, w, h: 0.4 }, runs: [{ text: text.toUpperCase() }],
    style: { fontSize: 12, bold: true, color, fontFace: font, charSpacing: 2.5, fit: 'shrink' },
  }
}

/** Outlined chip row — cover meta badges. `onDark` chips stroke in accent. */
function chipEls(items: string[], x: number, y: number, maxW: number, c: LayoutCtx, textColor: string): El[] {
  const els: El[] = []
  const h = 0.36
  let cx = x
  for (const item of items) {
    const w = Math.min(widthIn(item, 11, 'sans') + 0.42, maxW)
    if (cx + w > x + maxW) break
    els.push({
      type: 'roundRect', rect: { x: cx, y, w, h }, radius: h / 2,
      fill: { color: c.t.accent, transparency: 100 }, stroke: { color: c.t.accent, pt: 1 },
    })
    els.push({
      type: 'text', rect: { x: cx, y, w, h }, runs: [{ text: item }],
      style: { fontSize: 11, color: textColor, fontFace: c.t.bodyFont, align: 'center', valign: 'middle', maxLines: 1, fit: 'shrink' },
    })
    cx += w + 0.16
  }
  return els
}

export function layoutCover(spec: Extract<SlideSpec, { kind: 'cover' | 'title' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const variant = spec.kind === 'cover' ? (spec.variant ?? 'block') : 'block'
  const meta: string[] = []
  if (spec.kind === 'cover' && spec.badge) meta.push(spec.badge)
  if (spec.kind === 'cover' && spec.date) meta.push(spec.date)
  const kicker = spec.kind === 'cover' ? spec.kicker : undefined
  const chips = spec.kind === 'cover' ? spec.chips : undefined
  const els: El[] = []

  if (variant === 'split') {
    // Text on the bg side, full-height primary panel on the right with a deco circle.
    els.push({ type: 'rect', rect: { x: PAGE_W * 0.62, y: 0, w: PAGE_W * 0.38, h: PAGE_H }, fill: { color: t.primary } })
    els.push({ type: 'ellipse', rect: { x: PAGE_W * 0.62 + 0.7, y: PAGE_H - 3.1, w: 4.6, h: 4.6 }, fill: { color: t.accent, transparency: 55 } })
    if (kicker || chips) {
      // Richer cover asked for → second deco tone joins in (accent2).
      els.push({ type: 'ellipse', rect: { x: PAGE_W - 2.1, y: -1.1, w: 3.2, h: 3.2 }, fill: { color: r.accent2, transparency: 35 } })
    }
    const w = PAGE_W * 0.62 - s.margin - 0.6
    if (kicker) els.push(kickerEl(kicker, s.margin + 0.2, 1.35, w, t.accent, t.headFont))
    els.push({
      type: 'text', rect: { x: s.margin + 0.2, y: 2.1, w, h: 1.8 }, runs: [{ text: spec.title }],
      style: { fontSize: 44, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
    })
    if (spec.subtitle) {
      els.push({ type: 'text', rect: { x: s.margin + 0.2, y: 4.0, w, h: 0.8 }, runs: [{ text: spec.subtitle }], style: { fontSize: 20, color: r.muted, fontFace: t.bodyFont } })
    }
    if (chips?.length) els.push(...chipEls(chips, s.margin + 0.2, 5.3, w, c, r.title))
    if (meta.length) {
      els.push({ type: 'text', rect: { x: s.margin + 0.2, y: 6.5, w, h: 0.4 }, runs: [{ text: meta.join('  ·  ') }], style: { fontSize: 13, color: r.muted, fontFace: t.bodyFont } })
    }
    return { els, warnings: [] }
  }

  if (variant === 'center') {
    if (kicker) {
      els.push({
        type: 'text', rect: { x: 1.2, y: 1.95, w: PAGE_W - 2.4, h: 0.4 }, runs: [{ text: kicker.toUpperCase() }],
        style: { fontSize: 12, bold: true, color: t.accent, fontFace: t.headFont, align: 'center', charSpacing: 2.5, fit: 'shrink' },
      })
    }
    els.push({
      type: 'text', rect: { x: 1.2, y: 2.5, w: PAGE_W - 2.4, h: 1.6 }, runs: [{ text: spec.title }],
      style: { fontSize: 48, bold: true, color: WHITE, fontFace: t.headFont, align: 'center', fit: 'shrink' },
    })
    if (chips?.length) {
      const totalW = chips.reduce((n, it) => n + Math.min(widthIn(it, 11, 'sans') + 0.42, 4) + 0.16, -0.16)
      els.push(...chipEls(chips, (PAGE_W - totalW) / 2, 5.2, PAGE_W - 2.4, c, WHITE))
    }
    if (spec.subtitle) {
      els.push({ type: 'text', rect: { x: 1.2, y: 4.2, w: PAGE_W - 2.4, h: 0.7 }, runs: [{ text: spec.subtitle }], style: { fontSize: 20, color: r.onPrimary, fontFace: t.bodyFont, align: 'center' } })
    }
    if (meta.length) {
      els.push({ type: 'text', rect: { x: 1.2, y: 6.4, w: PAGE_W - 2.4, h: 0.4 }, runs: [{ text: meta.join('  ·  ') }], style: { fontSize: 13, color: r.onPrimary, fontFace: t.bodyFont, align: 'center' } })
    }
    return { els, warnings: [] }
  }

  // 'block' (default / legacy 'title')
  els.push({ type: 'ellipse', rect: { x: PAGE_W - 3.4, y: -1.6, w: 5, h: 5 }, fill: { color: t.accent, transparency: 78 } })
  if (kicker || chips) {
    // Richer cover asked for → the Claude-cover recipe: second deco tone,
    // kicker, chip row. Gated on the new fields so legacy covers render
    // byte-identically (baseline stays additive).
    els.push({ type: 'ellipse', rect: { x: PAGE_W - 1.9, y: PAGE_H - 2.4, w: 3.4, h: 3.4 }, fill: { color: r.accent2, transparency: 45 } })
  }
  if (kicker) els.push(kickerEl(kicker, 0.7, 1.55, 11.9, t.accent, t.headFont))
  els.push({
    type: 'text', rect: { x: 0.7, y: 2.3, w: 11.9, h: 1.6 }, runs: [{ text: spec.title }],
    style: { fontSize: 44, bold: true, color: WHITE, fontFace: t.headFont, fit: 'shrink' },
  })
  if (spec.subtitle) {
    els.push({ type: 'text', rect: { x: 0.7, y: 3.9, w: 11.9, h: 0.8 }, runs: [{ text: spec.subtitle }], style: { fontSize: 20, color: r.onPrimary, fontFace: t.bodyFont } })
  }
  if (chips?.length) els.push(...chipEls(chips, 0.7, 5.15, 11.9, c, WHITE))
  if (meta.length) {
    els.push({ type: 'text', rect: { x: 0.7, y: 6.5, w: 11.9, h: 0.4 }, runs: [{ text: meta.join('  ·  ') }], style: { fontSize: 13, color: r.onPrimary, fontFace: t.bodyFont } })
  }
  return { els, warnings: [] }
}

/** Cover variants paint their own full-bleed background instead of theme.bg. */
export function coverBackground(spec: Extract<SlideSpec, { kind: 'cover' | 'title' }>, c: LayoutCtx): string {
  const variant = spec.kind === 'cover' ? (spec.variant ?? 'block') : 'block'
  return variant === 'split' ? c.t.bg : c.t.primary
}

/**
 * The SANDWICH: a dark open and a dark close around light content.
 *
 * The cover already paints itself dark, but the deck used to just stop on a
 * white page — so the rhythm was half-built. `summary` variant 'thanks' is the
 * closing page by definition, so it takes the cover's ground and the deck ends
 * where it began. Every other slide stays on theme.bg.
 */
export function slideBackground(spec: SlideSpec, c: LayoutCtx): string | null {
  if (spec.kind === 'cover' || spec.kind === 'title') return coverBackground(spec, c)
  if (spec.kind === 'summary' && spec.variant === 'thanks') return c.t.primary
  return null
}

export function layoutToc(spec: Extract<SlideSpec, { kind: 'toc' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = [...headerEl(spec.title ?? 'Contents', c)]
  const warnings: LayoutWarning[] = []
  const variant = spec.variant ?? 'list'
  const sections = spec.sections.map(tocEntry)
  // One geometry per slide: any desc switches the whole page to the described
  // layout. Mixing per-row would read as ragged, and desc-free decks must stay
  // byte-identical to the pre-desc baseline.
  const hasDesc = sections.some((it) => it.desc)

  if (variant === 'cards') {
    const items = sections.slice(0, CAPS.tocCards)
    if (sections.length > CAPS.tocCards) {
      warnings.push({ code: 'clamped', what: 'toc.sections', kept: CAPS.tocCards, dropped: sections.length - CAPS.tocCards })
    }
    const cols = items.length <= 4 ? items.length : Math.ceil(items.length / 2)
    const rowCount = items.length <= 4 ? 1 : 2
    const cardW = (c.contentW - s.gap * (cols - 1)) / cols
    // Cards fill the band instead of sitting at a fixed 3.4"/2.5" — a single
    // row of four used to end at 5.4" and leave the bottom third empty.
    const bandC = contentBand(true, c)
    const cardH = (bandC.h - s.gap * (rowCount - 1)) / rowCount
    const y0 = bandC.y
    items.forEach((it, i) => {
      const x = s.margin + (i % cols) * (cardW + s.gap)
      const y = y0 + Math.floor(i / cols) * (cardH + s.gap)
      els.push({ type: 'roundRect', rect: { x, y, w: cardW, h: cardH }, radius: s.radiusMd, fill: { color: r.cardFill } })
      els.push({
        type: 'text', rect: { x: x + s.pad, y: y + s.pad, w: cardW - s.pad * 2, h: 0.7 }, runs: [{ text: padNum(i + 1) }],
        style: { fontSize: 30, bold: true, color: t.accent, fontFace: t.headFont },
      })
      const labelH = it.desc ? 0.55 : cardH - s.pad * 2 - 0.8
      els.push({
        type: 'text', rect: { x: x + s.pad, y: y + s.pad + 0.8, w: cardW - s.pad * 2, h: labelH }, runs: [{ text: it.label }],
        style: { fontSize: 16, ...(it.desc ? { bold: true } : {}), color: r.body, fontFace: t.bodyFont, valign: 'top', fit: 'shrink' },
      })
      if (it.desc) {
        els.push({
          type: 'text', rect: { x: x + s.pad, y: y + s.pad + 1.38, w: cardW - s.pad * 2, h: cardH - s.pad * 2 - 1.38 }, runs: [{ text: it.desc }],
          style: { fontSize: 11, color: r.muted, fontFace: t.bodyFont, valign: 'top', fit: 'shrink' },
        })
      }
    })
    return { els, warnings }
  }

  const twoCol = sections.length > 6
  const perCol = twoCol ? Math.ceil(sections.length / 2) : sections.length
  const bandT = contentBand(true, c)
  const { y0, rowH } = rowBand(perCol, bandT, hasDesc ? 1.5 : 1.25)
  sections.forEach((it, i) => {
    const col = twoCol ? Math.floor(i / perCol) : 0
    const row = twoCol ? i % perCol : i
    const x = s.margin + 0.5 + col * (c.contentW / 2)
    const y = y0 + row * rowH
    const textW = c.contentW / (twoCol ? 2 : 1) - 1.6
    if (variant === 'sidebar') {
      els.push({ type: 'rect', rect: { x: x - 0.3, y: y + rowH * 0.18, w: 0.09, h: rowH * 0.55 }, fill: { color: t.accent } })
    }
    els.push({
      type: 'text', rect: { x, y, w: 0.8, h: hasDesc ? rowH * 0.55 : rowH }, runs: [{ text: padNum(i + 1) }],
      style: { fontSize: 22, bold: true, color: t.accent, fontFace: t.headFont, valign: 'middle' },
    })
    if (hasDesc) {
      els.push({
        type: 'text', rect: { x: x + 0.9, y, w: textW, h: rowH * 0.55 }, runs: [{ text: it.label }],
        style: { fontSize: 17, bold: true, color: r.title, fontFace: t.headFont, valign: 'middle', maxLines: 1, fit: 'shrink' },
      })
      if (it.desc) {
        els.push({
          type: 'text', rect: { x: x + 0.9, y: y + rowH * 0.52, w: textW, h: rowH * 0.44 }, runs: [{ text: it.desc }],
          style: { fontSize: 12, color: r.muted, fontFace: t.bodyFont, valign: 'top', fit: 'shrink' },
        })
      }
    } else {
      els.push({
        type: 'text', rect: { x: x + 0.9, y, w: textW, h: rowH }, runs: [{ text: it.label }],
        style: { fontSize: 18, color: r.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
      })
    }
  })
  return { els, warnings }
}

export function layoutSection(spec: Extract<SlideSpec, { kind: 'section' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = []
  const variant = spec.variant ?? 'number'

  if (variant === 'accentBlock') {
    els.push({ type: 'rect', rect: { x: 0, y: 0, w: 1.6, h: PAGE_H }, fill: { color: t.primary } })
    els.push({
      type: 'text', rect: { x: 0, y: 2.9, w: 1.6, h: 1.2 }, runs: [{ text: padNum(spec.number) }],
      style: { fontSize: 44, bold: true, color: t.accent, fontFace: t.headFont, align: 'center' },
    })
    els.push({
      type: 'text', rect: { x: 2.2, y: 3.0, w: PAGE_W - 2.2 - s.margin, h: 0.9 }, runs: [{ text: spec.title }],
      style: { fontSize: 36, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
    })
    if (spec.intro) {
      els.push({
        type: 'text', rect: { x: 2.2, y: 4.1, w: PAGE_W - 2.2 - s.margin - 1, h: 1.2 }, runs: [{ text: spec.intro }],
        style: { fontSize: 16, color: r.muted, fontFace: t.bodyFont },
      })
    }
    return { els, warnings: [] }
  }

  if (variant === 'split') {
    els.push({ type: 'rect', rect: { x: 0, y: 0, w: PAGE_W * 0.42, h: PAGE_H }, fill: { color: t.primary } })
    els.push({
      type: 'text', rect: { x: 0.4, y: 2.4, w: PAGE_W * 0.42 - 0.8, h: 2.6 }, runs: [{ text: padNum(spec.number) }],
      style: { fontSize: 120, bold: true, color: WHITE, fontFace: t.headFont, align: 'center', valign: 'middle', transparency: 25 },
    })
    els.push({
      type: 'text', rect: { x: PAGE_W * 0.42 + 0.6, y: 3.0, w: PAGE_W * 0.58 - 0.6 - s.margin, h: 0.9 }, runs: [{ text: spec.title }],
      style: { fontSize: 36, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
    })
    if (spec.intro) {
      els.push({
        type: 'text', rect: { x: PAGE_W * 0.42 + 0.6, y: 4.1, w: PAGE_W * 0.58 - 0.6 - s.margin, h: 1.2 }, runs: [{ text: spec.intro }],
        style: { fontSize: 16, color: r.muted, fontFace: t.bodyFont },
      })
    }
    return { els, warnings: [] }
  }

  // 'number' (default): oversized ghost number behind, solid number + title in front.
  // Paint order matters — the ghost must precede the solid one.
  els.push({
    type: 'text', rect: { x: PAGE_W - 6.4, y: 0.4, w: 6, h: 5.6 }, runs: [{ text: padNum(spec.number) }],
    style: { fontSize: 300, bold: true, color: t.secondary, fontFace: t.headFont, align: 'right', transparency: r.ghostAlpha },
  })
  els.push({
    type: 'text', rect: { x: 0.7, y: 1.5, w: 6, h: 1.9 }, runs: [{ text: padNum(spec.number) }],
    style: { fontSize: 96, bold: true, color: t.secondary, fontFace: t.headFont },
  })
  els.push({
    type: 'text', rect: { x: 0.75, y: 3.6, w: 11.8, h: 0.9 }, runs: [{ text: spec.title }],
    style: { fontSize: 36, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
  })
  if (spec.intro) {
    els.push({
      type: 'text', rect: { x: 0.75, y: 4.7, w: 10.5, h: 1.2 }, runs: [{ text: spec.intro }],
      style: { fontSize: 16, color: r.muted, fontFace: t.bodyFont },
    })
  }
  return { els, warnings: [] }
}

export function layoutSummary(spec: Extract<SlideSpec, { kind: 'summary' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const variant = spec.variant ?? 'takeaways'
  const warnings: LayoutWarning[] = []
  if (spec.takeaways.length > CAPS.summaryTakeaways && variant !== 'thanks') {
    warnings.push({ code: 'clamped', what: 'summary.takeaways', kept: CAPS.summaryTakeaways, dropped: spec.takeaways.length - CAPS.summaryTakeaways })
  }

  if (variant === 'thanks') {
    const els: El[] = [{
      type: 'ellipse', rect: { x: -1.6, y: PAGE_H - 2.6, w: 4.2, h: 4.2 }, fill: { color: t.accent, transparency: 88 },
    }, {
      type: 'ellipse', rect: { x: PAGE_W - 2.4, y: -1.8, w: 4.2, h: 4.2 }, fill: { color: r.accent2, transparency: 90 },
    }, {
      type: 'text', rect: { x: 1.2, y: 2.2, w: PAGE_W - 2.4, h: 1.4 },
      runs: [{ text: spec.closing ?? spec.title ?? 'Thank You' }],
      style: { fontSize: 54, bold: true, color: WHITE, fontFace: t.headFont, align: 'center', fit: 'shrink' },
    }]
    if (spec.takeaways.length) {
      els.push({
        type: 'text', rect: { x: 1.2, y: 3.9, w: PAGE_W - 2.4, h: 0.6 }, runs: [{ text: spec.takeaways.join('   ·   ') }],
        style: { fontSize: 15, color: r.onPrimary, fontFace: t.bodyFont, align: 'center', fit: 'shrink' },
      })
    }
    if (spec.contact) {
      els.push({
        type: 'text', rect: { x: 1.2, y: 5.1, w: PAGE_W - 2.4, h: 0.5 }, runs: [{ text: spec.contact }],
        style: { fontSize: 14, color: r.onPrimary, fontFace: t.bodyFont, align: 'center' },
      })
    }
    return { els, warnings }
  }

  if (variant === 'split') {
    // TWO SECTIONS, ONE PAGE — they must agree on a horizontal grid.
    //
    // The card used to start at a fixed 1.6 and stand 4.6" tall while the tick
    // list started at the same y but with no heading, so the card's "Next
    // Steps" heading floated above the first tick and the two columns read as
    // two unrelated pages pasted together. Now both columns share ONE heading
    // baseline and ONE first-item baseline, and the card fills the band so the
    // page has a defined bottom edge.
    const els: El[] = [...headerEl(spec.title ?? 'Summary', c)]
    const colW = (c.contentW - s.gap) / 2
    const bandSp = contentBand(true, c)
    const rx = s.margin + colW + s.gap
    const headY = bandSp.y + s.pad
    const itemsY = headY + 0.7          // shared by both columns

    els.push({ type: 'roundRect', rect: { x: rx, y: bandSp.y, w: colW, h: bandSp.h }, radius: s.radiusLg, fill: { color: r.cardFill } })
    els.push({
      type: 'text', rect: { x: s.margin + 0.1, y: headY, w: colW - 0.2, h: 0.5 }, runs: [{ text: 'Takeaways' }],
      style: { fontSize: 17, bold: true, color: r.title, fontFace: t.headFont, maxLines: 1, fit: 'shrink' },
    })
    spec.takeaways.slice(0, CAPS.summaryTakeaways).forEach((tk, i) => {
      const y = itemsY + i * 0.72
      els.push({ type: 'text', rect: { x: s.margin + 0.1, y, w: 0.5, h: 0.55 }, runs: [{ text: '✓' }], style: { fontSize: 18, bold: true, color: t.accent, fontFace: t.headFont, valign: 'middle' } })
      els.push({ type: 'text', rect: { x: s.margin + 0.7, y, w: colW - 0.8, h: 0.55 }, runs: [{ text: tk }], style: { fontSize: 16, color: r.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' } })
    })
    els.push({
      type: 'text', rect: { x: rx + s.pad, y: headY, w: colW - s.pad * 2, h: 0.5 }, runs: [{ text: 'Next Steps' }],
      style: { fontSize: 17, bold: true, color: r.onLight, fontFace: t.headFont, maxLines: 1, fit: 'shrink' },
    })
    ;(spec.nextSteps ?? []).slice(0, CAPS.summaryNextSteps).forEach((st, i) => {
      const y = itemsY + i * 0.72
      els.push({
        type: 'text', rect: { x: rx + s.pad, y: y + 0.05, w: 0.4, h: 0.4 }, runs: [{ text: String(i + 1) }],
        style: { fontSize: 12, bold: true, color: r.onAccent, fontFace: t.headFont, align: 'center', valign: 'middle' },
        shape: { kind: 'ellipse', fill: { color: t.accent } },
      })
      els.push({
        type: 'text', rect: { x: rx + s.pad + 0.55, y, w: colW - s.pad * 2 - 0.55, h: 0.55 }, runs: [{ text: st }],
        style: { fontSize: 14, color: r.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
      })
    })
    if (spec.contact) {
      els.push({ type: 'text', rect: { x: rx + s.pad, y: bandSp.bottom - 0.5, w: colW - s.pad * 2, h: 0.4 }, runs: [{ text: spec.contact }], style: { fontSize: 12, color: r.muted, fontFace: t.bodyFont } })
    }
    if (spec.closing) {
      els.push({ type: 'text', rect: { x: s.margin, y: bandSp.bottom - 0.75, w: colW, h: 0.7 }, runs: [{ text: spec.closing }], style: { fontSize: 20, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' } })
    }
    return { els, warnings }
  }

  // 'takeaways' (default) — corner ghost behind, list on top.
  const els: El[] = [
    { type: 'ellipse', rect: { x: PAGE_W - 2.3, y: -1.6, w: 3.8, h: 3.8 }, fill: { color: t.accent, transparency: 89 } },
    ...headerEl(spec.title ?? 'Key Takeaways', c),
  ]
  const kept = spec.takeaways.slice(0, CAPS.summaryTakeaways)
  // The closing line owns the bottom of the band; the ticks share what is left.
  const bandS = contentBand(true, c)
  const closingH = spec.closing ? 1.0 : 0
  const { y0: sy0, rowH: sRow } = rowBand(kept.length, { y: bandS.y, h: bandS.h - closingH }, 1.1)
  kept.forEach((tk, i) => {
    const y = sy0 + i * sRow
    els.push({ type: 'text', rect: { x: s.margin + 0.2, y, w: 0.5, h: Math.min(sRow, 0.6) }, runs: [{ text: '✓' }], style: { fontSize: 20, bold: true, color: t.accent, fontFace: t.headFont, valign: 'middle' } })
    els.push({ type: 'text', rect: { x: s.margin + 0.8, y, w: c.contentW - 1.0, h: Math.min(sRow, 0.6) }, runs: [{ text: tk }], style: { fontSize: 18, color: r.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' } })
  })
  if (spec.closing) {
    els.push({ type: 'text', rect: { x: s.margin, y: bandS.bottom - closingH + 0.1, w: c.contentW, h: 0.9 }, runs: [{ text: spec.closing }], style: { fontSize: 24, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' } })
  }
  return { els, warnings }
}
