// Block painters — the primitives the `layout` kind composes.
//
// MiniMax gets its layout variety by letting the model write free pptxgenjs
// code per slide, steered by a pattern library. We cannot execute model-written
// code, so the same freedom arrives as DECLARATIVE composition: the model picks
// blocks and column spans, and these painters own the pixels.
//
// See shared/deck/page.ts (purity) and ./common.ts (colour-role rule).

import type { El, Rect } from '../el'
import { lineHeightIn, widthIn } from '../text/metrics'
import { wrapText } from '../text/wrap'
import type { ChartKind } from '../spec'
import type { LayoutCtx } from './common'
import { iconNode } from '../icons'
import { pickReadable } from '../color'

export type BlockBody =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'stat'; value: string; label: string; sublabel?: string; pct?: number }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'chart'; chartType: ChartKind; categories: string[]; series: { name: string; values: number[] }[] }
  | { type: 'image'; imagePath: string; caption?: string }
  | { type: 'kv'; rows: { k: string; v: string }[] }
  | { type: 'icon'; name: string; label?: string; sublabel?: string }
  | { type: 'step'; number?: number | string; icon?: string; title: string; desc?: string }
  | { type: 'chips'; items: string[] }
  | { type: 'funnel'; stages: { label: string; desc?: string }[] }
  | { type: 'spacer' }

export type Block = {
  /** 1..12 columns. Default 12 (full width). */
  span?: number
  /** force a new row before this block */
  break?: boolean
  /** draw a themed card behind it and inset the content */
  card?: boolean
  align?: 'top' | 'middle'
  minH?: number
  body: BlockBody
}

const HEADING_PT: Record<1 | 2 | 3, number> = { 1: 24, 2: 18, 3: 15 }

/**
 * Validate a block body BEFORE any measuring/painting touches it.
 *
 * Without this, a body with the right `type` but wrong fields (a real case:
 * the QA round patched in `{ type:'kv', label, text }` instead of
 * `{ type:'kv', rows }`) dies deep in a painter as
 * "Cannot read properties of undefined" — no slide, no block, no field name,
 * nothing the model can act on. Same discipline as unknownKindError: the
 * contract fails by NAME or it will be violated silently.
 */
export function assertBlockBody(body: BlockBody, ordinal: number): void {
  const at = `layout block ${ordinal}`
  const b = body as Record<string, unknown> & { type?: string }
  switch (b.type) {
    case 'heading': case 'paragraph': case 'quote':
      if (typeof b.text !== 'string') throw new Error(`${at} ('${b.type}') needs \`text: string\``)
      return
    case 'bullets':
      if (!Array.isArray(b.items)) throw new Error(`${at} ('bullets') needs \`items: string[]\``)
      return
    case 'stat':
      if (typeof b.value !== 'string' || typeof b.label !== 'string') throw new Error(`${at} ('stat') needs \`value\` and \`label\` strings`)
      if (b.pct !== undefined && typeof b.pct !== 'number') throw new Error(`${at} ('stat') \`pct\` must be a number 0-100`)
      return
    case 'chart':
      if (typeof b.chartType !== 'string' || !Array.isArray(b.categories) || !Array.isArray(b.series)) {
        throw new Error(`${at} ('chart') needs \`chartType\`, \`categories: string[]\`, \`series: [{ name, values }]\``)
      }
      return
    case 'image':
      if (typeof b.imagePath !== 'string') throw new Error(`${at} ('image') needs \`imagePath: string\``)
      return
    case 'kv':
      if (!Array.isArray(b.rows)) throw new Error(`${at} ('kv') needs \`rows: [{ k, v }]\` — there is no label/text on kv`)
      return
    case 'icon':
      if (typeof b.name !== 'string') throw new Error(`${at} ('icon') needs \`name: string\``)
      return
    case 'step':
      if (typeof b.title !== 'string') throw new Error(`${at} ('step') needs \`title: string\``)
      return
    case 'chips':
      if (!Array.isArray(b.items)) throw new Error(`${at} ('chips') needs \`items: string[]\``)
      return
    case 'funnel':
      if (!Array.isArray(b.stages) || (b.stages as unknown[]).length < 2) {
        throw new Error(`${at} ('funnel') needs \`stages: [{ label, desc? }]\` with 2+ stages`)
      }
      return
    case 'spacer':
      return
    default:
      throw new Error(`${at} has unknown body type '${String(b.type)}'. Valid: heading | paragraph | bullets | stat | quote | chart | image | kv | icon | step | chips | funnel | spacer.`)
  }
}

