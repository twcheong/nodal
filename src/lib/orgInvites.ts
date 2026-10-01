// ─────────────────────────────────────────────────────────────────────────────
// orgInvites.ts — 팀 멤버 초대(코드 방식) + 멤버 제거. (US-R1-01)
//
// 이메일 서버가 없어 초대 = 공유 가능한 코드. admin 이 발급 → 상대가 로그인 상태에서
// 코드 입력 → 가입. 전부 DEFINER RPC (백엔드 supabase/org_invites.sql). 렌더러-직접,
// IPC 없음 — orgMembers.ts 와 동일 형태.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'

export interface OrgInviteRow {
  id:          string
  org_id:      string
  email:       string | null
  code:        string
  role:        'admin' | 'member'
  invited_by:  string | null
  status:      'pending' | 'accepted' | 'revoked'
  created_at:  string
}

// admin: 초대 코드 발급. 반환된 code 를 상대에게 공유.
export async function createOrgInvite(orgId: string, email?: string, role: 'admin' | 'member' = 'member'): Promise<OrgInviteRow> {
  const { data, error } = await supabase.rpc('create_org_invite', {
    p_org_id: orgId, p_email: email ?? null, p_role: role,
  })
  if (error) throw new Error(error.message)
  return data as OrgInviteRow
}

// 초대 이메일 발송 — Edge Function send-invite 호출. 미설정/실패해도 코드 방식은 그대로 동작.
// throw 하지 않고 성공 여부만 반환(호출부가 부드럽게 폴백).
export async function sendInviteEmail(to: string, code: string, orgName?: string, inviterName?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('send-invite', {
      body: { to, code, orgName, inviterName },
    })
    if (error) return { ok: false, error: error.message }
    return (data as { ok: boolean; error?: string }) ?? { ok: false, error: 'no_response' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// 초대받은 본인: 코드 입력해 가입. 반환 = 가입된 org_id.
export async function acceptOrgInvite(code: string): Promise<string> {
  const { data, error } = await supabase.rpc('accept_org_invite', { p_code: code.trim() })
  if (error) throw new Error(error.message)
  return data as string
}

// admin: 대기 중 초대 목록.
export async function listOrgInvites(orgId: string): Promise<OrgInviteRow[]> {
  const { data, error } = await supabase.rpc('list_org_invites', { p_org_id: orgId })
  if (error) throw new Error(error.message)
  return (data ?? []) as OrgInviteRow[]
}

// admin: 초대 취소.
export async function revokeOrgInvite(inviteId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_org_invite', { p_id: inviteId })
  if (error) throw new Error(error.message)
}

// admin: 멤버 제거. 기존 DB 함수 remove_org_member(p_org_id, p_member_user_id) 재사용
// (auth + self제거방지 + admin체크). 앱은 여태 안 썼지만 백엔드에 이미 있음.
export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_org_member', { p_org_id: orgId, p_member_user_id: userId })
  if (error) throw new Error(error.message)
}
