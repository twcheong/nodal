// ─────────────────────────────────────────────────────────────────────────────
// orgMembers.ts — 팀 멤버 로스터 조회 (DEFINER RPC list_org_members).
//
// organization_members 엔 이름/이메일이 없고(auth.users 소관) 클라이언트가
// 직접 못 읽으므로, 서버 함수가 호출자의 org 에 한해 신원을 돌려준다.
// 멤버끼리 서로 보이는 것은 기존 투명 공개 결정과 일관.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'

export interface OrgMemberRow {
  org_id:       string
  user_id:      string
  email:        string | null
  display_name: string | null
  role:         'admin' | 'member'
  joined_at:    string
}

export async function listOrgMembers(): Promise<OrgMemberRow[]> {
  const { data, error } = await supabase.rpc('list_org_members')
  if (error) throw new Error(error.message)
  return (data ?? []) as OrgMemberRow[]
}
