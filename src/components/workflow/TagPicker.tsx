// ─────────────────────────────────────────────────────────────────────────────
// TagPicker.tsx — 태그를 토글 버튼으로 고르는 컨트롤 (자유 텍스트 입력 대체).
//
// 옵션 = 전달된 palette(기본 태그 ∪ 이미 org 에서 쓰인 태그) ∪ 현재 선택값.
// 클릭으로 on/off. 팔레트에 없는 새 태그는 "+ 추가"로 넣을 수 있고, 넣는 즉시
// 버튼으로 나타난다. 선택 상한은 normalizeTags(8개)가 상위에서 강제.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react'

interface Props {
  value:   string[]
  palette: string[]
  onChange: (tags: string[]) => void
  allowAdd?: boolean
  // 최대 선택 수. max=1 이면 라디오처럼 동작(새로 고르면 기존 선택을 대체).
  max?:    number
}

export function TagPicker({ value, palette, onChange, allowAdd = true, max }: Props) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  // 옵션 = 팔레트 ∪ 현재 선택값 (순서: 팔레트 먼저, 그 외 선택값 뒤에).
  const options = useMemo(() => {
    const norm = (s: string) => s.trim().toLowerCase()
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of [...palette, ...value]) {
      const n = norm(t)
      if (n && !seen.has(n)) { seen.add(n); out.push(n) }
    }
    return out
  }, [palette, value])

  const selected = useMemo(() => new Set(value.map(t => t.trim().toLowerCase())), [value])

  function toggle(tag: string) {
    if (selected.has(tag)) { onChange(value.filter(t => t.trim().toLowerCase() !== tag)); return }
    // max=1 이면 대체(라디오), 그 외엔 상한까지 추가.
    if (max === 1) { onChange([tag]); return }
    if (max && value.length >= max) return
    onChange([...value, tag])
  }

  function commitAdd() {
    const t = draft.trim().toLowerCase()
    if (t && !selected.has(t)) {
      if (max === 1) onChange([t])
      else if (!max || value.length < max) onChange([...value, t])
    }
    setDraft('')
    setAdding(false)
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {options.map((tag) => {
        const on = selected.has(tag)
        return (
          <button
            key={tag}
            type="button"
            onClick={() => toggle(tag)}
            style={{
              border: `1px solid ${on ? 'var(--accent, #4ea1ff)' : 'var(--border)'}`,
              background: on ? 'var(--accent, #4ea1ff)' : 'var(--bg-surface)',
              color: on ? '#fff' : 'var(--text-muted)',
              borderRadius: 20, padding: '3px 11px', fontSize: 11, fontWeight: on ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {on ? '✓ ' : ''}{tag}
          </button>
        )
      })}
      {allowAdd && (adding ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') { setDraft(''); setAdding(false) } }}
          onBlur={commitAdd}
          placeholder="new tag"
          autoFocus
          style={{
            border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)',
            borderRadius: 20, padding: '3px 11px', fontSize: 11, width: 90, outline: 'none',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          title="Add a new tag"
          style={{
            border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)',
            borderRadius: 20, padding: '3px 10px', fontSize: 11, cursor: 'pointer',
          }}
        >
          + tag
        </button>
      ))}
    </div>
  )
}
