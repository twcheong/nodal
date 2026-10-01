import type { CSSProperties, ReactNode } from 'react'

type Option<V extends string> = { value: V; label: ReactNode }

type SegmentedControlProps<V extends string> = {
  options: Option<V>[]
  value: V
  onChange: (value: V) => void
  style?: CSSProperties
  className?: string
}

/** 탭형 토글 (Preview/Edit/Table/Raw 등). active = accent-dim 배경 + accent 텍스트. */
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  style,
  className,
}: SegmentedControlProps<V>) {
  return (
    <div
      role="tablist"
      className={className ? `tx-segment ${className}` : 'tx-segment'}
      style={style}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          data-active={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
