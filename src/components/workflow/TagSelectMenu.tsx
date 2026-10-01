// ─────────────────────────────────────────────────────────────────────────────
// TagSelectMenu.tsx — 다중 태그 선택 메뉴 (in-flow, 즉시 반영).
//
// 옵션(기본 팔레트 ∪ 이미 쓰인 태그)을 칩으로 나열해 클릭 즉시 onPick(해당 태그 토글).
// current 에 포함된 칩은 강조 표시 — 다시 누르면 부모가 해제. max N 이라 다중 선택.
// allowCreate 면 "+ new" 로 새 태그 생성 가능 — 룰상 Team Dashboard 에서만 true.
// absolute 팝오버가 아니라 흐름 안에 펼쳐지므로 스크롤 컨테이너에서 잘리지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'

interface Props {
  options:      string[]
  current:      string[]                 // 현재 선택된 태그들
  allowCreate?: boolean
  busy?:        boolean
  onPick:       (tag: string) => void    // 해당 태그를 토글(부모가 add/remove)
}

export function TagSelectMenu({ options, current, allowCreate = false, busy = false, onPick }: Props) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft]   = useState('')

  function commitNew() {
    const t = draft.trim().toLowerCase()
    if (t) onPick(t)
    setDraft('')
    setAdding(false)
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
      {options.map((opt) => {
        const on = current.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            disabled={busy}
            onClick={() => onPick(opt)}
            style={{
              border: `1px solid ${on ? 'var(--accent, #4ea1ff)' : 'var(--border)'}`,
              background: on ? 'var(--accent, #4ea1ff)' : 'var(--bg-surface)',
              color: on ? '#fff' : 'var(--text-muted)',
              borderRadius: 20, padding: '1px 9px', fontSize: 10,
              fontWeight: on ? 600 : 400, cursor: busy ? 'default' : 'pointer',
            }}
          >
            {opt}
          </button>
        )
      })}
      {allowCreate && (
        adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // CJK IME: composing 중에는 커밋하지 않는다.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitNew()
              else if (e.key === 'Escape') { setDraft(''); setAdding(false) }
            }}
            onBlur={commitNew}
            placeholder="new tag"
            style={{
              width: 84, background: 'var(--bg-base)', border: '1px solid var(--border)',
              borderRadius: 20, color: 'var(--text-primary)', fontSize: 10,
              padding: '2px 9px', outline: 'none',
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            title="Create a new tag (Team Dashboard only)"
            style={{
              border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)',
              borderRadius: 20, padding: '1px 9px', fontSize: 10, cursor: 'pointer',
            }}
          >
            + new
          </button>
        )
      )}
    </div>
  )
}
