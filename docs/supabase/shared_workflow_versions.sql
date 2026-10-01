-- ─────────────────────────────────────────────────────────────────────────────
-- shared_workflow_versions — 공유 워크플로의 버전 이력 (업데이트 직전 스냅샷).
--
-- shared_workflows 는 재공유 시 upsert 로 스냅샷을 덮어써 이전 버전이 사라진다.
-- 이 테이블 + BEFORE UPDATE 트리거로, 워크플로 내용이 바뀌기 "직전"의 스냅샷을
-- 자동 보관한다 → Team Dashboard 상세 모달에서 이전 버전을 조회할 수 있다.
--
-- 배포: Supabase SQL Editor 에 이 파일을 그대로 실행.
--   (테이블 생성은 anon 키로 불가 — 프로젝트 소유자가 SQL Editor 에서 실행해야 함)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.shared_workflow_versions (
  id            uuid primary key default gen_random_uuid(),
  -- 부모 공유 행. 공유 해제(삭제) 시 이력도 함께 정리.
  shared_id     uuid not null references public.shared_workflows(id) on delete cascade,
  org_id        uuid not null,
  owner_user_id uuid not null,
  source_wf_id  text not null,
  title         text not null,
  workflow_json jsonb not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_swv_shared_created
  on public.shared_workflow_versions (shared_id, created_at desc);

alter table public.shared_workflow_versions enable row level security;

-- 읽기: 해당 org 멤버 누구나 (shared_workflows 읽기 정책과 동일 범위).
drop policy if exists "swv read by org members" on public.shared_workflow_versions;
create policy "swv read by org members" on public.shared_workflow_versions
  for select using (
    org_id in (select org_id from public.organization_members where user_id = auth.uid())
  );

-- 쓰기는 아래 트리거(security definer)로만 이뤄지므로 별도 insert 정책은 불필요.
-- update/delete 정책 없음 → 이력은 불변. 삭제는 부모 행 cascade 로만.

-- ── 업데이트 직전 스냅샷 트리거 ───────────────────────────────────────────────
-- workflow_json 이 실제로 바뀌는 UPDATE 에서만, 바뀌기 전(OLD) 스냅샷을 append.
-- (태그만 바꾸는 updateSharedTags 는 workflow_json 을 안 건드리므로 버전 안 남음.)
create or replace function public.snapshot_shared_workflow_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.shared_workflow_versions
    (shared_id, org_id, owner_user_id, source_wf_id, title, workflow_json, created_at)
  values
    (OLD.id, OLD.org_id, OLD.owner_user_id, OLD.source_wf_id, OLD.title, OLD.workflow_json, coalesce(OLD.updated_at, now()));
  return NEW;
end;
$$;

drop trigger if exists trg_snapshot_shared_workflow on public.shared_workflows;
create trigger trg_snapshot_shared_workflow
  before update on public.shared_workflows
  for each row
  when (OLD.workflow_json is distinct from NEW.workflow_json)
  execute function public.snapshot_shared_workflow_version();
