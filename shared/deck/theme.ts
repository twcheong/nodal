// Deck themes (palette + font pairing) and style recipes (shape + whitespace).
// The two axes are orthogonal: a theme carries a default style, payload.style
// overrides it.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import type { WritePptxPayload } from './spec'
import { parseHex, rgbToHsl, hsl, pickReadable, ensureContrast } from './color'

export type Hex = string // 'RRGGBB', uppercase, no '#'

// ── Style recipes (MiniMax design-system, scaled to the 13.33x7.5 canvas) ────
export type StyleRecipe = {
  radiusSm: number
  radiusMd: number
  radiusLg: number
  badgeRadius: number
  margin: number
  gap: number
  pad: number
  /**
   * Page-number treatment. Every deck used the same grey pill, which made the
   * one element that appears on EVERY slide the least varied thing in the
   * system. It rides the style axis rather than a new payload field, so it
   * varies with the deck's personality and stays deterministic.
   *
   *   plain — bare numeral, no container (editorial)
   *   pill  — soft filled pill (the historical look)
   *   dot   — filled accent circle, number knocked out
   *   frame — outlined pill, transparent inside
   */
  badge: 'plain' | 'pill' | 'dot' | 'frame'
}

export const PPTX_STYLES: Record<string, StyleRecipe> = {
  sharp:   { radiusSm: 0,    radiusMd: 0.03, radiusLg: 0.05, badgeRadius: 0.02, margin: 0.45, gap: 0.25, pad: 0.2,  badge: 'plain' },
  soft:    { radiusSm: 0.05, radiusMd: 0.08, radiusLg: 0.12, badgeRadius: 0.05, margin: 0.55, gap: 0.35, pad: 0.25, badge: 'pill' },
  rounded: { radiusSm: 0.1,  radiusMd: 0.15, radiusLg: 0.25, badgeRadius: 0.08, margin: 0.65, gap: 0.45, pad: 0.32, badge: 'dot' },
  pill:    { radiusSm: 0.2,  radiusMd: 0.3,  radiusLg: 0.4,  badgeRadius: 0.15, margin: 0.75, gap: 0.55, pad: 0.38, badge: 'frame' },
}

export type StyleName = keyof typeof PPTX_STYLES

// ── Themes ───────────────────────────────────────────────────────────────────
export type Theme = {
  /** darkest — titles (light themes), cover background */
  primary: Hex
  /** dark accent — section numbers, secondary emphasis */
  secondary: Hex
  /** highlight — stats values, timeline dots, chart series 1; title color on dark themes */
  accent: Hex
  /** light fill — table headers, badges, cards (a dark surface on dark themes) */
  light: Hex
  /** slide background */
  bg: Hex
  /** main body text */
  ink: Hex
  /** secondary text */
  muted: Hex
  /** hairline borders */
  line: Hex
  headFont: string
  bodyFont: string
  /** style recipe used when payload.style is absent */
  styleDefault: StyleName
  dark?: boolean
  /** full chart run override (e.g. the 'charts' palette) */
  chartColors?: Hex[]
  /** Secondary accent for two-tone decoration (cover deco, funnel bands).
   *  Optional: roles fall back to `secondary`, so presets without one keep
   *  rendering byte-identically. */
  accent2?: Hex
  /**
   * Optional overrides the role layer reads instead of its dark/light branch.
   * Set ONLY by deriveTheme — the named presets leave them undefined, which is
   * what keeps the snapshot baseline untouched by brand derivation.
   */
  onAccent?: Hex
  onLight?: Hex
}

type ThemeSeed = Partial<Theme> & Pick<Theme, 'primary' | 'secondary' | 'accent' | 'light' | 'bg' | 'headFont' | 'bodyFont' | 'styleDefault'>

function makeTheme(seed: ThemeSeed): Theme {
  return { ink: '1A1A1A', muted: '666666', line: 'E3E3E3', ...seed }
}

