import { describe, it, expect } from 'vitest'
import { normalizeTags, rankShared, type SharedWorkflowRow } from './sharedWorkflows'

describe('normalizeTags', () => {
  it('trims, lowercases, and dedupes', () => {
    expect(normalizeTags([' SEO ', 'seo', 'Content'])).toEqual(['seo', 'content'])
  })

  it('drops empty / whitespace-only tags', () => {
    expect(normalizeTags(['', '   ', 'seo'])).toEqual(['seo'])
  })

  it('caps at 5 tags', () => {
    expect(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ])
  })

  it('truncates each tag to 24 chars (before dedupe/compare)', () => {
    const long = 'x'.repeat(30)
    const out = normalizeTags([long])
    expect(out).toEqual(['x'.repeat(24)])
    expect(out[0].length).toBe(24)
  })

  it('dedupes tags that collide only after truncation', () => {
    const a = 'y'.repeat(24) + 'AAA'
    const b = 'y'.repeat(24) + 'BBB'
    expect(normalizeTags([a, b])).toEqual(['y'.repeat(24)])
  })

  it('returns empty array for empty input', () => {
    expect(normalizeTags([])).toEqual([])
  })

  it('stops at 5 even when later duplicates would collapse (break is post-push)', () => {
    // 5 distinct tags reached -> loop breaks before considering the 6th.
    expect(normalizeTags(['a', 'b', 'c', 'd', 'e', 'a'])).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ])
  })
})

function row(p: Partial<SharedWorkflowRow>): SharedWorkflowRow {
  return {
    id: 'id', org_id: 'o', owner_user_id: 'u', owner_email: null,
    owner_name: null, source_wf_id: 's', title: 't', description: null,
    workflow_json: {} as SharedWorkflowRow['workflow_json'], tags: [],
    copy_count: 0, run_count: 0, last_used_at: null,
    created_at: '', updated_at: '',
    archived_at: null, archived_by: null, // 보관 안 된(활성) 행이 기본
    ...p,
  }
}

describe('rankShared', () => {
  it('weights copy (x3) heavier than run (x1)', () => {
    // A: 1 copy => score 3. B: 2 runs => score 2. A should rank first.
    const a = row({ id: 'a', copy_count: 1, run_count: 0 })
    const b = row({ id: 'b', copy_count: 0, run_count: 2 })
    expect(rankShared([b, a]).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('sorts by combined weighted score descending', () => {
    const a = row({ id: 'a', copy_count: 0, run_count: 1 })   // 1
    const b = row({ id: 'b', copy_count: 2, run_count: 1 })   // 7
    const c = row({ id: 'c', copy_count: 1, run_count: 0 })   // 3
    expect(rankShared([a, b, c]).map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('breaks ties by last_used_at descending', () => {
    const older = row({ id: 'older', copy_count: 1, last_used_at: '2020-01-01' })
    const newer = row({ id: 'newer', copy_count: 1, last_used_at: '2024-01-01' })
    expect(rankShared([older, newer]).map(r => r.id)).toEqual(['newer', 'older'])
  })

  it('treats null last_used_at as lowest in tie-break', () => {
    const withDate = row({ id: 'd', run_count: 1, last_used_at: '2021-06-01' })
    const noDate = row({ id: 'n', run_count: 1, last_used_at: null })
    expect(rankShared([noDate, withDate]).map(r => r.id)).toEqual(['d', 'n'])
  })

  it('does not mutate the input array', () => {
    const input = [
      row({ id: 'a', copy_count: 0 }),
      row({ id: 'b', copy_count: 5 }),
    ]
    const snapshot = input.map(r => r.id)
    rankShared(input)
    expect(input.map(r => r.id)).toEqual(snapshot)
  })

  it('returns empty for empty input', () => {
    expect(rankShared([])).toEqual([])
  })
})
