# OpenRouter 키 자동 credit-limit 사건 — 원인 분석 및 수정

조사·수정 2026-08-08. 코드는 웹 레포(`x-viral-marketing-tool`) `feature/team-workflows-credits`
브랜치, 커밋 `3524fe4` (푸시 완료). 데스크톱 앱 레포는 수정 없음.

---

## 증상

Twixy 모드에서 org 멤버의 OpenRouter 키가 주기적으로 credit limit 에 걸려 LLM 호출이 막혔다.
최근 두 번 발생. Supabase 의 `organization_members` 는 정상으로 보였다 —
`monthly_limit $20`, `spent_this_month $0.022415`.

OpenRouter 대시보드의 해당 키(`twixy-org:6dba5df4:2026-07-07`):

| 항목 | 값 |
|---|---|
| 사용량(전 기간) | $9.36 |
| limit | **$2.98** / MONTH |
| 만료 | 2036-07-04 |

한도 $20 을 설정해뒀는데 키에는 $2.98 이 걸려 있었다.

---

## 어디서 걸리는가 — 클라이언트도 OpenRouter 도 아니다

키 `limit` 을 쓰는 곳은 웹 백엔드 두 군데뿐이다.

- `src/app/api/openrouter-key/route.ts` — 앱이 키를 받아갈 때
- `src/app/api/org/credits/allocate/route.ts` — 관리자가 한도를 바꿀 때

데스크톱 앱(`electron/main.ts:1343` `fetchOpenRouterHandout`)은 키를 **받아오고 usage 를 읽기만**
한다. PATCH 를 보내는 코드가 없다. OpenRouter 는 우리가 설정한 값을 강제할 뿐이다.

결정적 증거: 걸려 있던 $2.98 은 `monthly_limit`($20)도, 솔로 티어 예산($2/$5)도 아니다.
실측한 `organizations.pool_remaining` 이 정확히 **$2.977586** 이었다. 소스는 이것 하나뿐이다.

---

## 근본 원인 1 — 누적 상한과 잔액을 같은 것으로 취급

`bbf6e6d harden org security` (2026-07-29) 에서 들어온 클램프:

```ts
const desiredLimit = isOrgMember
  ? Math.min(rawLimit, orgPoolRemaining ?? 0)  // never exceed the pool
  : rawLimit;
```

의도("풀보다 많이 승인하지 않는다")는 맞지만 **두 값의 단위가 다르다.**

| 값 | 의미 |
|---|---|
| OpenRouter `limit` | 리셋 주기 동안의 **누적 지출 상한**. `usage_monthly >= limit` 이면 차단 |
| `pool_remaining` | 그 지출이 **이미 차감된 잔액**. `consume_member_credit_for` 가 sync 마다 깎음 |

같은 돈을 양쪽에서 두 번 뺀다. 풀 총액 P, 이번 달 누적 사용 U 라 하면:

```
pool_remaining = P − U
키 limit       = P − U
차단 조건       = U ≥ limit = P − U
              ⇒ U ≥ P/2
```

**풀의 절반만 쓰면 키가 죽는다.** 그리고 `openrouterHandoutCache` 는 프로세스 메모리라
앱을 재시작할 때마다 키를 다시 조회하고, 그때마다 더 낮아진 `pool_remaining` 으로 PATCH 된다.
한 번 내려간 상한은 충전 전에는 절대 안 올라간다 — "자꾸 자동으로 걸린다"의 정체.

### 실측 검증

```
pool_remaining $2.977586  →  버그 공식 limit = min(20, 2.977586) = $2.977586
```

대시보드의 **$2.98 과 일치**. 원인 확정.

---

## 근본 원인 2 — 전 기간 누적을 이번 달 사용액으로 읽음

`src/lib/openrouter/provision.ts` 가 `usage` 를 읽고 있었다. OpenRouter 스펙상:

| 필드 | 의미 |
|---|---|
| `usage` | **전 기간** 누적 |
| `usage_monthly` | 현재 UTC 월 사용액 — `limit_reset: "monthly"` 가 강제하는 기준 |
| `usage_daily` / `usage_weekly` | 각 주기 |

