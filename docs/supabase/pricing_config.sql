-- ──────────────────────────────────────────────────────────────────────────
-- Twixy display-markup pricing schema (two tables)
--
-- ── Lookup order in electron/pricing.ts ─────────────────────────────────
--   1. user_pricing.markup_multiplier (per-user override)
--   2. pricing_config.display_markup  (single-row global default)
--   3. neither row exists / fetch fails → error → renderer falls back to
--      raw cost with a small "*" indicator + "may be inaccurate" tooltip
--
-- ── Migration ownership ─────────────────────────────────────────────────
-- Twixy and the "X Viral Marketing Tool" web app share one Supabase
-- project. Migrations are managed by ~/Dev/X Viral Marketing Tool — copy
-- changes into that repo and run `supabase db push` FROM THAT REPO.
--
-- Applied as of 2026-06-18 via:
--   20260618171500_pricing_config.sql       (global default)
--   20260618172000_user_pricing_override.sql (per-user override)
--
-- ── Editing markup ──────────────────────────────────────────────────────
-- Global default:
--   update pricing_config set display_markup = 1.3 where id = true;
--
-- Per-user override (for a given email):
--   insert into user_pricing (user_id, markup_multiplier)
--     values ((select id from auth.users where email = 'foo@bar.com'), 1.5)
--     on conflict (user_id) do update set markup_multiplier = excluded.markup_multiplier;
--
-- Twixy picks up changes on the next 5-min cache cycle (or immediately on
-- IPC `refreshMarkup` call).
-- ──────────────────────────────────────────────────────────────────────────

-- Global default (single row).
create table if not exists pricing_config (
  id              boolean   primary key default true check (id = true),
  display_markup  numeric   not null default 1.0 check (display_markup > 0),
  updated_at      timestamptz not null default now()
);
insert into pricing_config (id, display_markup) values (true, 1.0)
  on conflict (id) do nothing;

alter table pricing_config enable row level security;
drop policy if exists "auth can read pricing config" on pricing_config;
create policy "auth can read pricing config" on pricing_config
  for select using (auth.role() = 'authenticated');

create or replace function pricing_config_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists pricing_config_updated_at on pricing_config;
create trigger pricing_config_updated_at
  before update on pricing_config
  for each row execute function pricing_config_set_updated_at();

-- Per-user override (priority over pricing_config).
create table if not exists user_pricing (
  user_id           uuid       primary key references auth.users(id) on delete cascade,
  markup_multiplier numeric    not null default 1.0 check (markup_multiplier > 0),
  updated_at        timestamptz not null default now()
);
alter table user_pricing enable row level security;
drop policy if exists "users read own pricing" on user_pricing;
create policy "users read own pricing" on user_pricing
  for select using (auth.uid() = user_id);

create or replace function user_pricing_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists user_pricing_updated_at on user_pricing;
create trigger user_pricing_updated_at
  before update on user_pricing
  for each row execute function user_pricing_set_updated_at();
