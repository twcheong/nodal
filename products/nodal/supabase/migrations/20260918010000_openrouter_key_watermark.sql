-- 사용량 집계용 워터마크.
--
-- /api/openrouter-usage 는 클라이언트가 보낸 금액을 믿지 않고 OpenRouter 에서 그 키의
-- "이번 기간 누적 지출"을 직접 읽는다. 누적값이므로 지난번에 어디까지 장부에 올렸는지
-- (period_booked) 를 키마다 기억해야 증분만 더할 수 있다. 키가 바뀌거나 달이 바뀌면
-- 누적값이 0 에서 다시 시작하므로 워터마크도 0 으로 되돌린다 — 이걸 빠뜨리면 새 키의
-- 첫 동기화에서 "사용량이 줄었다" 로 보여 지출이 장부에서 빠진다.
alter table public.user_openrouter_keys
  add column if not exists period_booked numeric(14,6) not null default 0,
  add column if not exists period_month  date;
