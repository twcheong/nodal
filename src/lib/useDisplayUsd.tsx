// ─────────────────────────────────────────────────────────────────────────────
// useDisplayUsd.tsx — display markup 적용 후 포맷된 $ 문자열을 비동기로 받는 hook.
// 모든 cost UI 의 단일 진입점. multiplier 값은 main process 안에만 살고, hook
// 은 IPC 결과로 marked-up usd 만 받아 캐시한다.
//
// 캐시 키: raw usd 값 (소수점 7자리까지). 같은 raw 가 다시 와도 IPC 안 부르고
// 즉시 ok 반환. 사용자가 명시적으로 `window.twixy.refreshMarkup()` 호출 후
// `clearDisplayCostCache()` 부르면 캐시 비움 (Settings 의 retry 버튼 등).
//
// Error UX (markup 못 받아옴): DisplayCost 가 raw cost 를 그대로 표시하되
// 작은 `*` 와 dim opacity 로 "정확하지 않음" 시그널 + tooltip 으로 안내.
// raw 를 가짜 markup 가격인 척 보여주는 게 아니라 — "지금은 기본 cost 만 보임"
// 을 약하게 알림. 사용자가 화면을 흩뜨리지 않으면서도 알아챌 수 있음.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { formatCostUsd } from './modelPricing'

export type DisplayState =
  | { kind: 'loading' }
  | { kind: 'ok';      text: string; markedUsd: number }
  | { kind: 'error';   message: string }

// raw → marked-up value 매핑. multiplier 자체는 여기 없음.
// 모든 hook 인스턴스가 공유 — 같은 raw 값이 여러 카드에 떠도 IPC 한 번.
const cache = new Map<string, number>()

// 외부 사용자가 사용 — Supabase 갱신 후 또는 retry 버튼.
export function clearDisplayCostCache(): void {
  cache.clear()
}

function cacheKey(raw: number): string {
  return raw.toFixed(7)
}

// ── formatDisplayUsd — 문자열을 조립하는 곳을 위한 async 버전 ──────────────
// 채팅 displayText 처럼 React 컴포넌트를 끼워넣을 수 없는 자리에서 쓴다.
// useDisplayUsd 와 같은 캐시를 공유하므로 같은 raw 값은 IPC 를 다시 타지 않는다.
// 실패 시 DisplayCost 와 동일하게 raw + '*' 로 폴백 — 가짜 markup 가격을
// 만들어내지 않는다는 원칙은 여기서도 같다.
//
// 주의: LLM 에게 보내는 payload 에는 쓰지 말 것. 모델이 비용을 분석할 땐
// 마진이 섞이지 않은 raw 원가를 봐야 한다.
export async function formatDisplayUsd(rawUsd: number | undefined): Promise<string> {
  if (typeof rawUsd !== 'number' || !Number.isFinite(rawUsd) || rawUsd < 0) return '—'
  const key = cacheKey(rawUsd)
  const cached = cache.get(key)
  if (cached !== undefined) return formatCostUsd(cached)
  try {
    const res = await window.twixy?.applyDisplayMarkup?.(rawUsd)
    if (!res || res.ok !== true) return formatCostUsd(rawUsd) + '*'
    cache.set(key, res.value)
    return formatCostUsd(res.value)
  } catch {
    return formatCostUsd(rawUsd) + '*'
  }
}

export function useDisplayUsd(rawUsd: number | undefined): DisplayState {
  const [state, setState] = useState<DisplayState>(
    typeof rawUsd === 'number' ? { kind: 'loading' } : { kind: 'ok', text: '', markedUsd: 0 },
  )

  useEffect(() => {
    if (typeof rawUsd !== 'number' || !Number.isFinite(rawUsd) || rawUsd < 0) {
      setState({ kind: 'ok', text: '', markedUsd: 0 })
      return
    }
    const key = cacheKey(rawUsd)
    const cached = cache.get(key)
    if (cached !== undefined) {
      setState({ kind: 'ok', text: formatCostUsd(cached), markedUsd: cached })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await window.twixy?.applyDisplayMarkup?.(rawUsd)
        if (cancelled) return
        if (!res || res.ok !== true) {
          setState({ kind: 'error', message: (res as { error?: string } | undefined)?.error ?? 'pricing unavailable' })
          return
        }
        cache.set(key, res.value)
        setState({ kind: 'ok', text: formatCostUsd(res.value), markedUsd: res.value })
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: (e as Error)?.message ?? 'pricing IPC failed' })
      }
    })()
    return () => { cancelled = true }
  }, [rawUsd])

  return state
}

// ── DisplayCost — cost chip / inline 표시용 표준 컴포넌트 ──────────────────
// 모든 $ 사이트는 이걸 쓰면 markup + 포맷 + loading + error 한 번에 해결.
//
// 옵션:
//   - prefix / suffix: chip 안 텍스트 ("Total: $0.03" 같은 경우 prefix='Total: ')
//   - showZero: raw=0 일 때도 표시할지. 기본 false (chip 숨김).
//
// loading 은 muted "…", error 는 amber "⚠ pricing" + tooltip 에 메시지.

export function DisplayCost({
  rawUsd, prefix = '', suffix = '', showZero = false, style,
}: {
  rawUsd:    number | undefined
  prefix?:   string
  suffix?:   string
  showZero?: boolean
  style?:    React.CSSProperties
}) {
  const state = useDisplayUsd(rawUsd)

  if (typeof rawUsd !== 'number' || (rawUsd === 0 && !showZero)) return null

  if (state.kind === 'loading') {
    return (
      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', ...style }}>
        {prefix}…{suffix}
      </span>
    )
  }
  if (state.kind === 'error') {
    // Markup 모름 → raw cost 표시 + 작은 `*` 와 dim opacity 로 부정확함 시그널.
    // tooltip 에 "서버 연결 불안정 — 가격이 부정확할 수 있음".
    return (
      <span
        title={`서버 연결이 불안정해 기본 cost 만 표시 중입니다. 가격이 부정확할 수 있습니다. (${state.message})`}
        style={{ fontFamily: 'var(--font-mono)', opacity: 0.7, ...style }}
      >
        {prefix}{formatCostUsd(rawUsd)}
        <span style={{ marginLeft: 1, fontSize: '0.85em', color: 'var(--text-muted)' }}>*</span>
        {suffix}
      </span>
    )
  }
  return (
    <span style={{ fontFamily: 'var(--font-mono)', ...style }}>
      {prefix}{state.text}{suffix}
    </span>
  )
}
