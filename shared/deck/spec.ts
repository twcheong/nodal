// The deck spec — the contract between whoever authors a deck (the agent via
// tool_write_pptx, or the Content mode chat) and the renderer.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

type Base = { notes?: string }

export type ChartKind = 'bar' | 'line' | 'pie' | 'doughnut' | 'area'

/**
 * A toc entry. Plain strings stay valid (every existing deck), but an entry
 * may carry a one-line `desc` — without this the only way to author a
 * DESCRIBED agenda was the hand-built `layout` step-stack recipe, which gave
 * every deck's overview the exact same face.
 */
export type TocSection = string | { label: string; desc?: string }

export function tocEntry(s: TocSection): { label: string; desc?: string } {
  return typeof s === 'string' ? { label: s } : s
}

export type SlideSpec = Base &
  (
    | { kind: 'cover'; variant?: 'block' | 'split' | 'center'; title: string; subtitle?: string; date?: string; badge?: string; kicker?: string; chips?: string[] }
    | { kind: 'title'; title: string; subtitle?: string } // legacy alias of 'cover'
    | { kind: 'toc'; variant?: 'list' | 'sidebar' | 'cards'; title?: string; sections: TocSection[] }
    | { kind: 'section'; variant?: 'number' | 'accentBlock' | 'split'; number: number | string; title: string; intro?: string }
    | { kind: 'stats'; variant?: 'cards' | 'bare'; title?: string; items: { value: string; label: string; sublabel?: string }[] }
    | { kind: 'compare'; variant?: 'cards' | 'vs' | 'stacked'; title?: string; left: { title: string; bullets: string[] }; right: { title: string; bullets: string[] } }
    | { kind: 'quote'; text: string; attribution?: string }
    | { kind: 'timeline'; variant?: 'rail' | 'vertical' | 'bars' | 'chevron'; title?: string; steps: { label: string; desc?: string }[] }
    | {
        kind: 'chart'
        variant?: 'full' | 'split' | 'banner'
        title?: string
        chartType: ChartKind
        categories: string[]
        series: { name: string; values: number[] }[]
        takeaway?: string
        source?: string
      }
    | { kind: 'summary'; variant?: 'takeaways' | 'split' | 'thanks'; title?: string; takeaways: string[]; closing?: string; nextSteps?: string[]; contact?: string }
    | { kind: 'bullets'; variant?: 'rows' | 'cards' | 'numbered' | 'twoCol'; title?: string; bullets: string[] }
    | { kind: 'text'; variant?: 'rail' | 'panel' | 'twoCol'; title?: string; body: string }
    | { kind: 'image'; variant?: 'full' | 'bleed' | 'hero'; title?: string; imagePath: string; caption?: string }
    | { kind: 'table'; variant?: 'grid' | 'zebra' | 'kv'; title?: string; headers: string[]; rows: (string | number | null)[][] }
    /** Free composition on a 12-column grid — see layout/grid.ts. Use when no
     *  fixed kind fits, or to break up a deck that is getting repetitive. */
    | { kind: 'layout'; title?: string; blocks: LayoutBlock[] }
  )

export type LayoutBlockBody =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  /** `pct` (0-100) turns the stat into a progress ring with the value inside —
   *  use it when the number IS a share/completion ("64%", "3 of 4 done"). */
  | { type: 'stat'; value: string; label: string; sublabel?: string; pct?: number }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'chart'; chartType: ChartKind; categories: string[]; series: { name: string; values: number[] }[] }
  | { type: 'image'; imagePath: string; caption?: string }
  | { type: 'kv'; rows: { k: string; v: string }[] }
  /** Centered icon tile: icon + label (+ sublabel). Icon names come from the
   *  curated deck set (shared/deck/icons.ts) — unknown names are a hard error. */
  | { type: 'icon'; name: string; label?: string; sublabel?: string }
  /** Numbered agenda/process row: accent chip + bold title + muted desc. A
   *  stack of span-12 steps IS the dense agenda page. Give `icon` instead of
   *  `number` and the chip becomes an icon in a tinted circle — the
   *  "icon + text rows" page type. */
  | { type: 'step'; number?: number | string; icon?: string; title: string; desc?: string }
  /** Row of small outlined chips — meta badges ("internal", "44 posts analyzed"). */
  | { type: 'chips'; items: string[] }
  /** Funnel: stacked bands narrowing toward the last stage, connectors between.
   *  2–6 stages; band colours rotate accent → accent2 → secondary. */
  | { type: 'funnel'; stages: { label: string; desc?: string }[] }
  | { type: 'spacer' }

export type LayoutBlock = {
  /** 1..12 columns, default 12. Blocks flow left→right and wrap. */
  span?: number
  break?: boolean
  card?: boolean
  align?: 'top' | 'middle'
  minH?: number
  body: LayoutBlockBody
}

