// ─────────────────────────────────────────────────────────────────────────────
// TwixyConfirm.tsx — 인앱 확인 다이얼로그 (네이티브 window.confirm 대체).
//
// useConfirm() 훅이 Promise 기반 confirm() 과 렌더할 다이얼로그 노드를 함께 준다:
//   const { confirm, confirmDialog } = useConfirm()
//   ... const ok = await confirm({ title, message, danger })
//   return (<>{...}{confirmDialog}</>)
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, type ReactNode } from 'react'

export interface ConfirmOpts {
  title:         string
  message?:      string
  confirmLabel?: string   // 기본 'OK'
  cancelLabel?:  string   // 기본 'Cancel'
  danger?:       boolean  // 확인 버튼을 위험(빨강) 톤으로
}

export function useConfirm(): { confirm: (opts: ConfirmOpts) => Promise<boolean>; confirmDialog: ReactNode } {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null)
  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>(resolve => setState({ ...opts, resolve })),
    [],
  )
  const confirmDialog = state
    ? <ConfirmDialog opts={state} onResolve={(ok) => { state.resolve(ok); setState(null) }} />
    : null
  return { confirm, confirmDialog }
}

export function ConfirmDialog({ opts, onResolve }: { opts: ConfirmOpts; onResolve: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onResolve(false) }
      if (e.key === 'Enter')  { e.preventDefault(); onResolve(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResolve])

  return (
    <div
      onClick={() => onResolve(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(400px, 92%)', background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 18px 14px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: opts.message ? 6 : 0 }}>
            {opts.title}
          </div>
          {opts.message && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, whiteSpace: 'pre-line' }}>
              {opts.message}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 18px 16px' }}>
          <button
            type="button"
            onClick={() => onResolve(false)}
            style={{
              background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontSize: 12.5, cursor: 'pointer',
            }}
          >{opts.cancelLabel ?? 'Cancel'}</button>
          <button
            type="button"
            autoFocus
            onClick={() => onResolve(true)}
            style={{
              background: opts.danger ? 'var(--danger)' : 'var(--accent)', border: 'none', color: '#fff',
              borderRadius: 'var(--radius-sm)', padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}
          >{opts.confirmLabel ?? 'OK'}</button>
        </div>
      </div>
    </div>
  )
}
