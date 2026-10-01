// Tooltip — 기존 components/Tooltip.tsx(인라인 방식)와 orchestration/HoverTip.tsx
// (portal 방식)를 통합한 atom. portal(position:fixed) 방식이라 캔버스 줌·
// overflow·스택 컨텍스트의 영향 없이 항상 위에 뜬다.
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type TooltipProps = {
  /** 툴팁 내용 — 문자열 또는 임의 노드 */
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'right'
  /** top/bottom일 때 가로 정렬 — center(기본) 또는 start(anchor 왼쪽 정렬) */
  align?: 'center' | 'start'
  /** wrapper 스타일 — 감싸는 요소의 레이아웃에 맞게 지정 */
  style?: CSSProperties
  /** 툴팁 박스 자체에 덧입힐 스타일 */
  tipStyle?: CSSProperties
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  style,
  tipStyle,
}: TooltipProps) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const x = align === 'start' ? r.left : r.left + r.width / 2
    if (side === 'right') setPos({ x: r.right + 8, y: r.top })
    else if (side === 'bottom') setPos({ x, y: r.bottom + 6 })
    else setPos({ x, y: r.top - 6 })
  }

  const tx = side !== 'right' && align === 'center' ? '-50%' : '0'
  const ty = side === 'top' ? '-100%' : '0'

  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      style={{ display: 'inline-flex', ...style }}
    >
      {children}
      {pos &&
        createPortal(
          <span
            role="tooltip"
            className="tx-tooltip"
            style={{
              position: 'fixed',
              left: pos.x,
              top: pos.y,
              transform: `translate(${tx}, ${ty})`,
              ...tipStyle,
            }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  )
}

/** 포트/배지 툴팁 공용 본문 — 작은 헤딩 + 필드 라인 목록 (구 HoverTip.TipBody). */
export function TipBody({ heading, lines, accent }: { heading: string; lines: string[]; accent?: string }) {
  return (
    <span style={{ display: 'block' }}>
      <span
        style={{
          display: 'block',
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: accent ?? 'var(--text-muted)',
          marginBottom: lines.length ? 4 : 0,
        }}
      >
        {heading}
      </span>
      {lines.map((l, i) => (
        <span key={i} style={{ display: 'block', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {l}
        </span>
      ))}
    </span>
  )
}
