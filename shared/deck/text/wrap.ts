// Line breaking for the preview painter (and, from Phase D, for autofit).
//
// Korean is a first-class requirement, not a nicety: a space-only wrapper does
// not wrap Korean body text AT ALL, so every Korean paragraph would run off the
// slide in the preview. CJK/Hangul therefore breaks between characters, with
// minimal kinsoku so a line never starts with closing punctuation.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import { TEXT_INSET_X, TEXT_INSET_Y } from '../page'
import type { TextRun, TextStyle } from '../el'
import { fontKeyOf, isCjk, lineHeightIn, widthIn, type FontKey } from './metrics'

/** Hanging indent pptxgenjs applies to bulleted paragraphs (27pt). */
export const BULLET_INDENT = 27 / 72

/** A line may not START with these. */
const NO_LINE_START = new Set('.,;:!?)]}”’」』〉》%·'.split(''))
/** A line may not END with these. */
const NO_LINE_END = new Set('([{“‘「『〈《'.split(''))

export type WrappedLine = {
  text: string
  /** paragraph index this line came from (bullets/paraSpaceAfter are per-paragraph) */
  para: number
  /** true for the first line of its paragraph — where a bullet glyph goes */
  first: boolean
  indentIn: number
  widthIn: number
}

export type WrapResult = {
  lines: WrappedLine[]
  /** total height of the wrapped block, inches */
  blockH: number
  /** how far the block exceeds the box, inches (0 when it fits) */
  overflowIn: number
}

/** Greedy break-opportunity scan. Returns indices AFTER which a break is legal. */
function breakPoints(text: string): number[] {
  const chars = [...text]
  const pts: number[] = []
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i]
    const b = chars[i + 1]
    if (a === ' ') { pts.push(i); continue }
    if (a === '-' || a === '/') { pts.push(i); continue }
    // Between two CJK chars, or at a CJK↔Latin boundary.
    if (isCjk(a) || isCjk(b)) {
      if (NO_LINE_END.has(a) || NO_LINE_START.has(b)) continue
      pts.push(i)
    }
  }
  return pts
}

function wrapParagraph(text: string, maxW: number, fontSize: number, f: FontKey, bold: boolean): string[] {
  if (!text) return ['']
  const chars = [...text]
  const legal = new Set(breakPoints(text))
  const out: string[] = []

  let start = 0
  let lastLegal = -1
  let w = 0

  for (let i = 0; i < chars.length; i++) {
    w += widthIn(chars[i], fontSize, f, bold)
    if (legal.has(i)) lastLegal = i

    if (w > maxW && i > start) {
      // Break after the last legal point; if there is none (one long token),
      // break right here rather than letting it run off the slide.
      const cut = lastLegal >= start ? lastLegal : i - 1
      out.push(chars.slice(start, cut + 1).join('').replace(/\s+$/, ''))
      start = cut + 1
      // Leading spaces on the next line are dropped, like PowerPoint does.
      while (start < chars.length && chars[start] === ' ') start++
      lastLegal = -1
      w = 0
      for (let j = start; j <= i; j++) w += widthIn(chars[j], fontSize, f, bold)
    }
  }
  out.push(chars.slice(start).join(''))
  return out.length ? out : ['']
}

/**
 * Wrap runs into lines for a box.
 *
 * The pptx exporter does NOT use this — PowerPoint wraps natively. It exists so
 * the SVG preview breaks lines the same way PowerPoint will, and so the core
 * can detect (and report) overflow instead of silently producing a broken slide.
 */
export function wrapText(runs: TextRun[], boxW: number, boxH: number, style: TextStyle): WrapResult {
  const f = fontKeyOf(style.fontFace)
  const bold = !!style.bold
  const lh = lineHeightIn(style.fontSize)
  const lines: WrappedLine[] = []
  let blockH = 0

  runs.forEach((run, para) => {
    const indent = run.bullet ? BULLET_INDENT : 0
    const avail = boxW - TEXT_INSET_X * 2 - indent
    const parts = wrapParagraph(run.text, Math.max(avail, 0.2), style.fontSize, f, bold)
    parts.forEach((text, i) => {
      lines.push({ text, para, first: i === 0, indentIn: indent, widthIn: widthIn(text, style.fontSize, f, bold) })
      blockH += lh
    })
    if (run.paraSpaceAfter) blockH += run.paraSpaceAfter / 72
  })

  const usableH = boxH - TEXT_INSET_Y * 2
  return { lines, blockH, overflowIn: Math.max(0, blockH - usableH) }
}

/** y of the first line's TOP edge, honouring vertical alignment. */
export function firstLineTop(boxY: number, boxH: number, blockH: number, valign: TextStyle['valign']): number {
  if (valign === 'middle') return boxY + (boxH - blockH) / 2
  if (valign === 'bottom') return boxY + boxH - blockH - TEXT_INSET_Y
  return boxY + TEXT_INSET_Y
}
