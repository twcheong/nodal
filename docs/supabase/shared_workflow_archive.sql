-- ─────────────────────────────────────────────────────────────────────────────
-- shared_workflows — 팀이 함께 관리하는 공유 워크플로 (archive) + admin 전용 영구삭제.
--
-- 문제: 기존 RLS 는 UPDATE/DELETE 를 owner_user_id = auth.uid() 로 묶어놨다.
--   · 팀원이 남의 공유본 제목을 고치거나 잘못된 태그를 바꿀 수 없다.
--   · WF 탭 "Unshare" 는 즉시 하드 삭제였고, shared_workflow_versions 가
--     FK cascade 로 함께 날아가 복구가 불가능했다.
--
-- 새 모델:
--   · org 멤버 누구나 → archive / unarchive / 제목·설명·태그 편집
--   · org ADMIN 만    → 영구 삭제, 그것도 이미 archive 된 행에 한해서
--     (2단계: 먼저 archive → Team Dashboard 의 Archived 목록에서 삭제)
--
-- ★ 멤버 스코프 쓰기는 전부 SECURITY DEFINER RPC 다
--   (record_shared_workflow_use / log_org_activity 와 동일 패턴).
--   RLS 가 여전히 owner-scoped 이므로 비-owner 의 직접 UPDATE 는 행이 0건으로
--   필터링되고 PostgREST 는 "성공"을 돌려준다 → UI 가 거짓으로 "archive 됨"을
--   표시하고 새로고침하면 그대로 살아있다. 나중에 누가 "간단하게"
--   .from('shared_workflows').update(...) 로 되돌리면 이 무음 실패가 재발한다.
--
-- ★ 이 파일이 일부러 건드리지 않는 것 2가지:
--   · updated_at — "owner 가 새 내용을 게시함"을 뜻하고 fork staleness
--     (StaleCopyBanner)의 기준이다. archive/제목변경은 새 내용이 아니다.
--   · workflow_json — trg_snapshot_shared_workflow 가
--     `when (OLD.workflow_json is distinct from NEW.workflow_json)` 이라
--     건드리지 않으면 버전 이력이 오염되지 않는다.
--     (결과: row.title 과 row.workflow_json.title 이 갈라질 수 있으므로
--      클라이언트는 항상 row 레벨 값을 우선한다 — TeamDashboardPanel 참조)
--
-- 클라이언트: src/lib/sharedWorkflows.ts (setSharedArchived / updateSharedMeta /
--   deleteSharedWorkflow), src/components/TeamDashboardPanel.tsx (Archived 섹션),
--   src/components/workflow/ShareWorkflowButton.tsx (Unshare → Archive)
--
-- 배포: ~/Dev/X Viral Marketing Tool/supabase/migrations/
--         20260806000000_shared_workflow_archive.sql 이 정본(`supabase db push`).
--       이 파일은 그 사본이다 — 스키마를 바꾸려면 저쪽에 새 마이그레이션을 추가하고
--       이 문서를 함께 갱신할 것. 정본은 push 이후 수정 금지.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. 컬럼 ──────────────────────────────────────────────────────────
alter table public.shared_workflows
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete set null;

-- 갤러리 질의는 "내 org 의 활성 행" — 부분 인덱스로 커버.
create index if not exists idx_shared_wf_org_active
  on public.shared_workflows(org_id)
  where archived_at is null;

-- ── 2. RLS 조정 ──────────────────────────────────────────────────────
-- owner INSERT + owner UPDATE 는 유지: 공유/재공유 경로가 PostgREST upsert
-- (on_conflict org_id,owner_user_id,source_wf_id) 라 둘 다 필요하다.
-- owner DELETE 는 제거: 영구 삭제는 admin 전용 RPC, archived 행만. 정책이
-- 아예 없어야 RPC 가 유일한 경로가 된다.
drop policy if exists "owner delete shared" on public.shared_workflows;

