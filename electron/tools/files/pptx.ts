// PPTX deliverable writer.
//
// This file is now pure orchestration: ALL geometry, palettes and layout live
// in shared/deck/ so the renderer-side preview computes the identical result,
// and pptxPainter.ts turns that display list into pptxgenjs calls. There should
// be no coordinates below this line.
//
// Regression net: scripts/deck/snapshot.ts (npx tsx scripts/deck/snapshot.ts).

import fs from 'node:fs'
import path from 'node:path'
import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import { buildDeck, type BuildOpts } from '../../../shared/deck/layout'
import { PPTX_THEMES, PPTX_STYLES } from '../../../shared/deck/theme'
import { iconSvg } from '../../../shared/deck/icons'
import type { SlideSpec, WritePptxPayload } from '../../../shared/deck/spec'
import type { LayoutWarning } from '../../../shared/deck/el'
import { paintSlide, type IconPngs } from './pptxPainter'
import { resolveDeckImages, deckImageAspects } from './deckImages'

// Re-exported so this module stays the single import for electron/main.ts and
// electron/agent-tool-bridge.ts.
export type { SlideSpec, WritePptxPayload }
export { PPTX_THEMES, PPTX_STYLES }

/** Build the whole deck onto `pres`. Split out of writePptx so the snapshot
 *  oracle can drive it with a recording stub. Keep this free of fs. */
export type DeckFeedback = { warnings: LayoutWarning[]; structure: string[] }

/**
 * Rasterize every unique (name, colour) icon in the deck to a PNG data URI.
 *
 * The SVG preview strokes icon paths directly, but PowerPoint gets a PNG:
 * pptxgenjs can embed raw SVG, only Office 2019+ renders it and Keynote's
 * import is unreliable — a deliverable that shows empty squares in the
 * client's Keynote is a broken deliverable. sharp lives in electron main;
 * painters stay sync by taking the finished map.
 *
 * 256px, not 128: an icon is drawn at 0.6-1.3in, so 128px is ~100-210 DPI —
 * under the 150 DPI our own QA renders at and soft on any retina screen or
 * print. The reference skill names the same floor ("rasterize with sharp at
 * ≥256px"). A 256px lucide glyph is a few KB; there is no reason to be stingy.
 */
async function rasterizeIcons(payload: WritePptxPayload): Promise<IconPngs> {
  const deck = buildDeck(payload)
  const wanted = new Map<string, { name: string; color: string }>()
  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === 'icon') wanted.set(`${el.name}|${el.color}`, { name: el.name, color: el.color })
    }
  }
  const out: IconPngs = {}
  for (const [key, { name, color }] of wanted) {
    const png = await sharp(Buffer.from(iconSvg(name, color, 256))).png().toBuffer()
    out[key] = `data:image/png;base64,${png.toString('base64')}`
  }
  return out
}

export async function renderDeck(pres: PptxGenJS, payload: WritePptxPayload, opts?: BuildOpts): Promise<DeckFeedback> {
  const deck = buildDeck(payload, opts)
  const iconPngs = await rasterizeIcons(payload)
  pres.layout = 'LAYOUT_WIDE'
  pres.title = deck.title

  const warnings: LayoutWarning[] = []
  for (const s of deck.slides) {
    const slide = pres.addSlide()
    slide.background = { color: s.background }
    paintSlide(slide, s.elements, pres, iconPngs)
    if (s.notes) slide.addNotes(s.notes)
    warnings.push(...s.warnings)
  }
  return { warnings, structure: deck.structure }
}

export async function writePptx(
  safePath: string,
  payload: WritePptxPayload,
  opts?: { workspace?: string },
): Promise<{ bytes: number } & DeckFeedback> {
  // 사진 경로는 **쓰기 직전에** 확정한다. renderDeck 은 fs 를 모르는 채로
  // 두어야 스냅샷 오라클이 그대로 구동할 수 있고(파일 상단 주석), pptxgenjs 는
  // 상대경로를 프로세스 cwd 로 풀기 때문에 그냥 넘기면 조용히 빗나간다.
  const { payload: resolved, missing } = resolveDeckImages(payload, opts?.workspace)
  if (missing.length) {
    // 조용한 구멍 대신 이름을 부른다 — 어느 파일이 없는지 알아야 고친다.
    throw new Error(
      `image not found: ${missing.join(', ')}. ` +
      'Attach the picture first (drag it into the chat); the deck must reference the path the app gave you.',
    )
  }
  // 사진의 '모양' 도 함께 넘긴다 — 액자를 사진 비율에 맞추는 건 코어가 하되,
  // 파일을 열 수 있는 건 여기뿐이다.
  const imageAspects = await deckImageAspects(resolved)
  const pres = new PptxGenJS()
  const feedback = await renderDeck(pres, resolved, { imageAspects })
  fs.mkdirSync(path.dirname(safePath), { recursive: true })
  await pres.writeFile({ fileName: safePath })
  return { bytes: fs.statSync(safePath).size, ...feedback }
}
