import type { ComponentPropsWithoutRef } from 'react'

type TextareaProps = ComponentPropsWithoutRef<'textarea'> & {
  size?: 'sm' | 'md'
  invalid?: boolean
}

export function Textarea({ size = 'md', invalid, className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={className ? `tx-field ${className}` : 'tx-field'}
      data-size={size}
      data-invalid={invalid || undefined}
      {...rest}
    />
  )
}
