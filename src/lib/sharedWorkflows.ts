// ─────────────────────────────────────────────────────────────────────────────
// sharedWorkflows.ts — 팀 공유 워크플로 레지스트리(Supabase `shared_workflows`) 접근 레이어.
//
// 공유 모델: "명시적 공유 + 복사(템플릿)".
//   - 멤버가 워크플로를 팀에 공유하면 workflow_json 스냅샷을 org 스코프로 upsert.
//   - 팀원은 Team Dashboard 에서 보고 "내 것으로 복사"(fork) 해 자기 디스크에 독립 사본 생성.
//   - RLS 가 org 단위 접근을 강제하므로 렌더러에서 직접 호출해도 안전하다.
//
// 수명주기: 공유 → (누구나) archive ⇄ 복구 → (admin 만) 영구 삭제.
//   ★ archive/메타 편집은 반드시 DEFINER RPC 로만 간다. RLS 는 UPDATE/DELETE 를
//     owner 로 묶어놔서, 비-owner 의 직접 .update() 는 행이 0건으로 필터링되고
//     PostgREST 가 "성공"을 돌려준다 — UI 가 거짓 성공을 표시한다.
//     (docs/supabase/shared_workflow_archive.sql)
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'

export interface SharedWorkflowRow {
  id:            string
  org_id:        string
  owner_user_id: string
  owner_email:   string | null
  owner_name:    string | null
  source_wf_id:  string
  title:         string
  description:   string | null
  workflow_json: TwixyWorkflow
  tags:          string[]
  copy_count:    number
  run_count:     number
  last_used_at:  string | null
  created_at:    string
  updated_at:    string
  // archive = 팀 갤러리에서 내려둔 상태(소프트 삭제). 누구나 되돌릴 수 있다.
  archived_at:   string | null
  archived_by:   string | null
}

// Postgres jsonb 는 KB 단위 워크플로엔 충분하지만, 병리적으로 큰 행을 막기 위해 상한을 둔다.
const MAX_BLOB_BYTES = 256 * 1024

// 태그 정규화 — 공백 제거·소문자·중복 제거·개수/길이 상한. 필터 칩 매칭의 일관성 보장.
// 워크플로당 태그 N개 — 기능·클라이언트·단계로 다중 분류해 라이브러리가 커져도
// 칩 교집합으로 좁혀 찾을 수 있게(=폴더 없는 폴더). (US-R1-03)
const MAX_TAGS = 5
const MAX_TAG_LEN = 24
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim().toLowerCase().slice(0, MAX_TAG_LEN)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

// 태그 토글 UI(TagPicker)의 기본 팔레트 — 마케팅 에이전시 공통 분류.
// 실제 옵션은 이 기본값 ∪ 이미 org 에서 쓰인 태그로 구성된다(직접 타이핑 대체).
export const DEFAULT_TAGS = [
  'seo', 'content', 'research', 'reporting',
  'campaign', 'social', 'ads', 'email', 'analytics', 'client',
]

// 공유본의 메타(제목·설명·태그) 편집 — org 멤버 누구나. 스냅샷 재업로드 없이.
// 공유 워크플로는 팀 공용 자산이라 owner 가 아니어도 정리할 수 있어야 한다.
//
// undefined = 변경 없음 / null·'' = 비우기(설명만). RPC 쪽도 같은 규약.
// updated_at 과 workflow_json 은 건드리지 않는다 — 각각 fork stale 판정과
// 버전 스냅샷 트리거의 기준이라 분류/제목 변경으로 흔들면 안 된다.
// 결과적으로 row.title 이 workflow_json.title 과 갈라질 수 있다 → 표시·복사는
// 항상 row 레벨(팀이 큐레이션한) 값을 우선한다.
export async function updateSharedMeta(
  id: string,
  patch: { title?: string; description?: string | null; tags?: string[] },
): Promise<void> {
  const { error } = await supabase.rpc('update_shared_workflow_meta', {
    p_id:          id,
    p_title:       patch.title ?? null,
    p_description: patch.description === undefined ? null : (patch.description ?? ''),
    p_tags:        patch.tags ? normalizeTags(patch.tags) : null,
  })
  if (error) throw new Error(error.message)
}

