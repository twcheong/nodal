// 12-column grid for the `layout` kind.
//
// Blocks flow left→right and wrap when the row is full; rows are never split.
// All spacing comes from the active StyleRecipe, so a `layout` slide picks up
// the same sharp/soft/rounded/pill personality as every other kind.
//
// Content is never dropped: when the rows do not fit, autofit runs first
// (buildDeck applies it to the whole slide) and anything still over emits an
// `overflow` warning — silently truncating is how a deck ends up wrong without
// anyone noticing.
//
// See shared/deck/page.ts (purity) and ./common.ts (colour-role rule).

import { PAGE_H, BADGE_RESERVE, CONTENT_TOP, type Rect } from '../page'
import type { El, LayoutWarning } from '../el'
import { headerEl, type LayoutCtx } from './common'
import { assertBlockBody, measureBlock, paintBlock, type Block } from './blocks'

const COLS = 12

type Row = { blocks: { b: Block; col: number; span: number }[]; natural: number; flexible: boolean }

function packRows(blocks: Block[]): Row[] {
  const rows: Row[] = []
  let cur: Row = { blocks: [], natural: 0, flexible: false }
  let cursor = 0

  for (const b of blocks) {
    const span = Math.min(Math.max(Math.round(b.span ?? COLS), 1), COLS)
    if (b.break || cursor + span > COLS) {
      if (cur.blocks.length) rows.push(cur)
      cur = { blocks: [], natural: 0, flexible: false }
      cursor = 0
    }
    cur.blocks.push({ b, col: cursor, span })
    cursor += span
  }
  if (cur.blocks.length) rows.push(cur)
  return rows
}

/**
 * How an image block fills its cell.
 *
 * ONE picture in a row keeps its own shape (`contain`): the row was already
 * sized to its aspect, so the box and the photo agree and nothing is cropped.
 * Cropping a lone photo is not reversible and not ours to decide.
 *
 * TWO OR MORE pictures in a row are a gallery, and a gallery is only a gallery
 * if the tiles match. The row takes the tallest natural height and every tile
 * fills it (`cover`), so same-shaped photos fit exactly and mixed ones become
 * one uniform strip instead of three different rectangles floating in three
 * different amounts of white. This is what the reference decks do.
 */
/**
 * 한 장짜리 사진을 셀에 맞춰 채울 때 허용하는 최대 크롭 (긴 변 기준 배수).
 *
 * 실측해서 정했다. 같은 가로 사진(1.43:1)을 세 배치에 넣었을 때 셀과의 비율차:
 *   2단(글7/사진5)  4.89×5.50 → 1.65    · 3장 갤러리 3.84×5.50 → 1.43
 *   전폭 띠(span 12) 12.23×3.41 → 2.51
 * 2.2 로 잡으면 전폭 띠만 레터박스로 떨어져 셀의 40% 만 채웠다 — 띠는 크롭이
 * 의도인 배치(배너)인데 이름값을 못 했다. 3.0 은 한 변의 67% 까지 잘라도
 * 채운다는 뜻이고, 그 위(세로 사진 0.7:1 을 전폭 띠에 넣으면 5.1)는 사진이
 * 뭔지 알아볼 수 없으므로 레터박스로 남긴다 — 그게 이 상수가 있는 이유다.
 */
const CROP_LIMIT = 3.0

function fitFor(b: Block, row: Row, cell: Rect, c: LayoutCtx): 'contain' | 'cover' | undefined {
  if (b.body.type !== 'image') return undefined
  const ar = c.aspect(b.body.imagePath)
  // Without the photo's shape we cannot tell how much a cover would cut off.
  if (!ar || cell.h <= 0) return 'contain'
  const images = row.blocks.filter((x) => x.b.body.type === 'image').length
  if (images >= 2) return 'cover'
  // One photo: fill the cell only while the crop stays modest. `over` is how
  // much of a side disappears — 1.0 is a perfect fit, 1.5 cuts a third away.
  // Past CROP_LIMIT the picture would be unrecognisable in its own slot, and a
  // letterboxed photo beats a beheaded one.
  const over = Math.max((cell.w / cell.h) / ar, ar / (cell.w / cell.h))
  return over <= CROP_LIMIT ? 'cover' : 'contain'
}

