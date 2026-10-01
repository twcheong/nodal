/**
 * ConnectingSplash — 인증은 끝났지만 OpenClaw 게이트웨이가 아직 준비되지 않은 구간의
 * 브랜드 스플래시 (App.tsx 에서 status === 'connecting' 일 때 표시).
 *
 * LoginScreen 과 비주얼을 맞춰 "sign-in → ready" 전환이 하나의 연속된 부팅처럼 보이도록 한다.
 * CSS keyframes 로 작은 스피너를 표시 — 외부 스피너 라이브러리 없이 인라인.
 */
import { PRODUCT } from '../lib/product'

export function ConnectingSplash() {
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
        gap: 20,
        padding: 40,
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em' }}>
        {PRODUCT.displayName}
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: 'var(--text-muted, #4a594f)',
      }}>
        <span style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          border: '2px solid var(--text-muted, #4a594f)',
          borderTopColor: 'var(--accent, #0d5c50)',
          animation: 'twixy-spin 0.9s linear infinite',
        }} />
        Starting copilot…
      </div>
      <style>{`
        @keyframes twixy-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
