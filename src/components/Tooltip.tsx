// ─────────────────────────────────────────────────────────────────────────────
// Tooltip.tsx — 호환 셸. 실제 구현은 ui/Tooltip으로 통합됨.
// 신규 코드는 `import { Tooltip } from '@/components/ui'`를 사용할 것.
// ─────────────────────────────────────────────────────────────────────────────
import type { ReactNode } from 'react'
import { Tooltip as UITooltip } from './ui'

export function Tooltip({
  text,
  children,
  place = 'top',
}: {
  text: string
  children: ReactNode
  place?: 'top' | 'bottom'
}) {
  return (
    <UITooltip content={text} side={place} tipStyle={{ whiteSpace: 'nowrap' }}>
      {children}
    </UITooltip>
  )
}