export type SlideKind = SlideSpec['kind']

export const SLIDE_KINDS: SlideKind[] = [
  'cover', 'title', 'toc', 'section', 'stats', 'compare', 'quote', 'timeline', 'chart', 'summary',
  'bullets', 'text', 'image', 'table', 'layout',
]

/**
 * Kinds the painters still render but the PROMPTS no longer teach.
 *
 * A kind the model never sees is a kind it cannot emit — which is the only
 * thing that actually stopped divider pages. Softer measures did not: the
 * prompt said "no dividers", then "only past 14 slides", and a 17-slide deck
 * still shipped five bare "01" pages. Decks already saved with these kinds
 * keep rendering, and the importer keeps reading them.
 *
 * `title` is the legacy alias of `cover`; `section` is the divider page.
 */
export const LEGACY_KINDS: SlideKind[] = ['title', 'section']

/** Field names of one kind, excluding the two every kind shares. */
type FieldsOf<K extends SlideKind> = Exclude<keyof Extract<SlideSpec, { kind: K }>, 'kind' | 'notes'>

/**
 * The field contract, as DATA.
 *
 * The spec is authored by a language model reading a prompt, so the field names
 * are part of the product's contract — not an implementation detail. They used
 * to live only in the TS union, which meant every prompt that described them
 * was a hand copy. One of those copies (CONTENT_SOUL.md) elided the fields
 * entirely, so the model invented its own (`bullets.items`, `summary.points`,
 * `table.header`, …) and every deck it wrote failed to render.
 *
 * This table is the single source those prompts are checked against
 * (scripts/deck/check-prompt-schema.ts). It is type-checked twice over: the
 * mapped type forces every kind to appear, and `FieldsOf<K>` rejects a field
 * name that does not exist on that kind — so a typo here is a build error, not
 * a broken deck.
 */
export const SLIDE_FIELDS: { [K in SlideKind]: { required: FieldsOf<K>[]; optional: FieldsOf<K>[] } } = {
  cover:    { required: ['title'], optional: ['subtitle', 'date', 'badge', 'kicker', 'chips', 'variant'] },
  title:    { required: ['title'], optional: ['subtitle'] },
  toc:      { required: ['sections'], optional: ['title', 'variant'] },
  section:  { required: ['number', 'title'], optional: ['intro', 'variant'] },
  stats:    { required: ['items'], optional: ['title', 'variant'] },
  compare:  { required: ['left', 'right'], optional: ['title', 'variant'] },
  quote:    { required: ['text'], optional: ['attribution'] },
  timeline: { required: ['steps'], optional: ['title', 'variant'] },
  chart:    { required: ['chartType', 'categories', 'series'], optional: ['title', 'takeaway', 'source', 'variant'] },
  summary:  { required: ['takeaways'], optional: ['title', 'closing', 'nextSteps', 'contact', 'variant'] },
  bullets:  { required: ['bullets'], optional: ['title', 'variant'] },
  text:     { required: ['body'], optional: ['title', 'variant'] },
  image:    { required: ['imagePath'], optional: ['title', 'caption', 'variant'] },
  table:    { required: ['headers', 'rows'], optional: ['title', 'variant'] },
  layout:   { required: ['blocks'], optional: ['title'] },
}

/**
 * Per-field type signatures, for the prompt generator
 * (scripts/deck/gen-prompt-block.ts). '' = plain string field.
 *
 * SLIDE_FIELDS names the fields; this names their SHAPES. Split in two so each
 * mapped type can enforce its own completeness: here every field of every kind
 * must have an entry (missing one is a compile error), and a signature for a
 * field that does not exist is rejected by `FieldsOf<K>`.
 */
export const FIELD_SIGS: { [K in SlideKind]: { [F in FieldsOf<K>]: string } } = {
  cover:    { title: '', subtitle: '', date: '', badge: '', kicker: '', chips: 'string[]', variant: 'block|split|center' },
  title:    { title: '', subtitle: '' },
  toc:      { sections: '(string or { label, desc? })[]', title: '', variant: 'list|sidebar|cards' },
  section:  { number: 'number|string', title: '', intro: '', variant: 'number|accentBlock|split' },
  stats:    { items: '[{ value, label, sublabel? }]', title: '', variant: 'cards|bare' },
  compare:  { left: '{ title, bullets: string[] }', right: '{ title, bullets: string[] }', title: '', variant: 'cards|vs|stacked' },
  quote:    { text: '', attribution: '' },
  timeline: { steps: '[{ label, desc? }]', title: '', variant: 'rail|vertical|bars|chevron' },
  chart:    {
    chartType: 'bar|line|pie|doughnut|area', categories: 'string[]',
    series: '[{ name, values: number[] }]', title: '', takeaway: '', source: '', variant: 'full|split|banner',
  },
  summary:  { takeaways: 'string[]', title: '', closing: '', nextSteps: 'string[]', contact: '', variant: 'takeaways|split|thanks' },
  bullets:  { bullets: 'string[]', title: '', variant: 'rows|cards|numbered|twoCol' },
  text:     { body: '', title: '', variant: 'rail|panel|twoCol' },
  image:    { imagePath: '', title: '', caption: '', variant: 'full|bleed|hero' },
  table:    { headers: 'string[]', rows: '(string|number|null)[][]', title: '', variant: 'grid|zebra|kv' },
  layout:   { blocks: '[{ span?: 1-12, break?, card?, align?: top|middle, minH?, body }]', title: '' },
}

