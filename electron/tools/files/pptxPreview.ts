// Deck → contact-sheet PNG, so the MODEL can see the deck it just wrote.
//
// The layout engine's warnings/structure text is precise but blind — it cannot
// say "the two cards overlap" or "this dark slide is unreadable". Anthropic's
// pptx skill solves this with LibreOffice→PDF→images; we already own a
// deterministic painter (shared/deck/preview/svg.ts), so the sheet costs one
// sharp call and zero external processes.
//
// One sheet per deck, ≤1200px wide: openclaw sanitizes tool-result images down
// to 1200px anyway (DEFAULT_IMAGE_MAX_DIMENSION_PX) — emitting larger would
// just get recompressed. One image per deck keeps the vision cost flat.
//
// Consumers: agent-tool-bridge (tool result image), main.ts IPC
// `deck-render-sheet` (Content mode QA message).

import sharp from 'sharp'
import { buildDeck } from '../../../shared/deck/layout'
import { slideSvg } from '../../../shared/deck/preview/svg'
import { resolveDeckImages, imageDataUri, deckImageAspects } from './deckImages'
import type { WritePptxPayload } from '../../../shared/deck/spec'

const SHEET_W = 1200
const COLS = 4
const GAP = 8
const LABEL_H = 16

/**
 * Strip emoji from SVG before sharp sees it.
 *
 * sharp's SVG text goes through Pango, and a glyph with emoji presentation
 * (anything with U+FE0F, flags, ZWJ sequences …) makes Pango request an
 * "emoji" font family it cannot load in this environment — which is not a
 * warning but `Pango-ERROR … bailing out`: an ABORT that took the whole app
 * down the first time a model wrote "⚠️" into a slide (2026-08-16, real
 * crash, reproduced: exit 133). The model's own deck text is untrusted input
 * to this rasterizer.
 *
 * ONLY this path strips them: the renderer preview (Blink) and the exported
 * pptx (PowerPoint) render emoji fine and keep them. Dropped glyphs don't
 * re-flow the layout — wrap was computed upstream — so the sheet stays
 * geometrically faithful, minus the pictures.
 */
export function stripEmojiForPango(svg: string): string {
  // Pictographic runs (incl. flags), their joiners/selectors — then any
  // stragglers (lone VS15/VS16, keycap combiner) that survive on their own.
  return svg
    .replace(/(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])(?:[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]|\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])*/gu, '')
    .replace(/[\u{FE0E}\u{FE0F}\u{20E3}]/gu, '')
}

/** One slide, rasterised on its own — the page view wants more than a thumbnail. */
export async function rasterize(svg: string, width: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 150 }).resize({ width }).png().toBuffer()
}

/**
 * Compose numbered cells into one sheet. `cell(i, cellW)` returns a standalone
 * SVG of that width; the page ratio comes from pageW/pageH (pt). Shared by our
 * own decks (renderDeckSheet) and foreign-deck sketches (pptxSketch) so both
 * look the same to the model.
 */
export async function composeSheet(opts: {
  count: number; pageW: number; pageH: number
  cell: (i: number, cellW: number) => string
  /** Ready-made PNG for cell `i`, used instead of rasterising `cell`'s SVG.
   *  The true-render path (pptxRender) already has bitmaps from pdfjs. */
  bitmap?: (i: number) => Buffer
}): Promise<Buffer> {
  const { count, pageW, pageH, cell, bitmap } = opts
  const cols = Math.min(COLS, Math.max(1, count))
  const cellW = Math.floor((SHEET_W - GAP * (cols + 1)) / cols)
  const cellH = Math.round((cellW * pageH) / pageW)
  const rows = Math.ceil(count / cols)
  const sheetH = GAP + rows * (LABEL_H + cellH + GAP)

  const composites: sharp.OverlayOptions[] = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const left = GAP + col * (cellW + GAP)
    const top = GAP + row * (LABEL_H + cellH + GAP)

    const source = bitmap ? sharp(bitmap(i)) : sharp(Buffer.from(cell(i, cellW)), { density: 150 })
    const slidePng = await source.resize(cellW, cellH, { fit: 'fill' }).png().toBuffer()

    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${LABEL_H}">` +
      `<text x="2" y="${LABEL_H - 4}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#555">${i + 1}</text></svg>`

    composites.push(
      { input: await sharp(Buffer.from(label)).png().toBuffer(), left, top },
      { input: slidePng, left, top: top + LABEL_H },
    )
  }

  return sharp({
    create: { width: SHEET_W, height: sheetH, channels: 3, background: { r: 238, g: 237, b: 234 } },
  })
    .composite(composites)
    .png()
    .toBuffer()
}

/**
 * Render every slide and compose a numbered grid.
 *
 * `workspace` is what lets the sheet show the user's actual pictures instead
 * of a dashed frame. It matters more here than anywhere else: this sheet IS
 * the model's eyesight, and a model that sees an empty box where a photo sits
 * "fixes" the page by rewriting around a picture that is really there.
 */
export async function renderDeckSheet(
  payload: WritePptxPayload,
  opts?: { workspace?: string },
): Promise<{ png: Buffer; slideCount: number }> {
  const { payload: resolved } = resolveDeckImages(payload, opts?.workspace)
  const deck = buildDeck(resolved, { imageAspects: await deckImageAspects(resolved) })
  const slides = deck.slides
  // Read each file once — a photo repeated across slides is one read.
  const uris = new Map<string, string | undefined>()
  const imgSrc = (p: string): string | undefined => {
    if (!uris.has(p)) uris.set(p, imageDataUri(p))
    return uris.get(p)
  }
  const png = await composeSheet({
    count: slides.length, pageW: deck.pageW, pageH: deck.pageH,
    cell: (i, cellW) => stripEmojiForPango(slideSvg(slides[i], cellW, imgSrc)),
  })
  return { png, slideCount: slides.length }
}
