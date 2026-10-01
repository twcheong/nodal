import type { ComponentPropsWithoutRef } from 'react'

type IconButtonProps = ComponentPropsWithoutRef<'button'> & {
  /** 접근성 필수 — 아이콘만 있는 버튼이므로 라벨을 반드시 지정 */
  'aria-label': string
  size?: 'sm' | 'md'
}

/** 정사각 아이콘 버튼 (lucide-react 아이콘 등을 children으로). */
export function IconButton({ size = 'md', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={className ? `tx-iconbtn ${className}` : 'tx-iconbtn'}
      data-size={size}
      {...rest}
    >
      {children}
    </button>
  )
}
