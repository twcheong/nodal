import type { ComponentPropsWithoutRef } from 'react'

type ToggleProps = Omit<ComponentPropsWithoutRef<'button'>, 'onChange'> & {
  checked: boolean
  onChange: (checked: boolean) => void
}

/** 스위치 토글. role="switch" + aria-checked로 접근성 처리. */
export function Toggle({ checked, onChange, className, disabled, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={className ? `tx-toggle ${className}` : 'tx-toggle'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...rest}
    />
  )
}
