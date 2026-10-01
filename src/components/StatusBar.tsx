// ─────────────────────────────────────────────────────────────────────────────
// StatusBar.tsx — 앱 최하단의 28px 상태바.
// 표시 내용:
//   · 게이트웨이 연결 상태 (connecting / ready / error / disconnected) 도트 + 레이블
//   · Node 22 미설치 시 힌트 메시지
//   · 쿼터 프로그레스 바 (Twixy 호스팅 → USD 기반 토큰 사용량, BYOK → 메시지 수)
//   · 재연결 버튼 또는 "앱 재시작" 안내 (오프라인 시)
// 업그레이드 모달/재연결 콜백은 App.tsx 가 내려준다.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react'
import { FREE_PLAN } from '../lib/entitlements'

interface Props {
  status:           'connecting' | 'ready' | 'error' | 'disconnected'
  errorMsg?:        string
  onReconnect?:     () => void
  tier?:            'free' | 'pro'
  isTwixyHosting?:  boolean
  usageMessages?:   number
  limitMessages?:   number
  usageTokens?:     number
  limitTokens?:     number
  usdToday?:        number
  creditBalance?:   number | null   // 회사 크레딧 풀에서 이 멤버의 개인 잔액(USD). null=미소속
  creditLimit?:     number | null   // 이번 달 개인 할당 한도(USD) — 게이지 분모
  creditSpent?:     number | null   // 이번 달 사용액(USD) — 게이지 분자
  onUpgradeClick?:  () => void
}

// 상태별 레이블/색. CSS 변수는 globals.css 의 팔레트를 참조.
const labels = {
  connecting:   { text: 'Connecting...',  color: 'var(--yellow)'    },
  ready:        { text: 'Ready',          color: 'var(--green)'     },
  error:        { text: 'Error',          color: 'var(--red)'       },
  disconnected: { text: 'Offline',        color: 'var(--text-muted)' },
}