export function layoutGrid(
  spec: { title?: string; blocks: Block[] },
  c: LayoutCtx,
): { els: El[]; warnings: LayoutWarning[] } {
  const els: El[] = [...headerEl(spec.title, c)]
  const warnings: LayoutWarning[] = []
  if (spec.blocks.length === 0) return { els, warnings }
  // Fail by NAME before any geometry — see assertBlockBody.
  spec.blocks.forEach((b, i) => assertBlockBody(b.body, i + 1))

  const { s } = c
  const colW = (c.contentW - s.gap * (COLS - 1)) / COLS
  const xOf = (col: number) => s.margin + col * (colW + s.gap)
  const wOf = (span: number) => span * colW + (span - 1) * s.gap

  const contentY = spec.title ? CONTENT_TOP : s.margin
  const contentH = PAGE_H - contentY - BADGE_RESERVE

  // Pass 1 — pack, Pass 2 — intrinsic heights.
  const rows = packRows(spec.blocks)
  for (const row of rows) {
    for (const item of row.blocks) {
      const inner = wOf(item.span) - (item.b.card ? s.pad * 2 : 0)
      const m = measureBlock(item.b.body, inner, c)
      const withCard = m.natural + (item.b.card ? s.pad * 2 : 0)
      row.natural = Math.max(row.natural, Math.max(withCard, item.b.minH ?? 0))
      if (m.flexible) row.flexible = true
    }
  }

  // Pass 3 — distribute vertical space.
  const naturalTotal = rows.reduce((n, r) => n + r.natural, 0) + s.gap * (rows.length - 1)
  const slack = contentH - naturalTotal
  const heights = rows.map((r) => r.natural)

  // Rows that were grown past their natural height centre their content
  // instead of pinning it to the top (see the stretch branch below).
  let stretched = false

  if (slack > 0) {
    const flexRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.flexible)
    if (flexRows.length) {
      const base = flexRows.reduce((n, { r }) => n + r.natural, 0) || 1
      for (const { r, i } of flexRows) heights[i] += slack * (r.natural / base)
    } else {
      // No chart/image to absorb it, so the slack used to pile up at the
      // bottom — "reads as intentional whitespace" was wishful: an icon row
      // ended at 2.4" on a 7.5" page and a stat card floated above four inches
      // of nothing. Grow every row instead and centre what is inside them.
      const base = naturalTotal - s.gap * (rows.length - 1) || 1
      for (let i = 0; i < heights.length; i++) heights[i] += slack * (heights[i] / base)
      stretched = true
    }
  } else if (slack < 0) {
    // Scale rows down proportionally; autofit (applied later over the whole
    // slide) shrinks the text inside them. Report what could not be absorbed.
    const factor = contentH / naturalTotal
    for (let i = 0; i < heights.length; i++) heights[i] *= factor
    warnings.push({ code: 'overflow', what: `layout (${rows.length} rows)`, overBy: -slack })
  }

  // Pass 4 — paint.
  let y = contentY
  rows.forEach((row, i) => {
    const rowH = heights[i]
    for (const { b, col, span } of row.blocks) {
      const outer: Rect = { x: xOf(col), y, w: wOf(span), h: rowH }
      if (b.card) {
        els.push({ type: 'roundRect', rect: outer, radius: s.radiusLg, fill: { color: c.r.cardFill } })
      }
      const pad = b.card ? s.pad : 0
      const inner: Rect = { x: outer.x + pad, y: outer.y + pad, w: outer.w - pad * 2, h: outer.h - pad * 2 }
      // `icon` and `image` paint height-aware (the glyph scales; the photo
      // fills via cover), so they keep the full stretched rect instead of
      // being clamped back to a natural height they would leave unused.
      const heightAware = b.body.type === 'icon'
        || (b.body.type === 'image' && !!c.aspect(b.body.imagePath))
      if (stretched && b.align === undefined && !heightAware) {
        // The row is taller than the content asked for — centre rather than
        // leave a ragged gap under every block.
        const m = measureBlock(b.body, inner.w, c)
        if (m.natural < inner.h) {
          inner.y = outer.y + (outer.h - m.natural) / 2
          inner.h = m.natural
        }
      } else if (b.align === 'middle') {
        const m = measureBlock(b.body, inner.w, c)
        inner.y = outer.y + (outer.h - m.natural) / 2
        inner.h = m.natural
      }
      els.push(...paintBlock(b.body, inner, c, fitFor(b, row, inner, c)))
    }
    y += rowH + s.gap
  })

  return { els, warnings }
}
