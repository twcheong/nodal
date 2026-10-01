import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// ── useMemberCredits ────────────────────────────────────────────────────────
// 이 멤버의 이번 달 남은 크레딧(= monthly_limit − 이번 달 사용액)을 계산해 반환.
// balance === null ⇒ 조직 미소속(솔로 사용자) → 크레딧 미터링 대상 아님.
// 잔액/한도는 organization_members 행에 있고(투명 공개), 같은 org 멤버는
// "org members can view members" RLS 로 서로의 행을 읽을 수 있다.

export function useMemberCredits(userId: string | undefined, orgId: string | null) {
  const [balance, setBalance] = useState<number | null>(null)
  // 이번 달 한도/사용액 — 상태바 게이지(사용량 바)용. balance 만으로는
  // "얼마나 썼는지" 비율을 그릴 수 없다. null=조직 미소속.
  const [limit,   setLimit]   = useState<number | null>(null)
  const [spent,   setSpent]   = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!userId || !orgId) {
      setBalance(null)
      setLimit(null)
      setSpent(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const { data } = await supabase
      .from('organization_members')
      .select('monthly_limit, spent_this_month, spend_month')
      .eq('user_id', userId)
      .eq('org_id', orgId)
      .maybeSingle()
    if (!data) {
      setBalance(0)
      setLimit(0)
      setSpent(0)
    } else {
      // spent_this_month 은 spend_month 가 이번 달일 때만 유효(DB lazy reset).
      const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM
      const spendMonth = String(data.spend_month ?? '').slice(0, 7)
      const monthSpent = spendMonth === currentMonth ? Number(data.spent_this_month) : 0
      const monthLimit = Number(data.monthly_limit)
      setBalance(Math.max(0, monthLimit - monthSpent))
      setLimit(monthLimit)
      setSpent(monthSpent)
    }
    setLoading(false)
  }, [userId, orgId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { balance, limit, spent, loading, refresh }
}
