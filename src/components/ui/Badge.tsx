import type { ComponentPropsWithoutRef } from 'react'

type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  variant?: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info'
}

/** 상태/카운트 표시용 pill 배지. */
export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={className ? `tx-badge ${className}` : 'tx-badge'}
      data-variant={variant}
      {...rest}
    >
      {children}
    </span>
  )
}
