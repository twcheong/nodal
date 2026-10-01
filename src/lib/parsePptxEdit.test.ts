import { describe, it, expect } from 'vitest'
import { parsePptxEditBlock, stripPptxEditBlocks, pptxEditOrderWarnings, describePptxEditOp } from './parsePptxEdit'

const wrap = (json: string) => `Done.\n\n\`\`\`pptx-edit\n${json}\n\`\`\`\n`

describe('parsePptxEditBlock', () => {
  it('returns none when there is no block', () => {
    expect(parsePptxEditBlock('just chat')).toEqual({ status: 'none' })
  })

  it('parses every op kind', () => {
    const r = parsePptxEditBlock(wrap(JSON.stringify({ ops: [
      { op: 'replaceText', slide: 3, find: 'Old', replace: 'New' },
      { op: 'setNotes', slide: 1, notes: 'say this' },
      { op: 'duplicateSlide', slide: 2, after: 5 },
      { op: 'deleteSlide', slide: 4 },
      { op: 'reorderSlides', order: [2, 1, 3] },
    ] })))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.ops).toHaveLength(5)
    expect(r.ops[2]).toEqual({ op: 'duplicateSlide', slide: 2, after: 5 })
    expect(r.outRelPath).toBeUndefined()
  })

  it('rejects invalid JSON with a reason', () => {
    const r = parsePptxEditBlock(wrap('{ ops: [ }'))
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.error).toMatch(/not valid JSON/)
  })

  it('rejects an empty ops array', () => {
    const r = parsePptxEditBlock(wrap('{ "ops": [] }'))
    expect(r.status).toBe('invalid')
  })

  it('names the failing op and field', () => {
    const r = parsePptxEditBlock(wrap(JSON.stringify({ ops: [
      { op: 'replaceText', slide: 1, find: 'a', replace: 'b' },
      { op: 'replaceText', slide: 0, find: 'a', replace: 'b' },
    ] })))
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.error).toMatch(/^ops\[1\]: replaceText needs a 1-based "slide"/)
  })

  it('rejects unknown ops', () => {
    const r = parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'insertChart', slide: 1 }] })))
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.error).toMatch(/unknown op "insertChart"/)
  })

  it('requires reorderSlides to be a full permutation', () => {
    expect(parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'reorderSlides', order: [1, 1, 2] }] }))).status).toBe('invalid')
    expect(parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'reorderSlides', order: [1, 3] }] }))).status).toBe('invalid')
    expect(parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'reorderSlides', order: [3, 1, 2] }] }))).status).toBe('ok')
  })

  it('parses setText and insertSlide', () => {
    const r = parsePptxEditBlock(wrap(JSON.stringify({ ops: [
      { op: 'setText', slide: 2, shape: 3, paragraphs: ['a', 'b'] },
      { op: 'insertSlide', layout: 'Title and Content', after: 2, fill: { title: 'T', body: ['x'] } },
      { op: 'insertSlide', layout: 4 },
    ] })))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.ops[0]).toEqual({ op: 'setText', slide: 2, shape: 3, paragraphs: ['a', 'b'] })
    expect(r.ops[1]).toEqual({ op: 'insertSlide', layout: 'Title and Content', after: 2, fill: { title: 'T', body: ['x'] } })
    expect(r.ops[2]).toEqual({ op: 'insertSlide', layout: 4 })
  })

  it('rejects setText without paragraphs and insertSlide without a layout', () => {
    expect(parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'setText', slide: 1, shape: 1, paragraphs: [] }] }))).status).toBe('invalid')
    expect(parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'insertSlide' }] }))).status).toBe('invalid')
    expect(parsePptxEditBlock(wrap(JSON.stringify({ ops: [{ op: 'insertSlide', layout: 1, fill: { body: 'not-an-array' } }] }))).status).toBe('invalid')
  })

  it('accepts outRelPath only when it ends in .pptx', () => {
    const ok = parsePptxEditBlock(wrap(JSON.stringify({ outRelPath: 'output/copy.pptx', ops: [{ op: 'deleteSlide', slide: 1 }] })))
    expect(ok.status).toBe('ok')
    if (ok.status === 'ok') expect(ok.outRelPath).toBe('output/copy.pptx')
    const bad = parsePptxEditBlock(wrap(JSON.stringify({ outRelPath: 'output/copy.potx', ops: [{ op: 'deleteSlide', slide: 1 }] })))
    expect(bad.status).toBe('invalid')
  })
})

describe('stripPptxEditBlocks', () => {
  it('removes the fence and keeps the prose', () => {
    expect(stripPptxEditBlocks(wrap('{ "ops": [] }'))).toBe('Done.')
  })
})

describe('pptxEditOrderWarnings', () => {
  it('is quiet when structural ops come first', () => {
    expect(pptxEditOrderWarnings([
      { op: 'deleteSlide', slide: 5 },
      { op: 'reorderSlides', order: [2, 1, 3, 4] },
      { op: 'replaceText', slide: 1, find: 'a', replace: 'b' },
    ])).toEqual([])
  })

  it('treats insertSlide as structural and setText as content', () => {
    expect(pptxEditOrderWarnings([
      { op: 'setText', slide: 1, shape: 1, paragraphs: ['a'] },
      { op: 'insertSlide', layout: 1 },
    ])).toHaveLength(1)
    expect(pptxEditOrderWarnings([
      { op: 'insertSlide', layout: 1 },
      { op: 'setText', slide: 1, shape: 1, paragraphs: ['a'] },
    ])).toEqual([])
  })

  it('warns when a structural op follows a text edit', () => {
    const w = pptxEditOrderWarnings([
      { op: 'replaceText', slide: 2, find: 'a', replace: 'b' },
      { op: 'duplicateSlide', slide: 2 },
    ])
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/ops\[1\] duplicateSlide comes after a text edit/)
  })
})

describe('describePptxEditOp', () => {
  it('summarises each op in one line', () => {
    expect(describePptxEditOp({ op: 'replaceText', slide: 3, find: 'Old', replace: 'New' })).toBe('Slide 3: "Old" → "New"')
    expect(describePptxEditOp({ op: 'reorderSlides', order: [2, 1] })).toBe('Reorder → 2, 1')
  })
})
