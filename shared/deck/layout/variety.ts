// Layout variety and deck structure, enforced in code rather than asked for
// in a prompt.
//
// MiniMax's hard rule is "every content slide uses a different layout from the
// previous one". A prompt rule loses — we watched the executor emit a deck of
// eight near-identical slides while the runbook said not to. So:
//
//   1. rotateVariants — when a kind repeats and the author did NOT pick a
//      variant, the SECOND occurrence gets a different one automatically. The
//      deck stops having one face without anyone having to remember.
//   2. structureReport — problems the author cannot see come back as text on
//      the tool result / QA message, which is the model's feedback channel.
//      Purpose-aware when payload.purpose is set (missing/short/inverted
//      slots), legacy skeleton check when it is not, geometry-level repetition
//      always.
//
// Section dividers are deliberately EXCLUDED from rotation: dividers are a
// rhythm, and varying them mid-deck reads as a mistake.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import type { SlideSpec, WritePptxPayload } from '../spec'
import { PURPOSE_IDS } from '../spec'
import { fitPurpose, type DeckPurpose } from '../purpose'

/**
 * FNV-1a, 32-bit. Pure, allocation-free, identical in Node and Chromium
 * (charCodeAt is UTF-16 code units; Math.imul is spec-exact 32-bit) — which is
 * what lets a "random-looking" rotation stay inside the purity rules of
 * page.ts.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Seed = title + theme ONLY. Deliberately NOT the slide list: a deck-patch
 * that adds one slide must not re-roll the geometry of the fifteen the user
 * already accepted. Two different decks vary; one deck under edit does not.
 */
export function deckSeed(payload: WritePptxPayload): number {
  return hashString(`${payload.title ?? ''}|${payload.theme ?? ''}`)
}

/** Rotation order per kind. First entry is the default face. */
const ROTATIONS: Partial<Record<SlideSpec['kind'], string[]>> = {
  cover: ['block', 'split', 'center'],
  toc: ['list', 'cards', 'sidebar'],
  stats: ['cards', 'bare'],
  summary: ['takeaways', 'split', 'thanks'],
  chart: ['full', 'split', 'banner'],
  bullets: ['rows', 'cards', 'numbered', 'twoCol'],
  compare: ['cards', 'vs', 'stacked'],
  // 'kv' is deliberately NOT in the rotation: it draws no header row, so
  // rotating into it would drop the two header strings without the author
  // choosing that. Rotation must be content-neutral; kv is opt-in only.
  table: ['grid', 'zebra'],
  // 'chevron' renders label AND desc (desc under each arrow), so rotating
  // into it is content-neutral — the bar kv's exclusion does not apply.
  timeline: ['rail', 'vertical', 'bars', 'chevron'],
  text: ['rail', 'panel', 'twoCol'],
  // All three render title AND caption, so the rotation stays content-neutral
  // ('hero' overlays them on the photo instead of setting them beside it).
  image: ['full', 'bleed', 'hero'],
}

/** Dividers are a rhythm: ONE variant per deck, chosen by the seed, applied to
 *  every unset section slide. Varied across decks, constant within one — which
 *  is exactly what the runbook has been asking the model to do by hand. */
const SECTION_ROTATION = ['number', 'accentBlock', 'split'] as const

/**
 * Give slides a face. An explicit variant is always honoured; unset ones
 * rotate per kind, offset by the deck seed so two decks with the same slide
 * list still differ.
 *
 * The old rule skipped the FIRST occurrence (n === 0) — which made rotation a
 * dead axis: cover/toc/summary appear once per deck, so in practice only a
 * repeated `stats` ever rotated. With the seed offset the first occurrence
 * varies too, and `deckSeed() → 0` restores the old behaviour exactly (index 0
 * of every rotation is the previous default face).
 */
export function rotateVariants(slides: SlideSpec[], seed = 0): SlideSpec[] {
  const sectionVariant = SECTION_ROTATION[seed % SECTION_ROTATION.length]
  const seen = new Map<string, number>()
  return slides.map((spec) => {
    const n = seen.get(spec.kind) ?? 0
    seen.set(spec.kind, n + 1)
    if ((spec as { variant?: string }).variant !== undefined) return spec
    if (spec.kind === 'section') return { ...spec, variant: sectionVariant } as SlideSpec
    const rot = ROTATIONS[spec.kind]
    if (!rot) return spec
    // Per-kind hash offset decorrelates the picks: five kinds have 3-face
    // rotations, and `seed % 3` alone would seat ALL of them on the same index
    // — a deck where every page happens to get face #2 is not variety. Seed 0
    // stays the exact kill switch: first occurrence on the default face,
    // repeats rotating — the pre-seed behaviour, byte for byte.
    const idx = seed === 0 ? n % rot.length : (seed + n + hashString(spec.kind)) % rot.length
    return { ...spec, variant: rot[idx] } as SlideSpec
  })
}

/**
 * What the slide LOOKS like, not what it is called.
 *
 * Humans perceive repetition at the geometry level: a run of
 * bullets→chart→table→compare passed the old kind-level check ("4+ distinct
 * kinds") while reading as the same title-plus-one-block page four times.
 * The fingerprint is kind:variant — and for `layout`, the span pattern IS the
 * geometry.
 */
export function faceOf(spec: SlideSpec): string {
  if (spec.kind === 'layout') return 'layout:' + spec.blocks.map((b) => b.span ?? 12).join('-')
  const v = (spec as { variant?: string }).variant
  return v ? `${spec.kind}:${v}` : spec.kind
}

