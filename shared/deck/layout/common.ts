// Layout context + the elements every slide shares.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.
// Colour rule: painters read ONLY from `c.r` (Roles) — never branch on
// `t.dark` yourself, that duplication is what made new renderers forget dark
// mode. Raw theme colours (`c.t.accent` etc.) are fine when the role layer has
// no opinion (brand fills), but text colour always comes from a role.

import { PAGE_W, PAGE_H, HEADER_Y, HEADER_H, CONTENT_TOP, BADGE_RESERVE } from '../page'
import type { El, TextShape } from '../el'
import type { Roles, StyleRecipe, Theme } from '../theme'

export type LayoutCtx = {
  t: Theme
  s: StyleRecipe
  r: Roles
  /** page width minus both margins */
  contentW: number
  /**
   * Intrinsic width/height of a picture, when the host knows it.
   *
   * The layout core cannot open a file, but it CANNOT lay a photo out well
   * without its shape either: a 1.43:1 photo dropped into a 0.70:1 cell draws
   * at 49% of the cell and the rest is dead space — measured, on our own
   * gallery. So the host measures (main: sharp; renderer: the decoded image)
   * and passes numbers in, exactly like the pixels themselves (ImageSrc).
   *
   * undefined = not known yet (still loading) or not supplied (scripts). Every
   * painter must keep working without it — that is what keeps the snapshot
   * oracle, which supplies nothing, meaningful.
   */
  aspect: (path: string) => number | undefined
}

export function makeCtx(t: Theme, s: StyleRecipe, r: Roles, aspects?: Record<string, number>): LayoutCtx {
  return {
    t, s, r,
    contentW: PAGE_W - s.margin * 2,
    aspect: (path) => {
      const a = aspects?.[path]
      return typeof a === 'number' && Number.isFinite(a) && a > 0 ? a : undefined
    },
  }
}

/**
 * Slide title band. Returns nothing when the slide has no title.
 *
 * 36pt, not the 28pt this shipped with. Size CONTRAST is what makes a title
 * read as a title: against 14-16pt body, 28pt is 1.9× and reads as "slightly
 * bigger text", while the deck conventions we benchmark against call for
 * 36-44pt (≥2.4×) and warn explicitly not to skimp on it. Autofit still
 * shrinks a long title to fit the band, so this raises the ceiling without
 * risking overflow.
 */
export function headerEl(title: string | undefined, c: LayoutCtx): El[] {
  if (!title) return []
  return [{
    type: 'text',
    rect: { x: c.s.margin, y: HEADER_Y, w: c.contentW, h: HEADER_H },
    runs: [{ text: title }],
    style: { fontSize: 36, bold: true, color: c.r.title, fontFace: c.t.headFont, fit: 'shrink' },
  }]
}

/**
 * Page number, bottom right. Every slide except the cover.
 *
 * Four treatments, picked by the style recipe (see StyleRecipe.badge) — this
 * mark lands on every page of every deck, so a single hardcoded grey pill was
 * the most-repeated element we shipped.
 */
export function badgeEl(pageNum: number, c: LayoutCtx): El[] {
  const rect = { x: PAGE_W - 0.95, y: PAGE_H - 0.52, w: 0.55, h: 0.3 }
  const text = (color: string, shape?: TextShape): El => ({
    type: 'text', rect, runs: [{ text: String(pageNum) }],
    style: { fontSize: 10, bold: true, color, fontFace: c.t.bodyFont, align: 'center', valign: 'middle' },
    ...(shape ? { shape } : {}),
  })

  switch (c.s.badge) {
    case 'plain':
      return [text(c.r.muted)]
    case 'dot': {
      const d = 0.3
      return [
        { type: 'ellipse', rect: { x: rect.x + (rect.w - d) / 2, y: rect.y, w: d, h: d }, fill: { color: c.t.accent } },
        text(c.r.onAccent),
      ]
    }
    case 'frame':
      return [
        { type: 'roundRect', rect, radius: rect.h / 2, fill: { color: c.t.accent, transparency: 100 }, stroke: { color: c.r.hairline, pt: 0.75 } },
        text(c.r.muted),
      ]
    case 'pill':
    default:
      return [text(c.r.onLight, { kind: 'roundRect', radius: c.s.badgeRadius, fill: { color: c.r.cardFill } })]
  }
}

/**
 * The vertical band a content painter owns: below the header, above the badge.
 *
 * grid.ts (the `layout` kind) has always computed exactly this and filled it,
 * which is why `layout` slides reached the bottom of the page while every
 * fixed kind invented its own start (1.45 / 1.5 / 1.55 / 1.6) and height
 * (5.3 / 5.4 / 5.5) and stopped early. Measured on a real deck: content ended
 * at 4.17" on a 7.5" page, 1.94" of dead space per slide on average against
 * 0.12" for the deck we were benchmarking against. One band, one definition.
 */
export function contentBand(hasTitle: boolean, c: LayoutCtx): { y: number; h: number; bottom: number } {
  const y = hasTitle ? CONTENT_TOP : c.s.margin
  const bottom = PAGE_H - BADGE_RESERVE
  return { y, h: bottom - y, bottom }
}

/**
 * Lay `n` rows into a band: rows grow toward `max`, and leftover slack is split
 * evenly above and below so the stack sits BALANCED rather than clinging to the
 * header with a void underneath.
 *
 * The old form — `Math.min(0.9, 5.5 / n)` — capped the row height but kept the
 * top fixed, so few items meant the page emptied downward: three bullets used
 * 2.7" of a 5.5" band and left 2.8" of nothing. Same cap, different anchor.
 */
export function rowBand(n: number, b: { y: number; h: number }, max: number): { y0: number; rowH: number } {
  if (n <= 0) return { y0: b.y, rowH: 0 }
  const rowH = Math.min(max, b.h / n)
  return { y0: b.y + (b.h - rowH * n) / 2, rowH }
}

/** '3' → '03'; multi-digit and roman numerals pass through. */
export function padNum(n: number | string): string {
  const str = String(n)
  return /^\d$/.test(str) ? `0${str}` : str
}
