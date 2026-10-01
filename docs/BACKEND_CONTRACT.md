# 백엔드 계약 — 데스크톱 앱이 제품 백엔드에 기대하는 것

한 레포에서 여러 제품(Twixy · Nodal)을 빌드하고, 제품마다 **Supabase 프로젝트와 웹 백엔드가 따로** 있다.
데스크톱의 에이전트 코어는 제품을 모르므로, 어느 백엔드든 **아래 계약을 똑같이** 지켜야 한다.
앱은 `products/<id>/profile.ts` 의 `supabase` · `webUrl` · `protocolScheme` 만 바꿔서 붙는다.

Twixy 의 구현은 웹 레포(`X Viral Marketing Tool`, twixy.dev)에 있다. Nodal 은 이 문서를 보고 새로 구현한다.
계약을 바꿀 때는 **두 백엔드와 이 문서를 함께** 고친다 (예정된 서버 이관 포함).

모든 API 는 `Authorization: Bearer <Supabase access_token>` 을 받고, 서버가 그 토큰을 Supabase 로 검증해 `user.id` 를 얻는다. 401 이면 앱이 refresh 후 1회 재시도한다 (`fetchWithSessionRetry`, `electron/main.ts`).

## 1. 로그인 핸드오프

| | |
|---|---|
| 앱 → 브라우저 | `shell.openExternal(<webUrl>/auth/desktop-callback)` |
| 페이지가 할 일 | Supabase 로그인(Google 등)을 끝낸 뒤 아래 딥링크로 리디렉트 |
| 브라우저 → 앱 | `<protocolScheme>://auth#access_token=…&refresh_token=…&expires_at=<unix초>` |

- 토큰은 **hash fragment** 에 넣는다 (HTTP 서버 로그에 남지 않게). `access_token` · `refresh_token` 필수.
- Twixy = `twixy://`, Nodal = `nodal://`. 스킴이 다르므로 콜백 페이지도 제품별이어야 한다.
- 이후 세션 갱신은 앱이 직접 한다: `POST <supabase.url>/auth/v1/token?grant_type=refresh_token` (`apikey: <anonKey>`).

## 2. LLM 키 발급 — `GET /api/openrouter-key`

사용자별 OpenRouter 키를 발급(또는 재사용)해 돌려준다. 앱은 이 키를 게이트웨이에 `OPENROUTER_API_KEY` 로 주입한다. **과금 한도의 실제 강제는 이 키의 `limit` 이다** — 앱의 표시용 수치가 아니다.

```jsonc
// 200
{ "ok": true, "apiKey": "sk-or-…", "baseUrl": "https://openrouter.ai/api/v1", "expiresAt": 1790000000000 }  // ms
// 402 — 쓸 수 있는 키를 줄 수 없다 (한도 0, 잔액 없음). limit 0 짜리 키를 주지 말 것:
//       모든 요청이 원인 모를 provider 오류로 실패해 진단이 불가능했다.
{ "ok": false, "error": "no_credit", "message": "사람이 읽을 사유" }
```

- 앱은 만료 5분 전까지 키를 캐시한다. 호출마다 새 키를 만들어도 되지만, 같은 기간 안에서는 **같은 키를 재사용**하는 편이 사용량 집계가 단순하다.
- 한도 계산의 함정은 `docs/CREDIT_LIMIT_INCIDENT_2026-08-08.md` 에 있다: OpenRouter `limit` 은 기간 *누적 지출 상한*이다. 잔액(이미 지출이 빠진 값)을 그대로 limit 에 넣으면 같은 돈을 두 번 뺀다. `usage`(전 기간)와 `usage_monthly`(현재 월)도 혼동 금지.

## 3. 사용량 기록 — `POST /api/openrouter-usage`

두 경로에서 호출된다. 서버는 둘 다 받아야 한다.

```jsonc
// (a) 턴마다 — record-openrouter-usage IPC
{ "tokensIn": 1200, "tokensCacheIn": 800, "tokensOut": 300, "usdDelta": 0.0012, "usdActual": 0.0345 }
// (b) 5분 주기 동기화 — syncOpenRouterUsage. 본문이 {} 일 수도 있다 (빈 본문으로 보내지 않는다).
{ "usdActual": 0.0345 }

// 200
{ "ok": true, "deltaUsd": 0.0012 }
```