그런데 `openrouter-usage/route.ts` 는 이 값을 이번 달 값으로 취급한다. 아래 로직
(`prevUsd`, `openrouter_usd_today`, 풀 차감)은 전부 월 단위로 리셋되므로,
**달이 바뀐 뒤 첫 sync 에서 `prevUsd = 0` vs `usdActual = 평생 누적` → 그 전액이 델타로 잡혀
풀에서 통째로 또 차감된다.**

이번 org 에서는 실제 중복 차감 흔적이 없었지만(아래 정합성 확인), 터지면 원인 1보다 크다.

---

## 근본 원인 3 — 두 경로가 서로 다른 값을 씀

`allocate` 는 raw `amount`($20)를 PATCH 하고, `openrouter-key` 는 `pool_remaining`($2.98)로
PATCH 했다. 관리자가 한도를 올려도 **앱 재시작 한 번이면 도로 깎였다.**
UI 상으로는 "설정이 저절로 풀린다"로 보인다.

---

## 수정

### 클램프를 usage_monthly 와 같은 축으로

```
desiredLimit = min(monthly_limit, spent_this_month + pool_remaining)

실효 여유분 = desiredLimit − usage_monthly
           = min(monthly_limit − spent, pool_remaining)   ✓
```

`spent_this_month` 은 `spend_month` 가 이번 달일 때만 유효하게 읽는다(DB lazy reset 규칙 동일).

### 계산을 단일 헬퍼로

신규 `src/lib/openrouter/orgKeyLimit.ts` 의 `resolveOrgKeyLimit()`. 두 라우트가 모두 이걸 쓴다.
`allocate` 는 방금 쓴 값을 override 로 넘겨 read-your-write 레이스를 피한다.
원인 3 이 구조적으로 재발할 수 없다.

파일 상단에 단위 설명을 길게 박아뒀다. `min(limit, pool_remaining)` 은 짧고 그럴듯해 보여서
리팩터링 중에 되돌아가기 쉬운 형태다.

### 기간 카운터 선택

`provision.ts` 에 `periodUsage` 추가 — `limit_reset` 을 보고 맞는 필드를 고른다
(monthly→`usage_monthly`, weekly→`usage_weekly`, daily→`usage_daily`, null→`usage`).
`limit` 과 비교해도 되는 값은 이것뿐이라는 걸 타입 주석으로 못박았다.

기간 카운터가 응답에 없으면 `usage` 로 폴백하지 **않고** 그 sync 를 건너뛰고 `console.warn`.
과소청구는 OpenRouter 기록으로 정산되지만, 과다청구는 멀쩡한 사용자 키를 달 중간에 잠근다.

### 변경 파일

```
src/lib/openrouter/orgKeyLimit.ts          (신규)
src/lib/openrouter/provision.ts
src/app/api/openrouter-key/route.ts
src/app/api/openrouter-usage/route.ts
src/app/api/org/credits/allocate/route.ts
docs/openrouter-limit-repair.sql           (신규, 웹 레포)
```

`tsc --noEmit` 통과. (해당 레포는 ESLint 미설정 — `next lint` 가 초기 설정 프롬프트를 띄운다.)

---

## DB 작업

### 하마터면 풀을 0 으로 만들 뻔한 것

처음 작성한 복구 SQL 은 `pool_remaining = allocated − sum(spent_total)` 로 잔액을 재계산하는
것이었다. 실행 전 실측해보니 **`pool_allocated_tot` 이 0** 이었다 —
`topup_org_pool()` RPC 를 안 거치고 `pool_remaining` 을 직접 세팅했기 때문.

그대로 돌렸으면 `0 − 0.022415 = −0.022` → `greatest(0, …)` → **잔액 $0 → 키 disabled**.
증상을 고치려다 완전히 잠글 뻔했다. 실행하지 않고 SQL 파일에 ⚠ 경고로 남겼다.

### 실제로 실행한 것 — 감사 컬럼 백필만

잔액은 손대지 않고 `pool_allocated_tot` 만 실제 투입액으로 맞췄다.

```
Test Org         pool_allocated_tot  $0 → $3.000001   (pool_remaining $2.977586 불변)
Sangin Test Team 변경 없음 (풀 0)
```

이후 정합성:

```
pool_allocated_tot $3.000001 − sum(spent_total) $0.022415 = $2.977586 = pool_remaining  ✓
```

풀 차감 자체는 정상이었다. 원인 2 로 인한 중복 차감 흔적은 이 org 에 없다.

