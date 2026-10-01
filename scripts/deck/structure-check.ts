// Behavior check for structureReport — the purpose layer's only output.
//
//   npx tsx scripts/deck/structure-check.ts   (part of `npm run check:deck`)
//
// The snapshot oracle cannot see `structure` (the recorder keeps pptxgenjs
// calls only), so the page tables' behavior is pinned here instead: a
// well-formed deck per purpose yields ZERO purpose notes, and each deliberate
// break yields exactly the note that names it. A page table that flags a
// correct deck is worse than no check — the model would learn to pad.

import { buildDeck } from '../../shared/deck/layout'
import { deriveTheme, PPTX_THEMES, resolveRoles } from '../../shared/deck/theme'
import { contrast, parseHex } from '../../shared/deck/color'
import type { SlideSpec, WritePptxPayload, PurposeId } from '../../shared/deck/spec'
import { FIXTURES } from './fixtures'

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.error(`  FAIL ${name} ${detail}`) }
}

const S = (kind: string, extra: Record<string, unknown> = {}): SlideSpec =>
  ({ kind, ...extra } as unknown as SlideSpec)

const chart = (title: string) => S('chart', { title, chartType: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }], takeaway: 't' })
const stats = () => S('stats', { items: [{ value: '+34%', label: 'growth' }, { value: '2.8x', label: 'ROAS' }] })
const table = (title: string) => S('table', { title, headers: ['k', 'v'], rows: [['a', 1]] })
const bullets = (title: string) => S('bullets', { title, bullets: ['one', 'two'] })
const summary = () => S('summary', { takeaways: ['a', 'b'] })

/** One well-formed deck per purpose — must produce NO purpose notes. */
const GOOD: Record<PurposeId, SlideSpec[]> = {
  pitch: [
    S('cover', { title: 'Win Lumea' }), stats(), bullets('What is broken'),
    S('timeline', { steps: [{ label: 'w1' }, { label: 'w2' }] }), S('quote', { text: 'proof quote' }),
    table('Offer'), summary(),
  ],
  report: [
    S('cover', { title: 'August' }), stats(), S('section', { number: 1, title: 'IG' }),
    chart('IG reach'), table('YT numbers'), S('compare', { left: { title: 'A', bullets: ['x'] }, right: { title: 'B', bullets: ['y'] } }),
    summary(),
  ],
  decide: [
    S('cover', { title: 'Choose the budget split' }), S('text', { body: 'question, deadline, decider' }),
    S('compare', { left: { title: 'Option A', bullets: ['x'] }, right: { title: 'Option B', bullets: ['y'] } }),
    chart('Cost per option'), S('text', { body: 'we pick A because…' }), summary(),
  ],
  align: [
    S('cover', { title: 'Halden kickoff' }), S('text', { body: 'the goal line' }),
    S('layout', { blocks: [{ body: { type: 'heading', text: 'the picture' } }] }),
    table('Roles'), S('timeline', { steps: [{ label: 'kickoff' }, { label: 'launch' }] }), summary(),
  ],
  analyze: [
    S('cover', { title: 'Why did reach drop?' }), S('text', { body: 'the question' }),
    chart('Finding 1'), table('Finding 2'), S('compare', { left: { title: 'p', bullets: ['x'] }, right: { title: 'q', bullets: ['y'] } }),
    S('quote', { text: 'the implication' }), summary(),
  ],
  teach: [
    S('cover', { title: 'Write hooks that stop the scroll' }), bullets('After this you can'),
    S('layout', { blocks: [{ body: { type: 'paragraph', text: 'mental model' } }] }),
    S('timeline', { steps: [{ label: 's1' }, { label: 's2' }] }), S('image', { imagePath: 'x.png' }),
    bullets('Checklist'), summary(),
  ],
}

const build = (purpose: string | undefined, slides: SlideSpec[]) =>
  buildDeck({ title: 'T', purpose, slides } as WritePptxPayload)

