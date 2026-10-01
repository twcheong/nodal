// buildDeck — the one entry point into the layout core.
//
// Turns a deck spec into a backend-agnostic display list. Both the pptx
// exporter (electron/tools/files/pptx.ts) and the renderer's SVG preview call
// this, which is what makes the preview faithful by construction.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

import { PAGE_W, PAGE_H } from '../page'
import { unknownKindError, type SlideSpec, type WritePptxPayload, assertSlideFields } from '../spec'
import { resolveTheme, resolveStyle, resolveRoles } from '../theme'
import type { DeckDisplay, SlideDisplay } from '../el'
import { badgeEl, makeCtx, type LayoutCtx } from './common'
import { geometryNotes } from './geometry'
import { applyAutofit } from '../text/autofit'
import { layoutText, layoutBullets, layoutQuote, layoutImage, layoutTable, type LayoutResult } from './simple'
import { layoutStats, layoutCompare, layoutTimeline, layoutChart } from './data'
import { layoutCover, layoutToc, layoutSection, layoutSummary, slideBackground } from './structure'
import { layoutGrid } from './grid'
import { rotateVariants, structureReport, deckSeed } from './variety'
import { resolvePurpose } from '../purpose'
import { stripLongDashes } from '../strings'

/** Cover kinds paint a full-bleed background and carry no page badge. */
export function isCoverKind(kind: SlideSpec['kind']): boolean {
  return kind === 'cover' || kind === 'title'
}

export function layoutSlide(spec: SlideSpec, c: LayoutCtx): LayoutResult {
  switch (spec.kind) {
    case 'cover':
    case 'title': return layoutCover(spec, c)
    case 'toc': return layoutToc(spec, c)
    case 'section': return layoutSection(spec, c)
    case 'stats': return layoutStats(spec, c)
    case 'compare': return layoutCompare(spec, c)
    case 'quote': return layoutQuote(spec, c)
    case 'timeline': return layoutTimeline(spec, c)
    case 'chart': return layoutChart(spec, c)
    case 'summary': return layoutSummary(spec, c)
    case 'bullets': return layoutBullets(spec, c)
    case 'text': return layoutText(spec, c)
    case 'image': return layoutImage(spec, c)
    case 'table': return layoutTable(spec, c)
    case 'layout': return layoutGrid(spec, c)
    default:
      // The tool schema passes `slides` through unvalidated, so a typo'd kind
      // reaches us here. Fail loudly — silently skipping produced blank slides.
      throw unknownKindError((spec as { kind?: string }).kind)
  }
}

/** Host-supplied facts the pure layout cannot compute — see LayoutCtx.aspect. */
export type BuildOpts = { imageAspects?: Record<string, number> }

export function buildDeck(input: WritePptxPayload, opts?: BuildOpts): DeckDisplay {
  // Typography rule, enforced where every renderer passes: no em/en dashes in
  // deck copy (a plain hyphen is fine). The prompts ask for it too, but models
  // reach for `—` constantly and a prompt rule alone leaks — see
  // shared/deck/strings.ts. Prose strings only; machine values are untouched.
  const payload = stripLongDashes(input)
  const theme = resolveTheme(payload)
  const style = resolveStyle(payload, theme)
  // Purpose affects the structure REPORT only — never geometry. Resolved here
  // so an unknown purpose fails as loudly as an unknown theme.
  const purpose = resolvePurpose(payload)
  const c = makeCtx(theme, style, resolveRoles(theme), opts?.imageAspects)

  // Unset variants rotate per kind, offset by the deck seed (title+theme) so
  // two decks never share one face by default — see layout/variety.ts for why
  // this is code and not a prompt rule. Kill switch: seed 0 = old behaviour.
  const specs = rotateVariants(payload.slides, deckSeed(payload))

  const geomNotes: string[] = []
  const slides: SlideDisplay[] = specs.map((spec, i) => {
    let laid: LayoutResult
    try {
      // Required fields BEFORE any painter touches the spec — see
      // assertSlideFields. The try/catch below adds the slide locality.
      assertSlideFields(spec)
      laid = layoutSlide(spec, c)
    } catch (err) {
      // Locality is the fix's other half: "kv needs rows" is only actionable
      // when the author knows WHICH slide said it.
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`slide ${i + 1} (${spec.kind}): ${msg}`)
    }
    const { els, warnings } = laid
    // Geometry is checked on the painter's own output: the page badge lives
    // inside the edge gutter by design, so adding it first would make every
    // slide report itself. Autofit changes font sizes, never rects.
    for (const n of geometryNotes(els)) geomNotes.push(`slide ${i + 1}: ${n}`)
    const cover = isCoverKind(spec.kind)
    const withBadge = cover ? els : [...els, ...badgeEl(i + 1, c)]
    // Shrink-to-fit is resolved HERE, not by PowerPoint — see text/autofit.ts.
    const fitted = applyAutofit(withBadge)
    return {
      index: i,
      background: slideBackground(spec, c) ?? theme.bg,
      elements: fitted.els,
      notes: spec.notes,
      warnings: [...warnings, ...fitted.warnings],
    }
  })

  return {
    pageW: PAGE_W, pageH: PAGE_H,
    title: payload.title ?? 'Twixy Report',
    purpose: purpose?.id,
    slides,
    // POST-rotation specs, not payload.slides: the geometry fingerprints
    // (faceOf) measure variants, and the pre-rotation list would report
    // variants that were never rendered.
    structure: [...structureReport(specs, purpose), ...geomNotes],
  }
}
