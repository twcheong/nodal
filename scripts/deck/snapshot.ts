// Deck snapshot oracle — the regression net for the layout-core refactor.
//
//   npx tsx scripts/deck/snapshot.ts            compare against the baseline
//   npx tsx scripts/deck/snapshot.ts --update   re-baseline (review the diff first!)
//
// Why a call recorder rather than diffing .pptx files: PPTX zips are not
// byte-stable, and a diff there tells you "something changed" without saying
// what. Recording the exact pptxgenjs calls pins every coordinate, colour and
// font, needs zero dependencies, and points at the offending element.
//
// pptxgenjs MUTATES the option objects handed to it (it stamps `_bodyProp` on
// them), so every recorded argument is deep-cloned AT RECORD TIME. Without that
// the snapshot would capture post-mutation state and drift on its own.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type PptxGenJS from 'pptxgenjs'
import { renderDeck } from '../../electron/tools/files/pptx'
import { FIXTURES } from './fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(HERE, 'baseline.json')

type Call = { m: string; args: unknown[] }
type RecordedSlide = { calls: Call[]; background?: unknown; notes?: string }
type RecordedDeck = { layout?: string; title?: string; slides: RecordedSlide[] }

/** Structured clone with a stable key order so the JSON diff is meaningful. */
function stable(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(stable)
  const o = v as Record<string, unknown>
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])]))
}

const CHART_TYPES = {
  bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area',
  bar3d: 'bar3d', bubble: 'bubble', radar: 'radar', scatter: 'scatter',
} as const

async function record(payload: Parameters<typeof renderDeck>[1]): Promise<RecordedDeck> {
  const deck: RecordedDeck = { slides: [] }

  // The recorded object and the stub handed to the renderer must be SEPARATE:
  // a property that only has a setter reads back as undefined, so recording
  // into the same object the renderer writes to would silently drop
  // `background` from the snapshot (it did — cover backgrounds went unverified).
  const makeSlide = () => {
    const rec: RecordedSlide = { calls: [] }
    const push = (m: string) => (...args: unknown[]) => { rec.calls.push({ m, args: args.map(stable) as unknown[] }) }
    const slide = {
      addText: push('addText'),
      addShape: push('addShape'),
      addImage: push('addImage'),
      addChart: push('addChart'),
      addTable: push('addTable'),
      addNotes: (t: string) => { rec.notes = t },
      set background(v: unknown) { rec.background = stable(v) },
    }
    return { rec, slide }
  }

  const pres = {
    set layout(v: string) { deck.layout = v },
    set title(v: string) { deck.title = v },
    ChartType: CHART_TYPES,
    addSlide: () => { const { rec, slide } = makeSlide(); deck.slides.push(rec); return slide },
  }

  await renderDeck(pres as unknown as PptxGenJS, payload)
  return deck
}

async function main() {
  const update = process.argv.includes('--update')
  const actual: Record<string, RecordedDeck> = {}
  for (const f of FIXTURES) actual[f.name] = await record(f.payload)

  const slideCount = Object.values(actual).reduce((n, d) => n + d.slides.length, 0)
  const callCount = Object.values(actual).reduce((n, d) => n + d.slides.reduce((m, s) => m + s.calls.length, 0), 0)

  if (update || !fs.existsSync(BASELINE)) {
    fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 1) + '\n', 'utf8')
    console.log(`baseline written: ${FIXTURES.length} fixtures, ${slideCount} slides, ${callCount} calls`)
    return
  }

  const expected = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, RecordedDeck>
  const diffs: string[] = []

  for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const e = expected[name]
    const a = actual[name]
    if (!e) { diffs.push(`${name}: NEW fixture (not in baseline)`); continue }
    if (!a) { diffs.push(`${name}: MISSING (baseline has it)`); continue }
    if (e.layout !== a.layout) diffs.push(`${name}: layout ${e.layout} → ${a.layout}`)
    if (e.title !== a.title) diffs.push(`${name}: title ${e.title} → ${a.title}`)
    if (e.slides.length !== a.slides.length) { diffs.push(`${name}: slide count ${e.slides.length} → ${a.slides.length}`); continue }
    e.slides.forEach((es, i) => {
      const as = a.slides[i]
      const at = `${name} slide ${i + 1}`
      if (JSON.stringify(es.background) !== JSON.stringify(as.background)) diffs.push(`${at}: background changed`)
      if (es.notes !== as.notes) diffs.push(`${at}: notes changed`)
      if (es.calls.length !== as.calls.length) { diffs.push(`${at}: ${es.calls.length} → ${as.calls.length} calls`); return }
      es.calls.forEach((ec, j) => {
        const ac = as.calls[j]
        if (ec.m !== ac.m) { diffs.push(`${at} call ${j}: ${ec.m} → ${ac.m}`); return }
        const es_ = JSON.stringify(ec.args)
        const as_ = JSON.stringify(ac.args)
        if (es_ !== as_) diffs.push(`${at} call ${j} (${ec.m}):\n    - ${es_}\n    + ${as_}`)
      })
    })
  }

  if (diffs.length === 0) {
    console.log(`0 diffs — ${FIXTURES.length} fixtures, ${slideCount} slides, ${callCount} calls`)
    return
  }
  console.error(`${diffs.length} diff(s):\n`)
  for (const d of diffs.slice(0, 40)) console.error('  ' + d)
  if (diffs.length > 40) console.error(`  … and ${diffs.length - 40} more`)
  console.error('\nIf these changes are intended, re-run with --update after reviewing.')
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