/** Intrinsic height, inches. `flexible` blocks absorb leftover vertical space. */
/** 그리드 안의 사진 한 장이 요구할 수 있는 최대 높이(in). 위 주석 참고. */
const IMAGE_MAX_H = 3.6

export function measureBlock(body: BlockBody, w: number, c: LayoutCtx): { natural: number; flexible: boolean } {
  switch (body.type) {
    case 'heading': {
      const fs = HEADING_PT[body.level ?? 2]
      const { blockH } = wrapText([{ text: body.text }], w, 99, { fontSize: fs, fontFace: c.t.headFont, color: c.r.title, bold: true })
      return { natural: blockH + 0.12, flexible: false }
    }
    case 'paragraph': {
      const { blockH } = wrapText([{ text: body.text }], w, 99, { fontSize: 15, fontFace: c.t.bodyFont, color: c.r.body })
      return { natural: blockH + 0.1, flexible: false }
    }
    case 'bullets': {
      const runs = body.items.map((t) => ({ text: t, paraSpaceAfter: 6 }))
      const { blockH } = wrapText(runs, w - 0.45, 99, { fontSize: 15, fontFace: c.t.bodyFont, color: c.r.body })
      return { natural: blockH + 0.1, flexible: false }
    }
    case 'stat':
      return { natural: (body.pct !== undefined ? 1.7 : 1.35) + 0.5 + (body.sublabel ? 0.4 : 0), flexible: false }
    case 'quote': {
      const { blockH } = wrapText([{ text: body.text }], w, 99, { fontSize: 20, fontFace: c.t.headFont, color: c.r.title, italic: true })
      return { natural: blockH + (body.attribution ? 0.45 : 0.1), flexible: false }
    }
    case 'kv': {
      // Mirrors the painter's per-row decision (see paintBlock): a value that
      // cannot share a line with its key takes a taller, stacked row.
      const kStyle = { fontSize: 12, fontFace: c.t.bodyFont, color: c.r.muted }
      const vStyle = { fontSize: 13, fontFace: c.t.headFont, color: c.r.body, bold: true }
      const total = body.rows.reduce((n, row) => {
        const side = wrapText([{ text: row.v }], w * 0.45, 9, vStyle).lines.length <= 1
          && wrapText([{ text: row.k }], w * 0.55, 9, kStyle).lines.length <= 1
        return n + (side ? 0.36 : 0.62)
      }, 0)
      return { natural: total + 0.1, flexible: false }
    }
    case 'icon':
      // 0.6" glyph inside a 1.75x circle — see the motif note in paintBlock.
      return { natural: 1.05 + (body.label ? 0.45 : 0) + (body.sublabel ? 0.35 : 0), flexible: false }
    case 'step':
      return { natural: body.desc ? 0.78 : 0.55, flexible: false }
    case 'chips':
      return { natural: 0.42, flexible: false }
    case 'funnel':
      return { natural: body.stages.length * 0.78 + (body.stages.length - 1) * 0.18, flexible: false }
    case 'chart':
      return { natural: 2.6, flexible: true }
    case 'image': {
      // 비율을 알면 높이는 **계산값**이다: 폭이 span 으로 고정돼 있으므로
      // 사진이 가질 수 있는 높이는 하나뿐이다. 그래서 flexible 을 끈다 —
      // 켜 두면 행이 남는 높이를 흡수하는데 contain 사진은 그 높이를 쓸 수
      // 없어서, 흡수한 여백이 셀 '안'에 그대로 고인다(갤러리 셀의 51%가
      // 빈 공간이었던 원인).
      const capH = body.caption ? 0.35 : 0
      const a = c.aspect(body.imagePath)
      // 상한이 필요하다: 정사각 사진이 12칼럼을 차지하면 w/a = 12.2in 을
      // 요구해 7.5in 페이지를 통째로 넘긴다(그러면 그리드가 전부를 축소하고
      // overflow 경고를 낸다). 3.6in ≈ 콘텐츠 밴드(5.5in)의 2/3 — 사진 한 장이
      // 가져갈 수 있는 최대치로, 그 이상은 cover 가 잘라서 채운다.
      if (a) return { natural: Math.min(w / a, IMAGE_MAX_H) + capH, flexible: false }
      return { natural: 2.4 + capH, flexible: true }
    }
    case 'spacer':
      return { natural: 0.2, flexible: true }
  }
}