-- ── 3. Archive / Unarchive — 행이 속한 org 의 멤버 누구나 ────────────
create or replace function public.set_shared_workflow_archived(p_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null      then raise exception 'not_authenticated'; end if;
  if p_archived is null then raise exception 'invalid_args';      end if;

  if not exists (
    select 1 from public.shared_workflows sw
    where sw.id = p_id and sw.org_id = any(array(select public.my_org_ids()))
  ) then
    raise exception 'not_in_org';
  end if;

  -- coalesce(archived_at, now()): 재-archive 는 최초 시각을 보존.
  -- updated_at 은 의도적으로 미변경(헤더 참조).
  update public.shared_workflows set
    archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
    archived_by = case when p_archived then v_uid                        else null end
  where id = p_id;
end;
$$;
grant execute on function public.set_shared_workflow_archived(uuid, boolean) to authenticated;

-- ── 4. 제목/설명/태그 — 행이 속한 org 의 멤버 누구나 ─────────────────
-- NULL 인자 = "변경 없음" (태그 칩이 남의 제목 편집과 경합하지 않고 태그만
-- 패치할 수 있게). p_description = '' 은 비우기.
create or replace function public.update_shared_workflow_meta(
  p_id          uuid,
  p_title       text   default null,
  p_description text   default null,
  p_tags        text[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  if not exists (
    select 1 from public.shared_workflows sw
    where sw.id = p_id and sw.org_id = any(array(select public.my_org_ids()))
  ) then
    raise exception 'not_in_org';
  end if;

  if p_title is not null and length(btrim(p_title)) > 200 then
    raise exception 'title_too_long';
  end if;
  if p_description is not null and length(p_description) > 2000 then
    raise exception 'description_too_long';
  end if;
  if p_tags is not null and coalesce(array_length(p_tags, 1), 0) > 8 then
    raise exception 'too_many_tags';
  end if;

  update public.shared_workflows set
    title       = coalesce(nullif(btrim(p_title), ''), title),
    description = case when p_description is null then description
                       else nullif(btrim(p_description), '') end,
    tags        = coalesce(p_tags, tags)
  where id = p_id;
end;
$$;
grant execute on function public.update_shared_workflow_meta(uuid, text, text, text[]) to authenticated;

-- ── 5. 영구 삭제 — 행이 속한 org 의 ADMIN, archived 행만 ─────────────
-- shared_workflow_versions 가 FK cascade 로 함께 삭제된다. 복구 불가.
create or replace function public.delete_shared_workflow(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_org      uuid;
  v_archived timestamptz;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  -- DEFINER 는 RLS 를 우회하므로 행을 먼저 읽고 명시적으로 인가한다.
  select org_id, archived_at into v_org, v_archived
  from public.shared_workflows where id = p_id;

  if v_org is null then return; end if;   -- 이미 없음 → 멱등

  if not exists (
    select 1 from public.organization_members
    where org_id = v_org and user_id = v_uid and role = 'admin'
  ) then
    raise exception 'not_an_admin';
  end if;

  -- 2단계 규칙: 살아있는 공유본은 바로 날릴 수 없다.
  if v_archived is null then raise exception 'not_archived'; end if;

  delete from public.shared_workflows where id = p_id;
end;
$$;
grant execute on function public.delete_shared_workflow(uuid) to authenticated;

-- ── 6. org_activity: action 어휘 확장 ────────────────────────────────
-- CHECK 이 두 곳(테이블 제약 + log_org_activity 내부)에 있다. 둘 다 넓혀야
-- 새 이벤트가 조용히 실패하지 않는다.
-- 'unshared' 는 과거 행 보존용으로 남긴다(더 이상 아무도 쓰지 않음).
-- 'edited' 는 비-owner 가 남의 템플릿을 개명한 유일한 감사 흔적이라 추가.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.org_activity'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%action%'
  loop
    execute format('alter table public.org_activity drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.org_activity
  add constraint org_activity_action_check
  check (action in ('shared','unshared','copied','run','archived','unarchived','deleted','edited'));

create or replace function public.log_org_activity(
  p_org_id       uuid,
  p_action       text,
  p_target_type  text,
  p_target_id    text,
  p_target_title text,
  p_actor_name   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_action not in ('shared','unshared','copied','run','archived','unarchived','deleted','edited') then
    raise exception 'invalid_action';
  end if;
  if p_org_id is null or not (p_org_id = any(array(select public.my_org_ids()))) then
    raise exception 'not_in_org';
  end if;

  insert into public.org_activity (org_id, actor_user_id, actor_name, action, target_type, target_id, target_title)
  values (p_org_id, auth.uid(), p_actor_name, p_action, coalesce(p_target_type, 'workflow'), p_target_id, p_target_title);
end;
$$;
grant execute on function public.log_org_activity(uuid, text, text, text, text, text) to authenticated;
