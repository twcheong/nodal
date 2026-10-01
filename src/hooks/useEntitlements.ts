import { useEffect, useState, useCallback } from 'react'
import {
  fetchEntitlements,
  fetchOpenRouterUsageToday,
  recordUsage as recordUsageRaw,
  FREE_PLAN,
  type Entitlements,
  type OpenRouterUsage,
  type RecordKind,
  type RecordResult,
} from '../lib/entitlements'

/**
 * useEntitlements — 구독/쿼터 상태 훅.
 *
 * 사용자의 tier(플랜) 와 오늘 사용량을 Twixy 웹 API 에서 가져와 로컬 캐시.
 * 과금성 액션(메시지 전송, 스케줄 실행, 검색) 전에 `recordUsage` 를 호출해
 * 한도를 선검증한다. 반환값이 `{ allowed: false }` 면 실행을 막고 UpgradeModal 을 띄운다.
 *
 * 리프레시 전략:
 *   - 마운트 시 1회
 *   - recordUsage 성공 시 (서버가 최신 총합을 응답으로 내려줌)
 *   - 호출자가 수동으로 refresh() 할 때 (예: AI 응답 완료 2초 후 App.tsx)
 */
export function useEntitlements() {
  const [data, setData] = useState<Entitlements | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // OpenRouter 사용량은 entitlements 와 별도 엔드포인트라 병렬 fetch.
  const [openRouterUsage, setOpenRouterUsage] = useState<OpenRouterUsage>({ tokensIn: 0, tokensOut: 0, usdToday: 0 })

  // 서버에서 최신 entitlements + OpenRouter 사용량을 동시에 가져와 상태 갱신.
  // 에러는 표시용으로만 보관 — 실패 시 data=null 이 되고 UI 는 기본값으로 그리게 한다.
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [e, orUsage] = await Promise.all([fetchEntitlements(), fetchOpenRouterUsageToday()])
      setData(e)
      setOpenRouterUsage(orUsage)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 쿼터 소비 기록. 서버가 허용 여부 + 갱신된 사용량/한도를 돌려주므로
  // 별도 refresh 없이 즉시 로컬 캐시를 업데이트한다.
  const recordUsage = useCallback(async (kind: RecordKind, amount = 1): Promise<RecordResult> => {
    const result = await recordUsageRaw(kind, amount)
    // 서버의 최신 수치로 로컬 캐시 업데이트.
    setData(prev => prev ? {
      ...prev,
      tier:   result.tier,
      limits: result.limits,
      usage:  result.usage,
    } : prev)
    return result
  }, [])

  // ── 편의용 파생 값들 — 컴포넌트가 반복 계산하지 않도록 미리 계산 ────────
  // data 가 null (로딩/에러) 인 경우에도 UI 렌더가 가능하도록 안전한 기본값 제공.
  const tier = data?.tier ?? 'free'
  const limits = data?.limits ?? { messagesPerDay: 25, scheduledJobs: 2, searchesPerDay: 25, tokensPerDay: FREE_PLAN.tokensPerMonth }
  const usage = data?.usage ?? { date: '', messages: 0, tokens: 0, scheduledRuns: 0, searches: 0 }
  const messagesRemaining = Math.max(0, limits.messagesPerDay - usage.messages)
  const schedulesRemaining = Math.max(0, limits.scheduledJobs - usage.scheduledRuns)
  const searchesRemaining = Math.max(0, limits.searchesPerDay - usage.searches)
  const canSendMessage = messagesRemaining > 0
  const canSchedule    = schedulesRemaining > 0
  const canSearch      = searchesRemaining > 0

  return {
    data,
    tier,
    limits,
    usage,
    openRouterUsage,
    loading,
    error,
    messagesRemaining,
    schedulesRemaining,
    searchesRemaining,
    canSendMessage,
    canSchedule,
    canSearch,
    refresh,
    recordUsage,
  }
}
