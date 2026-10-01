# RPA 모듈화 규칙 (Activity Log → 재사용 모듈)

> 상태: **규칙 정의 초안** (개발 전 합의용). 확정되면 이걸 기준으로 구현.

## 0. 목적과 문제

Twixy는 plan 실행마다 **Activity Log**(L6 Task → L7 Sub-task → L8 Step, 각 L8에 toolName/input/callId)를 남긴다. 이걸 재사용 가능한 **RPA 모듈**로 만들어 SOP/Execution Plan 파이프라인에 태우는 게 목표.

**문제(파편화):** 직전 구현은 "모듈 = 전체 절차"이고 매칭이 **툴/액션 순서 완전일치(fingerprint)**라, 사소한 차이(추가 클릭·대기·중복 snapshot)에도 다른 모듈로 갈라진다 → 재사용 블록이 안 쌓임 → 비효율.

## 1. 핵심 원칙

1. **하향식 2-pass 매칭.** 먼저 **L6(태스크) 유사도로 클러스터링**하고, **그 클러스터 안에서만** L7/L8 디테일(변수/고정/개수)을 비교한다.
   - 근거: L6(무엇을 하는 태스크인지)이 다르면 L7/L8을 맞춰봐야 의미 없음.
2. **재사용 단위 = L6 태스크 모듈.** 전체 절차(plan)도, 너무 잘게 쪼갠 L8도 아닌, **L6 = "한 태스크"**를 재사용 블록으로 삼는다. 절차(plan/SOP)는 L6 태스크 모듈들의 **조합**.
3. **노이즈는 매칭에서 무시.** 우발적·일시적 행동은 정규화해서 제거 후 비교(규칙 3).
4. **값과 구조 분리.** 무엇을(값) = 변수, 어떻게(구조/방법) = 고정. (규칙 5)

## 2. 계층과 재사용 단위

```
L6 Task 모듈  ← 재사용의 기본 단위 (예: "소셜 게시물 스크랩", "JSON→Excel")
   └ L7 Sub-task  (능력 묶음: 페이지 1개 처리, 저장 등)
        └ L8 Step  (실제 tool 호출 = 재실행 원자)
절차(Plan/SOP) = L6 태스크 모듈들의 순서 + 파라미터 바인딩
```
같은 L6 태스크 모듈은 여러 절차에서 재사용된다 (예: "소셜 게시물 스크랩"을 Threads·X·인스타 절차가 공유).

## 3. 정규화 규칙 (매칭/시그니처 계산 전 적용)

비교·식별 전에 Activity Log를 canonical form으로:
- **부트스트랩 제거**: `SKILLS.md`/`<skill>/SKILL.md`/`skills/*` read (에이전트 자동 동작). *(이미 구현)*
- **일시적/우발 액션 제거 또는 접기**: `wait`, 재시도(같은 타깃 실패→성공), 연속 중복 `snapshot`/`evaluate`.
- **툴 변형 통일**: browser `open`≈`navigate` → "페이지 이동"; `read_file`≈`read`.
- **개수 접기**: 동일 시그니처 L7 반복 → loop 1개 (개수는 변수로 별도 기록).
- **runtime 값 마스킹**: `targetId`/`content`/`payload` 등은 시그니처에서 제외.

→ 정규화 후의 형태로만 시그니처/유사도를 계산해 "사소한 차이로 안 갈라지게" 한다.

## 4. L6 유사도 / 클러스터링 규칙 (Pass 1)

**L6 capability signature** = 그 L6 안의 L7들을 **능력 태그(capability tag)** 시퀀스로 환원한 것 (정규화 적용, 값/개수 무시).

- 능력 태그 = (정규화된 tool + action 패턴) → 이름. 스타터 매핑:
  | L7 패턴 | capability tag |
  |---|---|
  | browser 페이지이동 + snapshot/extract | `web.scrape` |
  | browser 페이지이동 + act(클릭/입력/스크롤) | `web.interact` |
  | read | `file.read` |
  | write / edit | `file.write` |
  | tool_write_xlsx / pdf / pptx | `doc.render` |
  | sessions_spawn | `delegate` |