/**
 * Deck purposes — what the deck must MAKE HAPPEN, not its industry. The ids
 * live here (next to SLIDE_KINDS) so purpose.ts can import SlideKind without a
 * cycle; the page tables live in purpose.ts.
 */
export const PURPOSE_IDS = ['pitch', 'report', 'decide', 'align', 'analyze', 'teach'] as const
export type PurposeId = (typeof PURPOSE_IDS)[number]

export function isPurposeId(v: unknown): v is PurposeId {
  return typeof v === 'string' && (PURPOSE_IDS as readonly string[]).includes(v)
}

export type WritePptxPayload = {
  title?: string
  /** Theme preset name — see PPTX_THEMES. Default 'twixy'. Unknown = hard error. */
  theme?: string
  /** Style recipe — sharp | soft | rounded | pill. Default: the theme's own. */
  style?: string
  /** Overrides only the theme's accent color (legacy compat — old payloads sent just this). */
  accent?: string
  /**
   * What the deck must make happen. Drives the STRUCTURE check only — never
   * geometry; no painter may branch on it. Absent = the legacy skeleton check
   * applies. Unknown = hard error, same discipline as theme.
   */
  purpose?: PurposeId
  /**
   * Client brand hex ('#RRGGBB'). Derives the WHOLE palette from it while the
   * named theme keeps supplying fonts, style and light/dark. Composition:
   * theme picks structure → brand re-skins → accent (legacy) overrides last.
   */
  brand?: string
  slides: SlideSpec[]
}

/** Collection caps the renderers enforce. Exported so authoring surfaces can
 *  warn before rendering rather than silently losing content. */
export const CAPS = {
  statsItems: 4,
  timelineSteps: 6,
  summaryTakeaways: 5,
  summaryNextSteps: 4,
  tocCards: 8,
  tableRows: 15,
  /** bullets beyond this fall back to a compact list instead of dot rows */
  bulletDotRows: 8,
} as const

export function isSlideKind(k: unknown): k is SlideKind {
  return typeof k === 'string' && (SLIDE_KINDS as string[]).includes(k)
}

/**
 * Every required field of this kind is present, or throw naming the missing one.
 *
 * SLIDE_FIELDS has always been the contract; nothing enforced it. A real spec
 * shipped `summary` with `nextSteps` but no `takeaways` (required), and the
 * painter died as "Cannot read properties of undefined (reading 'length')" —
 * no field, no kind, nothing the author could act on. That is the exact
 * failure assertBlockBody was written for, one level up: layout BLOCK bodies
 * were guarded, slide FIELDS were not.
 *
 * Driven by the same table the prompts are generated from, so a new required
 * field is enforced the moment it is declared — no second list to maintain.
 */
export function assertSlideFields(spec: SlideSpec): void {
  const kind = spec.kind
  const rec = spec as unknown as Record<string, unknown>
  for (const field of SLIDE_FIELDS[kind].required as string[]) {
    const v = rec[field]
    if (v === undefined || v === null) {
      const optional = (SLIDE_FIELDS[kind].optional as string[]).join(', ')
      throw new Error(
        `'${kind}' is missing required field \`${field}\`. ` +
        `Required: ${(SLIDE_FIELDS[kind].required as string[]).join(', ')}` +
        (optional ? ` · optional: ${optional}` : ''),
      )
    }
    // The signature table says which fields are collections; a string where an
    // array belongs crashes the same way one slide later.
    //
    // The test is on the SHAPE of the signature, not on whether it contains
    // "[]": `compare.left` is `{ title, bullets: string[] }` — an object whose
    // member is an array — and a contains-check flagged every compare slide in
    // the fixtures the moment this landed.
    const sig = (FIELD_SIGS[kind] as Record<string, string>)[field] ?? ''
    const isCollection = sig.endsWith('[]') || (sig.startsWith('[') && sig.endsWith(']'))
    if (isCollection && !Array.isArray(v)) {
      throw new Error(`'${kind}' field \`${field}\` must be an array (${sig}), got ${typeof v}`)
    }
  }
}

export function unknownKindError(kind: unknown): Error {
  return new Error(`Unknown slide kind '${String(kind)}'. Valid kinds: ${SLIDE_KINDS.join(' | ')}.`)
}
