# Run Review 모델 업그레이드 제안

> **대상:** Twixy 팀
> **주장:** 워크플로 자동 Run Review는 **비싸더라도 상위 모델로 분리**해야 한다.
> **근거:** 실제 run 1건에 대해 현재 리뷰가 **11회 전부 "clean, no changes needed"** 를 반환했는데,
> 같은 로그를 사람이 읽으면 **비용의 절반이 낭비**이고 **산출물에 산술 오류**가 있다.

---

## 0. TL;DR

| | |
|---|---|
| 케이스 | `wf_agency_client_ig_audit` — Instagram Account Deep Audit, 2026-07-28 run |
| run 결과 | 성공 · 447s · **$1.1213** · in/out **8,771,234 / 46,174 tokens** |
| 현재 리뷰 판정 | 14회 발사 → 11개 응답, **11개 모두 "clean / no spec changes needed"** (스펙 수정 제안 0건) |
| 실제 문제 | 비용 ~48% 낭비 + 납품 스프레드시트에 산술 오류 3종 + 분석 결론 무효화 요인 1건 |
| 리뷰가 받은 입력 | 워크플로 JSON 전문 + 노드별 cost/duration/**tokensIn/tokensOut** + 노드 출력 |
| 결론 | **데이터 부족이 아니라 판단 실패.** 리뷰 1회 비용은 run 비용의 5~10% 수준 — 상위 모델을 써도 경제성이 압도적 |

---

## 1. 케이스: 이 run이 무엇이었나

**Run 로그 파일 (원본, 재현용)**

| 파일 | 내용 |
|---|---|
| `<workspace>/workflows/wf_agency_client_ig_audit/runs/1785272494805.json` | run 상세 — 노드별 프롬프트/출력/비용/토큰 |
| `<workspace>/workflows/wf_agency_client_ig_audit/runs.jsonl` | run 요약 이력 |
| `<workspace>/workflows/wf_agency_client_ig_audit/builder-chat.jsonl` | WF 빌더 자동 리뷰 12회 |
| localStorage `twixy.copilot.msgs.a3309931-4d3b-4e4d-93ff-7e1f1c4741e1` | Copilot 자동 리뷰 2회 |
| `<workspace>/data/reports/cbc_audit.xlsx` | 최종 납품물 |
| `<workspace>/data/reports/cbc_posts_batch{1,2}.json`, `cbc_validation.json` | 중간 데이터 |

`<workspace>` = `~/Desktop/Test Folder/users/6dba5df4-106b-441f-807f-a23cd0388ae4`

**노드별 실측**

| 노드 | 시간 | 비용 | in tokens | out tokens |
|---|---:|---:|---:|---:|
| n1 프로필 + 포스트 1–15 (chrome/instagram) | 131s | $0.2142 | 2,612,949 | 15,813 |
| n2 포스트 16–30 (chrome/instagram) | 232s | **$0.7492** | 5,298,176 | 18,200 |
| n3 검증 (validation) | 21s | $0.0687 | 365,565 | 3,541 |
| n4 xlsx 쓰기 (write/xlsx) | 62s | $0.0892 | 494,544 | 8,620 |
| **합계** | **447s** | **$1.1213** | **8,771,234** | **46,174** |

---

## 2. 현재 Run Review가 내놓은 결과 (전수)

같은 run에 대해 리뷰가 **총 14회 발사**되어 **11개 응답**이 나왔다 (빌더챗 12건 발사 / 9건 응답 + Copilot 2건 발사 / 2건 응답 — 앱 재시작마다 재발사되는 별건 버그. §9 참조, 수정 완료).

**11개 모두 "clean". `workflow-spec` 수정 블록 0건.**

대표 응답:

> "The run looks clean — no wasted nodes, no redundant steps. The two batch nodes are justified by observability... **No spec update needed.**" (07-28 17:56)

> "This run looks clean. The two-batch structure was warranted — batch 1 hit 131s and batch 2 hit 232s, meaning a single 30-post loop would have comfortably timed out." (07-28 19:17)

> "The run is clean — no wasted or redundant nodes. Each step does one observable thing, the batch split kept both collection nodes under budget, and the validation gate was earned by catching zero issues. **No changes needed.**" (08-05 20:55)

여기서 이미 드러나는 품질 문제 3가지:

**(a) 로그를 반대로 읽음.** 2건(07-29 09:48, 07-28 19:17)이 *"Validation correctly caught the face-pile bug"* 라고 썼다. 실제 n3 출력은 **"Face-pile bug verdict: Clean — zero rows affected"**, 즉 버그를 **못 찾은 것**(= 없었던 것)이지 잡은 게 아니다. 07-29 09:48 응답은 같은 문단 안에서 "caught the face-pile extraction bug"와 "(There were no Human Review nodes)"를 동시에 말한다 — 한쪽은 로그를 정확히 읽고 한쪽은 뒤집었다.

**(b) 컨텍스트에 있는 JSON을 안 읽음.** 리뷰 프롬프트는 *"Human Review 노드를 지우라고 안내하라"* 를 **무조건** 지시한다. 그런데 이 워크플로에는 review 타입 노드가 **0개**이고, 그 사실이 담긴 workflow JSON 전문이 같은 프롬프트 안에 들어 있다.

- **11개 중 3개만** "이 워크플로엔 Human Review 노드가 없다"고 바로잡았다
- **8개는 없는 노드를 지우라고 안내**했다
- 그중 마지막(08-05 20:55)은 *"safely remove **both** Human Review nodes (click × on **each** card)"* — 존재하지 않는 노드의 **개수까지 지어냈다**

**(c) 비결정성.** 동일 입력 · 동일 프롬프트 · 11회 응답에서 (b)의 판정이 3:8로 갈렸다. 결론이 하나뿐인 사실 확인 문항에서 편차가 난다. 참고로 **직전 run(07-27, $0.7410)에서는 같은 모델이 `workflow-spec` 수정 블록을 실제로 제안**했다(`last_url_batch1` 스크롤 앵커 추가) — 능력이 없는 게 아니라 **안정적이지 않다**는 쪽 근거다.

**현재 리뷰 모델:** `minimax/minimax-m3` (`~/.openclaw/openclaw.json` → `agents.defaults.model`). 빌더/Copilot 에이전트에 모델 오버라이드가 없어 그대로 상속된다. (2026-08 M2.7→M3 마이그레이션)

---

## 3. 같은 로그를 정독했을 때 나온 진단

### 3.1 비용 — 절반이 컨텍스트 재전송

**입력:출력 = 190:1.** 포스트 30개에서 뽑은 실제 신호는 30행 × 10필드 ≈ 4,500토큰인데 입력으로 **877만 토큰**을 태웠다. 포스트 1건당 n1은 174K, n2는 353K 입력 토큰 — 유효 데이터 수율이 **0.05~0.1%**.

**결정적 지표: n2가 n1과 완전히 같은 일(포스트 15개)을 하고 3.5배 비싸다.**

```
n1  15 posts  $0.2142  2.61M in
n2  15 posts  $0.7492  5.30M in   ← 동일 작업, 3.50× 비용, 2.03× 토큰
```

원인은 세션이 하나라서 n2의 모든 턴이 n1이 쌓아놓은 페이지 스냅샷을 다시 실어 보내기 때문. 노드를 둘로 쪼갠 건 체크포인트만 얻었지 컨텍스트 격리는 전혀 안 됐다.

부수적으로, 리뷰가 8회 반복한 *"30개를 한 노드에 넣으면 타임아웃"* 논리도 근거가 약하다 — n2 단독 232s, 합쳐도 ~370s로 9분 상한 아래다.

### 3.2 납품물 — 검증 노드가 통과시킨 산술 오류

원본 JSON에서 재계산한 결과:

| Audit 시트 기재 | 실제 | 비고 |
|---|---|---|
| Reel **n=25** (25+4+2 = **31** ≠ 30) | Reel n=**24** | 합계 불일치 |
| Reel 평균 0.48% | **0.589%** | 18% 과소 |
| Overall 평균 0.437% | **0.506%** | 14% 과소 |
| "TOP 10% TRAITS (**3 posts** above 1%)" 라 쓰고 5개 나열 | 실제 5개 | 목록은 맞고 개수가 틀림 |
| "Canadian identity angle" 우수 사례로 **#3** 인용 | #3은 **전체 최하위** 0.007% | 자기모순 |

n=2, n=4짜리 그룹(Static/Carousel)은 정확히 맞고 n=24짜리만 틀렸다 — 계산한 게 아니라 눈대중한 것.

### 3.3 분석 타당성 — 게시 경과일 보정 없음

```
당일 게시(0d)   n=3    평균 ER 0.018%
7일 이상        n=16   평균 ER 0.547%     ← 30배 차이
```

당일 게시 3건이 전부 최하위 5위 안에 있다. 즉 납품물의 "Three Weakest Patterns" 1번(0.028%)·2번(0.06%)은 **콘텐츠 품질이 아니라 노출 시간**을 재고 있고, 그 위에 세운 Quick Wins 3번도 같이 흔들린다. 클라이언트에게 나가는 권고안의 근거가 무효다.

---

## 4. 차이 요약 — 현재 리뷰 vs 정독

| # | 항목 | 현재 리뷰 (11개 응답) | 정독 | 성격 |
|---|---|---|---|---|
| 1 | in/out 190:1 토큰 비율 | 언급 없음 | 낭비의 주 원인으로 지목 | 비용 |
| 2 | n1 $0.21 vs n2 $0.75 (동일 작업) | "batch split은 옳은 결정" | 컨텍스트 상속으로 3.5× — 세션 격리 필요 | 비용 |
| 3 | 배치 분할의 타임아웃 근거 | 8회 반복 주장 | 370s < 540s 상한, 근거 약함 | 사실오류 |
| 4 | 포맷 카운트 25+4+2=31≠30 | "clean" | 검증 구멍 + 평균 오류 | 산출물 |
| 5 | Reel/Overall 평균 14~18% 오차 | "clean" | 손계산 오류 | 산출물 |
| 6 | "3 posts" 라 쓰고 5개 나열 | "clean" | 헤더-내용 불일치 | 산출물 |
| 7 | 최하위 포스트를 우수 사례로 인용 | "clean" | 자기모순 | 산출물 |
| 8 | 경과일 미보정 (30배 왜곡) | "clean" | 권고안 근거 무효 | 분석 타당성 |
| 9 | n3의 face-pile 판정 | 2건이 "버그를 잡았다" (오독) | 버그 없었음 = 리포트 clean | 로그 오독 |
| 10 | 존재하지 않는 Human Review 노드 | 8/11이 "지우세요", 1건은 개수까지 창작 | 스펙에 review 노드 0개 | 컨텍스트 미독해 |

**적발률 0/10.** 그리고 9·10번은 리뷰가 **없는 사실을 만들어낸** 케이스라, 단순 누락보다 나쁘다 — 사용자가 그 말을 믿고 행동하면 순손실이다.

---

## 5. 반론 선제 대응 — "프롬프트 문제 아닌가?"

**부분적으로 맞다. 정직하게 분리한다.**

현재 리뷰 프롬프트(`WorkflowBuilderChat.tsx` `requestAutoReview`, `CopilotView.tsx` auto-review effect)의 "Your job" 항목은 다음 5개뿐이다:

```
- Nodes whose output was empty, trivial, or duplicated by a later node
- Tool/toolSkill choices that were overkill
- Sequential nodes that could collapse into one
- Missing outputScope declarations
- L7 detail checklists that drove unnecessary tool calls
```

**비용·토큰·산출물 정합성은 아예 안 묻는다.** 그러니 1·2·4~8번은 프롬프트 개선으로도 상당 부분 잡힐 수 있다. 이건 인정하고 가야 한다.

**다만 프롬프트로 설명되지 않는 부분이 남는다:**

- **입력은 이미 충분했다.** 리뷰 payload에는 노드별 토큰이 그대로 들어간다:
  ```
  Totals: 7m 27s 226ms · $1.1213 · 8771234/46174 tokens
  1. Collect profile overview and posts 1–15 [chrome/instagram] (action) — done · 131415ms · $0.2142 · 2612949/15813 tok
  2. Collect posts 16–30 [chrome/instagram] (action) — done · 232265ms · $0.7492 · 5298176/18200 tok
  ...
  ```
  같은 일을 하는 두 노드의 비용이 3.5배 차이 나는 게 **한 화면에 나란히** 있는데 11개 응답 모두 그냥 지나쳤다. "물어보지 않아서" 만으로는 부족하다.
- **9번(로그 오독)은 프롬프트와 무관하다.** 노드 출력 원문이 "zero rows affected"인데 "caught the bug"로 요약한 건 독해 실패다.
- **10번은 프롬프트가 유도했지만, 반증 자료가 같은 컨텍스트에 있었다.** 워크플로 JSON 전문이 프롬프트 안에 들어 있고 review 타입 노드가 없다. 3/11은 실제로 이걸 잡아냈다 — 즉 **불가능한 과제가 아니라 안정적으로 못 하는 과제**다. 그리고 1건은 없는 노드의 개수를 지어냈는데, 이건 프롬프트가 시킨 범위를 넘어선 환각이다.

**따라서 제안은 "프롬프트 고치고 끝"이 아니라 "프롬프트 고치고 + 모델 올려서 A/B"** 다. 프롬프트만 고치면 9·10번 같은 독해/일관성 문제는 그대로 남는다.

---

## 6. 경제성

리뷰 1회 payload 실측 규모:

| 구성 | 크기 |
|---|---|
| 워크플로 JSON 스냅샷 | ~8.5KB ≈ 2.1K tokens |
| run 요약 + 노드 출력(각 600자 clip) | ~3KB ≈ 0.8K tokens |
| 지시문 | ~0.6K tokens |
| **입력 합계** | **≈ 3.5~5K tokens** |
| 출력 | ≈ 300~500 tokens |

**리뷰는 run 전체가 아니라 요약본 한 장을 읽는 작업**이다. 상위 모델을 써도 **회당 수 센트** 수준이고, 이번 run 기준 리뷰 비용은 run 비용의 **5~10%**.

반대편에 놓인 값:

- 이 run 하나에서 **~$0.55 (48%)** 가 회수 가능한 낭비였다
- 납품물 산술 오류 5종 — 에이전시가 클라이언트에게 내보내는 문서다. 이건 토큰으로 환산되는 비용이 아니라 **신뢰 비용**이다
- 워크플로는 반복 실행된다. 스펙 결함 1건을 못 잡으면 **매 run마다** 같은 금액이 새어나간다

리뷰가 이번 건 하나만 제대로 잡았어도 이후 모든 run에서 회당 $0.55를 아꼈다. 회당 수 센트짜리 검사로.

---

## 7. 제안

**1단계 — 프롬프트 확장 (즉시, 무료)**
"Your job" 목록에 추가:
- 노드별 in/out 토큰 비율과 노드 간 비용 편차를 반드시 점검할 것 (같은 종류의 작업인데 비용이 2배 이상 차이 나면 원인을 지목)
- 산출물의 자체 정합성 (카운트 합, 헤더에 쓴 수치와 실제 나열 개수, 그룹 n의 총합)
- Human Review 안내는 **workflow JSON에 review 타입 노드가 실제로 있을 때만** — 현재는 무조건 발사되는 하드코딩이다 (이게 10/12 오답의 직접 원인)

**2단계 — 리뷰 전용 모델 분리 (본 제안)**
`agents.defaults.model` 상속을 끊고 리뷰 경로에만 상위 모델을 배정한다. 실행(run)은 지금 모델 유지 — 비용의 99%는 실행 쪽이고, 실행은 스크래핑·파일쓰기라 상위 모델의 이득이 작다. **판단이 필요한 건 리뷰 한 곳뿐이다.**

**3단계 — A/B 검증**
이 run 로그가 그대로 남아 있으므로 재현 가능하다. 동일 payload를 두 모델에 넣고 §4 표의 10개 항목 중 몇 개를 짚는지 센다. 통과 기준 제안: **10개 중 6개 이상 + 9·10번(오독/환각) 0건**.

---

## 8. 부록 — 이 진단으로 실제 반영한 워크플로 수정

`wf_agency_client_ig_audit` 스펙을 아래대로 고쳤다 (라이브 + `docs/agency-workflows/specs/`).

| 노드 | 변경 | 대응 항목 |
|---|---|---|
| n1/n2 | `COST RULE` — 페이지 통째 컨텍스트 반입 금지(full dump/a11y 트리/스크린샷), 포스트당 좁은 DOM 읽기 1회 → 8필드 JSON → 파일 즉시 append | #1 |
| n2 | 중복 제거를 **그리드 단계 shortcode**로 이동 — 중복 포스트를 여는 비용 자체 제거 | #1 |
| n1 | `posted_at_iso` (`<time datetime>`) 캡처, 팔로워를 exact 정수 + 반올림 문자열로 분리 | #8 |
| n3 | 디스크 JSON을 읽어 검증, 포맷별 카운트 합 = 총계 확인, `age_days` 계산 + 2일 미만 `too_new` 태깅, **평균 계산 금지** | #4 #8 |
| n4 | `ARITHMETIC RULE` — Eng. Rate와 Audit 집계 전부 Excel 수식(COUNTIF/AVERAGEIF/MAXIFS). 손계산 금지 / `AGE RULE` — 2일 미만 제외 + 사유 명시 / `CONSISTENCY RULE` — 헤더 수치 = 나열 개수, 포맷별 n 합 = 행 수 | #4 #5 #6 #7 #8 |

**미반영 (러너 변경 필요):** 노드별 세션 격리 — n2가 n1 컨텍스트를 상속하는 문제(#2). 절감액 기준 가장 크다(~48%). `useWorkflowTestSession` + 노드 `freshContext` 플래그 + recap 주입 작업.

**런타임 제약 메모:** `tools.deny: ["code_execution"]` + openrouter `group:runtime` deny라서 검증 노드를 코드 실행으로 바꾸는 건 불가능하다. 그래서 산술을 노드 밖(Excel 수식)으로 밀어내는 우회를 택했다.

---

## 9. 별건 — 리뷰 14회 중복 발사 버그 (수정 완료)

`hydrate()`가 앱 시작 시 `last-test-run.json`을 복원하면 "방금 끝난 run"과 구별이 안 되고, dedup이 전부 in-memory `useRef`라 재시작마다 run 종료 부수효과가 통째로 재발사됐다 — 자동 리뷰, `runs.jsonl` append(같은 runId 12줄), 실패 알림, 빌더 fix 요청.

`WorkflowTestState.hydrated` 플래그로 복원본을 표시하고 부수효과 5곳(자동 리뷰 2 · 디스크 저장 2 · 실패 fix 요청 1)에 가드를 넣어 수정했다 — `useWorkflowTest.ts`, `WorkflowView.tsx`, `CopilotView.tsx`.

이 문서의 "14회 발사"는 그 버그가 만든 숫자다. 다만 **매 회가 동일 입력에 대한 독립 시행**이었기 때문에 §2 (c)의 비결정성 근거로는 그대로 유효하고, 오히려 **모델 A/B에 쓸 무료 반복 측정치**를 남겨준 셈이다.
