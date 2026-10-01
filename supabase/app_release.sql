-- app_release — "새 버전 나옴" 알림용 싱글턴 테이블.
-- anon 은 SELECT 만. INSERT/UPDATE/DELETE 는 service-role(대시보드/서버)만.
-- Supabase SQL editor 에서 1회 실행. 릴리즈할 때는 아래 UPDATE 한 줄.

create table if not exists public.app_release (
  id             int primary key default 1,
  latest_version text        not null,
  download_url   text        not null,
  notes          text,
  min_supported  text,                          -- 이 미만이면 강제 업데이트 배너
  updated_at     timestamptz not null default now(),
  constraint app_release_singleton check (id = 1)  -- 행 1개 강제
);

alter table public.app_release enable row level security;

-- anon(로그인 유저 포함) 읽기만 허용.
drop policy if exists app_release_read on public.app_release;
create policy app_release_read
  on public.app_release for select
  to anon, authenticated
  using (true);

-- 쓰기 정책 없음 → service-role 만 UPDATE 가능. 유저는 값만 읽음.

-- 최초 1행 시드 (현재 버전으로).
insert into public.app_release (id, latest_version, download_url, notes)
values (1, '0.1.0', 'https://twixy.dev/download', null)
on conflict (id) do nothing;

-- ── 릴리즈 시 ────────────────────────────────────────────────
-- update public.app_release
--   set latest_version = '0.2.0',
--       download_url   = 'https://twixy.dev/download',
--       notes          = '무슨 변경',
--       updated_at     = now()
--   where id = 1;
