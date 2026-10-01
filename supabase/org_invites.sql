-- org_invites — 기존 org 에 멤버를 "초대 코드"로 초대. (US-R1-01)
-- 이메일 서버가 없으므로 초대 = 공유 가능한 코드. admin 이 코드 발급 → 상대가
-- Twixy 로그인 상태에서 코드 입력 → organization_members 에 자기 행 추가(가입).
-- 전부 렌더러-직접-supabase (기존 log_org_activity 등과 동일 DEFINER 패턴). IPC 불필요.
-- Supabase SQL editor 에서 1회 실행.

-- ── 테이블 ────────────────────────────────────────────────
create table if not exists public.org_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  email        text,                              -- 참고용 라벨(수락은 코드로)
  code         text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 12),
  role         text not null default 'member' check (role in ('admin','member')),
  invited_by   uuid,
  status       text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  uuid
);
create index if not exists org_invites_org_idx on public.org_invites(org_id, status);

alter table public.org_invites enable row level security;

-- 멤버는 자기 org 의 초대 목록을 읽을 수 있음(대기 목록 표시용). 쓰기는 RPC 로만.
drop policy if exists org_invites_read on public.org_invites;
create policy org_invites_read on public.org_invites for select to authenticated
  using (exists (select 1 from public.organization_members m
                 where m.org_id = org_invites.org_id and m.user_id = auth.uid()));

-- ── admin 판정 헬퍼 ───────────────────────────────────────
create or replace function public.is_org_admin(p_org uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.organization_members m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.role = 'admin')
      or exists (select 1 from public.organizations o
                 where o.id = p_org and o.created_by = auth.uid());
$$;

-- ── 초대 발급 (admin 전용) ────────────────────────────────
create or replace function public.create_org_invite(p_org_id uuid, p_email text default null, p_role text default 'member')
returns public.org_invites language plpgsql security definer set search_path = public as $$
declare inv public.org_invites;
begin
  if not public.is_org_admin(p_org_id) then raise exception 'not_admin'; end if;
  if p_role not in ('admin','member') then raise exception 'bad_role'; end if;
  insert into public.org_invites (org_id, email, role, invited_by)
    values (p_org_id, nullif(p_email,''), p_role, auth.uid())
    returning * into inv;
  return inv;
end $$;

-- ── 초대 수락 (초대받은 본인이 호출) ──────────────────────
create or replace function public.accept_org_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.org_invites;
begin
  select * into inv from public.org_invites where code = p_code and status = 'pending';
  if inv.id is null then raise exception 'invalid_or_used_code'; end if;
  if not exists (select 1 from public.organization_members
                 where org_id = inv.org_id and user_id = auth.uid()) then
    insert into public.organization_members (org_id, user_id, role, invited_by, joined_at)
      values (inv.org_id, auth.uid(), inv.role, inv.invited_by, now());
  end if;
  update public.org_invites
     set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
   where id = inv.id;
  return inv.org_id;
end $$;

-- ── 초대 취소 (admin) ─────────────────────────────────────
create or replace function public.revoke_org_invite(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.org_invites;
begin
  select * into inv from public.org_invites where id = p_id;
  if inv.id is null then raise exception 'not_found'; end if;
  if not public.is_org_admin(inv.org_id) then raise exception 'not_admin'; end if;
  update public.org_invites set status = 'revoked' where id = p_id;
end $$;

-- ── 멤버 제거 ─────────────────────────────────────────────
-- remove_org_member(p_org_id, p_member_user_id) 는 DB 에 이미 존재(auth+self제거방지
-- +admin체크). 재정의하지 않고 재사용 — grant 만 아래에서 보장.

-- ── 대기 초대 목록 (admin) ────────────────────────────────
create or replace function public.list_org_invites(p_org_id uuid)
returns setof public.org_invites language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_admin(p_org_id) then raise exception 'not_admin'; end if;
  return query select * from public.org_invites
    where org_id = p_org_id and status = 'pending' order by created_at desc;
end $$;

grant execute on function public.create_org_invite(uuid, text, text) to authenticated;
grant execute on function public.accept_org_invite(text)            to authenticated;
grant execute on function public.revoke_org_invite(uuid)            to authenticated;
grant execute on function public.remove_org_member(uuid, uuid)      to authenticated;
grant execute on function public.list_org_invites(uuid)             to authenticated;
grant execute on function public.is_org_admin(uuid)                 to authenticated;
