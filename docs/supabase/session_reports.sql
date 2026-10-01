-- ─────────────────────────────────────────────────────────────────────────────
-- session_reports — 고객이 CT(Copilot) 탭에서 올리는 "이슈 리포트" 수신함.
--
-- 목적: 고객사가 앱을 쓰다 문제를 겪으면, ⚠ 버튼 한 번으로 그 세션의 채팅
-- 트랜스크립트 · 활동 로그 · 연결된 워크플로 run 상세 · OpenClaw 프로세스 로그
-- tail · 환경 메타를 한 행으로 올린다 → Twixy 스태프가 원격 진단.
-- 클라이언트: src/lib/sessionReports.ts (payload 스키마도 그 파일이 원본).
--
-- ★ 이 테이블은 "지원 티켓 수신함"이다. 팀 공유 대시보드가 아니다.
--   · 고객: 자기 명의로 INSERT 만 가능.
--   · 고객 본인/같은 org 멤버: SELECT 불가 — payload 에 대화 전문이 통째로
--     들어가므로 org 범위 읽기를 열면 그 자체가 프라이버시 사고다.
--   · Twixy 스태프: service_role 키 또는 Supabase 대시보드(Table Editor /
--     SQL Editor)로만 조회 — 둘 다 RLS 를 우회한다.
--
-- ★ SELECT 정책이 없으므로 렌더러는 insert 후 행을 되돌려받을 수 없다.
--   → 클라이언트가 id(uuid)를 직접 생성하고 .select() 없이 insert 한다.
--     (teamRuns.reportRunStart 와 동일 패턴. 나중에 누가 .select() 를 붙이면
--      PostgREST 가 representation 을 못 만들어 실패한다 — 붙이지 말 것.)
--
-- 배포 완료 (2026-08-05, 프로젝트 mooltalmugrwzkvvawip):
--   ~/Dev/X Viral Marketing Tool/supabase/migrations/20260805000000_session_reports.sql
--   로 사본을 두고 `supabase db push` 로 적용했다. 이 레포의 다른 SQL 문서와 달리
--   SQL Editor 수동 실행이 아니다 — 마이그레이션 이력이 남는 쪽이 정본이므로,
--   이후 스키마 변경도 저쪽에 마이그레이션을 추가하고 이 파일을 함께 갱신할 것.
--   (테이블 생성은 anon 키로 불가 — 프로젝트 소유자 권한이 필요)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.session_reports (
  -- 클라이언트 생성 uuid. 서버 default 를 쓰지 않는 이유: insert-only RLS 라
  -- 생성값을 못 돌려받는데, 앱은 "접수번호"를 즉시 화면에 띄워야 한다.
  id                uuid primary key,
  created_at        timestamptz not null default now(),

  -- 신고자. auth.users FK 는 일부러 걸지 않는다 — 계정이 지워져도 리포트(=지원
  -- 이력)는 남아야 한다.
  reporter_user_id  uuid not null default auth.uid(),
  reporter_email    text,
  reporter_name     text,
  org_id            uuid,

  -- 수신함에서 필터/정렬할 값만 컬럼으로 승격. 본문은 전부 payload 안에 있다.
  conv_id           text not null,
  conv_title        text,
  conv_mode         text check (conv_mode in ('wf', 'simple')),
  wf_id             text,
  wf_title          text,

  -- 사용자가 남긴 한 줄 증상 설명 (선택). 클라이언트 200자, DB 500자 방어.
  note              text check (note is null or char_length(note) <= 500),

  app_version       text,
  platform          text,

  -- 전체 로그 번들. 스키마는 src/lib/sessionReports.ts 의 SessionReportPayload
  -- (payload.schema 로 버전 구분).
  payload           jsonb not null,
  payload_bytes     integer,
  -- 크기 상한 때문에 잘려나간 섹션 마커 ('messages:last-40',
  -- 'openClawLogTail:dropped' …). 스태프가 "왜 로그가 없지?" 로 헤매지 않게.
  truncated         text[],

  -- 스태프 트리아지용. 고객은 못 읽고 못 고친다 (정책이 없으므로).
  status            text not null default 'new'
                      check (status in ('new', 'triaged', 'in_progress', 'resolved', 'wontfix')),
  staff_notes       text,
  resolved_at       timestamptz
);

-- 수신함 정렬(최신순) · 신고자별 · org(고객사)별 · 미해결 필터.
create index if not exists idx_session_reports_created
  on public.session_reports (created_at desc);
create index if not exists idx_session_reports_reporter
  on public.session_reports (reporter_user_id, created_at desc);
create index if not exists idx_session_reports_org
  on public.session_reports (org_id, created_at desc);
create index if not exists idx_session_reports_open
  on public.session_reports (created_at desc)
  where status <> 'resolved';

alter table public.session_reports enable row level security;

-- ── 권한: Supabase 는 public 스키마의 새 테이블에 anon/authenticated 전체
--    권한을 기본 부여한다. 수신함이므로 명시적으로 좁힌다 (RLS 와 이중 방어).
revoke all on public.session_reports from anon;
revoke all on public.session_reports from authenticated;
grant  insert on public.session_reports to authenticated;

-- ── 정책은 하나뿐: 로그인 사용자가 "자기 명의로" INSERT ──────────────────────
drop policy if exists "sr insert own" on public.session_reports;
create policy "sr insert own" on public.session_reports
  for insert to authenticated
  with check (reporter_user_id = auth.uid());

-- SELECT / UPDATE / DELETE 정책은 의도적으로 없음.
--   → 고객은 자기가 올린 리포트조차 되읽을 수 없다 (접수번호는 앱이 로컬 생성).
--   → 같은 org 멤버도 남의 대화 전문을 볼 수 없다.
--   → 스태프는 service_role / 대시보드로만 접근 (RLS bypass).
-- 검증: anon 키 + 사용자 JWT 로 GET /rest/v1/session_reports 하면 [] 가 와야 정상.

-- ── (선택) 스태프 트리아지 뷰 — payload 를 빼고 목록만 빠르게 훑을 때 ─────────
-- 대시보드/service_role 전용. RLS 는 base table 에서 이미 강제된다.
create or replace view public.session_reports_inbox as
  select id, created_at, status, reporter_email, reporter_name, org_id,
         conv_title, conv_mode, wf_title, note, app_version, platform,
         payload_bytes, truncated
    from public.session_reports;
revoke all on public.session_reports_inbox from anon;
revoke all on public.session_reports_inbox from authenticated;