### 앞으로

풀 충전은 반드시 `select public.topup_org_pool('<ORG_ID>'::uuid, <금액>);` 로.
직접 UPDATE 하면 `pool_allocated_tot` 이 또 어긋나고, 그 위에서 도는 정합성 검사가
전부 거짓 음수를 낸다.

---

## 배포 후 확인

1. 웹 배포 (Vercel) — 커밋 `3524fe4`
2. 데스크톱 앱 재시작 → `/api/openrouter-key` 가 새 공식으로 PATCH
3. OpenRouter 대시보드에서 키 limit 확인

OpenRouter 대시보드에서 손으로 올리는 건 의미 없다 — 다음 키 조회에서 서버 값으로 덮인다.
즉시 반영하려면 관리자 UI 에서 해당 멤버 월 한도를 저장하면 `allocate` 가 바로 PATCH 한다.

---

# 2차 조사 (2026-08-11) — 여전히 $2.98 이던 이유

배포는 정상이었다(3일 전 프로덕션 `aaabfcb` 에 수정 포함). 원인이 **두 개 더** 있었다.
프로덕션 `OPENROUTER_PROVISIONING_KEY` 를 `vercel env pull` 로 받아 실제 키를 조회해서 확인.

## 원인 4 — `monthly_limit` 자체가 $2.98 로 내려가 있었다

```
monthly_limit    $2.980000      ← 1차 조사 때는 $20
pool_remaining   $2.977586
→ min(2.98, 0.022415 + 2.977586) = $2.98    수정된 공식이 맞게 계산 중
```

`set_member_monthly_limit` 이 "팀 헤드룸 ≤ pool_remaining" 을 강제하므로 **풀이 $3 뿐이면
$3 초과 한도는 애초에 설정이 거부된다.** 코드는 정상이었고, 제약은 풀 크기였다.
→ 이 "왜 거부되는지 알 수 없음" 문제가 아래 Allocation/Spend 분리 작업으로 이어짐.

## 원인 5 — 키가 stranded 상태 (이게 실제로 막던 것)

```
limit=2.98   limit_remaining=0   usage_monthly=0.0086
```

사용량이 한도의 0.3% 인데 잔여가 0. 실험:

| 조치 | 결과 |
|---|---|
| limit 을 3.00 으로 PATCH | `limit_remaining` 여전히 **0** |
| 동일 설정으로 새 키 발급 | `limit=1 remaining=1` ✅ |

**`limit_remaining` 은 `limit − usage_monthly` 를 그때그때 계산한 값이 아니라 저장된
카운터다.** 원인 1 의 클램프가 limit 을 키의 기간 사용량 아래로 반복해서 내리는 동안 0 으로
latch 됐고, **limit 을 다시 올려도 복구되지 않는다.** 리셋 주기까지 모든 요청이 거부된다.
유일한 해법은 재발급.

- 운영 조치: stranded 키 `c69efc9173b1…` 삭제 + `user_subscriptions` 포인터 정리
- 코드: 재사용 경로에 stranded 감지 → 자동 재발급 (`53d551a`)
  `remaining<=0 && desiredLimit>0 && periodUsage<desiredLimit`

## 사용량 추적 오염 — 숫자로 확인됨

| 출처 | 값 |
|---|---|
| 키 `usage_monthly` (8월 실사용) | $0.0085942 |
| DB `openrouter_usd_today` (이번 달 카운터) | $0.022415 |
| 키 `usage` (전 기간) | $0.0224967 ← DB 값과 일치 |

DB 의 "이번 달"이 실은 **그 키의 전 기간 누적**이었다. 원인 2 의 흔적이 숫자로 남아 있었다.

`openrouter_usd_total $13.206977` 은 더 심하다:

```
현재 계정의 모든 twixy 키 전 기간 합    ≈ $0.056
OpenRouter 계정 전체 lifetime usage     = $3.134576
DB 기록                                = $13.206977   ← 계정 총 사용량의 4배
```

계정이 평생 쓴 돈보다 크다. 개인계정 시절 + 키 교체마다 델타 중복 누적의 결과.
**org 계정 사용량 추적이 아니다.** 수정 후 sync 는 `usage_monthly` 를 읽지만
`Math.max(prevUsd, …)` 때문에 기존 값은 내려가지 않고 9월 1일 리셋된다.

