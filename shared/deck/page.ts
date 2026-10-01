// Deck page geometry. Inches, matching pptxgenjs LAYOUT_WIDE (13.33 x 7.5in).
//
// PURITY: everything under shared/deck/ runs in BOTH the electron main process
// and the browser renderer. No node/electron/pptxgenjs/react imports, no Intl
// or toLocaleString (Node and Chromium can carry different ICU data, which
// would make the export disagree with the preview), and nothing
// nondeterministic (Date.now/Math.random) — layout must be a pure function of
// (spec, theme, style, index) or the snapshot oracle is worthless.

export const PAGE_W = 13.33
export const PAGE_H = 7.5

/** Title band: slide headers sit here. */
export const HEADER_Y = 0.35
export const HEADER_H = 0.8
/** First y a content block may use when the slide has a header. */
export const CONTENT_TOP = 1.4

/** Bottom strip kept clear for the page-number badge. */
export const BADGE_RESERVE = 0.6
export const BADGE_W = 0.55
export const BADGE_H = 0.3

/** PowerPoint's default text-box insets (pptxgenjs only writes them when
 *  `margin` is passed, so these are what actually applies). */
export const TEXT_INSET_X = 0.1
export const TEXT_INSET_Y = 0.05

export type Rect = { x: number; y: number; w: number; h: number }

export function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 }
}
