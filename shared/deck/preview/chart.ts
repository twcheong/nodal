// Chart → preview primitives.
//
// The display list keeps `chart` SEMANTIC because the pptx exporter must hand
// the raw series to pptxgenjs, which writes an OOXML chart part that PowerPoint
// renders itself. There is no way to be pixel-faithful to that, so this is an
// explicit approximation used ONLY by the preview: PowerPoint picks its own
// axis maximum and tick rounding, bar gap widths, pie start angle and data
// label collision avoidance. Surface that to the user rather than pretending.
//
// It still lives in the core (not in the React component) so the preview shares
// the chart rect, colour run, legend position and font sizes with the exporter.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import type { El, Hex, Rect } from '../el'

export type PreviewShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: Hex; opacity?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: Hex; width: number }
  | { kind: 'polyline'; points: [number, number][]; stroke: Hex; width: number }
  | { kind: 'polygon'; points: [number, number][]; fill: Hex; opacity?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: Hex }
  /** Pie/doughnut wedge. Angles in radians, 0 = 3 o'clock. Kept structured
   *  rather than a path string so the painter can scale units safely — scaling
   *  a raw `d` multiplies the arc FLAGS too, which silently breaks the path. */
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; fill: Hex }
  | { kind: 'text'; x: number; y: number; text: string; size: number; fill: Hex; anchor: 'start' | 'middle' | 'end' }

type ChartEl = Extract<El, { type: 'chart' }>

const AXIS_GUTTER = 0.55   // left band for value labels
const CAT_BAND = 0.3       // bottom band for category labels
const LEGEND_BAND = 0.32

function plotArea(rect: Rect, hasLegend: boolean, radial: boolean): Rect {
  const bottom = (hasLegend ? LEGEND_BAND : 0) + (radial ? 0 : CAT_BAND)
  const left = radial ? 0 : AXIS_GUTTER
  return { x: rect.x + left, y: rect.y + 0.1, w: rect.w - left, h: rect.h - bottom - 0.1 }
}

/** Deterministic "nice" axis maximum — no Intl, no locale. */
function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / mag
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * mag
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function legendShapes(el: ChartEl, labels: string[], colors: Hex[]): PreviewShape[] {
  const out: PreviewShape[] = []
  const y = el.rect.y + el.rect.h - LEGEND_BAND / 2
  const size = el.style.legendFontSize / 72
  const each = Math.min(1.6, el.rect.w / Math.max(labels.length, 1))
  const total = each * labels.length
  let x = el.rect.x + (el.rect.w - total) / 2
  labels.forEach((name, i) => {
    out.push({ kind: 'rect', x, y: y - size * 0.35, w: size * 0.7, h: size * 0.7, fill: colors[i % colors.length] })
    out.push({ kind: 'text', x: x + size, y: y + size * 0.3, text: name, size: el.style.legendFontSize, fill: el.style.legendColor, anchor: 'start' })
    x += each
  })
  return out
}

export function expandChart(el: ChartEl): PreviewShape[] {
  const radial = el.chartType === 'pie' || el.chartType === 'doughnut'
  const colors = el.style.chartColors
  const p = plotArea(el.rect, el.style.showLegend, radial)
  const out: PreviewShape[] = []

  if (radial) {
    const vals = el.series[0]?.values ?? []
    const total = vals.reduce((a, b) => a + b, 0) || 1
    const cx = p.x + p.w / 2
    const cy = p.y + p.h / 2
    const r = Math.min(p.w, p.h) / 2 - 0.05
    let a0 = -Math.PI / 2
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2
      out.push({ kind: 'arc', cx, cy, r, a0, a1, fill: colors[i % colors.length] })
      a0 = a1
    })
    if (el.chartType === 'doughnut') {
      out.push({ kind: 'circle', cx, cy, r: r * 0.55, fill: el.style.surface })
    }
    if (el.style.showLegend) out.push(...legendShapes(el, el.categories, colors))
    return out
  }

  const maxVal = niceMax(Math.max(0, ...el.series.flatMap((s) => s.values)))
  const yOf = (v: number) => p.y + p.h - (v / maxVal) * p.h

  // value axis gridlines + labels
  for (let i = 0; i <= 2; i++) {
    const v = (maxVal / 2) * i
    const y = yOf(v)
    out.push({ kind: 'line', x1: p.x, y1: y, x2: p.x + p.w, y2: y, stroke: el.style.catAxisLabelColor, width: 0.004 })
    out.push({ kind: 'text', x: p.x - 0.06, y: y + 0.04, text: fmt(v), size: el.style.valAxisLabelFontSize, fill: el.style.valAxisLabelColor, anchor: 'end' })
  }

  const n = Math.max(el.categories.length, 1)
  const slot = p.w / n

  if (el.chartType === 'bar') {
    const sCount = Math.max(el.series.length, 1)
    const barW = (slot * 0.62) / sCount
    el.series.forEach((s, si) => {
      s.values.forEach((v, ci) => {
        const x = p.x + ci * slot + slot * 0.19 + si * barW
        const y = yOf(v)
        out.push({ kind: 'rect', x, y, w: barW * 0.92, h: p.y + p.h - y, fill: colors[si % colors.length] })
      })
    })
  } else {
    el.series.forEach((s, si) => {
      const pts = s.values.map((v, ci) => [p.x + ci * slot + slot / 2, yOf(v)] as [number, number])
      if (el.chartType === 'area') {
        out.push({ kind: 'polygon', points: [[pts[0]?.[0] ?? p.x, p.y + p.h], ...pts, [pts[pts.length - 1]?.[0] ?? p.x, p.y + p.h]], fill: colors[si % colors.length], opacity: 0.35 })
      }
      out.push({ kind: 'polyline', points: pts, stroke: colors[si % colors.length], width: 0.022 })
      for (const [x, y] of pts) out.push({ kind: 'circle', cx: x, cy: y, r: 0.035, fill: colors[si % colors.length] })
    })
  }

  el.categories.forEach((cat, i) => {
    out.push({ kind: 'text', x: p.x + i * slot + slot / 2, y: p.y + p.h + 0.2, text: cat, size: el.style.catAxisLabelFontSize, fill: el.style.catAxisLabelColor, anchor: 'middle' })
  })

  if (el.style.showLegend) out.push(...legendShapes(el, el.series.map((s) => s.name), colors))
  return out
}
