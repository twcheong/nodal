-- Nodal 기본 스키마 — 데스크톱 앱이 기대하는 계약(docs/BACKEND_CONTRACT.md §5)의 DB 쪽.
--
-- Twixy 의 같은 테이블들을 한 번에 정리해 옮긴 것이다 (Twixy 는 20개 가까운 마이그레이션에
-- 걸쳐 자랐다). B2C 단일 사용자 제품이라 org/team 테이블은 없다.
--
-- Twixy 와 의도적으로 다른 점 하나: OpenRouter 키를 user_subscriptions 에 두지 않는다.
-- Twixy 는 그 테이블에 "본인 행 SELECT" 정책이 있어 키 원문이 클라이언트에서 읽힌다.
-- 여기서는 정책이 없는 별도 테이블에 둬서 service_role(백엔드)만 접근한다.

-- ── 구독 + 오늘 사용량 ────────────────────────────────────────────────
-- 앱이 상태바에서 직접 읽는다 (src/lib/entitlements.ts fetchOpenRouterUsageToday).
create table if not exists public.user_subscriptions (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  tier               text not null default 'free' check (tier in ('free', 'pro')),
  current_period_end timestamptz,

  -- 일일 쿼터 카운터. usage_date 가 오늘이 아니면 record_usage 가 0 으로 되돌린다.
  usage_date           date not null default current_date,
  messages_today       int  not null default 0,
  tokens_today         int  not null default 0,
  scheduled_runs_today int  not null default 0,
  searches_today       int  not null default 0,

  -- OpenRouter 실사용량. 백엔드의 /api/openrouter-usage 가 쓴다 (단위 USD).
  openrouter_usage_date            date,
  openrouter_tokens_in_today       bigint not null default 0,
  openrouter_tokens_cache_in_today bigint not null default 0,
  openrouter_tokens_out_today      bigint not null default 0,
  openrouter_usd_today             numeric(14,6) not null default 0,
  openrouter_tokens_in_total       bigint not null default 0,
  openrouter_tokens_cache_in_total bigint not null default 0,
  openrouter_tokens_out_total      bigint not null default 0,
  openrouter_usd_total             numeric(14,6) not null default 0,
  openrouter_synced_at             timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_subscriptions enable row level security;

-- 읽기만. tier·사용량을 클라이언트가 고칠 수 있으면 과금이 무의미하다 — 쓰기는 전부
-- service_role(백엔드) 또는 아래 DEFINER 함수로만.
drop policy if exists "self read subscription" on public.user_subscriptions;
create policy "self read subscription" on public.user_subscriptions
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.user_subscriptions from anon, authenticated;

-- 가입 시 free 행 자동 생성.
create or replace function public.handle_new_user_subscription()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_subscriptions (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created_subscription on auth.users;
create trigger on_auth_user_created_subscription
  after insert on auth.users
  for each row execute function public.handle_new_user_subscription();

-- ── 쿼터 기록 ────────────────────────────────────────────────────────
-- /api/entitlements/record 가 사용자 토큰으로 호출한다. 한도 비교는 백엔드가 한다
-- (tier 별 한도의 단일 출처는 백엔드) — 여기는 원자적 증가와 일일 리셋만.
create or replace function public.record_usage(p_kind text, p_amount int default 1)
returns table (date date, messages int, tokens int, scheduled_runs int, searches int)
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := current_date;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('message', 'tokens', 'scheduled', 'search') then
    raise exception 'invalid_kind: %', p_kind;
  end if;
  if p_amount < 0 then raise exception 'negative_amount'; end if;

  insert into public.user_subscriptions (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  update public.user_subscriptions s set
    messages_today       = (case when s.usage_date = v_today then s.messages_today       else 0 end)
                           + (case when p_kind = 'message'   then p_amount else 0 end),
    tokens_today         = (case when s.usage_date = v_today then s.tokens_today         else 0 end)
                           + (case when p_kind = 'tokens'    then p_amount else 0 end),
    scheduled_runs_today = (case when s.usage_date = v_today then s.scheduled_runs_today else 0 end)
                           + (case when p_kind = 'scheduled' then p_amount else 0 end),
    searches_today       = (case when s.usage_date = v_today then s.searches_today       else 0 end)
                           + (case when p_kind = 'search'    then p_amount else 0 end),
    usage_date = v_today,
    updated_at = now()
  where s.user_id = v_uid;

  return query
    select s.usage_date, s.messages_today, s.tokens_today, s.scheduled_runs_today, s.searches_today
    from public.user_subscriptions s where s.user_id = v_uid;
end $$;

revoke all on function public.record_usage(text, int) from public, anon;
grant execute on function public.record_usage(text, int) to authenticated;

-- ── OpenRouter 키 (서버 전용) ─────────────────────────────────────────
-- RLS 를 켜고 정책을 만들지 않는다 → anon/authenticated 는 아무것도 못 본다.
create table if not exists public.user_openrouter_keys (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  api_key    text not null,
  key_hash   text not null,          -- OpenRouter 가 돌려주는 hash — limit 패치·삭제에 쓴다
  usd_limit  numeric(14,6) not null, -- 발급 시 건 한도 (기간 누적 지출 상한)
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_openrouter_keys enable row level security;
revoke all on public.user_openrouter_keys from anon, authenticated;

-- ── 표시 가격 배율 ───────────────────────────────────────────────────
-- electron/pricing.ts 가 읽는다: user_pricing(사용자별) → pricing_config(전역) 순.
create table if not exists public.pricing_config (
  id             boolean primary key default true check (id = true),
  display_markup numeric not null default 1.0 check (display_markup > 0),
  updated_at     timestamptz not null default now()
);
insert into public.pricing_config (id, display_markup) values (true, 1.0)
  on conflict (id) do nothing;
alter table public.pricing_config enable row level security;
drop policy if exists "auth can read pricing config" on public.pricing_config;
create policy "auth can read pricing config" on public.pricing_config
  for select to authenticated using (true);

create table if not exists public.user_pricing (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  markup_multiplier numeric not null default 1.0 check (markup_multiplier > 0),
  updated_at        timestamptz not null default now()
);
alter table public.user_pricing enable row level security;
drop policy if exists "users read own pricing" on public.user_pricing;
create policy "users read own pricing" on public.user_pricing
  for select to authenticated using (auth.uid() = user_id);

-- ── 업데이트 배너 ────────────────────────────────────────────────────
-- 새 버전을 낼 때: update app_release set latest_version='…', download_url='…';
create table if not exists public.app_release (
  id             int primary key default 1,
  latest_version text not null,
  download_url   text not null,
  notes          text,
  min_supported  text,                 -- 이 미만이면 강제 업데이트 배너
  updated_at     timestamptz not null default now(),
  constraint app_release_singleton check (id = 1)
);
alter table public.app_release enable row level security;
drop policy if exists app_release_read on public.app_release;
create policy app_release_read on public.app_release
  for select to anon, authenticated using (true);
-- 행은 첫 릴리스 때 넣는다. 비어 있으면 앱은 배너를 띄우지 않는다.

-- ── 이슈 리포트 ──────────────────────────────────────────────────────
-- 사용자는 INSERT 만. 읽기는 service_role (대시보드) — 남의 대화 로그가 들어 있다.
create table if not exists public.session_reports (
  id               uuid primary key,
  created_at       timestamptz not null default now(),
  reporter_user_id uuid not null default auth.uid(),
  reporter_email   text,
  reporter_name    text,
  org_id           uuid,               -- Nodal 은 항상 null. 앱 코드가 컬럼을 보내므로 유지
  conv_id          text not null,
  conv_title       text,
  conv_mode        text,               -- Twixy 는 ('wf','simple') 체크 — Nodal 은 'video' 등이 온다
  wf_id            text,
  wf_title         text,
  note             text check (note is null or char_length(note) <= 500),
  app_version      text,
  platform         text,
  payload          jsonb not null,
  payload_bytes    integer,
  truncated        text[],
  status           text not null default 'new'
                     check (status in ('new', 'triaged', 'in_progress', 'resolved', 'wontfix')),
  staff_notes      text,
  resolved_at      timestamptz
);
create index if not exists idx_session_reports_created  on public.session_reports (created_at desc);
create index if not exists idx_session_reports_reporter on public.session_reports (reporter_user_id, created_at desc);

alter table public.session_reports enable row level security;
revoke all on public.session_reports from anon, authenticated;
grant insert on public.session_reports to authenticated;
drop policy if exists "sr insert own" on public.session_reports;
create policy "sr insert own" on public.session_reports
  for insert to authenticated with check (reporter_user_id = auth.uid());