- **금액은 서버가 OpenRouter 에서 직접 읽는다.** 그 키의 "이번 기간 누적 지출"(월 리셋 키면 `usage_monthly` + `byok_usage_monthly`)을 조회하고, 지난번에 장부에 올린 지점(키별 워터마크)과의 차이만 더한다. 클라이언트가 보낸 `usdDelta` · `usdActual` 은 금액 계산에 쓰지 않는다 — 조작 가능한 값이고, 토큰×단가 계산은 실제 청구와 어긋난다. 토큰 수는 표시용 카운터에만 쓴다.
- 키가 새로 발급되거나 달이 바뀌면 누적값이 0 에서 다시 시작한다 — 워터마크도 0 으로 되돌려야 한다. 빠뜨리면 "사용량이 줄었다" 로 보여 지출이 장부에서 빠진다.
- OpenRouter 를 읽지 못한 동기화에서는 금액을 올리지 않는다. 누적값 기준이라 다음 동기화가 따라잡는다.
- 서버는 증분을 `user_subscriptions` 의 아래 컬럼에 반영한다 (앱이 상태바에서 직접 읽는다). `*_today` 컬럼은 이름과 달리 **이번 달 누적**이다 — 키의 limit 이 월 단위이기 때문 (Twixy·Nodal 공통 규약).

## 4. 요금제 조회 — `GET /api/entitlements`, `POST /api/entitlements/record`

```jsonc
// GET 200
{ "tier": "free" | "pro", "currentPeriodEnd": "2026-10-01T00:00:00Z" | null,
  "limits": { "messagesPerDay": 25, "scheduledJobs": 2, "searchesPerDay": 25, "tokensPerDay": 1780000 },
  "usage":  { "date": "2026-09-18", "messages": 3, "tokens": 41000, "scheduledRuns": 0, "searches": 0 } }

// POST { "kind": "message" | "tokens" | "scheduled" | "search", "amount": 1 }
// 200  { "allowed": true | false, "tier", "limits", "usage", "reason"?: "…" }
```

쿼터를 넘으면 `allowed:false` — 앱은 전송을 막고 업그레이드 모달을 띄운다. Nodal 은 웹 검색·예약 작업이 없으므로 `search` · `scheduled` 는 항상 0 이어도 된다.

## 5. 앱이 Supabase 에서 직접 읽는 테이블 (RLS 필수)

| 테이블 | 용도 | 앱의 접근 |
|---|---|---|
| `user_subscriptions` | 오늘 사용량 표시. 컬럼: `user_id`, `openrouter_tokens_in_today`, `openrouter_tokens_cache_in_today`, `openrouter_tokens_out_today`, `openrouter_usd_today` | 본인 행 SELECT |
| `pricing_config` (`display_markup`) · `user_pricing` (`markup_multiplier`) | 표시 가격 배율. main 프로세스만 읽는다 (`electron/pricing.ts`) | SELECT |
| `app_release` | 업데이트 배너 (`supabase/app_release.sql`) | anon SELECT |
| `session_reports` | 이슈 리포트 업로드 (`docs/SESSION_REPORTS.md`) | 본인 INSERT |

팀 기능을 켠 제품(Twixy)만 추가로 쓰는 것: `organizations`, `organization_members`, `shared_workflows`, `live_workflows`, `org_workflow_runs`, `org_direct_messages`, org RPC 들. **Nodal 은 필요 없다.**

## 6. 제품이 쓰지 않으면 구현하지 않아도 되는 것

| 엔드포인트 | 조건 |
|---|---|
| `GET /api/tavily-token` (+ `/api/tavily-proxy`) | `features.webSearch` 가 true 인 제품만 |
| `/api/org/*`, Stripe org 풀 | 팀 기능 제품만 |

## Nodal 백엔드를 붙이는 순서

1. Supabase 프로젝트 생성 → §5 의 테이블 4종 + RLS, Auth provider(Google) + 리디렉트 허용목록.
2. §1–§4 구현 후 `products/nodal/profile.ts` 의 `supabase` · `webUrl` · `pricingUrl` 채우기.
3. `npm run dev:nodal` → 로그인 → 로그에 `[twixy/openrouter] key acquired` → 대화 1턴 → `user_subscriptions.openrouter_usd_today` 증가 확인.
