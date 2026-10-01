// ─────────────────────────────────────────────────────────────────────────────
// NoCreditsModal.tsx — 회사 크레딧(개인 할당분) 소진 시 전송을 막고 안내하는 모달.
// admin 이 회사 풀에서 크레딧을 추가 지급해야 재개 가능하다.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  open:     boolean
  balance:  number | null
  onClose:  () => void
}

export function NoCreditsModal({ open, balance, onClose }: Props) {
  if (!open) return null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '90vw',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 14,
          padding: 24,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Out of credits</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 10 }}>
          Your team credit balance is{' '}
          <strong style={{ color: 'var(--text)' }}>${(balance ?? 0).toFixed(2)}</strong>. Ask your
          company admin to allocate more from the company pool, then try again.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button
            onClick={onClose}
            style={{
              border: '1px solid var(--border)',
              background: 'var(--bg-hover)',
              color: 'var(--text)',
              borderRadius: 8,
              padding: '7px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
