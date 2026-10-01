// Shrink-to-fit, solved by us rather than by PowerPoint.
//
// WHY THIS EXISTS — a real bug in the shipped tool: pptxgenjs writes
// `<a:normAutofit/>` with the fontScale line commented out (pptxgen.cjs.js
// ~6067), and PowerPoint only computes that scale when the shape is EDITED. So
// every `fit: 'shrink'` title silently overflowed on first open; the flag did
// nothing until a human clicked into the box.
//
// Solving it here fixes the export AND makes the preview exact: both painters
// receive one concrete font size instead of a promise PowerPoint never keeps.
// `fit: 'shrink'` stays on the pptx call as a residual safety net.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import type { El, LayoutWarning, TextRun, TextStyle } from '../el'
import { wrapText } from './wrap'

/** Never shrink below this fraction of the authored size — past it the slide is
 *  unreadable and the honest answer is an overflow warning, not 6pt text. */
const MIN_SCALE = 0.6
const STEP = 0.5

function fits(runs: TextRun[], w: number, h: number, style: TextStyle, fontSize: number): boolean {
  const r = wrapText(runs, w, h, { ...style, fontSize })
  if (r.overflowIn > 0) return false
  // A label that fits by height can still be broken mid-word — see maxLines.
  return style.maxLines === undefined || r.lines.length <= style.maxLines
}

/** Largest size ≤ nominal that fits, on a 0.5pt grid. Returns nominal when it
 *  already fits, and the floor when nothing does. */
export function solveAutofit(runs: TextRun[], w: number, h: number, style: TextStyle): number {
  if (fits(runs, w, h, style, style.fontSize)) return style.fontSize
  const floor = Math.max(6, style.fontSize * MIN_SCALE)
  for (let size = style.fontSize - STEP; size >= floor; size -= STEP) {
    if (fits(runs, w, h, style, size)) return Math.round(size * 2) / 2
  }
  return Math.round(floor * 2) / 2
}

/**
 * Bake autofit into a display list.
 *
 * Runs once per slide in buildDeck, so every consumer (pptx painter, SVG
 * preview, snapshot oracle) sees the same concrete sizes.
 */
export function applyAutofit(els: El[]): { els: El[]; warnings: LayoutWarning[] } {
  const warnings: LayoutWarning[] = []
  const out = els.map((el) => {
    if (el.type !== 'text' || el.style.fit !== 'shrink') return el

    const solved = solveAutofit(el.runs, el.rect.w, el.rect.h, el.style)
    if (solved === el.style.fontSize) return el

    const label = el.runs[0]?.text.slice(0, 24) ?? 'text'
    const still = wrapText(el.runs, el.rect.w, el.rect.h, { ...el.style, fontSize: solved })
    if (still.overflowIn > 0) {
      // Hit the readability floor — say so instead of shrinking into illegibility.
      warnings.push({ code: 'overflow', what: `"${label}…"`, overBy: still.overflowIn })
    } else {
      // A maxLines miss that still fits the box loses no content, so it stays a
      // `shrunk` (lossless) note rather than becoming a new failure code.
      warnings.push({ code: 'shrunk', what: `"${label}…"`, from: el.style.fontSize, to: solved })
    }
    return { ...el, style: { ...el.style, fontSize: solved } }
  })
  return { els: out, warnings }
}
