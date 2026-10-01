// Pure colour math for theme derivation. No Intl, no locale-dependent
// formatting (toString(16) is locale-independent), nothing nondeterministic —
// see shared/deck/page.ts for the purity rules.

export type Rgb = { r: number; g: number; b: number }   // 0..255
export type Hsl = { h: number; s: number; l: number }   // deg 0..360, 0..1, 0..1

/** '#RRGGBB' or 'RRGGBB' (case-insensitive). Anything else is a hard error —
 *  a silently mis-parsed brand colour paints the whole deck wrong. */
export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) throw new Error(`Invalid hex colour '${hex}' — expected RRGGBB.`)
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function toHex(c: Rgb): string {
  const p = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return (p(c.r) + p(c.g) + p(c.b)).toUpperCase()
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) :
    max === gn ? (bn - rn) / d + 2 :
    (rn - gn) / d + 4
  return { h: h * 60, s, l }
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360 / 360
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v } }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: f(hue + 1 / 3) * 255, g: f(hue) * 255, b: f(hue - 1 / 3) * 255 }
}

/** Hex straight from HSL components. */
export function hsl(h: number, s: number, l: number): string {
  return toHex(hslToRgb({ h, s: Math.max(0, Math.min(1, s)), l: Math.max(0, Math.min(1, l)) }))
}

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  const f = (v: number) => {
    const n = v / 255
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

/** WCAG contrast ratio, 1..21. Inputs are hex strings. */
export function contrast(a: string, b: string): number {
  const la = luminance(parseHex(a)), lb = luminance(parseHex(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The best-contrasting candidate against `bg`. For text sitting on a brand
 * fill — a bright-yellow brand makes white-on-accent unreadable, and
 * hardcoding WHITE is exactly how that would ship unnoticed.
 */
export function pickReadable(bg: string, candidates: string[]): string {
  let best = candidates[0], bestC = -1
  for (const c of candidates) {
    const ratio = contrast(bg, c)
    if (ratio > bestC) { best = c; bestC = ratio }
  }
  return best
}

/**
 * Walk `fg` lightness away from `bg` in 0.02 steps until the ratio is met.
 * Bounded at 40 iterations so it is total, not merely usually-terminating.
 */
export function ensureContrast(fg: string, bg: string, min: number): string {
  let cur = rgbToHsl(parseHex(fg))
  const darkBg = luminance(parseHex(bg)) < 0.35
  for (let i = 0; i < 40; i++) {
    const hex = hsl(cur.h, cur.s, cur.l)
    if (contrast(hex, bg) >= min) return hex
    cur = { ...cur, l: Math.max(0, Math.min(1, cur.l + (darkBg ? 0.02 : -0.02))) }
  }
  return hsl(cur.h, cur.s, cur.l)
}
