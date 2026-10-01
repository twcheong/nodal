// Exercise every pptxEdit operation against (a) a deck our own writer produced
// and (b) the real hand-made pitch deck in docs/pitch-materials — a file
// PowerPoint wrote, with masters/media/layouts we did not generate.
//
//   npx tsx scripts/deck/edit-roundtrip.ts
//
// Assertions go through readPptx — the same scanner the runtime verify uses.
// This is the edit path's whole safety story: an edit that survives this
// script produced a file that opens and says what it should.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePptx } from '../../electron/tools/files/pptx'
import { readPptx } from '../../electron/tools/files/pptxRead'
import { editPptx, type PptxEditOp } from '../../electron/tools/files/pptxEdit'
import { ensureFixtureImage, FIXTURES } from './fixtures'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-edit-'))
const verify = async (p: string) => ({ slideCount: (await readPptx(p)).slideCount })

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { console.log(`  ok  ${name}`) } else { failures++; console.error(`  FAIL ${name} ${detail}`) }
}

async function editCase(name: string, src: string, ops: PptxEditOp[]) {
  const dest = path.join(OUT, `${name}.pptx`)
  const r = await editPptx(src, dest, ops, verify)
  return { r, read: await readPptx(dest) }
}

async function main() {
  // 픽스처가 참조하는 PNG 를 이 자리에서 만든다 — /tmp 가 비워진 기계에서도
  // 이미지 경로 해석이 진짜로 검사되도록(예전엔 아무도 안 만들어 그냥 깨졌다).
  ensureFixtureImage()
  // ── (a) our own writer's output ────────────────────────────────────────────
  const fixture = FIXTURES.find((f) => f.name === 'theme-twixy')!
  const ours = path.join(OUT, 'ours.pptx')
  await writePptx(ours, fixture.payload)
  const base = await readPptx(ours)
  console.log(`ours.pptx — ${base.slideCount} slides`)

  {
    const { read } = await editCase('ours-replace', ours, [
      { op: 'replaceText', slide: 1, find: '2026 상반기 마케팅 리뷰', replace: '2026 H2 REVISED' },
    ])
    check('replaceText on own deck', JSON.stringify(read.slides[0]).includes('2026 H2 REVISED'))
  }
  {
    const { read } = await editCase('ours-dup', ours, [{ op: 'duplicateSlide', slide: 1 }])
    check('duplicateSlide count', read.slideCount === base.slideCount + 1, `got ${read.slideCount}`)
    check('duplicate is a copy', (read.slides[1].title ?? '') === (read.slides[0].title ?? ''))
  }
  {
    const { read } = await editCase('ours-del', ours, [{ op: 'deleteSlide', slide: 2 }])
    check('deleteSlide count', read.slideCount === base.slideCount - 1, `got ${read.slideCount}`)
    check('slide 2 gone', (read.slides[1].title ?? '') !== (base.slides[1].title ?? ''))
  }
  {
    const order = Array.from({ length: base.slideCount }, (_, i) => i + 1)
    ;[order[0], order[1]] = [order[1], order[0]]
    const { read } = await editCase('ours-reorder', ours, [{ op: 'reorderSlides', order }])
    check('reorder swapped 1↔2', (read.slides[0].title ?? '') === (base.slides[1].title ?? ''))
  }
  {
    const { read } = await editCase('ours-notes', ours, [{ op: 'setNotes', slide: 1, notes: 'REPLACED NOTES LINE' }])
    check('setNotes', (read.slides[0].notes ?? '').includes('REPLACED NOTES LINE'), `got "${read.slides[0].notes}"`)
  }
  {
    // Failure modes must be loud and precise.
    let msg = ''
    try { await editCase('ours-miss', ours, [{ op: 'replaceText', slide: 1, find: 'NOT ON THE SLIDE', replace: 'x' }]) }
    catch (e) { msg = String(e) }
    check('replaceText miss is loud', msg.includes('not found on slide 1'), msg)
    try { await editCase('ours-badorder', ours, [{ op: 'reorderSlides', order: [1, 1] }]); msg = '' }
    catch (e) { msg = String(e) }
    check('bad order rejected', msg.includes('permutation'), msg)
  }

  // ── (b) a real PowerPoint-authored deck ────────────────────────────────────
  const pitch = path.join(ROOT, 'docs/pitch-materials/Twixy-Pitch-Deck.pptx')
  if (fs.existsSync(pitch)) {
    const pbase = await readPptx(pitch)
    console.log(`Twixy-Pitch-Deck.pptx — ${pbase.slideCount} slides`)
    const anchor = pbase.slides[0].title ?? pbase.slides[0].body[0]?.text
    check('pitch deck has an anchor string', !!anchor)
    if (anchor) {
      const { read } = await editCase('pitch-replace', pitch, [
        { op: 'replaceText', slide: 1, find: anchor.split(' ')[0], replace: 'EDITED' },
        { op: 'duplicateSlide', slide: 2 },
        { op: 'deleteSlide', slide: pbase.slideCount + 1 },
      ])
      check('pitch edit chain survives', read.slideCount === pbase.slideCount, `got ${read.slideCount}`)
      check('pitch text replaced', JSON.stringify(read.slides[0]).includes('EDITED'))
    }
  } else {
    console.log('(pitch deck not present — skipping the real-file leg)')
  }

  fs.rmSync(OUT, { recursive: true, force: true })
  if (failures) { console.error(`\n${failures} edit-roundtrip failure(s)`); process.exit(1) }
  console.log('\nedit round-trip OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
