// Round-trip check for the .pptx importer.
//
//   npx tsx scripts/deck/roundtrip.ts
//
// Writes fixture decks with our own writer, reads them back with pptxRead, and
// asserts the text that IS on the slide survives. This is the strongest
// available test of the hand-written OOXML scanner: if it mis-nests elements or
// drops runs, strings go missing here.
//
// The expectation is deliberately kind-aware, because two classes of string are
// legitimately absent from slide XML and counting them would just make the test
// noisy:
//   · collections the renderer clamps (stats > 4, timeline > 6, …) — the text
//     never reached the slide
//   · chart categories and series names — pptxgenjs puts them in an embedded
//     workbook part, not in the slide
// Layout does not round-trip and is not expected to: the importer maps content
// into our kinds, it does not recover the original geometry.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writePptx } from '../../electron/tools/files/pptx'
import JSZip from 'jszip'
import { buildDeck } from '../../shared/deck/layout'
import { slideSvgInner } from '../../shared/deck/preview/svg'
import { resolveDeckImages, imageDataUri, deckImageAspects } from '../../electron/tools/files/deckImages'
import type { WritePptxPayload } from '../../shared/deck/spec'
import type { El } from '../../shared/deck/el'
import { readPptx } from '../../electron/tools/files/pptxRead'
import { renderDeckSheet, stripEmojiForPango } from '../../electron/tools/files/pptxPreview'
import { visibleTexts } from '../../shared/deck/visibleTexts'
import { ensureFixtureImage, FIXTURES } from './fixtures'

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rt-'))

// Long dashes are collapsed on BOTH sides: buildDeck strips em/en dashes out
// of deck copy (shared/deck/strings.ts), so a fixture authored with `—` is
// SUPPOSED to come back with `-`. That the strip actually happened is asserted
// separately below — this normalization only keeps text-survival honest.
const norm = (s: string) => s.replace(/[—–―]/g, '-').replace(/\s+/g, ' ').trim()