export const PPTX_THEMES = {
  twixy:  makeTheme({ primary: '4638B3', secondary: '6A5AE0', accent: '7C6AFF', accent2: 'FF7A9E', light: 'F0EEFF', bg: 'FDFCFF', headFont: 'Trebuchet MS', bodyFont: 'Calibri', styleDefault: 'soft' }),
  petrol: makeTheme({ primary: '0F4C5C', secondary: '156775', accent: '2A9D8F', accent2: 'E9C46A', light: 'E0F0EF', bg: 'FAF8F5', headFont: 'Georgia', bodyFont: 'Calibri', styleDefault: 'soft' }),
  navy:   makeTheme({ primary: '0B2545', secondary: '13315C', accent: 'B8860B', accent2: 'A63D57', light: 'EEF2F7', bg: 'FBFBF9', headFont: 'Cambria', bodyFont: 'Calibri', styleDefault: 'sharp' }),
  vivid:  makeTheme({ primary: '1D3557', secondary: '0070F3', accent: 'FF6B35', accent2: '00C2A8', light: 'E8F1FE', bg: 'FFFFFF', headFont: 'Arial Black', bodyFont: 'Arial', styleDefault: 'rounded' }),
  earth:  makeTheme({ primary: '3A5A40', secondary: '588157', accent: 'BC6C25', accent2: '7A9E7E', light: 'EDEFE6', bg: 'FBFAF6', headFont: 'Georgia', bodyFont: 'Calibri', styleDefault: 'soft' }),
  // MiniMax "Education & Charts" — chart-optimized 5-color run
  charts: makeTheme({ primary: '264653', secondary: '2A9D8F', accent: 'E76F51', accent2: 'E9C46A', light: 'F5EDD8', bg: 'FCFBF7', headFont: 'Calibri', bodyFont: 'Calibri Light', styleDefault: 'sharp',
                      chartColors: ['2A9D8F', 'E9C46A', 'F4A261', 'E76F51', '264653'] }),
  // Palette supplied by the user (0A0A0C / 1F2A24 / 3E5A4C / D4AF37 / F2F6F3).
  // headFont was Consolas — a fixed-width CODE face. It set the whole deck in
  // a terminal voice and read badly next to Korean, which is what made the
  // dark deck look cheap. Cambria is the serif the light themes already use.
  night:  makeTheme({ primary: '1F2A24', secondary: '3E5A4C', accent: 'D4AF37', accent2: '3E5A4C', light: '1F2A24', bg: '0A0A0C', ink: 'F2F6F3', muted: '9FB0A8', line: '2C3B34', headFont: 'Cambria', bodyFont: 'Calibri', styleDefault: 'sharp', dark: true }),
  // Three palettes taken from the curated set in the deck conventions we
  // follow, chosen for the domains our seven did not reach: warm/artisan,
  // hospitality/beauty, and a neutral that carries a client's own brand
  // without arguing with it. Same makeTheme contrast pipeline as the rest.
  terra:  makeTheme({ primary: '5C2B21', secondary: '7C3A2D', accent: 'B85042', accent2: 'A7BEAE', light: 'EFE7DC', bg: 'FBF7F2', headFont: 'Bookman Old Style', bodyFont: 'Calibri', styleDefault: 'soft' }),
  berry:  makeTheme({ primary: '4A1F31', secondary: '6D2E46', accent: 'A26769', accent2: 'D5A021', light: 'F2E7DA', bg: 'FDFAF5', headFont: 'Georgia', bodyFont: 'Calibri', styleDefault: 'rounded' }),
  slate:  makeTheme({ primary: '25303A', secondary: '36454F', accent: '5E8C8A', accent2: 'C9A227', light: 'EDEFF1', bg: 'FCFCFC', headFont: 'Century Schoolbook', bodyFont: 'Calibri', styleDefault: 'sharp' }),
} satisfies Record<string, Theme>

export type ThemeName = keyof typeof PPTX_THEMES

export const WHITE: Hex = 'FFFFFF'

