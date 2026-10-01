import type { ComponentPropsWithoutRef } from 'react'

type ChipProps = ComponentPropsWithoutRef<'button'> & {
  /** active일 때 입혀지는 색조 */
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info'
  active?: boolean
  /** 지정하면 오른쪽에 × 표시 (프리셋/태그 삭제용) */
  onRemove?: () => void
}

/** 클릭 가능한 pill — 모드 선택 칩, 태그 필터, 상태 컨트롤(▶ Start / ■ Stop 등). */
export function Chip({ tone = 'accent', active = false, onRemove, className, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      className={className ? `tx-chip ${className}` : 'tx-chip'}
      data-tone={tone}
      data-active={active}
      aria-pressed={active}
      {...rest}
    >
      {children}
      {onRemove && (
        <span
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          style={{ opacity: 0.7, cursor: 'pointer' }}
          aria-label="remove"
        >
          ×
        </span>
      )}
    </button>
  )
}