async function main() {
  // 픽스처가 참조하는 PNG 를 이 자리에서 만든다 — /tmp 가 비워진 기계에서도
  // 이미지 경로 해석이 진짜로 검사되도록(예전엔 아무도 안 만들어 그냥 깨졌다).
  ensureFixtureImage()
  let checked = 0
  const misses: string[] = []
  const dashMisses: string[] = []

  for (const f of FIXTURES) {
    const file = path.join(OUT, `${f.name}.pptx`)
    await writePptx(file, f.payload)
    const r = await readPptx(file)

    if (r.slideCount !== f.payload.slides.length) {
      console.error(`FAIL ${f.name}: wrote ${f.payload.slides.length} slides, read back ${r.slideCount}`)
      process.exit(1)
    }

    f.payload.slides.forEach((spec, i) => {
      const s = r.slides[i]
      const got = norm([
        s.title ?? '', ...s.body.map((b) => b.text), s.notes ?? '',
        ...(s.table ? [...s.table.headers, ...s.table.rows.flat()] : []),
      ].join(' '))

      // No long dash may reach the file. Fixtures deliberately contain them
      // (cover titles, captions), so this fails loudly if the strip regresses.
      const dashed = /[—–―]/.exec(got)
      if (dashed) dashMisses.push(`${f.name} slide ${i + 1} (${spec.kind}): "${got.slice(Math.max(0, dashed.index - 24), dashed.index + 24)}"`)

      for (const want of visibleTexts(spec)) {
        checked++
        if (!got.includes(norm(want))) misses.push(`${f.name} slide ${i + 1} (${spec.kind}): "${norm(want).slice(0, 48)}"`)
      }
    })
  }

  // ── Pictures ──────────────────────────────────────────────────────────────
  // A dropped photo has to survive four hops: spec path → resolved absolute
  // path → embedded media in the .pptx → visible pixels on the model's sheet.
  // Before this existed, `image` slides shipped as empty frames and nothing
  // failed: the path was never resolved (pptxgenjs resolves relative paths
  // against the process cwd, which is not the workspace) and the preview
  // painter had no way to load a file at all.
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-img-'))
    fs.mkdirSync(path.join(ws, 'data/raw'), { recursive: true })
    const photo = fs.readFileSync(ensureFixtureImage())
    fs.writeFileSync(path.join(ws, 'data/raw/shot.png'), photo)
    const withPics: WritePptxPayload = {
      title: 'pictures', theme: 'twixy',
      slides: [
        { kind: 'image', variant: 'full', title: 'full', imagePath: 'data/raw/shot.png', caption: 'cap' },
        { kind: 'image', variant: 'bleed', title: 'bleed', imagePath: 'data/raw/shot.png' },
        { kind: 'layout', title: 'in a grid', blocks: [
          { span: 6, body: { type: 'paragraph', text: 'words' } },
          { span: 6, body: { type: 'image', imagePath: 'data/raw/shot.png', caption: 'cap' } },
        ] },
      ],
    }

    // ① workspace-relative paths become real files inside the deck.
    const picFile = path.join(ws, 'data/reports/pics.pptx')
    await writePptx(picFile, withPics, { workspace: ws })
    const zip = await JSZip.loadAsync(fs.readFileSync(picFile))
    const media = Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/') && !n.endsWith('/'))
    if (media.length !== 3) throw new Error(`expected 3 embedded pictures, got ${media.length}`)
    const embedded = await zip.file(media[0])!.async('nodebuffer')
    if (!embedded.equals(photo)) throw new Error('embedded picture bytes differ from the source file')

    // ② A path nobody attached fails BY NAME rather than shipping a hole.
    let named = ''
    try {
      await writePptx(path.join(ws, 'data/reports/bad.pptx'),
        { title: 'x', slides: [{ kind: 'image', imagePath: 'data/raw/nope.png' }] }, { workspace: ws })
    } catch (e) { named = (e as Error).message }
    if (!named.includes('image not found') || !named.includes('data/raw/nope.png')) {
      throw new Error(`a missing picture must fail by name, got: ${named || '(no error)'}`)
    }

    // ③ The model's sheet must show the photo, not a dashed frame — a model
    //    that cannot see the picture "fixes" the page around a hole.
    const resolvedDeck = buildDeck(resolveDeckImages(withPics, ws).payload)
    const drawn = slideSvgInner(resolvedDeck.slides[0], (p) => imageDataUri(p))
    const frame = slideSvgInner(resolvedDeck.slides[0])
    if (!drawn.includes('<image ') || !drawn.includes('data:image/png;base64,')) throw new Error('preview painter drew no picture')
    if (frame.includes('<image ')) throw new Error('painter must fall back to a frame without a resolver')
    // full = contain, bleed = cover (edge to edge, cropped). The exporter maps
    // the same field to pptxgenjs sizing, so the two painters cannot drift.
    if (!drawn.includes('xMidYMid meet')) throw new Error("the 'full' face must letterbox (contain)")
    const bled = slideSvgInner(resolvedDeck.slides[1], (p) => imageDataUri(p))
    if (!bled.includes('xMidYMid slice') || !bled.includes('<clipPath')) throw new Error("the 'bleed' face must fill and crop (cover)")

    // ④ 사진의 '모양' 이 실제로 액자를 정하는가 — 이게 없으면 액자는 고정
    //    상자로 남고, 갤러리 셀의 절반이 빈 공간이 된다(실측 49%).
    const aspects = await deckImageAspects(resolveDeckImages(withPics, ws).payload)
    const oneAspect = Object.values(aspects)[0]
    if (!oneAspect) throw new Error('image aspect was not read from the file')
    const gallery: WritePptxPayload = { title: 'g', slides: [{ kind: 'layout', title: 'g', blocks: [
      { span: 4, body: { type: 'image', imagePath: 'data/raw/shot.png' } },
      { span: 4, body: { type: 'image', imagePath: 'data/raw/shot.png' } },
      { span: 4, body: { type: 'image', imagePath: 'data/raw/shot.png' } },
    ] }] }
    const resolvedGal = resolveDeckImages(gallery, ws).payload
    const galAspects = await deckImageAspects(resolvedGal)
    const cellOf = (aspectMap: Record<string, number>) => {
      const el = buildDeck(resolvedGal, { imageAspects: aspectMap }).slides[0].elements
        .find((e) => e.type === 'image') as Extract<El, { type: 'image' }>
      return el
    }
    const blind = cellOf({})
    const knowing = cellOf(galAspects)
    // 비율을 모르면 자를 수 없다(얼마나 잘리는지 모르니까) → contain.
    // 알면 타일이 셀을 채운다 → cover. 이게 갤러리 셀의 절반이 비던 원인의 수정.
    if (blind.sizing !== 'contain') throw new Error('without an aspect the painter must not crop')
    if (knowing.sizing !== 'cover') throw new Error('a row of photos must fill its tiles (cover)')
    // 한 장짜리는 자르지 않는다 — 잘린 얼굴은 되돌릴 수 없다.
    const lone: WritePptxPayload = { title: 'l', slides: [{ kind: 'layout', title: 'l', blocks: [
      { span: 6, body: { type: 'paragraph', text: 'x' } },
      { span: 6, body: { type: 'image', imagePath: 'data/raw/shot.png' } },
    ] }] }
    const loneRes = resolveDeckImages(lone, ws).payload
    const loneEl = buildDeck(loneRes, { imageAspects: await deckImageAspects(loneRes) }).slides[0].elements
      .find((e) => e.type === 'image') as Extract<El, { type: 'image' }>
    const cellAr = loneEl.rect.w / loneEl.rect.h
    const over = Math.max(cellAr / oneAspect, oneAspect / cellAr)
    if (loneEl.sizing === 'cover' && over > 2.2) throw new Error('a lone photo must not be cropped past the limit')

    // 'hero' = full-page photo + the text plate that makes the title readable
    // whatever the photo is (structure-check proves the contrast; this proves
    // the plate is actually drawn, and drawn AFTER the photo).
    const heroDeck = buildDeck(resolveDeckImages(
      { title: 'h', slides: [{ kind: 'image', variant: 'hero', title: 'T', imagePath: 'data/raw/shot.png', caption: 'C' }] },
      ws,
    ).payload)
    const heroEls = heroDeck.slides[0].elements
    const imgAt = heroEls.findIndex((e) => e.type === 'image')
    const plateAt = heroEls.findIndex((e) => e.type === 'rect')
    if (imgAt !== 0) throw new Error("the 'hero' photo must be the first element (full bleed, behind everything)")
    if (plateAt < imgAt) throw new Error("the 'hero' text plate must be painted over the photo, not under it")
    const plate = heroEls[plateAt] as Extract<typeof heroEls[number], { type: 'rect' }>
    if ((plate.fill.transparency ?? 0) > 20) throw new Error('the hero plate must stay near-opaque — it IS the contrast guarantee')

    fs.rmSync(ws, { recursive: true, force: true })
  }

  // Pango abort regression (2026-08-16, real crash): an emoji with forced
  // emoji presentation ("⚠️") in slide text made sharp's Pango request an
  // "emoji" font it cannot load — not an exception, an ABORT that killed the
  // whole app. renderDeckSheet must survive model-authored emoji; if the
  // sanitizer regresses, this call takes the test process down with exit 133.
  const keepSafe = 'Done ✓ · “quote” — 인지→전환'
  if (stripEmojiForPango(keepSafe) !== keepSafe) throw new Error('stripEmojiForPango ate a safe glyph')
  if (stripEmojiForPango('a ⚠️ b 🇰🇷 c 👨‍👩‍👧 d 1️⃣') !== 'a  b  c  d 1') throw new Error('stripEmojiForPango missed an emoji class')
  const emojiSheet = await renderDeckSheet({
    title: 'emoji regression', theme: 'twixy', slides: [
      { kind: 'cover', title: 'Launch ⚠️', subtitle: '🎯 targets', chips: ['🇰🇷 Korea'] },
      { kind: 'bullets', title: 'Risks ✔️', bullets: ['Budget ⚠️ tight', 'Step 1️⃣ pending'] },
    ],
  })
  if (emojiSheet.slideCount !== 2 || emojiSheet.png.length === 0) throw new Error('emoji sheet did not render')

  fs.rmSync(OUT, { recursive: true, force: true })
  if (dashMisses.length) {
    console.error(`${dashMisses.length} slides kept an em/en dash — buildDeck's strip did not reach the file:`)
    for (const m of dashMisses.slice(0, 10)) console.error('  ' + m)
    process.exit(1)
  }
  if (misses.length) {
    console.error(`${misses.length}/${checked} strings LOST:`)
    for (const m of misses.slice(0, 20)) console.error('  ' + m)
    if (misses.length > 20) console.error(`  … and ${misses.length - 20} more`)
    process.exit(1)
  }
  console.log(`round-trip OK — ${checked} strings recovered across ${FIXTURES.length} fixtures, 0 long dashes on any slide`)
}

main().catch((e) => { console.error(e); process.exit(1) })
