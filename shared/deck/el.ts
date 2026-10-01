// The display list — a backend-agnostic paint list produced by the layout core
// and consumed by two painters:
//   · electron/tools/files/pptxPainter.ts  → pptxgenjs (inches, straight through)
//   · the renderer's SlidePreview           → SVG (× 72 into a point viewBox)
//
// Because both painters read the SAME list, the preview is faithful by
// construction rather than by a re-implementation that drifts.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import type { Rect } from './page'
import type { Hex } from './theme'
import type { ChartKind } from './spec'

export type { Rect, Hex }

export type Fill = { color: Hex; transparency?: number }

export type TextRun = {
  text: string
  bullet?: boolean
  /** points of space after this paragraph */
  paraSpaceAfter?: number
}

export type TextStyle = {
  fontSize: number
  fontFace: string
  color: Hex
  bold?: boolean
  italic?: boolean
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  transparency?: number
  /** Letter spacing in points — kicker/eyebrow typography. ONLY for short
   *  single-line labels: the wrap metrics do not model it, so a wrapped
   *  paragraph with charSpacing would under-measure its width. */
  charSpacing?: number
  /**
   * Lines this text is DESIGNED to occupy. Autofit shrinks until the wrap fits
   * within it, not just within the box height.
   *
   * Height alone is not enough for labels: a stats label at 15pt wrapped to two
   * lines that measured 0.50" inside a 0.50" box, so nothing overflowed and
   * nothing was reported — but the Korean broke mid-word ("팔로 / 워") because
   * CJK legally breaks between characters. Requires `fit: 'shrink'` to have any
   * effect. Leave unset for paragraphs, which are supposed to wrap.
   */
  maxLines?: number
  /** pptxgenjs shrink-to-fit. NOTE: PowerPoint does not apply this until the
   *  box is edited, so the core solves autofit itself and bakes the resulting
   *  fontSize; this flag stays as a residual safety net. */
  fit?: 'shrink'
}

/** A text box may be drawn on top of its own shape — pptxgenjs models that as a
 *  single addText call, so keeping it as one El preserves z-order. */
export type TextShape =
  | { kind: 'roundRect'; radius: number; fill: Fill }
  | { kind: 'ellipse'; fill: Fill }

export type ChartStyle = {
  chartColors: Hex[]
  showLegend: boolean
  legendPos: 'b' | 'r' | 't' | 'l'
  legendFontSize: number
  legendColor: Hex
  catAxisLabelColor: Hex
  valAxisLabelColor: Hex
  catAxisLabelFontSize: number
  valAxisLabelFontSize: number
  dataLabelColor: Hex
  dataLabelFontSize: number
  /** Slide surface behind the chart. Preview-only (pptxgenjs draws doughnut
   *  holes itself); used to punch the doughnut hole in the right colour. */
  surface: Hex
}

export type TableCell = {
  text: string
  bold?: boolean
  color?: Hex
  fill?: Fill
  fontFace?: string
}

export type El =
  | { type: 'rect'; rect: Rect; fill: Fill }
  /** `stroke` outlines the shape; pair with `fill.transparency: 100` for an
   *  outline-only chip (the Claude-cover look). */
  | { type: 'roundRect'; rect: Rect; fill: Fill; radius: number; stroke?: { color: Hex; pt: number } }
  | { type: 'ellipse'; rect: Rect; fill: Fill }
  /** Right-pointing process arrow (prstGeom `chevron`). The tip depth is the
   *  shape's default: half the shorter side — the SVG painter mirrors that
   *  ratio so both backends draw the same silhouette. */
  | { type: 'chevron'; rect: Rect; fill: Fill }
  /** Progress ring: a `track`-coloured circle with `pct`% of an accent arc on
   *  top, starting at 12 o'clock, clockwise. `pt` is the stroke width in
   *  POINTS. Drawn inside the largest circle that fits `rect`, centered. */
  | { type: 'ring'; rect: Rect; pct: number; color: Hex; track: Hex; pt: number }
  /** Straight connector. `pt` is stroke width in POINTS (like font sizes). */
  | { type: 'line'; from: { x: number; y: number }; to: { x: number; y: number }; color: Hex; pt: number; dash?: 'dash' }
  | { type: 'text'; rect: Rect; runs: TextRun[]; style: TextStyle; shape?: TextShape }
  /** `contain` = 박스 안에 통째로(여백 생김) · `cover` = 박스를 채우고 넘치는
   *  쪽을 잘라낸다. 하프블리드처럼 "가장자리까지" 가 목적인 면은 cover 여야
   *  한다 — contain 으로 그리면 가장자리에 흰 띠가 남아 그 페이지 타입의
   *  존재 이유가 사라진다. */
  | { type: 'image'; rect: Rect; path: string; sizing: 'contain' | 'cover' }
  /** A deck icon (curated lucide subset, shared/deck/icons.ts). The SVG
   *  preview strokes the paths directly; the pptx exporter rasterizes to a
   *  PNG data URI at write time (sharp lives in electron main only). */
  | { type: 'icon'; rect: Rect; name: string; color: Hex }
  | {
      type: 'chart'
      rect: Rect
      chartType: ChartKind
      categories: string[]
      series: { name: string; values: number[] }[]
      style: ChartStyle
    }
  | {
      type: 'table'
      /** h is advisory: PowerPoint computes the real height from the rows. */
      rect: Rect
      /** Height of EVERY row, inches. Without it PowerPoint packs rows to their
       *  text height, so a 4-row table rendered ~1" tall under the title and
       *  left five inches of blank page — and the SVG preview (which capped
       *  rows at 0.34") disagreed with the export. Sizing rows in the layout
       *  core keeps both painters on the same geometry. */
      rowH: number
      rows: TableCell[][]
      fontSize: number
      fontFace: string
      color: Hex
      border: { pt: number; color: Hex }
    }

export type LayoutWarning =
  /** a collection was cut to its cap (stats > 4, timeline > 6, takeaways > 5) */
  | { code: 'clamped'; what: string; kept: number; dropped: number }
  /** table rows beyond the per-slide cap were replaced by a "see XLSX" row */
  | { code: 'rowsTruncated'; kept: number; dropped: number }
  /** content is taller than its box */
  | { code: 'overflow'; what: string; overBy: number }
  /** autofit reduced a font size to make text fit */
  | { code: 'shrunk'; what: string; from: number; to: number }

export type SlideDisplay = {
  index: number
  background: Hex
  /** paint order — never reorder (e.g. the ghost numeral must precede the solid one) */
  elements: El[]
  notes?: string
  warnings: LayoutWarning[]
}

export type DeckDisplay = {
  pageW: number
  pageH: number
  title: string
  /** Declared purpose id, when the payload set one (report/pitch/…). */
  purpose?: string
  slides: SlideDisplay[]
  /** Deck-level structural notes (purpose slots missing/inverted, geometry
   *  repetition, legacy skeleton). Text because the feedback channel is text. */
  structure: string[]
}

/** Convenience for painters that need a single text run. */
export function runs(text: string): TextRun[] {
  return [{ text }]
}
