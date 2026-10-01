import type { ComponentPropsWithoutRef } from 'react'

type InputProps = Omit<ComponentPropsWithoutRef<'input'>, 'size'> & {
  size?: 'sm' | 'md'
  invalid?: boolean
}

export function Input({ size = 'md', invalid, className, ...rest }: InputProps) {
  return (
    <input
      className={className ? `tx-field ${className}` : 'tx-field'}
      data-size={size}
      data-invalid={invalid || undefined}
      {...rest}
    />
  )
}
