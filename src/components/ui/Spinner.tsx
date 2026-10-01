import type { CSSProperties } from 'react'

/** 로딩 스피너. size = 지름(px). */
export function Spinner({ size = 14, style }: { size?: number; style?: CSSProperties }) {
  return (
    <span
      className="tx-spinner"
      role="status"
      aria-label="loading"
      style={{ width: size, height: size, ...style }}
    />
  )
}
