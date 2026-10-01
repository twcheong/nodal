// Post-export self-check: read the file we JUST wrote back with our own
// importer and assert the content survived.
//
// Anthropic's pptx skill runs an XSD validator over its output; ours is
// stronger in practice and cheaper — a schema-valid file can still have lost
// text, but a file that our scanner reads back with every visible string
// present both opens and says what it was told to say. Failure never deletes
// the file: the caller reports it and the user can still inspect the output.
//
// Kept out of pptx.ts so the writer does not import the reader (pptxRead is a
// separate module by design).

import { readPptx } from './pptxRead'
import { visibleTexts } from '../../../shared/deck/visibleTexts'
import type { WritePptxPayload } from '../../../shared/deck/spec'

export type DeckVerify =
  | { ok: true; slides: number; strings: number }
  | { ok: false; reason: string }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export async function verifyWritten(absPath: string, payload: WritePptxPayload): Promise<DeckVerify> {
  try {
    const r = await readPptx(absPath)
    if (r.slideCount !== payload.slides.length) {
      return { ok: false, reason: `wrote ${payload.slides.length} slides but the file reads back ${r.slideCount}` }
    }

    let strings = 0
    const missing: string[] = []
    payload.slides.forEach((spec, i) => {
      const s = r.slides[i]
      const got = norm([
        s.title ?? '', ...s.body.map((b) => b.text), s.notes ?? '',
        ...(s.table ? [...s.table.headers, ...s.table.rows.flat()] : []),
      ].join(' '))
      for (const want of visibleTexts(spec)) {
        strings++
        if (!got.includes(norm(want))) missing.push(`slide ${i + 1}: "${norm(want).slice(0, 40)}"`)
      }
    })

    if (missing.length) {
      return { ok: false, reason: `${missing.length}/${strings} strings missing from the file — ${missing.slice(0, 3).join(' · ')}` }
    }
    return { ok: true, slides: r.slideCount, strings }
  } catch (err) {
    return { ok: false, reason: `file does not read back: ${String(err instanceof Error ? err.message : err)}` }
  }
}
