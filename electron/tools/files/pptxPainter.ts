// El[] → pptxgenjs. One of the two painters over the shared display list
// (the other is the renderer's SVG SlidePreview).
//
// HARD RULE: build a FRESH option literal for every call. pptxgenjs mutates the
// objects it is handed (it stamps `_bodyProp` onto them), so passing an El or
// any sub-object straight through would corrupt the display list — which the
// preview and the snapshot oracle also read.

import type PptxGenJS from 'pptxgenjs'
import type { El, Fill, TextRun } from '../../../shared/deck/el'
import type { ChartKind } from '../../../shared/deck/spec'

function fillOpt(f: Fill): { color: string; transparency?: number } {
  return f.transparency === undefined ? { color: f.color } : { color: f.color, transparency: f.transparency }
}

/** A lone plain run is passed as a string, matching how the deck was authored
 *  before the display list existed (and what the snapshot baseline records). */
function textArg(rs: TextRun[]): string | { text: string; options: Record<string, unknown> }[] {
  const plain = rs.length === 1 && !rs[0].bullet && rs[0].paraSpaceAfter === undefined
  if (plain) return rs[0].text
  return rs.map((r) => {
    const options: Record<string, unknown> = {}
    if (r.bullet) options.bullet = true
    if (r.paraSpaceAfter !== undefined) options.paraSpaceAfter = r.paraSpaceAfter
    return { text: r.text, options }
  })
}

function chartTypeOf(pres: PptxGenJS, kind: ChartKind) {
  switch (kind) {
    case 'bar': return pres.ChartType.bar
    case 'line': return pres.ChartType.line
    case 'pie': return pres.ChartType.pie
    case 'doughnut': return pres.ChartType.doughnut
    case 'area': return pres.ChartType.area
    default:
      throw new Error(`Unknown chartType '${String(kind)}'. Valid: bar | line | pie | doughnut | area.`)
  }
}

/** Pre-rasterized icon PNGs, keyed `${name}|${color}` — built by pptx.ts
 *  (sharp is async and main-only; painters stay sync by taking the result). */
export type IconPngs = Record<string, string>

