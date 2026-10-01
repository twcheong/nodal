-- live_workflows — 팀 실시간 공동편집 문서. (US-R1-04, 가벼운 버전)
-- 로컬 파일 모델과 별개: "함께 편집" 켠 워크플로는 이 서버 행이 진실. org 멤버 누구나
-- read/write, Supabase Realtime 로 변경 브로드캐스트 → 모두 즉시 반영. 충돌은 LWW
-- (마지막 저장 이김) + 노드별 편집 presence(별도 Realtime Presence 채널)로 보완.
-- Supabase SQL editor 에서 1회 실행.

create table if not exists public.live_workflows (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  title         text,
  workflow_json jsonb not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists live_workflows_org_idx on public.live_workflows(org_id);

alter table public.live_workflows enable row level security;

-- org 멤버면 읽기.
drop policy if exists live_workflows_read on public.live_workflows;
create policy live_workflows_read on public.live_workflows for select to authenticated
  using (exists (select 1 from public.organization_members m
                 where m.org_id = live_workflows.org_id and m.user_id = auth.uid()));

-- org 멤버면 편집(공동편집이 목적).
drop policy if exists live_workflows_update on public.live_workflows;
create policy live_workflows_update on public.live_workflows for update to authenticated
  using (exists (select 1 from public.organization_members m
                 where m.org_id = live_workflows.org_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.organization_members m
                 where m.org_id = live_workflows.org_id and m.user_id = auth.uid()));

-- org 멤버면 라이브 문서 생성.
drop policy if exists live_workflows_insert on public.live_workflows;
create policy live_workflows_insert on public.live_workflows for insert to authenticated
  with check (exists (select 1 from public.organization_members m
                 where m.org_id = live_workflows.org_id and m.user_id = auth.uid()));

-- 삭제 = 생성자 또는 admin.
drop policy if exists live_workflows_delete on public.live_workflows;
create policy live_workflows_delete on public.live_workflows for delete to authenticated
  using (created_by = auth.uid() or public.is_org_admin(org_id));

-- Realtime: UPDATE 를 구독자에게 브로드캐스트.
alter publication supabase_realtime add table public.live_workflows;
