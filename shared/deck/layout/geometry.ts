// Geometry checks over the finished display list.
//
// The deck conventions we follow ask a human (or a vision model) to look for
// overlapping elements, text running off the slide, and content crowding the
// page edge. They have to LOOK because they generate free code and have no
// model of the result. We do: `El[]` carries every rect in inches, so those
// same questions are arithmetic — deterministic, free, and available on every
// build instead of once per deck.
//
// Our own visual-QA sheet renders a slide at 290x163px, where 15pt text is
// 4.5px tall; it cannot resolve these defects even in principle. Geometry
// belongs in code, and the sheet is left to judge what code cannot — colour
// impression, semantic awkwardness, whether the page reads.
//
// PRECISION OVER RECALL. Every check here fires only on things that are
// defects in all cases: two opaque TEXT boxes on top of each other, ink past
// the page edge, content inside the edge gutter. Deliberate overlaps the
// design relies on (text on its own card, the ghost numeral behind the solid
// one, corner decoration bleeding off-canvas) must never be reported, or the
// notes become noise the model learns to skip.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import { PAGE_W, PAGE_H, type Rect } from '../page'
import type { El } from '../el'
import { wrapText, firstLineTop } from '../text/wrap'

/** Hairline tolerance. Painters butt boxes against each other by design, and a
 *  0.02" kiss is not an overlap — only a real collision should be reported. */
const EPS = 0.06

/** Content must stay this far from the page edge (the badge lives outside it). */
const EDGE = 0.3

function overlap(a: Rect, b: Rect): number {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return dx > EPS && dy > EPS ? Math.min(dx, dy) : 0
}

/**
 * Where the GLYPHS actually land, not where the box is.
 *
 * A centered label in a wide box has its box against the page edge while the
 * ink sits inches inside it — checking boxes reported those as violations and
 * would have taught the model to "fix" correct slides. The wrapper already
 * knows the line widths and the block height, so the ink rect is exact.
 *
 * An element that carries its OWN shape (a chip, a numbered circle) is the
 * exception: the shape is painted at the full rect and is every bit as visible
 * as the glyph, so its footprint is the box. Missing that hid a real collision
 * — the "VS" chip sitting on top of the right column's title.
 */
function inkRect(el: Extract<El, { type: 'text' }>): Rect {
  const { rect, style } = el
  if (el.shape) return rect
  const { lines, blockH } = wrapText(el.runs, rect.w, rect.h, style)
  const widest = lines.reduce((n, l) => Math.max(n, l.widthIn + l.indentIn), 0)
  const w = Math.min(widest, rect.w)
  const x =
    style.align === 'center' ? rect.x + (rect.w - w) / 2
    : style.align === 'right' ? rect.x + rect.w - w
    : rect.x
  const y = firstLineTop(rect.y, rect.h, blockH, style.valign)
  // NOT clamped to rect.h: text that outgrows its box is exactly the case that
  // collides with the row beneath it, and clamping hid every one of them. A kv
  // block shipped three lines inside a 0.36" row and ploughed through its
  // neighbour while this check reported the slide clean.
  return { x, y, w, h: blockH }
}

/** First few words, for a note the author can locate on the slide. */
function label(el: Extract<El, { type: 'text' }>): string {
  const t = el.runs.map((r) => r.text).join(' ').trim()
  return t.length > 22 ? `${t.slice(0, 22)}…` : t || '(empty)'
}

/**
 * Opaque text boxes only.
 *
 * Ghost type (the oversized section numeral, watermarks) is painted with
 * `transparency` precisely so other text can sit on top of it — reporting that
 * pair would be reporting the design.
 */
function opaqueText(els: El[]): Extract<El, { type: 'text' }>[] {
  return els.filter(
    (el): el is Extract<El, { type: 'text' }> =>
      el.type === 'text' && (el.style.transparency ?? 0) < 20 && el.runs.some((r) => r.text.trim()),
  )
}

/** Structural notes for one slide. Empty when the geometry is clean. */
export function geometryNotes(els: El[]): string[] {
  const notes: string[] = []

  // ── 1. text over text ──────────────────────────────────────────────────────
  const texts = opaqueText(els).map((el) => ({ el, ink: inkRect(el) }))
  for (let i = 0; i < texts.length && notes.length < 3; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const by = overlap(texts[i].ink, texts[j].ink)
      if (!by) continue
      notes.push(`"${label(texts[i].el)}" and "${label(texts[j].el)}" overlap by ${by.toFixed(2)}in — shorten one or move it`)
      break
    }
  }

  // ── 2. ink past the page edge ──────────────────────────────────────────────
  // Text only: decoration is allowed (and designed) to bleed off-canvas.
  for (const { el, ink } of texts) {
    if (ink.x < -EPS || ink.y < -EPS || ink.x + ink.w > PAGE_W + EPS || ink.y + ink.h > PAGE_H + EPS) {
      notes.push(`"${label(el)}" runs off the slide — its text is outside the ${PAGE_W}x${PAGE_H}in page`)
      break
    }
  }

  // ── 3. the edge gutter ─────────────────────────────────────────────────────
  for (const { el, ink } of texts) {
    const gap = Math.min(ink.x, ink.y, PAGE_W - (ink.x + ink.w), PAGE_H - (ink.y + ink.h))
    if (gap < -EPS) continue          // already reported by check 2
    if (gap < EDGE - EPS) {
      notes.push(`"${label(el)}" sits ${gap.toFixed(2)}in from the page edge — keep content ${EDGE}in clear`)
      break
    }
  }

  return notes
}
