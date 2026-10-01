// PatternSelector — 5개 패턴 세그먼트 버튼. 선택 시 orchestration.pattern 갱신.
// DISABLED_PATTERNS(현재 conductor)는 비활성으로 표시되어 선택 불가.
import { PATTERN_META, DISABLED_PATTERNS } from '../../lib/orchestrationPatterns'

const ORDER: OrchestrationPattern[] = ['pipeline', 'parallel', 'roundtable', 'relay', 'conductor']

interface Props {
  value:    OrchestrationPattern
  disabled?: boolean
  onChange: (p: OrchestrationPattern) => void
}

export function PatternSelector({ value, disabled, onChange }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ORDER.map(p => {
          const active = p === value
          const off = DISABLED_PATTERNS.includes(p)
          const meta = PATTERN_META[p]
          return (
            <button
              key={p}
              disabled={disabled || off}
              onClick={() => { if (!off) onChange(p) }}
              title={off ? `${meta.label} — currently disabled` : meta.blurb}
              style={{
                border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: active ? 'var(--accent-dim)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11.5,
                fontWeight: active ? 600 : 500,
                padding: '5px 11px',
                cursor: (disabled || off) ? 'not-allowed' : 'pointer',
                opacity: off ? 0.4 : disabled ? 0.5 : 1,
                textDecoration: off ? 'line-through' : 'none',
              }}
            >
              {meta.label}{off && ' (off)'}
            </button>
          )
        })}
      </div>
      <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
        {PATTERN_META[value].blurb}
      </span>
    </div>
  )
}
