// El[] → SVG *string*. The second painter over the shared display list (the
// first is electron/tools/files/pptxPainter.ts → pptxgenjs).
//
// This used to live inside the React component SlidePreview.tsx, which made it
// unusable from the electron main process — and main is where the deck-QA
// contact sheet is rasterized so the MODEL can see its own deck. Extracted as a
// plain string builder: React wraps it (dangerouslySetInnerHTML), main feeds it
// to sharp. One painter, three consumers.
//
// The viewBox is in POINTS (inches × 72) so font-size maps 1:1 to the deck's
// point sizes. Text is placed line-by-line using the core's own wrapper —
// foreignObject would delegate wrapping to Blink, which the exporter cannot
// reproduce, reintroducing drift.
//
// Unlike JSX, nothing here escapes text automatically — every user string goes
// through esc(). See shared/deck/page.ts for the purity rules.

import type { El, SlideDisplay, TextStyle } from '../el'
import { PAGE_W, PAGE_H } from '../page'
import { wrapText, firstLineTop } from '../text/wrap'
import { lineHeightIn, ascentIn } from '../text/metrics'
import { expandChart, type PreviewShape } from './chart'
import { fontStack } from './fonts'
import { iconNode } from '../icons'

const PT = 72
const hex = (c: string) => `#${c}`

/**
 * Picture bytes for an `image` element, as something an `<image href>` accepts
 * (a data: URI, or a URL the host page can load).
 *
 * The painter stays pure and synchronous: loading is the host's business and
 * has to be done BEFORE painting. Returning undefined is normal (not yet
 * loaded, or missing) and draws the named frame instead.
 */
export type ImageSrc = (path: string) => string | undefined

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Serialize one attribute set, dropping undefined values. */
function attrs(a: Record<string, string | number | undefined>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${typeof v === 'string' ? esc(v) : v}"`)
    .join(' ')
}

function textEl(el: Extract<El, { type: 'text' }>): string {
  const s: TextStyle = el.style
  const { lines, blockH } = wrapText(el.runs, el.rect.w, el.rect.h, s)
  const lh = lineHeightIn(s.fontSize)
  const top = firstLineTop(el.rect.y, el.rect.h, blockH, s.valign)

  const anchor = s.align === 'center' ? 'middle' : s.align === 'right' ? 'end' : 'start'
  const xFor = (indent: number) => {
    if (s.align === 'center') return el.rect.x + el.rect.w / 2
    if (s.align === 'right') return el.rect.x + el.rect.w - 0.1
    return el.rect.x + 0.1 + indent
  }

  let y = top
  const out: string[] = []
  lines.forEach((ln, i) => {
    const baseline = y + ascentIn(s.fontSize)
    const bullet = ln.first && el.runs[ln.para]?.bullet ? '• ' : ''
    out.push(
      `<text ${attrs({
        x: xFor(ln.indentIn) * PT,
        y: baseline * PT,
        'font-family': fontStack(s.fontFace),
        'font-size': s.fontSize,
        'font-weight': s.bold ? 700 : 400,
        'font-style': s.italic ? 'italic' : undefined,
        'letter-spacing': s.charSpacing,   // viewBox is in points → 1:1
        fill: hex(s.color),
        'text-anchor': anchor,
        opacity: s.transparency !== undefined ? 1 - s.transparency / 100 : undefined,
      })}>${esc(bullet + ln.text)}</text>`,
    )
    y += lh
    const gap = el.runs[ln.para]?.paraSpaceAfter
    if (gap && i + 1 < lines.length && lines[i + 1].para !== ln.para) y += gap / 72
  })
  return out.join('')
}

function shape(sh: PreviewShape): string {
  switch (sh.kind) {
    case 'rect':
      return `<rect ${attrs({ x: sh.x * PT, y: sh.y * PT, width: sh.w * PT, height: sh.h * PT, fill: hex(sh.fill), opacity: sh.opacity })}/>`
    case 'line':
      return `<line ${attrs({ x1: sh.x1 * PT, y1: sh.y1 * PT, x2: sh.x2 * PT, y2: sh.y2 * PT, stroke: hex(sh.stroke), 'stroke-width': sh.width * PT, opacity: 0.35 })}/>`
    case 'polyline':
      return `<polyline ${attrs({ points: sh.points.map(([x, y]) => `${x * PT},${y * PT}`).join(' '), fill: 'none', stroke: hex(sh.stroke), 'stroke-width': sh.width * PT })}/>`
    case 'polygon':
      return `<polygon ${attrs({ points: sh.points.map(([x, y]) => `${x * PT},${y * PT}`).join(' '), fill: hex(sh.fill), opacity: sh.opacity })}/>`
    case 'circle':
      return `<circle ${attrs({ cx: sh.cx * PT, cy: sh.cy * PT, r: sh.r * PT, fill: hex(sh.fill) })}/>`
    case 'arc': {
      const { cx, cy, r, a0, a1 } = sh
      // A full circle cannot be expressed as a single arc (start == end).
      if (a1 - a0 >= Math.PI * 2 - 1e-6) return `<circle ${attrs({ cx: cx * PT, cy: cy * PT, r: r * PT, fill: hex(sh.fill) })}/>`
      const p = (a: number) => `${(cx + r * Math.cos(a)) * PT} ${(cy + r * Math.sin(a)) * PT}`
      const large = a1 - a0 > Math.PI ? 1 : 0
      return `<path ${attrs({ d: `M ${cx * PT} ${cy * PT} L ${p(a0)} A ${r * PT} ${r * PT} 0 ${large} 1 ${p(a1)} Z`, fill: hex(sh.fill) })}/>`
    }
    case 'text':
      return `<text ${attrs({ x: sh.x * PT, y: sh.y * PT, 'font-size': sh.size, fill: hex(sh.fill), 'text-anchor': sh.anchor })}>${esc(sh.text)}</text>`
  }
}