const TEXT_ONLY = new Set<SlideSpec['kind']>(['bullets', 'text'])

/**
 * Structural notes for the author. Empty when the deck is well-formed.
 * Deliberately about STRUCTURE, not taste.
 *
 * MUST be called with the POST-rotation specs: the geometry fingerprints
 * measure variants, and measuring the pre-rotation list would report variants
 * that were never rendered.
 */
export function structureReport(specs: SlideSpec[], purpose: DeckPurpose | null): string[] {
  const notes: string[] = []
  const kinds = specs.map((s) => s.kind)

  // ── A. purpose notes ───────────────────────────────────────────────────────
  if (purpose) {
    const fills = fitPurpose(purpose, kinds)
    for (const f of fills) {
      const [min] = f.slot.repeat
      if (f.count >= min) continue
      notes.push(
        f.count === 0
          ? `\`${purpose.id}\` deck has no '${f.slot.role}' page — ${f.slot.guide} (use ${f.slot.kinds.slice(0, 3).join('/')})`
          : `\`${purpose.id}\` needs ${min}+ '${f.slot.role}' pages, found ${f.count} — ${f.slot.guide}`,
      )
    }
    // Order: first-occurrence inversions between filled slots. Interleaving
    // (part/result dividers) keeps first occurrences monotone, so it does not
    // misfire; a 'recommend' page sitting before 'options' does.
    const filled = fills.filter((f) => f.at.length > 0)
    for (let i = 1; i < filled.length; i++) {
      if (filled[i].at[0] < filled[i - 1].at[0]) {
        notes.push(`'${filled[i].slot.role}' comes before '${filled[i - 1].slot.role}' — a ${purpose.id} deck earns it the other way round`)
      }
    }
  }

  // ── B. no purpose declared — nudge once, then the legacy skeleton check ────
  // (The old "no section divider" nudge is gone on purpose — it was training
  // the padding it complained about. Badge-geometry forensics later showed the
  // 8-divider EDIS deck was OURS, not the benchmark's. Dividers are opt-in.)
  if (!purpose && specs.length >= 6) {
    notes.push(`no purpose declared — set payload.purpose (${PURPOSE_IDS.join('|')}) so the structure check fits what the deck is FOR`)
    if (!kinds.includes('toc')) notes.push('no toc slide — a 6+ slide deck needs one')
    if (kinds.at(-1) !== 'summary') notes.push('deck does not end on a summary slide')
  }

  // ── C. geometry notes — always, purpose or not ─────────────────────────────
  const faces = specs.map(faceOf)
  const body = specs.filter((s) => s.kind !== 'cover' && s.kind !== 'title')

  for (let i = 2; i < faces.length; i++) {
    if (faces[i] === faces[i - 1] && faces[i] === faces[i - 2]) {
      notes.push(`slides ${i - 1}-${i + 1} share the same geometry ('${faces[i]}') — set a different variant on one, or make one a \`layout\``)
      break
    }
  }
  for (let i = 1; i < kinds.length; i++) {
    if (TEXT_ONLY.has(kinds[i]) && TEXT_ONLY.has(kinds[i - 1])) {
      notes.push(`slides ${i} and ${i + 1} are both text-only — make one visual`)
      break
    }
  }
  // Divider pages carry no content. The prompt asked for restraint twice and
  // still shipped five of them in a 17-slide deck, so the check moved into
  // code: any `section` slide is reported, with the page it should have been
  // folded into.
  {
    const dividers = specs.map((sp, i) => (sp.kind === 'section' ? i + 1 : 0)).filter(Boolean)
    if (dividers.length) {
      notes.push(
        `slide${dividers.length > 1 ? 's' : ''} ${dividers.join(', ')} ${dividers.length > 1 ? 'are' : 'is'} a bare divider page — fold the part name into the FOLLOWING page's title ("FUNNEL · What runs where") and delete the divider, unless chapter dividers were explicitly requested`,
      )
    }
  }

  // A deck with ZERO graphic pages reads as a printed document. `layout`
  // counts only when one of its blocks is a graphic device — a grid of
  // paragraphs is still prose.
  if (specs.length >= 6) {
    const GRAPHIC_BLOCKS = new Set(['chart', 'icon', 'funnel', 'stat', 'kv', 'image'])
    const graphic = specs.filter((sp) =>
      sp.kind === 'chart' || sp.kind === 'table' || sp.kind === 'timeline' || sp.kind === 'image' || sp.kind === 'stats' ||
      (sp.kind === 'layout' && sp.blocks.some((b) => GRAPHIC_BLOCKS.has(b.body.type))),
    ).length
    if (graphic === 0) {
      notes.push('no page carries a graphic device (chart / table / timeline / stats / icons / funnel) — make at least two pages visual')
    }
  }

  if (specs.length >= 6) {
    const distinct = new Set(body.map(faceOf)).size
    const floor = Math.min(6, Math.max(4, Math.ceil(body.length / 2)))
    if (distinct < floor) {
      notes.push(`${body.length} content slides but only ${distinct} distinct geometries — the deck reads as one page repeated (aim for ${floor}+)`)
      // The layout push lives HERE, in code — the prompt row asking for it
      // has already lost this argument once.
      if (!kinds.includes('layout')) {
        notes.push('no `layout` slide — the 12-column grid is the one free geometry; use it for the page that mixes a number, a chart and a note')
      }
    }
  }
  return notes
}
