import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// ── useOrg ────────────────────────────────────────────────────────────────
// 현재 사용자의 조직(회사) 소속을 해석한다. 팀 공유/크레딧 기능이 필요로 하는
// orgIds(접근 가능한 org 목록)와 primaryOrgId(v1: 첫 소속)를 제공.
// RLS 정책상 멤버는 자기 소속 행을 읽을 수 있으므로 렌더러에서 직접 조회 가능.

export interface OrgMembership {
  orgId: string
  role:  'admin' | 'member'
}

export function useOrg(userId: string | undefined) {
  const [memberships, setMemberships] = useState<OrgMembership[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!userId) {
      setMemberships([])
      setLoading(false)
      return
    }
    setLoading(true)
    const { data } = await supabase
      .from('organization_members')
      .select('org_id, role, joined_at')
      .eq('user_id', userId)
      .order('joined_at', { ascending: true })
    setMemberships(
      (data ?? []).map((r) => ({ orgId: r.org_id as string, role: r.role as 'admin' | 'member' })),
    )
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // orgIds 는 참조 안정성이 중요하다 — 소비자(useEffect 의존성)가 매 렌더 재실행되지
  // 않도록 memberships 가 바뀔 때만 새 배열을 만든다.
  const orgIds = useMemo(() => memberships.map((m) => m.orgId), [memberships])
  const primaryOrgId = orgIds[0] ?? null
  const isAdmin = useMemo(() => memberships.some((m) => m.role === 'admin'), [memberships])
  // org 별 admin 판정 — 대시보드는 여러 org 의 공유본을 한 그리드에 섞으므로
  // "어딘가의 admin"(isAdmin)이 아니라 "그 행이 속한 org 의 admin"이어야 한다.
  const adminOrgIds = useMemo(
    () => memberships.filter((m) => m.role === 'admin').map((m) => m.orgId),
    [memberships],
  )

  return { memberships, orgIds, adminOrgIds, primaryOrgId, isAdmin, loading, refresh }
}