function main() {
  console.log('purpose tables — well-formed decks:')
  for (const [id, slides] of Object.entries(GOOD)) {
    // Purpose notes start with the backticked id or are order inversions;
    // geometry notes may legitimately fire on these tiny fixtures.
    const purposeNotes = build(id, slides).structure.filter((n) => n.startsWith('`') || /comes before/.test(n))
    check(`${id}: zero purpose notes`, purposeNotes.length === 0, `got: ${JSON.stringify(purposeNotes)}`)
  }

  console.log('deliberate breaks:')
  {
    // decide without an options page
    const broken = GOOD.decide.filter((s) => s.kind !== 'compare')
    const notes = build('decide', broken).structure
    check('decide w/o options is named', notes.some((n) => n.includes("'options'")), JSON.stringify(notes))
  }
  {
    // recommend before options — order inversion
    const d = [...GOOD.decide]
    const rec = d.splice(4, 1)[0]   // the 'we pick A' text
    d.splice(1, 0, rec)             // right after cover, before compare
    const notes = build('decide', d).structure
    check('recommend-before-options inversion', notes.some((n) => /comes before/.test(n)), JSON.stringify(notes))
  }
  {
    // report with one result page (needs 2+)
    const r = GOOD.report.filter((s) => !(s.kind === 'table'))
    const notes = build('report', r).structure
    check('report short on results', notes.some((n) => n.includes("'result'") || n.includes("'driver'")), JSON.stringify(notes))
  }
  {
    // unknown purpose = hard error
    let threw = ''
    try { build('sales', GOOD.pitch) } catch (e) { threw = String(e) }
    check('unknown purpose throws', threw.includes('Unknown purpose'), threw)
  }
  {
    // no purpose + 6 slides → nudge + legacy skeleton. The old "no section
    // divider" line is GONE by design (divider pages are filler in decks this
    // size — the user called them out on Claude's 8-divider deck).
    const notes = build(undefined, GOOD.report).structure
    check('no-purpose nudge', notes.some((n) => n.includes('no purpose declared')), JSON.stringify(notes))
    check('no divider nudge', !notes.some((n) => n.includes('section divider')), JSON.stringify(notes))
  }
  {
    // divider pages are reported by CODE — the prompt asked twice and a
    // 17-slide deck still shipped five of them.
    const withDiv = [
      S('cover', { title: 'x' }), S('section', { number: 1, title: 'Part one' }), chart('a'),
      S('section', { number: 2, title: 'Part two' }), chart('b'), summary(),
    ]
    const notes = build(undefined, withDiv).structure
    check('divider pages are reported', notes.some((n) => n.includes('divider page') && n.includes('2, 4')), JSON.stringify(notes))
    const noDiv = build(undefined, [S('cover', { title: 'x' }), chart('a'), chart('b'), summary()]).structure
    check('no divider note when clean', !noDiv.some((n) => n.includes('divider page')), JSON.stringify(noDiv))
  }
  {
    // an all-prose deck gets the graphic-device note; one chart clears it
    const prose = [
      S('cover', { title: 'x' }), bullets('a'), S('text', { title: 'b', body: 'y' }),
      bullets('c'), S('text', { title: 'd', body: 'z' }), summary(),
    ]
    const notes = build(undefined, prose).structure
    check('all-prose deck is flagged', notes.some((n) => n.includes('graphic device')), JSON.stringify(notes))
    const withChart = [...prose.slice(0, 5), chart('e'), summary()]
    const notes2 = build(undefined, withChart).structure
    check('one graphic page clears the flag', !notes2.some((n) => n.includes('graphic device')), JSON.stringify(notes2))
  }
  {
    // geometry: three identical faces in a row. Variants are EXPLICIT here —
    // unset ones get rotated apart by the seed, which is the feature, but this
    // test pins the author who insists on the same face three times.
    const sameChart = (t: string) => S('chart', { variant: 'full', title: t, chartType: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }] })
    const notes = build('report', [
      S('cover', { title: 'x' }), stats(), sameChart('a'), sameChart('b'), sameChart('c'), S('compare', { left: { title: 'a', bullets: ['x'] }, right: { title: 'b', bullets: ['y'] } }), summary(),
    ]).structure
    check('3-in-a-row same face', notes.some((n) => n.includes('same geometry')), JSON.stringify(notes))
  }
  {
    // and the rotation DOES break up three unset charts — the feature itself
    const notes = build('report', [
      S('cover', { title: 'x' }), stats(), chart('a'), chart('b'), chart('c'), S('compare', { left: { title: 'a', bullets: ['x'] }, right: { title: 'b', bullets: ['y'] } }), summary(),
    ]).structure
    check('rotation breaks up unset run', !notes.some((n) => n.includes('same geometry')), JSON.stringify(notes))
  }

  {
    // Slide-level required fields fail by NAME too. Real spec (2026-08-17):
    // `summary` with nextSteps but no takeaways died as "Cannot read
    // properties of undefined (reading 'length')" — the exact unlocatable
    // error assertBlockBody had already fixed one level down.
    let msg = ''
    try {
      build(undefined, [S('summary', { title: 'Next', variant: 'split', nextSteps: ['a'] })])
    } catch (e) { msg = String(e) }
    check('missing required field is named', msg.includes('missing required field `takeaways`') && msg.includes('slide 1 (summary)'), msg)
    try {
      build(undefined, [S('summary', { takeaways: 'not an array' })]); msg = ''
    } catch (e) { msg = String(e) }
    check('wrong-typed collection is named', msg.includes('`takeaways` must be an array'), msg)
  }

  {
    // layout block-body contract fails by NAME with slide locality — the QA
    // round once patched in { type:'kv', label, text } and the whole preview
    // died as an unlocatable TypeError.
    let msg = ''
    try {
      build(undefined, [S('layout', { title: 'x', blocks: [{ span: 4, body: { type: 'kv', label: 'A', text: 'b' } }] })])
    } catch (e) { msg = String(e) }
    check('bad kv block fails by name', msg.includes("('kv') needs `rows:") && msg.includes('slide 1 (layout)'), msg)
    try {
      build(undefined, [S('layout', { blocks: [{ body: { type: 'hero', text: 'x' } }] })]); msg = ''
    } catch (e) { msg = String(e) }
    check('unknown block type is named', msg.includes("unknown body type 'hero'"), msg)
  }

  // ── hero plate: readable over the brightest possible photo ────────────────
  // The hero face puts text on a plate that is 92% `primary`, 8% photo. We
  // never see the photo, so the check assumes the worst one: pure white. If
  // that composite still clears 4.5:1 against `onPrimary`, no picture can make
  // the title unreadable — which is the whole reason the plate exists instead
  // of a semi-transparent scrim.
  {
    const BLEED = 0.08                     // must match layoutImage's hero plate
    const over = (hex: string, alpha: number): string => {
      const { r, g, b } = parseHex(hex)
      const mix = (c: number) => Math.round(c * (1 - alpha) + 255 * alpha)
      return [mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
    }
    for (const [name, theme] of Object.entries(PPTX_THEMES)) {
      const roles = resolveRoles(theme)
      const plate = over(theme.primary, BLEED)
      const ratio = contrast(roles.onPrimary, plate)
      check(`hero plate on ${name} (worst-case white photo)`, ratio >= 4.5, `${ratio.toFixed(2)}:1`)
    }
  }

  // ── typography: no em/en dash anywhere on a slide ─────────────────────────
  // Two sources, two fixes: the SPEC's prose (stripped in buildDeck) and text
  // the PAINTERS compose themselves (quote attribution used to be `— Name`).
  // Only a scan of the finished display list sees both, which is why the check
  // lives here and not next to the strip.
  {
    const offenders: string[] = []
    for (const f of FIXTURES) {
      buildDeck(f.payload).slides.forEach((sl, i) => {
        for (const el of sl.elements) {
          const text = (el.type === 'text' ? el.runs.map((r) => r.text).join('') : '')
          if (/[—–―]/.test(text)) offenders.push(`${f.name} slide ${i + 1}: ${JSON.stringify(text.slice(0, 40))}`)
        }
      })
    }
    check(`no long dash on any slide (${FIXTURES.length} fixtures)`, offenders.length === 0, offenders.slice(0, 5).join(' · '))
  }

  // ── brand derivation — contrast safety over hexes that break naive math ────
  // The snapshot cannot judge readability; these assertions can. The four
  // nasty ones: pure yellow, near-black, pale pink, grey (no saturation).
  console.log('brand-derived contrast:')
  const HEXES = ['FF5A5F', 'FFD400', '111111', 'FFD9E8', '888888', '0B2545', '2A9D8F', '7C6AFF', 'E76F51', '3A5A40', 'FF00FF', '00CED1']
  for (const bx of HEXES) {
    for (const base of ['twixy', 'night']) {
      const t = deriveTheme(bx, PPTX_THEMES[base as 'twixy'])
      const bad: string[] = []
      if (contrast(t.muted, t.bg) < 4.5) bad.push(`muted/bg ${contrast(t.muted, t.bg).toFixed(2)}`)
      if (contrast(t.onAccent!, t.accent) < 4.5) bad.push(`onAccent/accent ${contrast(t.onAccent!, t.accent).toFixed(2)}`)
      if (contrast(t.onLight!, t.light) < 4.5) bad.push(`onLight/light ${contrast(t.onLight!, t.light).toFixed(2)}`)
      if (contrast(t.ink, t.bg) < 7) bad.push(`ink/bg ${contrast(t.ink, t.bg).toFixed(2)}`)
      check(`#${bx} on ${base}`, bad.length === 0, bad.join(', '))
    }
  }
  {
    // Presets must be untouched by the brand machinery (baseline invariant).
    const before = JSON.stringify(PPTX_THEMES.twixy)
    void deriveTheme('FF5A5F', PPTX_THEMES.twixy)
    check('deriveTheme does not mutate presets', JSON.stringify(PPTX_THEMES.twixy) === before)
  }

  if (failures) { console.error(`\n${failures} structure-check failure(s)`); process.exit(1) }
  console.log('\nstructure check OK')
}

main()
