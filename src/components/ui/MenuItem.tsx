import type { ComponentPropsWithoutRef, ReactNode } from 'react'

type MenuItemProps = ComponentPropsWithoutRef<'button'> & {
  /** 라벨 왼쪽 아이콘 (lucide 아이콘 등) */
  icon?: ReactNode
  /** 삭제 등 파괴적 액션 — 빨간 텍스트 + 빨간 틴트 hover */
  danger?: boolean
}

/** 컨텍스트 메뉴/드롭다운의 행 버튼. 풀너비 좌측 정렬, hover 시 bg-hover. */
export function MenuItem({ icon, danger, className, children, ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      className={className ? `tx-menuitem ${className}` : 'tx-menuitem'}
      data-danger={danger || undefined}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
