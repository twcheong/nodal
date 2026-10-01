// HoverTip — 커스텀 hover 툴팁. children 위에 마우스를 올리면 content 를 document.body 로
// portal(position:fixed) 표시한다. 네이티브 title 의 느린 지연·기본 스타일을 대체하고,
// 캔버스 줌(transform)·overflow·스택 컨텍스트의 영향 없이 항상 위에 뜬다.
//
// ★ WF 노드 관련 UI의 표준 툴팁 — ui/Tooltip으로 통합하지 않고 원본 유지한다
//   (2026-08 디자인 시스템 도입 때 통합했다가 원본이 낫다고 판단해 되돌림).
import { useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export function HoverTip({ content, children, side = 'bottom', style }: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'right'
  style?: CSSProperties      // wrapper(box) 스타일 — 레이아웃에 맞게 지정
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return
    if (side === 'right') setPos({ x: r.right + 8, y: r.top })
    else if (side === 'top') setPos({ x: r.left, y: r.top - 6 })
    else setPos({ x: r.left, y: r.bottom + 6 })
  }
  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={() => setPos(null)} style={style}>
      {children}
      {pos && createPortal(
        <div style={{
          position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999, pointerEvents: 'none',
          transform: side === 'top' ? 'translateY(-100%)' : undefined,
          minWidth: 160, maxWidth: 320, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.45)', padding: '7px 9px', textAlign: 'left',
        }}>
          {content}
        </div>, document.body)}
    </div>
  )
}

// 포트/배지 툴팁 공용 본문 — 작은 헤딩 + 필드 라인 목록.
export function TipBody({ heading, lines, accent }: { heading: string; lines: string[]; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: accent ?? 'var(--text-muted)', marginBottom: lines.length ? 4 : 0 }}>{heading}</div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{l}</div>
      ))}
    </div>
  )
}
