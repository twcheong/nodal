// Renders the REAL SlidePreview component to a static HTML page so the SVG
// painter can be eyeballed without booting the app.
//
//   npx tsx scripts/deck/preview-html.tsx [outfile]

import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildDeck } from '../../shared/deck/layout'
import { SlidePreview } from '../../src/components/copilot/deck/SlidePreview'
import { FIXTURES } from './fixtures'

const out = process.argv[2] ?? path.join(process.cwd(), 'tmp', 'deck-preview.html')

const decks = FIXTURES.filter((f) => ['theme-twixy', 'theme-night', 'theme-charts', 'style-sharp', 'style-pill', 'legacy-payload', 'variants-twixy', 'variants-night', 'composite-navy', 'composite-night'].includes(f.name))

const sections = decks.map((f) => {
  const deck = buildDeck(f.payload)
  const slides = deck.slides
    .map((s) => `<figure><figcaption>${s.index + 1} · ${(f.payload.slides[s.index] as { kind: string }).kind}${
      s.warnings.length ? ` <b>⚠ ${s.warnings.map((w) => w.code).join(', ')}</b>` : ''
    }</figcaption>${renderToStaticMarkup(createElement(SlidePreview, { slide: s, width: 420 }))}</figure>`)
    .join('\n')
  return `<h2>${f.name}</h2><div class="grid">${slides}</div>`
}).join('\n')

const html = `<!doctype html><meta charset="utf-8"><title>Deck preview</title>
<style>
 body{font:13px -apple-system,'Apple SD Gothic Neo',sans-serif;background:#EEEDEA;margin:0;padding:24px 32px 64px}
 h2{margin:28px 0 10px;font-size:15px}
 .grid{display:flex;flex-wrap:wrap;gap:14px}
 figure{margin:0}
 figcaption{font-size:10px;color:#777;margin-bottom:4px}
 figcaption b{color:#b8501e}
</style>
<h1 style="font-size:18px">SlidePreview — SVG painter over the shared layout core</h1>
<p style="color:#777;margin:0 0 8px">Same El[] the pptx exporter paints. Charts are an explicit approximation.</p>
${sections}`

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log(`wrote ${out} (${decks.length} decks, ${decks.reduce((n, f) => n + f.payload.slides.length, 0)} slides)`)
