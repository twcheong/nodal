// Deterministic text metrics.
//
// WHY A TABLE AND NOT canvas.measureText: layout decisions (line breaking,
// autofit) must produce the SAME answer in the electron exporter and in the
// browser preview. Canvas metrics only exist in one of those, so using them for
// layout would reintroduce exactly the drift the shared core exists to prevent.
// Canvas is allowed only in a dev-time calibration harness that reports drift.
//
// Accuracy, measured against canvas.measureText over the real font stacks
// (see the calibration note below): mean |error| 1.5%, max 3.3% at sentence
// length across all seven theme fonts, Korean and English. Every error is
// POSITIVE — we slightly over-estimate, so we wrap a touch earlier than the
// real font does and never under-report overflow. Kerning, ligatures and
// per-font side bearings are still ignored; for text landing within a few
// percent of a box edge the core reports overflow rather than pretending.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

/** Font families collapse into four metric classes. */
export type FontKey = 'sans' | 'serif' | 'mono' | 'display'

export function fontKeyOf(fontFace: string): FontKey {
  const f = fontFace.toLowerCase()
  if (f.includes('consolas') || f.includes('mono') || f.includes('menlo')) return 'mono'
  if (f.includes('georgia') || f.includes('cambria') || f.includes('caladea') || f.includes('serif') || f.includes('times') || f.includes('palatino') || f.includes('garamond')) return 'serif'
  if (f.includes('black') || f.includes('impact')) return 'display'
  return 'sans'
}

// Calibrated against canvas.measureText for the real font stacks
// (tmp/calib.html harness, macOS). Sentence-level error after calibration:
// Korean −0.4%, English +0.4% for the sans stack, against ±10% before.
// Re-run the harness if the theme font stacks change.

/** Per-class width multipliers for Latin. Applied to Latin only — CJK glyphs
 *  come from the system fallback face regardless of the requested family. */
const CLASS_SCALE: Record<FontKey, number> = { sans: 1, serif: 1.03, mono: 1, display: 1.25 }

/** Bold widens Latin, and by very different amounts per family (Georgia's bold
 *  is much heavier than Trebuchet's; Arial Black and Consolas do not widen). */
const BOLD_SCALE: Record<FontKey, number> = { sans: 1.06, serif: 1.16, mono: 1, display: 1 }

const NARROW = new Set("iljtfrI'\".,;:|!()[]{}`-".split(''))
const WIDE = new Set(['m', 'w', 'M', 'W'])

export function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (
    (c >= 0xac00 && c <= 0xd7a3) ||  // Hangul syllables
    (c >= 0x1100 && c <= 0x11ff) ||  // Hangul jamo
    (c >= 0x3130 && c <= 0x318f) ||  // Hangul compatibility jamo
    (c >= 0x3040 && c <= 0x30ff) ||  // Hiragana + Katakana
    (c >= 0x3000 && c <= 0x303f) ||  // CJK punctuation
    (c >= 0x4e00 && c <= 0x9fff) ||  // CJK unified ideographs
    (c >= 0xf900 && c <= 0xfaff) ||  // CJK compatibility ideographs
    (c >= 0xff00 && c <= 0xffef)     // Halfwidth/fullwidth forms
  )
}

/** CJK/Hangul comes from the system fallback face, not the requested family,
 *  so it takes neither the family scale nor the bold widening — but a serif
 *  stack falls back to a serif Korean face, which is measurably wider. */
const CJK_EM: Record<FontKey, number> = { sans: 0.88, serif: 1.0, mono: 0.88, display: 0.88 }

/** Advance width of one character, in em. */
export function advanceEm(ch: string, f: FontKey, bold: boolean): number {
  if (isCjk(ch)) return CJK_EM[f]

  let em: number
  if (ch === '\t') em = 1.0
  else if (f === 'mono') em = 0.602
  else if (ch === ' ') em = 0.29
  else if (NARROW.has(ch)) em = 0.355
  else if (WIDE.has(ch)) em = /[A-Z]/.test(ch) ? 0.9 : 0.79
  else if (/[0-9]/.test(ch)) em = 0.53
  else if (/[A-Z]/.test(ch)) em = 0.6
  else em = 0.52

  return em * CLASS_SCALE[f] * (bold ? BOLD_SCALE[f] : 1)
}

/** Width of a string in inches at the given point size. */
export function widthIn(text: string, fontSizePt: number, f: FontKey, bold = false): number {
  let em = 0
  for (const ch of text) em += advanceEm(ch, f, bold)
  return (em * fontSizePt) / 72
}

/** Line box height in inches. 1.2 is PowerPoint's single-spacing for text boxes. */
export const LINE_HEIGHT = 1.2

export function lineHeightIn(fontSizePt: number): number {
  return (fontSizePt * LINE_HEIGHT) / 72
}

/** Approximate ascent, used to place the first baseline. */
export function ascentIn(fontSizePt: number): number {
  return (fontSizePt * 0.8) / 72
}