export function paintBlock(body: BlockBody, r: Rect, c: LayoutCtx, fit?: 'contain' | 'cover'): El[] {
  const { t, r: roles } = c
  switch (body.type) {
    case 'heading': {
      const fs = HEADING_PT[body.level ?? 2]
      return [{
        type: 'text', rect: r, runs: [{ text: body.text }],
        style: { fontSize: fs, bold: true, color: roles.title, fontFace: t.headFont, fit: 'shrink' },
      }]
    }

    case 'paragraph':
      return [{
        type: 'text', rect: r, runs: [{ text: body.text }],
        style: { fontSize: 15, color: roles.body, fontFace: t.bodyFont, valign: 'top' },
      }]

    case 'bullets': {
      // Accent dot rows — keeps the "every content slide has a non-text
      // element" rule true inside the grid too.
      const els: El[] = []
      const rowH = Math.min(0.62, r.h / Math.max(body.items.length, 1))
      body.items.forEach((item, i) => {
        const y = r.y + i * rowH
        els.push({ type: 'ellipse', rect: { x: r.x + 0.05, y: y + rowH / 2 - 0.07, w: 0.14, h: 0.14 }, fill: { color: t.accent } })
        els.push({
          type: 'text', rect: { x: r.x + 0.35, y, w: r.w - 0.4, h: rowH }, runs: [{ text: item }],
          style: { fontSize: 15, color: roles.body, fontFace: t.bodyFont, valign: 'middle', fit: 'shrink' },
        })
      })
      return els
    }

    case 'stat': {
      if (body.pct !== undefined) {
        // Progress ring with the value inside — the share/completion read.
        const d = 1.6
        const els: El[] = [{
          type: 'ring', rect: { x: r.x + (r.w - d) / 2, y: r.y, w: d, h: d },
          pct: body.pct, color: t.accent, track: roles.hairline, pt: 9,
        }, {
          type: 'text', rect: { x: r.x, y: r.y + d / 2 - 0.4, w: r.w, h: 0.8 }, runs: [{ text: body.value }],
          style: { fontSize: 24, bold: true, color: roles.title, fontFace: t.headFont, align: 'center', valign: 'middle', fit: 'shrink' },
        }, {
          type: 'text', rect: { x: r.x, y: r.y + d + 0.1, w: r.w, h: 0.5 }, runs: [{ text: body.label }],
          style: { fontSize: 14, bold: true, color: roles.onLight, fontFace: t.headFont, align: 'center', fit: 'shrink' },
        }]
        if (body.sublabel) {
          els.push({
            type: 'text', rect: { x: r.x, y: r.y + d + 0.6, w: r.w, h: 0.4 }, runs: [{ text: body.sublabel }],
            style: { fontSize: 11, color: roles.muted, fontFace: t.bodyFont, align: 'center', maxLines: 1, fit: 'shrink' },
          })
        }
        return els
      }
      const subH = body.sublabel ? Math.min(0.4, r.h * 0.18) : 0
      const labH = Math.min(0.5, r.h * 0.24)
      const valH = Math.max(0.3, r.h - labH - subH)
      const els: El[] = [{
        type: 'text', rect: { x: r.x, y: r.y, w: r.w, h: valH }, runs: [{ text: body.value }],
        style: { fontSize: 40, bold: true, color: t.accent, fontFace: t.headFont, align: 'center', valign: 'middle', fit: 'shrink' },
      }, {
        type: 'text', rect: { x: r.x, y: r.y + valH, w: r.w, h: labH }, runs: [{ text: body.label }],
        style: { fontSize: 14, bold: true, color: roles.onLight, fontFace: t.headFont, align: 'center', valign: 'middle', maxLines: 1, fit: 'shrink' },
      }]
      if (body.sublabel) {
        els.push({
          type: 'text', rect: { x: r.x, y: r.y + valH + labH, w: r.w, h: subH }, runs: [{ text: body.sublabel }],
          style: { fontSize: 11, color: roles.muted, fontFace: t.bodyFont, align: 'center', valign: 'middle', maxLines: 1, fit: 'shrink' },
        })
      }
      return els
    }

    case 'quote': {
      const els: El[] = [{
        type: 'text', rect: { x: r.x, y: r.y, w: r.w, h: r.h - (body.attribution ? 0.4 : 0) }, runs: [{ text: `“${body.text}”` }],
        style: { fontSize: 20, italic: true, color: roles.title, fontFace: t.headFont, valign: 'middle', fit: 'shrink' },
      }]
      if (body.attribution) {
        els.push({
          type: 'text', rect: { x: r.x, y: r.y + r.h - 0.4, w: r.w, h: 0.35 }, runs: [{ text: `- ${body.attribution}` }],
          style: { fontSize: 12, color: roles.muted, fontFace: t.bodyFont },
        })
      }
      return els
    }

    case 'chart':
      return [{
        type: 'chart', rect: r, chartType: body.chartType,
        categories: [...body.categories],
        series: body.series.map((s) => ({ name: s.name, values: [...s.values] })),
        style: {
          chartColors: roles.chartRun,
          showLegend: body.series.length > 1 || body.chartType === 'pie' || body.chartType === 'doughnut',
          legendPos: 'b', legendFontSize: 10, legendColor: roles.muted,
          catAxisLabelColor: roles.muted, valAxisLabelColor: roles.muted,
          catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
          dataLabelColor: roles.muted, dataLabelFontSize: 9,
          surface: t.bg,
        },
      }]

    case 'image': {
      const capH = body.caption ? 0.32 : 0
      // 'cover' 는 타일(한 행에 사진 여러 장)에서만 온다 — grid.ts 가 정한다.
      // 한 장짜리 사진을 마음대로 자르지 않는다: 잘린 얼굴은 되돌릴 수 없다.
      const els: El[] = [{ type: 'image', rect: { x: r.x, y: r.y, w: r.w, h: r.h - capH }, path: body.imagePath, sizing: fit ?? 'contain' }]
      if (body.caption) {
        els.push({
          type: 'text', rect: { x: r.x, y: r.y + r.h - capH, w: r.w, h: capH }, runs: [{ text: body.caption }],
          style: { fontSize: 11, italic: true, color: roles.muted, fontFace: t.bodyFont, align: 'center' },
        })
      }
      return els
    }

    case 'kv': {
      // Two columns when the value is short enough to sit beside its key;
      // STACKED when it is not.
      //
      // The old painter always split 55/45 and gave every row a fixed 0.36".
      // In a span-4 card that leaves the value ~1.2" wide, so a value like
      // "206 followers · 포트폴리오 부모" could not fit one line even at the
      // autofit floor — it wrapped to three lines inside a 0.36" row and
      // ploughed straight through the row beneath it. Rows are laid out
      // cumulatively now, so whatever else happens they cannot collide.
      const els: El[] = []
      const kStyle = { fontSize: 12, color: roles.muted, fontFace: c.t.bodyFont } as const
      const vStyle = { fontSize: 13, bold: true, color: roles.body, fontFace: c.t.headFont } as const
      const kW = r.w * 0.55
      const vW = r.w * 0.45
      const oneLine = (text: string, w: number, style: { fontSize: number; fontFace: string; color: string; bold?: boolean }) =>
        wrapText([{ text }], w, 9, style).lines.length <= 1

      let y = r.y
      body.rows.forEach((row, i) => {
        const side = oneLine(row.v, vW, vStyle) && oneLine(row.k, kW, kStyle)
        const rowH = side ? 0.36 : 0.62
        if (i > 0) els.push({ type: 'rect', rect: { x: r.x, y, w: r.w, h: 0.008 }, fill: { color: roles.hairline } })
        if (side) {
          els.push({
            type: 'text', rect: { x: r.x, y, w: kW, h: rowH }, runs: [{ text: row.k }],
            style: { ...kStyle, valign: 'middle', maxLines: 1, fit: 'shrink' },
          })
          els.push({
            type: 'text', rect: { x: r.x + kW, y, w: vW, h: rowH }, runs: [{ text: row.v }],
            style: { ...vStyle, align: 'right', valign: 'middle', maxLines: 1, fit: 'shrink' },
          })
        } else {
          // Key above, value below, both across the full width.
          els.push({
            type: 'text', rect: { x: r.x, y, w: r.w, h: 0.26 }, runs: [{ text: row.k }],
            style: { ...kStyle, valign: 'middle', maxLines: 1, fit: 'shrink' },
          })
          els.push({
            type: 'text', rect: { x: r.x, y: y + 0.26, w: r.w, h: 0.34 }, runs: [{ text: row.v }],
            style: { ...vStyle, valign: 'middle', maxLines: 1, fit: 'shrink' },
          })
        }
        y += rowH
      })
      return els
    }

    case 'icon': {
      // Centered tile: 0.6in icon, label under it, sublabel under that —
      // Anthropic's "icon rows" recipe: three span-4 icon blocks make a row.
      iconNode(body.name)   // validate NOW — an unknown name must fail loudly
      const els: El[] = []
      // Height-aware: a row of four icons on an otherwise empty page used to
      // draw 0.6" glyphs and leave the rest of the band blank. The tile grows
      // with the space it is given, and the stack centres inside it.
      const iconSz = Math.max(0.6, Math.min(1.3, r.h * 0.34))
      // THE MOTIF: every icon sits in a tinted circle. Committing to one
      // repeated element (rather than a different flourish per slide) is what
      // makes a deck read as designed — and the circle already recurs as the
      // step/timeline number chips and the corner ghosts, so the deck has a
      // single shape language instead of an assortment.
      const ring = iconSz * 1.75
      const stackH = ring + 0.12 + (body.label ? 0.44 : 0) + (body.sublabel ? 0.34 : 0)
      let y = r.y + Math.max(0.08, (r.h - stackH) / 2)
      els.push({
        type: 'ellipse', rect: { x: r.x + (r.w - ring) / 2, y, w: ring, h: ring },
        fill: { color: t.accent, transparency: 88 },
      })
      els.push({ type: 'icon', rect: { x: r.x + (r.w - iconSz) / 2, y: y + (ring - iconSz) / 2, w: iconSz, h: iconSz }, name: body.name, color: t.accent })
      y += ring + 0.12
      if (body.label) {
        els.push({
          type: 'text', rect: { x: r.x, y, w: r.w, h: 0.42 }, runs: [{ text: body.label }],
          style: { fontSize: iconSz > 0.9 ? 17 : 14, bold: true, color: roles.title, fontFace: t.headFont, align: 'center', maxLines: 1, fit: 'shrink' },
        })
        y += 0.44
      }
      if (body.sublabel) {
        els.push({
          type: 'text', rect: { x: r.x, y, w: r.w, h: 0.34 }, runs: [{ text: body.sublabel }],
          style: { fontSize: 11, color: roles.muted, fontFace: t.bodyFont, align: 'center', maxLines: 1, fit: 'shrink' },
        })
      }
      return els
    }

    case 'step': {
      // Number chip left, bold title beside it, muted desc under the title —
      // six span-12 steps make the dense agenda page this exists for.
      const els: El[] = []
      const chip = 0.44
      if (body.icon) {
        // "Icon + text rows": the glyph rides the same circle the numbers use,
        // so the motif holds whether the row is numbered or iconic.
        iconNode(body.icon)   // unknown name fails loudly, as everywhere else
        els.push({ type: 'ellipse', rect: { x: r.x, y: r.y + 0.04, w: chip, h: chip }, fill: { color: t.accent, transparency: 85 } })
        els.push({ type: 'icon', rect: { x: r.x + chip * 0.24, y: r.y + 0.04 + chip * 0.24, w: chip * 0.52, h: chip * 0.52 }, name: body.icon, color: t.accent })
      } else {
        els.push({
          type: 'text', rect: { x: r.x, y: r.y + 0.04, w: chip, h: chip }, runs: [{ text: String(body.number ?? '•') }],
          style: { fontSize: 14, bold: true, color: roles.onAccent, fontFace: t.headFont, align: 'center', valign: 'middle' },
          shape: { kind: 'ellipse', fill: { color: t.accent } },
        })
      }
      const tx = r.x + chip + 0.22
      els.push({
        type: 'text', rect: { x: tx, y: r.y, w: r.w - chip - 0.25, h: 0.5 }, runs: [{ text: body.title }],
        style: { fontSize: 16, bold: true, color: roles.title, fontFace: t.headFont, valign: 'middle', maxLines: 1, fit: 'shrink' },
      })
      if (body.desc) {
        els.push({
          type: 'text', rect: { x: tx, y: r.y + 0.46, w: r.w - chip - 0.25, h: 0.32 }, runs: [{ text: body.desc }],
          style: { fontSize: 12, color: roles.muted, fontFace: t.bodyFont, valign: 'top', fit: 'shrink' },
        })
      }
      return els
    }

    case 'chips': {
      // Outlined pills sized by text width, flowing left to right.
      const els: El[] = []
      const h = 0.36
      let x = r.x
      for (const item of body.items) {
        const w = Math.min(widthIn(item, 11, 'sans') + 0.42, r.w)
        if (x + w > r.x + r.w) break   // no wrap: chips are meta, not content
        els.push({
          type: 'roundRect', rect: { x, y: r.y, w, h }, radius: h / 2,
          fill: { color: t.accent, transparency: 100 }, stroke: { color: t.accent, pt: 1 },
        })
        els.push({
          type: 'text', rect: { x, y: r.y, w, h }, runs: [{ text: item }],
          style: { fontSize: 11, color: roles.title, fontFace: t.bodyFont, align: 'center', valign: 'middle', maxLines: 1, fit: 'shrink' },
        })
        x += w + 0.16
      }
      return els
    }

    case 'funnel': {
      // Stacked bands narrowing toward the action stage, short connectors
      // between — the shape Claude drew with free code, as one block.
      const els: El[] = []
      const n = body.stages.length
      const bandH = 0.78
      const gap = 0.18
      const run = roles.funnelRun
      body.stages.forEach((st, i) => {
        const shrink = n > 1 ? (i / (n - 1)) * 0.4 : 0   // last band = 60% width
        const w = r.w * (1 - shrink)
        const x = r.x + (r.w - w) / 2
        const y = r.y + i * (bandH + gap)
        const color = run[i % run.length]
        // Band colours span yellow to near-black — per-band readable text,
        // not a single role (pickReadable is pure; see shared/deck/color.ts).
        const onBand = pickReadable(color, ['FFFFFF', '1A1A1A'])
        els.push({ type: 'roundRect', rect: { x, y, w, h: bandH }, radius: 0.06, fill: { color } })
        els.push({
          type: 'text', rect: { x: x + 0.25, y: y + 0.06, w: w - 0.5, h: 0.36 }, runs: [{ text: st.label }],
          style: { fontSize: 15, bold: true, color: onBand, fontFace: t.headFont, valign: 'middle', maxLines: 1, fit: 'shrink' },
        })
        if (st.desc) {
          els.push({
            type: 'text', rect: { x: x + 0.25, y: y + 0.4, w: w - 0.5, h: 0.32 }, runs: [{ text: st.desc }],
            style: { fontSize: 11, color: onBand, fontFace: t.bodyFont, valign: 'top', fit: 'shrink', transparency: 15 },
          })
        }
        if (i < n - 1) {
          els.push({ type: 'line', from: { x: r.x + r.w / 2, y: y + bandH + 0.02 }, to: { x: r.x + r.w / 2, y: y + bandH + gap - 0.02 }, color: roles.muted, pt: 1.5 })
        }
      })
      return els
    }

    case 'spacer':
      return []
  }
}

/** Line height helper re-exported for the grid's own maths. */
export { lineHeightIn }
