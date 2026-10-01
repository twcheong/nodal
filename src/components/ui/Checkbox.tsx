import type { ComponentPropsWithoutRef, ReactNode } from 'react'

type CheckboxProps = Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'size'> & {
  /** 체크박스 오른쪽에 붙는 라벨 */
  label?: ReactNode
}

export function Checkbox({ label, className, style, disabled, ...rest }: CheckboxProps) {
  return (
    <label
      className={className ? `tx-checkbox ${className}` : 'tx-checkbox'}
      data-disabled={disabled || undefined}
      style={style}
    >
      <input type="checkbox" disabled={disabled} {...rest} />
      {label}
    </label>
  )
}
