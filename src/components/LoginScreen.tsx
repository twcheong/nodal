import { useState } from 'react'
import { PRODUCT } from '../lib/product'

interface Props {
  onSignIn: () => void
}

/**
 * LoginScreen — 유효한 Supabase 세션이 생길 때까지 표시되는 전체 화면 락스크린.
 *
 * 실제 인증 플로우는 외부 기본 브라우저에서 진행되고, 완료되면 twixy://auth 딥링크로
 * 앱에 토큰이 돌아온다. 이 화면은 그 플로우를 트리거하고 사용자가 돌아올 때까지 기다린다.
 *
 * waiting 플래그는 버튼을 "대기 중…" 상태로 바꾸고 보조 안내 + 재시도 링크를 노출.
 */
export function LoginScreen({ onSignIn }: Props) {
  const [waiting, setWaiting] = useState(false)

  function handleClick() {
    setWaiting(true)
    onSignIn()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base, #fafaf6)',
        color: 'var(--text-primary, #14201b)',
        fontFamily: 'system-ui, sans-serif',
        gap: 24,
        padding: 40,
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em' }}>{PRODUCT.displayName}</div>
      <div style={{ fontSize: 14, color: 'var(--text-muted, #4a594f)', textAlign: 'center', maxWidth: 360 }}>
        Sign in with your {PRODUCT.accountName} account to get started.
      </div>

      <button
        onClick={handleClick}
        disabled={waiting}
        style={{
          marginTop: 8,
          padding: '12px 32px',
          background: waiting ? 'transparent' : 'var(--accent, #0d5c50)',
          color: waiting ? 'var(--text-muted, #4a594f)' : '#fff',
          border: waiting ? '1px solid var(--border-subtle, #cfdbd3)' : 'none',
          borderRadius: 'var(--radius-sm, 6px)',
          fontSize: 14,
          fontWeight: 600,
          cursor: waiting ? 'default' : 'pointer',
        }}
      >
        {waiting ? 'Waiting for browser sign-in…' : 'Sign in with web'}
      </button>

      {waiting && (
        <div style={{ fontSize: 12, color: 'var(--text-muted, #4a594f)', textAlign: 'center', maxWidth: 380 }}>
          A browser tab should have opened. Complete sign-in there and {PRODUCT.displayName} will unlock automatically.
          <br />
          <button
            onClick={handleClick}
            style={{
              marginTop: 12,
              background: 'none',
              border: 'none',
              color: 'var(--accent, #0d5c50)',
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Open sign-in page again
          </button>
        </div>
      )}
    </div>
  )
}