export function paintEl(slide: PptxGenJS.Slide, el: El, pres: PptxGenJS, iconPngs: IconPngs = {}): void {
  switch (el.type) {
    case 'rect':
      slide.addShape('rect', { x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h, fill: fillOpt(el.fill) })
      return

    case 'roundRect':
      slide.addShape('roundRect', {
        x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h, rectRadius: el.radius, fill: fillOpt(el.fill),
        ...(el.stroke ? { line: { color: el.stroke.color, width: el.stroke.pt } } : {}),
      })
      return

    case 'ellipse':
      slide.addShape('ellipse', { x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h, fill: fillOpt(el.fill) })
      return

    case 'chevron':
      // prstGeom chevron at its default adjust — the SVG painter mirrors the
      // half-of-shorter-side tip, so no adjust value needs to be forced.
      slide.addShape('chevron', { x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h, fill: fillOpt(el.fill) })
      return

    case 'ring': {
      // Track = stroked circle; progress = stroked open 'arc'. pptxgenjs
      // angleRange maps 1:1 to OOXML arc degrees (0° = 3 o'clock, clockwise),
      // verified against the generated avLst — so 270° is 12 o'clock.
      const d = Math.min(el.rect.w, el.rect.h)
      const x = el.rect.x + (el.rect.w - d) / 2
      const y = el.rect.y + (el.rect.h - d) / 2
      const pct = Math.max(0, Math.min(100, el.pct))
      slide.addShape('ellipse', {
        x, y, w: d, h: d,
        fill: { color: el.track, transparency: 100 },
        line: { color: pct === 100 ? el.color : el.track, width: el.pt },
      })
      if (pct > 0 && pct < 100) {
        slide.addShape('arc', {
          x, y, w: d, h: d,
          angleRange: [270, 270 + pct * 3.6],
          fill: { color: el.color, transparency: 100 },
          line: { color: el.color, width: el.pt },
        })
      }
      return
    }

    case 'line': {
      // pptxgenjs draws a line inside its bounding box from corner to corner;
      // flipV picks the other diagonal for lines that run upward.
      const x = Math.min(el.from.x, el.to.x)
      const y = Math.min(el.from.y, el.to.y)
      const goesUp = (el.to.y - el.from.y) * (el.to.x - el.from.x) < 0
      slide.addShape('line', {
        x, y, w: Math.abs(el.to.x - el.from.x), h: Math.abs(el.to.y - el.from.y),
        ...(goesUp ? { flipV: true } : {}),
        line: { color: el.color, width: el.pt, ...(el.dash ? { dashType: 'dash' } : {}) },
      })
      return
    }

    case 'text': {
      const s = el.style
      const o: Record<string, unknown> = {
        x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h,
        fontSize: s.fontSize, color: s.color, fontFace: s.fontFace,
      }
      if (el.shape) {
        o.shape = el.shape.kind
        if (el.shape.kind === 'roundRect') o.rectRadius = el.shape.radius
        o.fill = fillOpt(el.shape.fill)
      }
      if (s.bold) o.bold = true
      if (s.italic) o.italic = true
      if (s.align) o.align = s.align
      if (s.valign) o.valign = s.valign
      if (s.transparency !== undefined) o.transparency = s.transparency
      if (s.charSpacing !== undefined) o.charSpacing = s.charSpacing
      if (s.fit) o.fit = s.fit
      slide.addText(textArg(el.runs) as never, o as never)
      return
    }

    case 'image':
      slide.addImage({
        path: el.path,
        x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h,
        sizing: { type: el.sizing, w: el.rect.w, h: el.rect.h },
      })
      return

    case 'icon': {
      const data = iconPngs[`${el.name}|${el.color}`]
      // A missing entry is a wiring bug (pptx.ts rasterizes every icon the
      // deck uses) — fail loudly rather than exporting an invisible hole.
      if (!data) throw new Error(`icon '${el.name}' was not rasterized before painting`)
      slide.addImage({ data, x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h })
      return
    }

    case 'chart': {
      const data = el.series.map((sr) => ({ name: sr.name, labels: el.categories, values: sr.values }))
      const s = el.style
      slide.addChart(chartTypeOf(pres, el.chartType), data, {
        x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h,
        chartColors: [...s.chartColors],
        showLegend: s.showLegend,
        legendPos: s.legendPos,
        legendFontSize: s.legendFontSize,
        legendColor: s.legendColor,
        catAxisLabelColor: s.catAxisLabelColor,
        valAxisLabelColor: s.valAxisLabelColor,
        catAxisLabelFontSize: s.catAxisLabelFontSize,
        valAxisLabelFontSize: s.valAxisLabelFontSize,
        dataLabelColor: s.dataLabelColor,
        dataLabelFontSize: s.dataLabelFontSize,
      })
      return
    }

    case 'table': {
      const rows = el.rows.map((r) =>
        r.map((c) => {
          const options: Record<string, unknown> = {}
          if (c.bold) options.bold = true
          if (c.fill) options.fill = fillOpt(c.fill)
          if (c.color) options.color = c.color
          if (c.fontFace) options.fontFace = c.fontFace
          return Object.keys(options).length ? { text: c.text, options } : { text: c.text }
        }),
      )
      slide.addTable(rows as never, {
        x: el.rect.x, y: el.rect.y, w: el.rect.w,
        rowH: el.rowH,
        fontSize: el.fontSize,
        color: el.color,
        fontFace: el.fontFace,
        border: { type: 'solid', pt: el.border.pt, color: el.border.color },
        autoPage: false,
      })
      return
    }
  }
}

export function paintSlide(slide: PptxGenJS.Slide, els: El[], pres: PptxGenJS, iconPngs: IconPngs = {}): void {
  for (const el of els) paintEl(slide, el, pres, iconPngs)
}