export function StatusBar({ status, errorMsg, onReconnect, tier, isTwixyHosting, usageMessages, limitMessages, usageTokens, limitTokens, usdToday, creditBalance, creditLimit, creditSpent, onUpgradeClick }: Props) {
  const { text, color } = labels[status]

  // 재연결 1회 시도 후에도 실패 시 "앱 재시작" 안내로 전환하는 플래그.
  // 연결이 복구되면 자동으로 리셋해 다음 장애에서도 다시 Reconnect 버튼을 노출.
  const [triedReconnect, setTriedReconnect] = useState(false)

  // 연결 복구 시 플래그 초기화
  useEffect(() => {
    if (status === 'ready' || status === 'connecting') setTriedReconnect(false)
  }, [status])

  const isOffline    = status === 'disconnected' || status === 'error'
  // Node v22 미설치는 자주 발생하는 셋업 오류라 전용 힌트로 노출
  const isNodeError  = errorMsg?.includes('Node.js v22')

  const displayText = isNodeError
    ? 'Node.js v22 required — run: nvm install 22 && nvm use 22'
    : `Twixy · ${text}`

  function handleReconnect() {
    setTriedReconnect(true)
    onReconnect?.()
  }

  return (
    <div style={{
      height:          28,
      background:      'var(--bg-surface)',
      borderTop:       '1px solid var(--border-subtle)',
      display:         'flex',
      alignItems:      'center',
      paddingInline:    16,
      gap:              6,
      fontSize:         11,
      color:           isNodeError ? 'var(--yellow)' : 'var(--text-muted)',
      WebkitAppRegion: 'no-drag',
    } as React.CSSProperties}>

      <span style={{
        width:        6,
        height:       6,
        borderRadius: '50%',
        background:    color,
        boxShadow:    status === 'ready' ? `0 0 6px ${color}` : 'none',
        flexShrink:    0,
      }} />

      <span>{displayText}</span>

      {/* 회사 크레딧 게이지 — 팀 멤버의 이번 달 사용량(spent/limit)을 tok 게이지와
         같은 바 형태로. null=조직 미소속(표시 안 함). 한도 데이터가 아직 없거나
         한도 0(무제한/미설정)이면 잔액 텍스트만 표시. */}
      {typeof creditBalance === 'number' && !isOffline && (() => {
        const hasGauge = typeof creditLimit === 'number' && creditLimit > 0
        const spent    = Math.max(0, creditSpent ?? 0)
        const pct      = hasGauge ? Math.min(100, (spent / (creditLimit ?? 1)) * 100) : 0
        const danger   = hasGauge ? pct >= 100 : creditBalance <= 0
        const warn     = hasGauge && pct >= 80 && !danger
        const barColor = danger ? 'var(--red, #b5482f)' : warn ? 'var(--yellow, #b07d18)' : 'var(--accent, #0d5c50)'
        return (
          <span
            title={hasGauge
              ? `Team credits this month: $${spent.toFixed(2)} used of $${(creditLimit ?? 0).toFixed(2)} · $${creditBalance.toFixed(2)} left`
              : 'Your remaining team credits (allocated by your admin)'}
            style={{
              marginLeft:  'auto',
              display:     'flex',
              alignItems:  'center',
              gap:          6,
              fontSize:     10,
              fontFamily:  'monospace',
              color:        danger ? 'var(--red, #b5482f)' : 'var(--text-muted)',
            }}
          >
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.7 }}>
              credits
            </span>
            {hasGauge && (
              <div style={{
                width:        80,
                height:        4,
                background:   'var(--bg-input, #222)',
                borderRadius: 2,
                overflow:    'hidden',
              }}>
                <div style={{
                  width:      `${pct}%`,
                  height:     '100%',
                  background:  barColor,
                  transition: 'width 0.3s ease',
                }} />
              </div>
            )}
            <span style={{ minWidth: 44, textAlign: 'right' }}>
              ${creditBalance.toFixed(2)}
            </span>
          </span>
        )
      })()}

      {/* 쿼터 배지 — Twixy 호스팅은 토큰/USD 기반, BYOK 는 일일 메시지 수.
         클릭하면 UpgradeModal 오픈. 임계치별 색상:
           <80% 보라색(accent), 80-99% 노랑(warn), >=100% 빨강(danger)

         org 멤버에게는 숨긴다. 이 배지는 개인 티어 쿼터(FREE_PLAN 월 예산 대비
         본인 usdToday)라서, 회사 풀에서 관리자가 배정한 한도로 쓰는 팀 멤버에겐
         무의미하고 바로 옆 team credits 게이지와 서로 다른 숫자로 충돌한다. */}
      {typeof creditBalance !== 'number'
        && tier && typeof usageMessages === 'number' && typeof limitMessages === 'number' && !isOffline && (() => {
        const showTokens = isTwixyHosting && typeof usageTokens === 'number' && typeof limitTokens === 'number' && limitTokens > 0
        const used  = showTokens ? (usageTokens ?? 0) : usageMessages
        const limit = showTokens ? (limitTokens ?? 1) : limitMessages
        // Bar: twixy mode → strictly USD-based (same source as UpgradeModal).
        //      BYOK / message mode → token-based.
        const pct = showTokens
          ? Math.min(100, ((usdToday ?? 0) / FREE_PLAN.monthlyBudgetUsd) * 100)
          : (limit > 0 ? Math.min(100, (used / limit) * 100) : 0)
        const danger = pct >= 100
        const warn   = pct >= 80 && !danger
        const barColor = danger ? 'var(--red, #b5482f)' : warn ? 'var(--yellow, #b07d18)' : 'var(--accent, #0d5c50)'
        const label = showTokens
          ? (used >= 1000 ? `${(used / 1000).toFixed(1)}K` : String(used)) + ' tok'
          : `${usageMessages}/${limitMessages}`

        return (
          <button
            onClick={onUpgradeClick}
            title={showTokens ? 'AI token usage today' : 'Message usage today'}
            style={{
              marginLeft: 'auto',   // org 멤버에겐 아예 렌더되지 않으므로 항상 우측 정렬
              border:     'none',
              background: 'transparent',
              padding:     0,
              cursor:     'pointer',
              display:    'flex',
              alignItems: 'center',
              gap:         6,
            }}
          >
            <span style={{
              fontSize:      9,
              fontWeight:    600,
              letterSpacing:'0.06em',
              textTransform:'uppercase',
              color:        'var(--text-muted)',
              opacity:       0.7,
            }}>
              {showTokens ? 'tok' : 'msg'}
            </span>
            <div style={{
              width:        80,
              height:        4,
              background:   'var(--bg-input, #222)',
              borderRadius: 2,
              overflow:    'hidden',
            }}>
              <div style={{
                width:      `${pct}%`,
                height:     '100%',
                background:  barColor,
                transition: 'width 0.3s ease',
              }} />
            </div>
            <span style={{
              fontSize:    10,
              fontFamily: 'monospace',
              color:      danger ? 'var(--red, #b5482f)' : 'var(--text-muted)',
              minWidth:    44,
              textAlign:  'right',
            }}>
              {label}
            </span>
          </button>
        )
      })()}

      {/* 재연결 시도 후에도 실패 상태라면 "앱 재시작" 안내 */}
      {isOffline && triedReconnect && (
        <span style={{ marginLeft: 'auto', color: 'var(--red)', fontWeight: 500 }}>
          Please restart the app
        </span>
      )}

      {/* 첫 오프라인 감지 → Reconnect 버튼 노출 */}
      {isOffline && !triedReconnect && onReconnect && (
        <button
          onClick={handleReconnect}
          style={{
            marginLeft:   'auto',
            border:       '1px solid var(--border)',
            background:   'var(--bg-hover)',
            color:        'var(--text)',
            borderRadius: 'var(--radius-sm)',
            padding:      '2px 10px',
            fontSize:      10,
            fontWeight:    600,
            cursor:       'pointer',
            letterSpacing:'0.03em',
          }}
        >
          Reconnect
        </button>
      )}
    </div>
  )
}
