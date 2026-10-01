// Layout for the data-bearing kinds: stats · compare · timeline · chart.
//
// See shared/deck/page.ts (purity) and ./common.ts (colour-role rule).

import { PAGE_H, PAGE_W } from '../page'
import { CAPS, type SlideSpec } from '../spec'
import type { El, LayoutWarning } from '../el'
import { contentBand, headerEl, rowBand, type LayoutCtx } from './common'
import type { LayoutResult } from './simple'
import { pickReadable } from '../color'
import { wrapText } from '../text/wrap'

export function layoutStats(spec: Extract<SlideSpec, { kind: 'stats' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = [...headerEl(spec.title, c)]
  const warnings: LayoutWarning[] = []

  const items = spec.items.slice(0, CAPS.statsItems)
  if (spec.items.length > CAPS.statsItems) {
    warnings.push({ code: 'clamped', what: 'stats.items', kept: CAPS.statsItems, dropped: spec.items.length - CAPS.statsItems })
  }
  const cardW = (c.contentW - s.gap * (items.length - 1)) / items.length
  const bandStats = contentBand(!!spec.title, c)

  if (spec.variant === 'bare') {
    // The bare face has no cards to fill the page — a corner ghost keeps the
    // big numerals from floating in blank space. Painted first: it must sit
    // behind everything.
    els.unshift({ type: 'ellipse', rect: { x: PAGE_W - 2.4, y: PAGE_H - 2.4, w: 3.8, h: 3.8 }, fill: { color: t.accent, transparency: 88 } })
    // Centre the numeral stack in the band instead of pinning it to 2.0".
    const stackH = 1.7 + 0.6 + (items.some((it) => it.sublabel) ? 0.5 : 0)
    const y = bandStats.y + Math.max(0, (bandStats.h - stackH) / 2)
    items.forEach((it, i) => {
      const x = s.margin + i * (cardW + s.gap)
      if (i > 0) {
        els.push({ type: 'rect', rect: { x: x - s.gap / 2, y: y + 0.3, w: 0.02, h: 2.5 }, fill: { color: t.line } })
      }
      els.push({
        type: 'text', rect: { x, y: y + 0.1, w: cardW, h: 1.6 }, runs: [{ text: it.value }],
        style: { fontSize: 60, bold: true, color: t.accent, fontFace: t.headFont, align: 'center', valign: 'middle', fit: 'shrink' },
      })
      els.push({
        type: 'text', rect: { x, y: y + 1.8, w: cardW, h: 0.6 }, runs: [{ text: it.label }],
        style: { fontSize: 15, bold: true, color: r.title, fontFace: t.headFont, align: 'center', maxLines: 1, fit: 'shrink' },
      })
      if (it.sublabel) {
        els.push({
          type: 'text', rect: { x, y: y + 2.4, w: cardW, h: 0.5 }, runs: [{ text: it.sublabel }],
          style: { fontSize: 11, color: r.muted, fontFace: t.bodyFont, align: 'center', maxLines: 1, fit: 'shrink' },
        })
      }
    })
    return { els, warnings }
  }

  // Cards fill the band rather than sitting 3.1" tall under the title, which
  // left a third of the page blank on every stats slide. The text inside stays
  // anchored to the card's own top so the numerals don't drift apart.
  const cardH = bandStats.h
  items.forEach((it, i) => {
    const x = s.margin + i * (cardW + s.gap)
    const cy = bandStats.y
    els.push({ type: 'roundRect', rect: { x, y: cy, w: cardW, h: cardH }, radius: s.radiusLg, fill: { color: r.cardFill } })
    // Centre the value/label/sublabel stack inside the taller card.
    const stackH = 1.4 + 0.6 + (it.sublabel ? 0.5 : 0)
    const top = cy + Math.max(s.pad, (cardH - stackH) / 2)
    els.push({
      type: 'text', rect: { x: x + s.pad, y: top, w: cardW - s.pad * 2, h: 1.4 }, runs: [{ text: it.value }],
      style: { fontSize: 44, bold: true, color: t.accent, fontFace: t.headFont, align: 'center', valign: 'middle', fit: 'shrink' },
    })
    els.push({
      type: 'text', rect: { x: x + s.pad, y: top + 1.5, w: cardW - s.pad * 2, h: 0.6 }, runs: [{ text: it.label }],
      style: { fontSize: 15, bold: true, color: r.onLight, fontFace: t.headFont, align: 'center', maxLines: 1, fit: 'shrink' },
    })
    if (it.sublabel) {
      els.push({
        type: 'text', rect: { x: x + s.pad, y: top + 2.1, w: cardW - s.pad * 2, h: 0.5 }, runs: [{ text: it.sublabel }],
        style: { fontSize: 11, color: r.muted, fontFace: t.bodyFont, align: 'center', maxLines: 1, fit: 'shrink' },
      })
    }
  })
  return { els, warnings }
}

export function layoutCompare(spec: Extract<SlideSpec, { kind: 'compare' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = [...headerEl(spec.title, c)]
  const colW = (c.contentW - s.gap) / 2
  const bandCmp = contentBand(!!spec.title, c)
  const y = bandCmp.y

  // 'stacked' holds ≤3 bullets a side; more falls back to 'cards' (content is
  // never dropped to keep a variant).
  const variant =
    spec.variant === 'stacked' && (spec.left.bullets.length > 3 || spec.right.bullets.length > 3)
      ? 'cards' : (spec.variant ?? 'cards')

  if (variant === 'vs') {
    // Two bare columns with a rail between them and a "VS" chip on it.
    //
    // The rail used to span the whole band and the chip sat at the band's
    // midpoint, so with four short bullets the content filled the top third
    // and the chip floated below all of it — "the VS isn't centred". Both are
    // now measured against the CONTENT: the rail is as tall as the taller
    // column, and the chip sits at that column's middle.
    const midX = s.margin + colW + s.gap / 2
    const inner = colW - s.gap / 2 - 0.45   // clears the 0.62" VS chip on the rail
    const bodyStyle = { fontSize: 14, color: r.body, fontFace: t.bodyFont } as const
    const listTop = bandCmp.y + 0.85
    const bodyH = Math.max(
      ...[spec.left, spec.right].map((side) =>
        wrapText(side.bullets.map((b) => ({ text: b, bullet: true, paraSpaceAfter: 8 })), inner, bandCmp.h, bodyStyle).blockH,
      ),
    )
    const contentBottom = Math.min(bandCmp.bottom, listTop + bodyH)
    const railTop = bandCmp.y + 0.2
    els.push({ type: 'rect', rect: { x: midX - 0.04, y: railTop, w: 0.08, h: Math.max(0.8, contentBottom - railTop) }, fill: { color: t.accent, transparency: 55 } })
    els.push({
      type: 'text', rect: { x: midX - 0.31, y: (railTop + contentBottom) / 2 - 0.31, w: 0.62, h: 0.62 }, runs: [{ text: 'VS' }],
      style: { fontSize: 15, bold: true, color: r.onAccent, fontFace: t.headFont, align: 'center', valign: 'middle' },
      shape: { kind: 'ellipse', fill: { color: t.accent } },
    })
    for (const { side, x } of [{ side: spec.left, x: s.margin }, { side: spec.right, x: s.margin + colW + s.gap + 0.25 }]) {
      els.push({
        type: 'text', rect: { x, y: bandCmp.y + 0.1, w: inner, h: 0.6 }, runs: [{ text: side.title }],
        style: { fontSize: 20, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
      })
      els.push({
        type: 'text', rect: { x, y: listTop, w: inner, h: bandCmp.bottom - listTop },
        runs: side.bullets.map((b) => ({ text: b, bullet: true, paraSpaceAfter: 8 })),
        style: { ...bodyStyle, valign: 'top' },
      })
    }
    return { els, warnings: [] }
  }

  if (variant === 'stacked') {
    // Before/after read: full-width bands, title as an accent chip on the left.
    const bandH = 2.5
    ;[0, 1].map((k) => ({ side: k === 0 ? spec.left : spec.right, by: bandCmp.y + (bandCmp.h - (bandH * 2 + 0.2)) / 2 + k * (bandH + 0.2) })).forEach(({ side, by }) => {
      els.push({ type: 'roundRect', rect: { x: s.margin, y: by, w: c.contentW, h: bandH }, radius: s.radiusMd, fill: { color: r.cardFill } })
      els.push({
        type: 'text', rect: { x: s.margin + s.pad, y: by + s.pad, w: 2.3, h: 0.5 }, runs: [{ text: side.title }],
        style: { fontSize: 13, bold: true, color: r.onAccent, fontFace: t.headFont, align: 'center', valign: 'middle', fit: 'shrink' },
        shape: { kind: 'roundRect', radius: s.radiusSm, fill: { color: t.accent } },
      })
      els.push({
        type: 'text',
        rect: { x: s.margin + s.pad + 2.6, y: by + s.pad, w: c.contentW - s.pad * 2 - 2.6, h: bandH - s.pad * 2 },
        runs: side.bullets.map((b) => ({ text: b, bullet: true, paraSpaceAfter: 6 })),
        style: { fontSize: 14, color: r.body, fontFace: t.bodyFont, valign: 'top' },
      })
    })
    return { els, warnings: [] }
  }

  // 'cards' (default) — today's geometry, byte-identical.
  for (const { side, x } of [{ side: spec.left, x: s.margin }, { side: spec.right, x: s.margin + colW + s.gap }]) {
    els.push({ type: 'roundRect', rect: { x, y, w: colW, h: bandCmp.h }, radius: s.radiusMd, fill: { color: r.cardFill } })
    els.push({
      type: 'text', rect: { x: x + s.pad, y: y + s.pad, w: colW - s.pad * 2, h: 0.6 }, runs: [{ text: side.title }],
      style: { fontSize: 18, bold: true, color: r.onLight, fontFace: t.headFont, fit: 'shrink' },
    })
    els.push({
      type: 'text',
      rect: { x: x + s.pad, y: y + s.pad + 0.75, w: colW - s.pad * 2, h: bandCmp.h - s.pad * 2 - 0.75 },
      runs: side.bullets.map((b) => ({ text: b, bullet: true, paraSpaceAfter: 8 })),
      style: { fontSize: 14, color: r.body, fontFace: t.bodyFont, valign: 'top' },
    })
  }
  return { els, warnings: [] }
}

export function layoutTimeline(spec: Extract<SlideSpec, { kind: 'timeline' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = [...headerEl(spec.title, c)]
  const warnings: LayoutWarning[] = []

  const steps = spec.steps.slice(0, CAPS.timelineSteps)
  if (spec.steps.length > CAPS.timelineSteps) {
    warnings.push({ code: 'clamped', what: 'timeline.steps', kept: CAPS.timelineSteps, dropped: spec.steps.length - CAPS.timelineSteps })
  }
  const variant = spec.variant ?? 'rail'

  if (variant === 'vertical') {
    // Steps down the page. This one earns its keep: the horizontal rail
    // truncates `desc` badly at 5-6 steps; vertical gives each step the full
    // content width.
    const bandTl = contentBand(!!spec.title, c)
    const { y0: tly0, rowH } = rowBand(steps.length, bandTl, 1.5)
    const dotX = s.margin + 0.1
    els.push({ type: 'rect', rect: { x: dotX + 0.235, y: tly0 + rowH / 2, w: 0.05, h: rowH * (steps.length - 1) }, fill: { color: r.hairline } })
    steps.forEach((st, i) => {
      const y = tly0 + i * rowH
      els.push({
        type: 'text', rect: { x: dotX, y: y + rowH / 2 - 0.26, w: 0.52, h: 0.52 }, runs: [{ text: String(i + 1) }],
        style: { fontSize: 15, bold: true, color: r.onAccent, fontFace: t.headFont, align: 'center', valign: 'middle' },
        shape: { kind: 'ellipse', fill: { color: t.accent } },
      })
      els.push({
        type: 'text', rect: { x: s.margin + 0.95, y, w: 3.4, h: rowH }, runs: [{ text: st.label }],
        style: { fontSize: 17, bold: true, color: r.title, fontFace: t.headFont, valign: 'middle', maxLines: 1, fit: 'shrink' },
      })
      if (st.desc) {
        els.push({
          type: 'text', rect: { x: s.margin + 4.55, y, w: c.contentW - 4.55, h: rowH }, runs: [{ text: st.desc }],
          style: { fontSize: 12, color: r.muted, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
        })
      }
    })
    return { els, warnings }
  }

  if (variant === 'bars') {
    // One row of equal blocks with a ghost numeral each — a "discrete stages"
    // read without needing a chevron primitive.
    const blockW = (c.contentW - s.gap * (steps.length - 1)) / steps.length
    const bandBar = contentBand(!!spec.title, c)
    steps.forEach((st, i) => {
      const x = s.margin + i * (blockW + s.gap)
      els.push({ type: 'roundRect', rect: { x, y: bandBar.y, w: blockW, h: bandBar.h }, radius: s.radiusMd, fill: { color: r.cardFill } })
      els.push({
        type: 'text', rect: { x: x + 0.05, y: bandBar.y + 0.05, w: blockW - 0.15, h: 1.1 }, runs: [{ text: String(i + 1) }],
        style: { fontSize: 54, bold: true, color: t.accent, fontFace: t.headFont, align: 'right', transparency: r.ghostAlpha },
      })
      els.push({
        type: 'text', rect: { x: x + s.pad * 0.6, y: bandBar.y + 1.0, w: blockW - s.pad * 1.2, h: 0.6 }, runs: [{ text: st.label }],
        style: { fontSize: 16, bold: true, color: r.title, fontFace: t.headFont, maxLines: 1, fit: 'shrink' },
      })
      if (st.desc) {
        els.push({
          type: 'text', rect: { x: x + s.pad * 0.6, y: bandBar.y + 1.65, w: blockW - s.pad * 1.2, h: bandBar.h - 1.75 }, runs: [{ text: st.desc }],
          style: { fontSize: 11, color: r.muted, fontFace: t.bodyFont, valign: 'top', fit: 'shrink' },
        })
      }
    })
    return { els, warnings }
  }

  if (variant === 'chevron') {
    // Horizontal chevron chain — the consulting process strip. Labels sit
    // INSIDE the arrows, desc beneath each column: full content parity with
    // 'rail', which is what lets the rotation pick this face safely.
    const overlap = 0.18
    const bandH = 1.15
    const bandCh = contentBand(!!spec.title, c)
    const y = bandCh.y + (bandCh.h - (bandH + 1.95)) / 2
    const w = (c.contentW + overlap * (steps.length - 1)) / steps.length
    const run = r.funnelRun
    steps.forEach((st, i) => {
      const x = s.margin + i * (w - overlap)
      const color = run[i % run.length]
      const onBand = pickReadable(color, ['FFFFFF', '1A1A1A'])
      els.push({ type: 'chevron', rect: { x, y, w, h: bandH }, fill: { color } })
      els.push({
        type: 'text', rect: { x: x + 0.5, y, w: w - 0.85, h: bandH }, runs: [{ text: st.label }],
        style: { fontSize: 14, bold: true, color: onBand, fontFace: t.headFont, align: 'center', valign: 'middle', maxLines: 1, fit: 'shrink' },
      })
      if (st.desc) {
        els.push({
          type: 'text', rect: { x: x + 0.25, y: y + bandH + 0.25, w: w - 0.5, h: 1.95 }, runs: [{ text: st.desc }],
          style: { fontSize: 11, color: r.muted, fontFace: t.bodyFont, align: 'center', valign: 'top' },
        })
      }
    })
    return { els, warnings }
  }

  // 'rail' (default) — today's geometry, byte-identical.
  const stepW = c.contentW / steps.length
  const bandRail = contentBand(!!spec.title, c)
  const cy = bandRail.y + (bandRail.h - 2.8) / 2

  els.push({ type: 'rect', rect: { x: s.margin + stepW / 2, y: cy + 0.28, w: c.contentW - stepW, h: 0.05 }, fill: { color: r.hairline } })

  steps.forEach((st, i) => {
    const cx = s.margin + i * stepW + stepW / 2
    els.push({
      type: 'text', rect: { x: cx - 0.3, y: cy, w: 0.6, h: 0.6 }, runs: [{ text: String(i + 1) }],
      style: { fontSize: 16, bold: true, color: r.onAccent, fontFace: t.headFont, align: 'center', valign: 'middle' },
      shape: { kind: 'ellipse', fill: { color: t.accent } },
    })
    els.push({
      type: 'text', rect: { x: cx - stepW / 2 + 0.1, y: cy + 0.8, w: stepW - 0.2, h: 0.6 }, runs: [{ text: st.label }],
      style: { fontSize: 14, bold: true, color: r.title, fontFace: t.headFont, align: 'center', fit: 'shrink' },
    })
    if (st.desc) {
      els.push({
        type: 'text', rect: { x: cx - stepW / 2 + 0.1, y: cy + 1.4, w: stepW - 0.2, h: 1.4 }, runs: [{ text: st.desc }],
        style: { fontSize: 11, color: r.muted, fontFace: t.bodyFont, align: 'center', valign: 'top' },
      })
    }
  })
  return { els, warnings }
}

export function layoutChart(spec: Extract<SlideSpec, { kind: 'chart' }>, c: LayoutCtx): LayoutResult {
  const { s, t, r } = c
  const els: El[] = [...headerEl(spec.title, c)]

  const chartStyle = {
    chartColors: r.chartRun,
    showLegend: spec.series.length > 1 || spec.chartType === 'pie' || spec.chartType === 'doughnut',
    legendPos: 'b' as const, legendFontSize: 11, legendColor: r.muted,
    catAxisLabelColor: r.muted, valAxisLabelColor: r.muted,
    catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
    dataLabelColor: r.muted, dataLabelFontSize: 10,
    surface: t.bg,
  }
  const chartEl = (rect: { x: number; y: number; w: number; h: number }): El => ({
    type: 'chart', rect,
    chartType: spec.chartType,
    categories: [...spec.categories],
    series: spec.series.map((sr) => ({ name: sr.name, values: [...sr.values] })),
    style: chartStyle,
  })

  // 'split' needs the takeaway to fill its side card — an empty card is worse
  // than no variant, so it falls back to 'full'.
  const variant = spec.variant === 'split' && !spec.takeaway ? 'full' : (spec.variant ?? 'full')

  if (variant === 'split') {
    const chartW = c.contentW * 0.62 - s.gap / 2
    const cardX = s.margin + chartW + s.gap
    const cardW = c.contentW * 0.38 - s.gap / 2
    els.push(chartEl({ x: s.margin, y: 1.4, w: chartW, h: 5.5 }))
    els.push({ type: 'roundRect', rect: { x: cardX, y: 1.4, w: cardW, h: 5.5 }, radius: s.radiusLg, fill: { color: r.cardFill } })
    els.push({
      type: 'text', rect: { x: cardX + s.pad, y: 1.4 + s.pad, w: cardW - s.pad * 2, h: 3.4 }, runs: [{ text: spec.takeaway! }],
      style: { fontSize: 20, bold: true, color: r.onLight, fontFace: t.headFont, valign: 'top', fit: 'shrink' },
    })
    if (spec.source) {
      els.push({
        type: 'text', rect: { x: cardX + s.pad, y: 6.3 - s.pad, w: cardW - s.pad * 2, h: 0.4 }, runs: [{ text: `Source: ${spec.source}` }],
        style: { fontSize: 10, italic: true, color: r.muted, fontFace: t.bodyFont },
      })
    }
    return { els, warnings: [] }
  }

  if (variant === 'banner') {
    // Takeaway FIRST as a 24pt statement, chart below — inverts the read order.
    if (spec.takeaway) {
      els.push({ type: 'rect', rect: { x: s.margin, y: 1.48, w: 0.14, h: 0.8 }, fill: { color: t.accent } })
      els.push({
        type: 'text', rect: { x: s.margin + 0.35, y: 1.4, w: c.contentW - 0.35, h: 0.95 }, runs: [{ text: spec.takeaway }],
        style: { fontSize: 24, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
      })
    }
    els.push(chartEl({ x: s.margin, y: spec.takeaway ? 2.55 : 1.4, w: c.contentW, h: spec.takeaway ? 4.45 : 5.5 }))
    if (spec.source) {
      els.push({
        type: 'text', rect: { x: s.margin, y: PAGE_H - 0.62, w: c.contentW - 1.2, h: 0.3 }, runs: [{ text: `Source: ${spec.source}` }],
        style: { fontSize: 10, italic: true, color: r.muted, fontFace: t.bodyFont, align: 'right' },
      })
    }
    return { els, warnings: [] }
  }

  // 'full' (default) — today's geometry, byte-identical.
  els.push(chartEl({ x: s.margin, y: 1.4, w: c.contentW, h: spec.takeaway ? 4.8 : 5.5 }))
  if (spec.takeaway) {
    els.push({ type: 'rect', rect: { x: s.margin, y: 6.38, w: 0.14, h: 0.34 }, fill: { color: t.accent } })
    els.push({
      type: 'text', rect: { x: s.margin + 0.3, y: 6.3, w: c.contentW - 0.3, h: 0.5 }, runs: [{ text: spec.takeaway }],
      style: { fontSize: 15, bold: true, color: r.title, fontFace: t.headFont, fit: 'shrink' },
    })
  }
  if (spec.source) {
    els.push({
      type: 'text', rect: { x: s.margin, y: PAGE_H - 0.62, w: c.contentW - 1.2, h: 0.3 }, runs: [{ text: `Source: ${spec.source}` }],
      style: { fontSize: 10, italic: true, color: r.muted, fontFace: t.bodyFont, align: 'right' },
    })
  }
  return { els, warnings: [] }
}