## 미정리 항목

고아 키 2개가 계정에 살아 있다 — `twixy-org:6dba5df4:2026-07-07`(`0ab76ea2…`),
`:2026-07-05`(`d2352b0d…`). DB 어디서도 참조되지 않는데 각각 limit $3 활성.
키 재발급 시 이전 키를 지우지 않은 결과. 삭제 필요.

---

# Allocation / Spend 2축 분리 (2026-08-11)

`pool_remaining` 하나가 두 역할을 겸한 게 위 원인 4 의 배경이다. 두 축을 명시적으로 나눴다.
마이그레이션 `20260811000000_allocation_vs_spend.sql`, 커밋 `d3561e2`. 프로덕션 적용 완료.

```
unspent(m)  = max(0, monthly_limit − spent_this_month)   멤버 예약분
allocated   = Σ unspent        ← 할당하는 순간 줄어듦
cash        = pool_remaining   ← 실사용에만 줄어듦
allocatable = cash − allocated ← 지금 더 줄 수 있는 돈

불변식: allocated ≤ cash
```

지출이 나면 cash 와 allocated 가 같은 금액씩 줄어 불변식이 유지된다. 그래서 회사가 실제 낸
돈보다 많이 약속하는 일이 구조적으로 불가능하다. 월말엔 안 쓴 할당이 소멸하고
(`spend_month` lazy reset) 현금만 이월된다.

**거부될 때 무엇을 조정해야 하는지 알려준다** — 이게 이번 작업의 핵심.
`set_member_monthly_limit` 이 `detail` 에 JSON(`requested` / `maxForThisMember` /
`shortfall` / `cash` / `allocatedToOthers`), `hint` 에 사람이 읽는 문장을 실어 보내고,
관리자 UI 가 "$N 초과 · 다른 멤버 한도를 $N 줄이거나 충전" 을 표로 렌더한다.
멤버 테이블엔 `Reserved` 컬럼(= unspent)을 추가해 누구 걸 빼면 되는지 바로 보이게 했다.

**요약값은 행을 JS 로 합산하지 않고 `get_org_allocation` RPC 를 읽는다.** 같은 공식이 두
군데 살아서 어긋난 게 이번 사건의 뿌리라, 강제하는 쪽(SQL)과 보여주는 쪽(대시보드)이 같은
SQL 을 보게 했다.

---

## 미해결 — 확인 필요

**키의 전 기간 사용액 $9.36 vs 풀에 기록된 총 지출 $0.022415.**

`user_subscriptions` 실측:

```
openrouter_usd_today (이번 달)  $0.022415
openrouter_usd_total (전 기간)  $13.206977
openrouter_key_hash             저장됨
openrouter_synced_at            2026-08-08 17:24 (정상 동작 중)
```

앱 쪽 누적($13.21)은 키 교체를 거치며 쌓인 값이라 키 하나의 $9.36 과 다른 게 자연스럽다.
문제는 **`organization_members.spent_total` 이 $0.022415 뿐**이라는 것 — 즉 과거 지출이
풀에 거의 청구되지 않았다. 풀 자체가 `topup_org_pool` 을 안 거치고 $3.00 으로 직접 세팅된
테스트 org 라, 그 시점에 카운터가 리셋된 것으로 보인다. 실사용 org 에서 같은 격차가 나오면
원인 1·2 로는 설명되지 않으므로 별도 조사가 필요하다.

또 하나: **이번 달 사용액이 $0.0224 인데 왜 키가 막혔는가.** 월 리셋이 정상 동작한다면
$0.0224 < $2.98 이라 안 막혀야 한다. 막혔다면 OpenRouter 가 전 기간 `usage`($9.36)를
기준으로 강제하고 있다는 뜻이고, 그렇다면 **기존 키를 재발급**해야 카운터가 초기화된다
(`patchOpenRouterKeyLimit` 은 `limit`/`disabled`/`include_byok_in_limit` 만 건드리고
`limit_reset` 은 안 건드린다 — 기존 키의 리셋 설정을 바꿀 수단이 현재 없다).

로컬 `.env` 에 `OPENROUTER_PROVISIONING_KEY` 가 없어서(Vercel 전용) 키의 `usage_monthly` /
`limit_reset` 실측을 못 했다. 배포 후에도 계속 막히면 이쪽을 파야 한다.
