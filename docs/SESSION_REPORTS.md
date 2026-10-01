# Session Reports — 고객 이슈 신고 수신함

고객사가 앱을 쓰다 문제를 겪으면 CT(Copilot) 탭에서 **⚠ Report** 버튼 한 번으로 그 세션의 로그를
우리 Supabase 로 올린다. 이전에는 문제 흔적이 전부 고객 로컬 머신에만 남아 원격 진단 수단이 없었다.

배포 완료 (2026-08-05, 프로젝트 `mooltalmugrwzkvvawip`). 코드는 `feature/ui-ux-polish` 브랜치.

---

## 고객이 보는 흐름

1. CT 탭 헤더, 대화 탭 스트립 오른쪽의 **⚠ Report** 클릭 (활성 탭 = 신고 대상)
2. 확인 모달: 무엇이 올라가는지 안내 + "무엇이 잘못됐나요?" 한 줄 메모(선택)
3. **Send report** → 업로드 → **접수번호**(uuid 앞 8자) 표시

확인을 눌러야만 전송된다. 취소·Escape·오버레이 클릭은 아무것도 올리지 않는다.
버튼은 활성 대화가 없거나 로그아웃 상태면 비활성.

고객이 접수번호를 알려주면 그걸로 행을 찾으면 된다.

---

## 우리가 보는 법

Supabase 대시보드 → Table Editor → **`session_reports`** (최신순).
목록만 빠르게 훑을 땐 **`session_reports_inbox`** 뷰 (payload 제외).

트리아지는 `status` 컬럼으로: `new` → `triaged` → `in_progress` → `resolved` / `wontfix`.
`staff_notes`, `resolved_at` 도 함께 있다. 대시보드에서 직접 수정하면 된다.

빠른 조회:

```sql
select id, created_at, reporter_email, org_id, conv_title, wf_title, note, payload_bytes
  from public.session_reports
 where status <> 'resolved'
 order by created_at desc;
```

### payload 안에 뭐가 있나

| 키 | 내용 |
|---|---|
| `messages` | 그 탭의 대화 전문 (user/assistant, 최대 300건) |
| `activityLog` | 툴 활동 로그 (최대 40줄) |
| `runDetail` | 연결된 워크플로 run 의 노드별 status·reason·prompt·output |
| `runSummary` | 실행 시간·비용·노드 성공/실패 카운트 |
| `openClawLogTail` | OpenClaw 프로세스 로그 꼬리 (최대 96KB) |
| `env` | 앱버전·OS·workspace·projectDir·타임존·userAgent |
| `identity` | userId / email / org |
| `truncated` | 크기 상한 때문에 잘려나간 섹션 마커 |

**`truncated` 를 먼저 보라.** `["messages:last-120", …]` 처럼 값이 있으면 그 섹션은 온전하지 않다.
비어 있으면 전량이 그대로 올라온 것.

행당 700KB 상한이 있고, 초과하면 `openClawLogTail` → `runDetail` 의 output → 오래된 메시지 순으로
줄인다. 메모와 신원/환경 정보는 어떤 경우에도 버리지 않는다.

---

## 프라이버시 / 권한

**이건 지원 티켓 수신함이지 팀 공유 대시보드가 아니다.** payload 에 고객 대화 전문이 통째로 들어가므로
읽기를 열면 그 자체가 사고다. 정책은 딱 하나 — 로그인 사용자가 **자기 명의로 INSERT 만**.

프로덕션에서 실측한 동작:

| 시도 | 결과 |
|---|---|
| anon 키로 SELECT / INSERT | 401 `42501` |
| 로그인 사용자가 SELECT | **403 `42501`** (같은 토큰으로 `org_workflow_runs` 는 200) |
| 로그인 사용자가 자기 명의 INSERT | 201 |
| 남의 `reporter_user_id` 로 INSERT | 403 (RLS with check 위반) |
| 자기가 넣은 행 되읽기 | 403 |

즉 고객도, 같은 org 의 동료도, 본인조차도 못 읽는다. 우리만 대시보드(service_role)로 본다.

### 레닥션

업로드 전에 자동으로 지워지는 것: JWT(`eyJ…`), `sk-ant-`, `sk-or-v1-`, OpenAI 키, `AIza…`,
AWS 키, `ghp_…`, Slack 토큰, `Bearer …`, `api_key=` 류. `[redacted:<종류>]` 로 치환된다.
**OpenClaw 로그에는 Supabase access token 이 실제로 찍히므로 이 처리가 필수다.**

**파일 경로는 일부러 안 지운다.** 이 앱에서 가장 흔한 실패가 "파일 못 찾음"이고 절대경로 자체가
진단 정보라서. 모달에서 고객에게 "경로가 포함된다"고 미리 알린다.

---

## 코드 위치

| 파일 | 역할 |
|---|---|
| `src/lib/sessionReports.ts` | payload 수집·레닥션·크기 축소·업로드·에러 분류 |
| `src/components/copilot/CopilotView.tsx` | ⚠ Report 버튼 + `ReportIssueModal` |
| `src/App.tsx` | `identityCtx` (user/org) 를 `reportCtx` 로 전달 |
| `docs/supabase/session_reports.sql` | 스키마 설명본 |
| `~/Dev/X Viral Marketing Tool/supabase/migrations/20260805000000_session_reports.sql` | **적용본 정본** — 수정 금지 |

스키마를 바꿀 땐 그쪽 레포에 **새 마이그레이션**을 추가하고 `supabase db push`, 그 다음 이 레포의
설명본을 갱신한다. 이미 적용된 마이그레이션 파일을 고치면 이후 push 에서 불일치 경고가 난다.

payload 모양이 바뀌면 `SESSION_REPORT_SCHEMA` 를 올릴 것 (`payload.schema` 로 구분).

---

## 알아둘 것

- **run 상세는 메모리에서 조립된다.** CopilotView 는 `runs/<startedAt>.json` 을 저장하지 않아서
  (WorkflowView 만 저장) 디스크에서 못 읽는다. `composeRunDetail()` 이 `test.stateFor()` 로 만든다.
  같은 워크플로를 Workflow 탭에서도 돌렸다면 디스크본을 우선 쓴다.
- **활성 탭만 신고된다.** 닫힌(archive) 탭이나 다른 탭은 대상이 아니다 — `useCopilotChat` 이
  활성 대화의 메시지만 노출하기 때문. 다른 탭도 신고하려면 훅에 per-conv 리더를 추가해야 한다.
- **고객은 자기 리포트를 앱에서 다시 볼 수 없다.** 접수번호는 클라이언트가 로컬 생성해서 보여주는 것.
- 부가 로그(OpenClaw 로그, run 상세) 수집이 실패해도 리포트는 그대로 올라간다. 해당 필드가 null 이
  되고 `truncated` 에 마커가 남을 뿐, 신고 자체를 막지 않는다.
- 실패 시 고객이 보는 문구는 원인별로 다르다 (미로그인 / 오프라인 / 타임아웃 20초 / 테이블 없음 /
  RLS 거부). 메모는 보존되어 **Try again** 으로 재입력 없이 재시도된다.