export function normalizeColor(c: string): Hex {
  return c.replace(/^#/, '').toUpperCase()
}

/**
 * Derive a full palette from one brand hex, inheriting everything a hex cannot
 * express (fonts, style, light/dark) from `base`.
 *
 * Dark is opt-in, NEVER inferred from the brand's luminance: the navy preset's
 * primary (0B2545) is nearly black yet produces a light deck — inferring
 * darkness would flip every navy-branded client to a black deck. `theme:
 * 'night'` + `brand` is the way to a dark branded deck, and it composes
 * because base.dark is inherited.
 */
export function deriveTheme(brandHex: string, base: Theme): Theme {
  const { h, s, l } = rgbToHsl(parseHex(brandHex))
  const dark = base.dark === true
  // A pale or near-black brand cannot be the cover background as authored.
  const pl = Math.min(0.52, Math.max(0.15, l))
  const primary = hsl(h, Math.max(s, 0.3), pl)
  const secondary = hsl(h, Math.max(s, 0.28) * 0.92, Math.min(0.68, pl + 0.1))
  // A desaturated brand has no highlight to shift — take the complement.
  const accentH = s < 0.25 ? (h + 150) % 360 : (h + 18) % 360
  const accent = hsl(accentH, Math.max(s, 0.62), dark ? 0.62 : 0.56)
  const light = dark ? hsl(h, s * 0.3, 0.22) : hsl(h, s * 0.35, 0.94)
  const bg = dark ? hsl(h, s * 0.3, 0.06) : hsl(h, s * 0.1, 0.985)
  const ink = dark ? hsl(h, s * 0.12, 0.95) : '1A1A1A'
  const line = dark ? hsl(h, s * 0.16, 0.28) : hsl(h, s * 0.1, 0.9)
  const muted = ensureContrast(hsl(h, s * 0.1, dark ? 0.68 : 0.42), bg, 4.5)

  // Five hues 32° apart with alternating lightness — distinguishable at a
  // glance, never colliding with bg, deterministic.
  const ls = dark ? [0.62, 0.72, 0.54, 0.68, 0.48] : [0.52, 0.62, 0.44, 0.58, 0.38]
  const chartColors = ls.map((cl, i) => hsl((accentH + i * 32) % 360, Math.max(s, 0.55), cl))

  // When no text candidate reaches 4.5:1 on the accent, the accent itself
  // moves — a fill can shift lightness, the text colours cannot.
  let onAccent = pickReadable(accent, [WHITE, ink, bg])
  const safeAccent = ensureContrast(accent, onAccent, 4.5)
  onAccent = pickReadable(safeAccent, [WHITE, ink, bg])

  return {
    ...base,   // fonts, styleDefault, dark — NOT derivable from a hex
    primary, secondary, accent: safeAccent, light, bg, ink, muted, line, chartColors,
    accent2: hsl((accentH + 320) % 360, Math.max(s, 0.5), dark ? 0.55 : 0.5),
    onAccent,
    onLight: pickReadable(light, [primary, ink]),
  }
}

// Unknown names are a hard error, never a silent fallback: a stale theme name
// used to render as plain Twixy purple, which reads as "the old design" and is
// invisible to whoever authored the payload.
//
// Composition, in one line the prompts copy: `theme` picks the STRUCTURE
// (fonts, style, light/dark), `brand` re-skins its palette, `accent` is a
// single-colour legacy override applied last. All three compose; none is
// required.
export function resolveTheme(payload: WritePptxPayload): Theme {
  const name = (payload.theme ?? 'twixy').toLowerCase().trim()
  const base = (PPTX_THEMES as Record<string, Theme>)[name]
  if (!base) throw new Error(`Unknown theme '${payload.theme}'. Valid themes: ${Object.keys(PPTX_THEMES).join(' | ')}.`)
  const t = payload.brand ? deriveTheme(payload.brand, base) : base
  if (!payload.accent) return t
  const accent = normalizeColor(payload.accent)
  // Legacy override applied last. When the theme was DERIVED, the baked
  // on-accent text colour was computed for the old accent and would be stale.
  return { ...t, accent, ...(payload.brand ? { onAccent: pickReadable(accent, [WHITE, t.ink, t.bg]) } : {}) }
}

export function resolveStyle(payload: WritePptxPayload, t: Theme): StyleRecipe {
  const name = (payload.style ?? t.styleDefault).toLowerCase().trim()
  const recipe = PPTX_STYLES[name]
  if (!recipe) throw new Error(`Unknown style '${payload.style}'. Valid styles: ${Object.keys(PPTX_STYLES).join(' | ')}.`)
  return recipe
}

/** Header/title text color: primary on light themes, accent on dark ones. */
export function titleColor(t: Theme): Hex {
  return t.dark ? t.accent : t.primary
}

/**
 * Semantic colour roles, resolved once per deck.
 *
 * Painters should read ONLY from here, never branch on `t.dark` themselves —
 * that branch used to be duplicated across 13 renderers and is the documented
 * top hazard when adding a new one.
 */
export type Roles = {
  /** slide/section titles */
  title: Hex
  /** text sitting on a `light` fill (cards, table headers, badges) */
  onLight: Hex
  /** text sitting on an `accent` fill (timeline dots, step numbers) */
  onAccent: Hex
  /** body copy */
  body: Hex
  /** captions, sublabels, axis labels */
  muted: Hex
  /** hairlines, dividers, connectors */
  hairline: Hex
  /** card / chip fill */
  cardFill: Hex
  /** transparency (0-100) for the oversized ghost numerals */
  ghostAlpha: number
  /** transparency for decorative quote marks */
  quoteAlpha: number
  /** chart series run */
  chartRun: Hex[]
  /** two-tone decoration partner of `accent` */
  accent2: Hex
  /** subtitle/meta text ON the primary cover ground. On light themes this is
   *  t.light (the original look, baseline-frozen); on dark themes t.light is a
   *  SURFACE colour and unreadable — pick the best-contrast text instead.
   *  This was a live bug: night covers shipped with invisible subtitles. */
  onPrimary: Hex
  /** funnel band colour run — on dark themes `secondary` sits below bg and
   *  vanishes, so the run swaps it for the light surface */
  funnelRun: Hex[]
}

export function resolveRoles(t: Theme): Roles {
  return {
    title: titleColor(t),
    // Derived themes carry contrast-checked overrides; presets leave them
    // undefined so their output stays byte-identical (baseline unmoved).
    onLight: t.onLight ?? (t.dark ? t.ink : t.primary),
    onAccent: t.onAccent ?? (t.dark ? t.bg : WHITE),
    body: t.ink,
    muted: t.muted,
    hairline: t.dark ? t.line : t.light,
    cardFill: t.light,
    ghostAlpha: t.dark ? 78 : 88,
    quoteAlpha: t.dark ? 40 : 70,
    chartRun: t.chartColors ?? [t.accent, t.dark ? t.ink : t.primary, t.secondary, 'A0A0A0', 'D0D0D0'],
    accent2: t.accent2 ?? t.secondary,
    onPrimary: t.dark ? pickReadable(t.primary, [t.ink, WHITE, t.muted]) : t.light,
    funnelRun: t.dark
      ? [t.accent, t.accent2 ?? t.secondary, t.light]
      : [t.accent, t.accent2 ?? t.secondary, t.secondary],
  }
}
