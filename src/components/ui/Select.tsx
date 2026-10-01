import type { ComponentPropsWithoutRef } from 'react'

type SelectProps = Omit<ComponentPropsWithoutRef<'select'>, 'size'> & {
  size?: 'sm' | 'md'
  invalid?: boolean
}

/** 스타일된 네이티브 select (셰브론 포함). options는 children으로. */
export function Select({ size = 'md', invalid, className, children, ...rest }: SelectProps) {
  return (
    <select
      className={className ? `tx-field ${className}` : 'tx-field'}
      data-size={size}
      data-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  )
}