export async function updateSharedTags(id: string, tags: string[]): Promise<void> {
  return updateSharedMeta(id, { tags })
}

// archived 행도 함께 가져온다 — 갤러리 규모(수십)라 한 번에 받아 클라이언트에서
// 활성/보관을 가른다. Archived 섹션이 같은 payload 를 쓰므로
// .is('archived_at', null) 로 "최적화"하면 그 섹션이 빈 채로 죽는다.
export async function listSharedForOrgs(orgIds: string[]): Promise<SharedWorkflowRow[]> {
  if (!orgIds.length) return []
  const { data, error } = await supabase
    .from('shared_workflows')
    .select('*')
    .in('org_id', orgIds)
  if (error) throw new Error(error.message)
  return (data ?? []) as SharedWorkflowRow[]
}

// "자주 사용" 랭킹 — 복사가 실행보다 강한 채택 신호라 가중치를 더 준다.
// 가중치는 코드 측 상수라 마이그레이션 없이 조정 가능.
export function rankShared(rows: SharedWorkflowRow[]): SharedWorkflowRow[] {
  const W_COPY = 3
  const W_RUN = 1
  return [...rows].sort((a, b) => {
    const sa = a.copy_count * W_COPY + a.run_count * W_RUN
    const sb = b.copy_count * W_COPY + b.run_count * W_RUN
    if (sb !== sa) return sb - sa
    return (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '')
  })
}

export async function shareWorkflow(
  orgId: string,
  user: { id: string; email?: string | null; name?: string | null },
  wf: TwixyWorkflow,
  tags: string[] = [],
): Promise<void> {
  const blob = JSON.stringify(wf)
  if (blob.length > MAX_BLOB_BYTES) throw new Error('workflow_too_large')
  // 버전 이력은 DB 트리거(snapshot_shared_workflow_version)가 UPDATE 직전 스냅샷을
  // 자동 보관한다 — 클라이언트는 그대로 upsert 만 하면 된다 (shared_workflow_versions.sql).
  const { error } = await supabase.from('shared_workflows').upsert(
    {
      org_id:        orgId,
      owner_user_id: user.id,
      owner_email:   user.email ?? null,
      owner_name:    user.name ?? null,
      source_wf_id:  wf.id,
      title:         wf.title,
      description:   wf.description ?? null,
      workflow_json: wf,
      tags:          normalizeTags(tags),
      // upsert 의 conflict-update 경로는 DB 가 updated_at 을 자동 갱신하지 않으므로
      // 명시한다 — 재공유 = 스냅샷 갱신이 팀원 사본의 stale 감지 기준이 된다.
      updated_at:    new Date().toISOString(),
      // conflict target 이 (org, owner, source_wf_id) 라 archive 된 행을 제자리에서
      // 갱신한다 → 여기서 플래그를 지우지 않으면 owner 는 "공유 성공"을 보고도
      // 갤러리에 나타나지 않는다. (owner 는 자기 행 UPDATE 권한이 있어 RLS 로 통과)
      archived_at:   null,
      archived_by:   null,
    },
    { onConflict: 'org_id,owner_user_id,source_wf_id' },
  )
  if (error) throw new Error(error.message)
}

// 공유 워크플로 1건의 버전 이력 (최신순). 테이블 미배포/권한 없으면 빈 배열.
export interface SharedVersionRow {
  id:            string
  shared_id:     string
  org_id:        string
  owner_user_id: string
  source_wf_id:  string
  title:         string
  workflow_json: TwixyWorkflow
  created_at:    string
}
export async function listSharedVersions(sharedId: string): Promise<SharedVersionRow[]> {
  const { data, error } = await supabase
    .from('shared_workflow_versions')
    .select('*')
    .eq('shared_id', sharedId)
    .order('created_at', { ascending: false })
  if (error) { console.warn('[shared] listSharedVersions:', error.message); return [] }
  return (data ?? []) as SharedVersionRow[]
}

