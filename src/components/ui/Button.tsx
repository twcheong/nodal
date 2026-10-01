import type { ComponentPropsWithoutRef } from 'react'
import { Spinner } from './Spinner'

type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline' | 'dashed'
  size?: 'sm' | 'md'
  /** true면 스피너 표시 + 클릭 비활성화 */
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={className ? `tx-btn ${className}` : 'tx-btn'}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner size={size === 'sm' ? 10 : 12} />}
      {children}
    </button>
  )
}
