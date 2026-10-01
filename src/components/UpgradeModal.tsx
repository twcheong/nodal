// ─────────────────────────────────────────────────────────────────────────────
// UpgradeModal.tsx — 쿼터 초과 시 또는 사용자가 상태바에서 직접 눌렀을 때 뜨는 모달.
// 오늘자 사용량 미니바 + Free/Pro 플랜 비교 카드 + 외부 pricing 페이지로 이동 버튼.
// 현재는 정보/안내 전용 — Stripe 결제 연동은 Upgrade 버튼에 이후 훅업 예정.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS, FREE_PLAN, type Tier } from '../lib/entitlements'
import { PRODUCT } from '../lib/product'

interface Props {
  open:             boolean
  reason:           'messages' | 'schedules'
  tier:             Tier
  isTwixyHosting?:  boolean
  usageMessages?:   number
  limitMessages?:   number
  usageTokens?:     number
  limitTokens?:     number
  usdToday?:        number
  onClose:          () => void
}

/**
 * 쿼터 초과 또는 사용자가 직접 업그레이드 버튼을 눌렀을 때 뜨는 모달.
 * reason 에 따라 헤드라인을 "메시지 한도" / "스케줄 잡 한도" 로 분기한다.
 */
export function UpgradeModal({ open, reason, tier, isTwixyHosting, usageMessages, limitMessages, usageTokens, limitTokens, usdToday, onClose }: Props) {
  if (!open) return null

  const free = LIMITS.free
  const pro  = LIMITS.pro

  // 초과한 리소스 종류에 맞춘 한 줄 헤드라인.
  const headline =
    reason === 'messages'
      ? `You've hit today's message limit (${tier === 'free' ? free.messagesPerDay : pro.messagesPerDay})`
      : `You've reached your scheduled job limit (${tier === 'free' ? free.scheduledJobs : pro.scheduledJobs})`

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(440px, 90vw)',
          background: 'var(--bg-surface, #ffffff)',
          border: '1px solid var(--border-subtle, #cfdbd3)',
          borderRadius: 'var(--radius, 10px)',
          padding: 28,
          color: 'var(--text-primary, #14201b)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Upgrade to Pro</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted, #8a968d)', marginBottom: 20 }}>{headline}</div>

        {/* Today's usage */}
        <div style={{
          background: 'rgba(20, 32, 27,0.03)',
          border: '1px solid var(--border-subtle, #cfdbd3)',
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted, #8a968d)' }}>
            Today's usage
          </div>
          <MiniBar
            label="Messages"
            used={usageMessages ?? 0}
            limit={limitMessages ?? free.messagesPerDay}
            formatUsed={u => `${u} / ${limitMessages ?? free.messagesPerDay}`}
          />
          {isTwixyHosting && (
            <MiniBar
              label="AI tokens"
              used={usdToday ?? 0}
              limit={FREE_PLAN.monthlyBudgetUsd}
              formatUsed={() => {
                const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
                return `${fmt(usageTokens ?? 0)} tok`
              }}
            />
          )}
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
          fontSize: 12, marginBottom: 24,
        }}>
          <PlanCard
            name="Free"
            current={tier === 'free'}
            features={[
              `${free.messagesPerDay} messages/day`,
              `${free.scheduledJobs} scheduled jobs`,
              'Built-in skills',
            ]}
          />
          <PlanCard
            name="Pro"
            current={tier === 'pro'}
            features={[
              `${pro.messagesPerDay} messages/day`,
              `${pro.scheduledJobs} scheduled jobs`,
              'Mobile channels',
              'Custom skills',
            ]}
            highlight
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnGhost}>Close</button>
          <button
            onClick={() => window.twixy?.openExternal?.(PRODUCT.pricingUrl)}
            style={btnPrimary}
          >
            Upgrade
          </button>
        </div>
      </div>
    </div>
  )
}

// 작은 가로 프로그레스바 + 우측 수치 표기.
// 임계치: <80% 보라, 80-99% 노랑, 100%+ 빨강. StatusBar 의 색상 규칙과 일치.
function MiniBar({ label, used, limit, formatUsed }: {
  label: string
  used: number
  limit: number
  formatUsed: (used: number) => string
}) {
  const pct    = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const danger = used >= limit
  const warn   = pct >= 80 && !danger
  const barColor = danger ? 'var(--danger)' : warn ? 'var(--warning)' : 'var(--accent, #0d5c50)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted, #8a968d)' }}>{label}</span>
        <span style={{ fontFamily: 'monospace', color: danger ? 'var(--danger)' : 'var(--text-muted, #8a968d)' }}>
          {formatUsed(used)}
        </span>
      </div>
      <div style={{ height: 4, background: 'rgba(20, 32, 27,0.08)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  )
}

// Free/Pro 플랜 비교용 카드. highlight=true 면 accent 컬러 테두리 + 연한 배경.
// current=true 면 우측 상단에 "current" 뱃지를 표시해 사용자가 현재 플랜을 식별할 수 있게 한다.
function PlanCard({ name, features, current, highlight }: {
  name: string
  features: string[]
  current?: boolean
  highlight?: boolean
}) {
  return (
    <div style={{
      border: highlight ? '1px solid var(--accent, #0d5c50)' : '1px solid var(--border-subtle, #cfdbd3)',
      borderRadius: 8,
      padding: 14,
      background: highlight ? 'rgba(124,58,237,0.08)' : 'transparent',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
        {current && <span style={{ fontSize: 10, color: 'var(--text-muted, #8a968d)' }}>current</span>}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {features.map(f => (
          <li key={f} style={{ fontSize: 11, color: 'var(--text-muted, #8a968d)' }}>· {f}</li>
        ))}
      </ul>
    </div>
  )
}

const btnGhost: React.CSSProperties = {
  padding: '8px 16px',
  background: 'transparent',
  border: '1px solid var(--border-subtle, #cfdbd3)',
  borderRadius: 6,
  color: 'var(--text-muted, #8a968d)',
  fontSize: 12,
  cursor: 'pointer',
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--accent, #0d5c50)',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}