// 팀 갤러리에서 내리기/되돌리기 — org 멤버 누구나(DEFINER RPC).
// 스냅샷도 버전 이력도 남으므로 되돌릴 수 있다. 이게 예전 "Unshare" 를 대체한다.
export async function setSharedArchived(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_shared_workflow_archived', { p_id: id, p_archived: archived })
  if (error) throw new Error(error.message)
}

// 영구 삭제 — org admin 만, 그것도 이미 archive 된 행만(RPC 가 강제).
// shared_workflow_versions 가 FK cascade 로 함께 사라진다. 복구 불가.
export async function deleteSharedWorkflow(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_shared_workflow', { p_id: id })
  if (error) throw new Error(error.message)
}

// 특정 워크플로(source_wf_id)가 이 사용자에 의해 이미 공유돼 있는지 조회 —
// WorkflowView 의 Share/Unshare 토글 상태 표시에 사용.
export async function findSharedRow(
  orgIds: string[],
  userId: string,
  sourceWfId: string,
): Promise<SharedWorkflowRow | null> {
  if (!orgIds.length) return null
  const { data } = await supabase
    .from('shared_workflows')
    .select('*')
    .in('org_id', orgIds)
    .eq('owner_user_id', userId)
    .eq('source_wf_id', sourceWfId)
    .maybeSingle()
  return (data as SharedWorkflowRow) ?? null
}

// 공유본 단건 조회 — fork 사본의 stale 감지("원본 업데이트됨")용.
// RLS 가 org 접근을 강제하므로 남의 org 행은 null. 원본이 unshare 됐어도 null.
export async function getSharedById(id: string): Promise<SharedWorkflowRow | null> {
  const { data } = await supabase
    .from('shared_workflows')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  return (data as SharedWorkflowRow) ?? null
}

// 사용 카운터 증가 — 비-소유자도 DEFINER RPC 로 올릴 수 있다(같은 org 여야 함).
export async function recordSharedUse(id: string, kind: 'copy' | 'run'): Promise<void> {
  await supabase.rpc('record_shared_workflow_use', { p_id: id, p_kind: kind })
}

// ── 팀 활동 피드 (org_activity) ──────────────────────────────────────────────
// append-only 로그. 쓰기는 DEFINER RPC(log_org_activity)로만 — actor 는 서버가
// auth.uid() 로 찍으므로 위조 불가. 조회는 org 멤버 SELECT (RLS).

// 'unshared' 는 과거 행 보존용 — archive 도입 후 새로 찍히지 않는다.
export type OrgActivityAction =
  | 'shared' | 'unshared' | 'copied' | 'run'
  | 'archived' | 'unarchived' | 'deleted' | 'edited'

export interface OrgActivityRow {
  id:            string
  org_id:        string
  actor_user_id: string
  actor_name:    string | null
  action:        OrgActivityAction
  target_type:   string
  target_id:     string | null
  target_title:  string | null
  created_at:    string
}

// 피드는 부가 기능 — 실패해도 공유/복사 UX 를 막지 않도록 호출부에서 무시한다.
export async function logActivity(
  orgId: string,
  action: OrgActivityAction,
  target: { id: string; title: string },
  actorName?: string | null,
): Promise<void> {
  await supabase.rpc('log_org_activity', {
    p_org_id:       orgId,
    p_action:       action,
    p_target_type:  'workflow',
    p_target_id:    target.id,
    p_target_title: target.title,
    p_actor_name:   actorName ?? null,
  })
}

export async function listActivity(orgIds: string[], limit = 50): Promise<OrgActivityRow[]> {
  if (!orgIds.length) return []
  const { data, error } = await supabase
    .from('org_activity')
    .select('*')
    .in('org_id', orgIds)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as OrgActivityRow[]
}
