// ─────────────────────────────────────────────────────────────────────────────
// ContextChip — 워크플로 Test 세션의 누적 토큰 사용량 표시 + 사용자 reset.
//
// 같은 워크플로에서 ▶ Test 를 여러 번 돌리면 그 세션 transcript 가 누적돼 LLM
// 이 이전 run 결과를 기억한다 (디버깅 / iteration 에 유용). 단 contextWindow
// 가 차면 모델이 토큰 부족 오류를 내거나 비용이 폭증하므로 사용자가 시각적
// 으로 인지하고 적절한 시점에 reset 할 수 있어야 함 — Cursor / Claude Code 의
// 컨텍스트 바 패턴.
//
// 색 단계: muted < 60% < amber < 80% < red.
// 클릭 → confirm → sessions.reset → 카운터 0.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextUsage } from '../../hooks/useWorkflowTestSession'

interface Props {
  usage:     ContextUsage | null
  onReset:   () => void | Promise<void>
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

export function ContextChip({ usage, onReset }: Props) {
  if (!usage) return null
  const pct = Math.max(0, Math.min(1, usage.pct))
  const stalling = pct >= 0.6
  const hot      = pct >= 0.8
  const fg       = hot ? 'var(--red)' : stalling ? '#fbbf24' : 'var(--text-muted)'
  const barBg    = hot ? 'var(--red)' : stalling ? '#fbbf24' : 'var(--text-muted)'
  // Tooltip — 모델명 노출 안 함 (내부 정보).
  const titleTxt = `Test session context — ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.windowTokens)} tokens\nClick to reset for fresh start.`

  const handleClick = () => {
    const ok = window.confirm(`Reset workflow test context?\n\nPrevious run history (${formatTokens(usage.usedTokens)} tokens) will be cleared. The workflow itself is not affected.`)
    if (ok) void onReset()
  }

  return (
    <button
      onClick={handleClick}
      title={titleTxt}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 7px',
        margin: '6px 0',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: fg,
        background: 'var(--bg-elevated)',
        border: `1px solid ${hot ? 'var(--red)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      {/* 진행 바 */}
      <span style={{
        position: 'relative',
        width: 36,
        height: 5,
        borderRadius: 2,
        background: 'var(--bg-active)',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: `${pct * 100}%`,
          background: barBg,
          transition: 'width 0.3s ease',
        }} />
      </span>
      <span>{formatTokens(usage.usedTokens)} / {formatTokens(usage.windowTokens)}</span>
      {hot && <span style={{ fontSize: 9 }}>⚠</span>}
    </button>
  )
}