function fillOpacity(t: number | undefined): number | undefined {
  return t ? 1 - t / 100 : undefined
}

function element(el: El, imgSrc?: ImageSrc): string {
  switch (el.type) {
    case 'rect':
      return `<rect ${attrs({ x: el.rect.x * PT, y: el.rect.y * PT, width: el.rect.w * PT, height: el.rect.h * PT, fill: hex(el.fill.color), opacity: fillOpacity(el.fill.transparency) })}/>`
    case 'roundRect':
      return `<rect ${attrs({
        x: el.rect.x * PT, y: el.rect.y * PT, width: el.rect.w * PT, height: el.rect.h * PT, rx: el.radius * PT,
        fill: el.fill.transparency === 100 ? 'none' : hex(el.fill.color),
        opacity: el.fill.transparency && el.fill.transparency < 100 ? 1 - el.fill.transparency / 100 : undefined,
        stroke: el.stroke ? hex(el.stroke.color) : undefined,
        'stroke-width': el.stroke ? el.stroke.pt : undefined,
      })}/>`
    case 'line':
      return `<line ${attrs({
        x1: el.from.x * PT, y1: el.from.y * PT, x2: el.to.x * PT, y2: el.to.y * PT,
        stroke: hex(el.color), 'stroke-width': el.pt,
        'stroke-dasharray': el.dash ? '6 4' : undefined, 'stroke-linecap': 'round',
      })}/>`
    case 'ellipse':
      return `<ellipse ${attrs({ cx: (el.rect.x + el.rect.w / 2) * PT, cy: (el.rect.y + el.rect.h / 2) * PT, rx: (el.rect.w / 2) * PT, ry: (el.rect.h / 2) * PT, fill: hex(el.fill.color), opacity: fillOpacity(el.fill.transparency) })}/>`
    case 'chevron': {
      // Same silhouette as prstGeom 'chevron' at its default adjust: the tip
      // (and the notch on the left edge) is half the shorter side deep.
      const { x, y, w, h } = el.rect
      const tip = Math.min(w, h) / 2
      const pts: [number, number][] = [
        [x, y], [x + w - tip, y], [x + w, y + h / 2], [x + w - tip, y + h], [x, y + h], [x + tip, y + h / 2],
      ]
      return `<polygon ${attrs({ points: pts.map(([px, py]) => `${px * PT},${py * PT}`).join(' '), fill: hex(el.fill.color), opacity: fillOpacity(el.fill.transparency) })}/>`
    }
    case 'ring': {
      const cx = (el.rect.x + el.rect.w / 2) * PT
      const cy = (el.rect.y + el.rect.h / 2) * PT
      const rr = (Math.min(el.rect.w, el.rect.h) / 2) * PT - el.pt / 2
      const track = `<circle ${attrs({ cx, cy, r: rr, fill: 'none', stroke: hex(el.track), 'stroke-width': el.pt })}/>`
      const pct = Math.max(0, Math.min(100, el.pct))
      if (pct === 0) return track
      if (pct === 100) return track + `<circle ${attrs({ cx, cy, r: rr, fill: 'none', stroke: hex(el.color), 'stroke-width': el.pt })}/>`
      const a = (pct / 100) * Math.PI * 2   // clockwise from 12 o'clock
      const x2 = cx + rr * Math.sin(a)
      const y2 = cy - rr * Math.cos(a)
      return track + `<path ${attrs({
        d: `M ${cx} ${cy - rr} A ${rr} ${rr} 0 ${pct > 50 ? 1 : 0} 1 ${x2} ${y2}`,
        fill: 'none', stroke: hex(el.color), 'stroke-width': el.pt,
      })}/>`
    }
    case 'text': {
      const parts: string[] = []
      if (el.shape?.kind === 'roundRect') {
        parts.push(`<rect ${attrs({ x: el.rect.x * PT, y: el.rect.y * PT, width: el.rect.w * PT, height: el.rect.h * PT, rx: el.shape.radius * PT, fill: hex(el.shape.fill.color) })}/>`)
      }
      if (el.shape?.kind === 'ellipse') {
        parts.push(`<ellipse ${attrs({ cx: (el.rect.x + el.rect.w / 2) * PT, cy: (el.rect.y + el.rect.h / 2) * PT, rx: (el.rect.w / 2) * PT, ry: (el.rect.h / 2) * PT, fill: hex(el.shape.fill.color) })}/>`)
      }
      parts.push(textEl(el))
      return parts.join('')
    }
    case 'image': {
      // A filesystem path is not loadable from here — this module is pure and
      // its two hosts reach the bytes differently (renderer: an IPC that
      // returns a data URI; main: fs). So the HOST resolves, and we draw.
      const src = imgSrc?.(el.path)
      if (src) {
        // cover 는 박스 밖으로 넘치므로 clipPath 로 잘라낸다 — SVG 의
        // preserveAspectRatio slice 는 넘치는 부분을 스스로 숨기지 않는다.
        const clip = el.sizing === 'cover' ? `img-${Math.round(el.rect.x * 1e3)}-${Math.round(el.rect.y * 1e3)}-${Math.round(el.rect.w * 1e3)}` : ''
        const defs = clip
          ? `<defs><clipPath id="${clip}"><rect ${attrs({ x: el.rect.x * PT, y: el.rect.y * PT, width: el.rect.w * PT, height: el.rect.h * PT })}/></clipPath></defs>`
          : ''
        return defs + `<image ${attrs({
          ...(clip ? { 'clip-path': `url(#${clip})` } : {}),
          x: el.rect.x * PT, y: el.rect.y * PT, width: el.rect.w * PT, height: el.rect.h * PT,
          href: src,
          // meet = contain(박스 안에 통째로), slice = cover(채우고 잘라냄).
          // 내보내기의 pptxgenjs `sizing.type` 과 1:1 로 맞춘다.
          preserveAspectRatio: el.sizing === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet',
        })}/>`
      }
      // Unresolved (still loading, or the file is gone): keep the frame so the
      // page still reads, and NAME the file — that name is how the user finds
      // out which picture is missing.
      return (
        `<rect ${attrs({ x: el.rect.x * PT, y: el.rect.y * PT, width: el.rect.w * PT, height: el.rect.h * PT, fill: '#00000008', stroke: '#00000022', 'stroke-dasharray': '4 4' })}/>` +
        `<text ${attrs({ x: (el.rect.x + el.rect.w / 2) * PT, y: (el.rect.y + el.rect.h / 2) * PT, 'font-size': 11, fill: '#888', 'text-anchor': 'middle' })}>${esc(el.path.split('/').pop() ?? '')}</text>`
      )
    }
    case 'icon': {
      // Lucide shapes live in a 24×24 box: translate + scale into the rect,
      // stroke in the el's colour. stroke-width is in ICON units (pre-scale).
      const sc = (el.rect.w * PT) / 24
      const inner = iconNode(el.name)
        .map(([tag, a]) => `<${tag} ${attrs(a as Record<string, string | number>)}/>`)
        .join('')
      return (
        `<g transform="translate(${el.rect.x * PT} ${el.rect.y * PT}) scale(${sc})" ` +
        `fill="none" stroke="${hex(el.color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
      )
    }
    case 'chart':
      return expandChart(el).map(shape).join('')
    case 'table': {
      const cols = el.rows[0]?.length ?? 1
      const colW = el.rect.w / cols
      const rowH = el.rowH
      const cells: string[] = []
      el.rows.forEach((row, ri) => {
        row.forEach((cell, ci) => {
          const x = el.rect.x + ci * colW
          const y = el.rect.y + ri * rowH
          cells.push(
            `<rect ${attrs({ x: x * PT, y: y * PT, width: colW * PT, height: rowH * PT, fill: cell.fill ? hex(cell.fill.color) : 'none', stroke: hex(el.border.color), 'stroke-width': el.border.pt })}/>` +
            `<text ${attrs({ x: (x + 0.07) * PT, y: (y + rowH * 0.68) * PT, 'font-size': el.fontSize, 'font-family': fontStack(el.fontFace), 'font-weight': cell.bold ? 700 : 400, fill: hex(cell.color ?? el.color) })}>${esc(cell.text)}</text>`,
          )
        })
      })
      return cells.join('')
    }
  }
}

/** Inner markup of a slide (background + elements), no <svg> wrapper — the
 *  React component owns the wrapper so it can attach props/styles. */
export function slideSvgInner(slide: SlideDisplay, imgSrc?: ImageSrc): string {
  return (
    `<rect ${attrs({ x: 0, y: 0, width: PAGE_W * PT, height: PAGE_H * PT, fill: hex(slide.background) })}/>` +
    slide.elements.map((el) => element(el, imgSrc)).join('')
  )
}

/** A complete standalone SVG document for one slide, `width` px wide. */
export function slideSvg(slide: SlideDisplay, width: number, imgSrc?: ImageSrc): string {
  const height = Math.round((width * PAGE_H) / PAGE_W)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_W * PT} ${PAGE_H * PT}" width="${width}" height="${height}">` +
    slideSvgInner(slide, imgSrc) +
    '</svg>'
  )
}
