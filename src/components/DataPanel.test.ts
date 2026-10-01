import { describe, it, expect } from 'vitest'
import { buildTable, toCSV, type TableData } from './DataPanel'

describe('buildTable', () => {
  it('parses CSV with headers and rows', () => {
    const t = buildTable('x.csv', 'a,b,c\n1,2,3\n4,5,6')!
    expect(t.headers).toEqual(['a', 'b', 'c'])
    expect(t.rows).toEqual([['1', '2', '3'], ['4', '5', '6']])
    expect(t.truncated).toBe(false)
  })

  it('pads short CSV rows to header width and trims long ones', () => {
    const t = buildTable('x.csv', 'a,b,c\n1\n1,2,3,4')!
    expect(t.rows[0]).toEqual(['1', '', ''])
    expect(t.rows[1]).toEqual(['1', '2', '3'])
  })

  it('parses TSV using tab delimiter', () => {
    const t = buildTable('x.tsv', 'a\tb\n1\t2')!
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['1', '2']])
  })

  it('parses JSON array of objects into a table', () => {
    const t = buildTable('x.json', JSON.stringify([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]))!
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['1', 'x'], ['2', 'y']])
  })

  it('fills missing keys in JSON rows with empty string', () => {
    // headers come from the first object; second object lacks b
    const t = buildTable('x.json', JSON.stringify([{ a: 1, b: 2 }, { a: 3 }]))!
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows[1]).toEqual(['3', ''])
  })

  it('renders a single JSON object as a Key/Value table', () => {
    const t = buildTable('x.json', JSON.stringify({ foo: 1, bar: 'baz' }))!
    expect(t.headers).toEqual(['Key', 'Value'])
    expect(t.rows).toEqual([['foo', '1'], ['bar', '"baz"']])
  })

  it('returns null for invalid JSON', () => {
    expect(buildTable('x.json', '{not json')).toBeNull()
  })

  it('returns null for JSON that is neither array-of-objects nor object', () => {
    expect(buildTable('x.json', '42')).toBeNull()
    expect(buildTable('x.json', '[]')).toBeNull()
  })

  it('parses the first markdown table', () => {
    const md = [
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
    ].join('\n')
    const t = buildTable('x.md', md)!
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['1', '2'], ['3', '4']])
  })

  it('handles markdown rows without outer pipes and pads short rows', () => {
    const md = 'a | b | c\n--- | --- | ---\n1 | 2'
    const t = buildTable('markdown', md)!
    expect(t.headers).toEqual(['a', 'b', 'c'])
    expect(t.rows[0]).toEqual(['1', '2', ''])
  })

  it('returns null when markdown has no table', () => {
    expect(buildTable('x.md', 'just some prose\nno table here')).toBeNull()
  })

  it('returns null for unsupported extensions', () => {
    expect(buildTable('x.txt', 'a,b\n1,2')).toBeNull()
    expect(buildTable('noext', 'a,b\n1,2')).toBeNull()
  })

  it('is case-insensitive on the extension', () => {
    const t = buildTable('X.CSV', 'a,b\n1,2')!
    expect(t.headers).toEqual(['a', 'b'])
  })
})

describe('toCSV', () => {
  const mk = (headers: string[], rows: string[][]): TableData => ({ headers, rows, truncated: false })

  it('joins headers and rows with commas and newlines', () => {
    expect(toCSV(mk(['a', 'b'], [['1', '2'], ['3', '4']]))).toBe('a,b\n1,2\n3,4')
  })

  it('quotes and doubles embedded quotes', () => {
    expect(toCSV(mk(['a'], [['he said "hi"']]))).toBe('a\n"he said ""hi"""')
  })

  it('quotes values containing commas', () => {
    expect(toCSV(mk(['a'], [['x,y']]))).toBe('a\n"x,y"')
  })

  it('quotes values containing newlines', () => {
    expect(toCSV(mk(['a'], [['line1\nline2']]))).toBe('a\n"line1\nline2"')
  })

  it('leaves plain values unquoted', () => {
    expect(toCSV(mk(['name'], [['plain']]))).toBe('name\nplain')
  })

  it('emits only the header line when there are no rows', () => {
    expect(toCSV(mk(['a', 'b'], []))).toBe('a,b')
  })

  it('round-trips through buildTable for simple data', () => {
    const original = mk(['a', 'b'], [['1', '2'], ['3', '4']])
    const reparsed = buildTable('x.csv', toCSV(original))!
    expect(reparsed.headers).toEqual(original.headers)
    expect(reparsed.rows).toEqual(original.rows)
  })

  it('quotes values containing carriage returns', () => {
    expect(toCSV(mk(['a'], [['x\ry']]))).toBe('a\n"x\ry"')
  })

  it('ignores the truncated flag when serialising', () => {
    const data: TableData = { headers: ['a'], rows: [['1']], truncated: true }
    expect(toCSV(data)).toBe('a\n1')
  })
})

describe('buildTable truncation and edge cases', () => {
  const MAX = 200

  it('caps CSV rows at MAX_ROWS and marks truncated', () => {
    const body = Array.from({ length: MAX + 50 }, (_, i) => `${i}`).join('\n')
    const t = buildTable('x.csv', `h\n${body}`)!
    expect(t.rows.length).toBe(MAX)
    expect(t.truncated).toBe(true)
  })

  it('does not mark truncated when exactly at MAX_ROWS', () => {
    const body = Array.from({ length: MAX }, (_, i) => `${i}`).join('\n')
    const t = buildTable('x.csv', `h\n${body}`)!
    expect(t.rows.length).toBe(MAX)
    expect(t.truncated).toBe(false)
  })

  it('caps JSON array rows at MAX_ROWS and marks truncated', () => {
    const arr = Array.from({ length: MAX + 10 }, (_, i) => ({ a: i }))
    const t = buildTable('x.json', JSON.stringify(arr))!
    expect(t.rows.length).toBe(MAX)
    expect(t.truncated).toBe(true)
  })

  it('parses markdown separators with alignment colons', () => {
    const md = '| a | b |\n| :--- | ---: |\n| 1 | 2 |'
    const t = buildTable('x.md', md)!
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['1', '2']])
  })

  it('returns only the first table when markdown has several', () => {
    const md = [
      '| a | b |', '| --- | --- |', '| 1 | 2 |',
      '', 'prose', '',
      '| c | d |', '| --- | --- |', '| 9 | 8 |',
    ].join('\n')
    const t = buildTable('x.md', md)!
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['1', '2']])
  })
})