- **클러스터링 = 게이트 → rubric LLM → 메모이즈** (결정론 최대, LLM 최소):
  1. **결정론적 게이트**: capability tag **멀티셋(순서 무시)이 동일**한 L6만 같은 후보군. 멀티셋이 다르면 → 자동 "다른 모듈"(LLM 안 부름). 예: `{web.scrape, file.write}` 끼리만 비교.
  2. **rubric LLM 판정 (assign-or-NEW)**: 새 L6에게 호환 후보군의 **기존 클러스터 목록**을 주고, LLM은 ⓐ 기존 클러스터 id 하나 선택 또는 ⓑ "NEW"+태스크 이름 제안. 자유서술 금지, 선택지만.
     - **rubric(기준)**: 같은 모듈 = 산출물/목표 종류 같음 + 차이가 대상·값·개수뿐. 다른 모듈 = 산출물 종류 다름 / capability 구성 다름 / 목표 자체 다름.
  3. **메모이즈**: 판정을 **capability signature 키로 캐시** → 같은 시그니처는 다음부터 LLM 없이 자동 라우팅. LLM은 새/모호 시그니처에서만 호출.
  4. **가드레일**: LLM 반환 id가 후보 목록에 없으면 NEW 처리. confidence 낮으면 candidate로 두고 사람 확정.
- `sopRef`가 있으면 게이트·LLM 건너뛰고 그걸 키로 (명시적 정체성).

## 5. L7/L8 변수 분류 규칙 (Pass 2 — 클러스터 안에서)

같은 L6 클러스터에 모인 런들끼리 **슬롯 단위 다수결**로 확정 *(다중 기록 diff, 이미 구현)*:
- 슬롯 값이 **런마다 다름 → 변수(param)**
- **항상 같음 → 고정(fixed)** = 재사용 골격
- `content`/`payload`/`targetId` 등 → **runtime**(실행 중 생성, 주입 아님)
- L7 그룹 **개수가 런마다 다름 → 개수 변수(loop/list)**
- 신뢰도: 1런 low → 2런 medium → 3+런 high
- `fn`(browser evaluate JS) = **재사용 절차 코드 → fixed** (값 아님). *(이미 반영)*

## 6. 식별 키 / 그룹핑

- 태스크 모듈 키 `moduleKey = sopRef ?? L6_capability_signature_hash`.
- 한 plan은 여러 L6를 가지므로, **각 L6가 자기 태스크 모듈 클러스터에 기여**한다 (plan 통째가 아니라 L6별로).
- 절차(SOP) 모듈은 별도: L6 태스크 모듈들의 **조합 레시피**(순서 + 바인딩)로 표현.

## 7. 조합 / 바인딩

- 절차 = `[{ taskModule: <key>, bind: { param→source } }, …]` 순서.
- Execution Plan = 절차 + 이번 회차 파라미터 값.
- 재사용 = 태스크 모듈 골격(고정) + 바인딩만 교체.

## 8. 기존 구현과의 관계

- 유지/재사용: `generateModuleSpec`(L6/L7/L8 + fixed/param/runtime/loop 분류), `mergeRunIntoModule`(슬롯 다수결·confidence·loop 통계), 정규화 헬퍼(`isBootstrapRead`, `l7Signature`).
- **변경 핵심**: `procedureFingerprint`(전체 절차 exact)를 → **L6 capability signature(태스크 단위)** 로 교체. 그룹핑을 plan-통째에서 **L6-per-task**로 내림.
- 추가: 능력 태그 매핑(규칙 4), 정규화 강화(규칙 3의 wait/retry/중복 접기).

## 9. 결정 현황 (개발 전)

1. ✅ **L6 매칭**: capability tag **멀티셋(순서 무시) 동일**만 게이트 통과 → 그 안에서 **rubric LLM이 assign-or-NEW** 판정 → signature로 메모이즈. (§4 확정)
2. ⏳ **능력 태그 매핑**: §4 스타터 표 기준 — 추가/수정 의견 받기.
3. ⏳ **정규화 공격성**: wait/retry/중복 snapshot을 버릴지 vs 접어서 개수만 보존?
4. ⏳ **태스크 모듈 vs 절차 모듈**: 이번엔 L6 태스크 모듈만 먼저? 절차(조합) 모듈은 다음?
5. ⏳ **클러스터 사람 개입**: 자동 클러스터 + 사람이 병합/분리 확정(candidate 유지)?

## 10. 비범위 (나중)
- 진짜 step 추가/누락(능력 시그니처 자체가 다른 변형) 병합 — 유사도 임계치로 후속.
- 능력 태그 자동 학습(LLM) — 현재는 결정론적 매핑.
- 태스크 모듈 라이브러리 UI / Clovex 동기화.
