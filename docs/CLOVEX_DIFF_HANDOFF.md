# Clovex ← Twixy 핸드오프: 다중 기록 diff에 필요한 자료

> 역할 분담: **Twixy = 기록 공급**(Activity Log + 단일 트레이스 모듈 후보 + 그룹핑 키). **Clovex = 추론**(여러 런을 누적·비교해 변수/고정 확정 = "다중 기록 diff"). 이 문서는 Clovex가 diff를 구현하는 데 필요한 입력 자료·스키마·알고리즘을 명세한다.

관련 문서: [RPA_MODULARIZATION_RULES.md](./RPA_MODULARIZATION_RULES.md)(규칙), [PLANNING_MODE_PER_STEP_COMPACTION.md](./PLANNING_MODE_PER_STEP_COMPACTION.md)(Activity Log 생성 원리).

---

## 1. Twixy가 생산하는 아티팩트 (Clovex의 입력)

플랜 1회 실행(완료)당 다음이 디스크에 남는다:

```
<workspace>/user/plans/<planId>/
├── plan.json          ← 권위 상태 (Activity Log 포함)
├── module.json        ← 단일 트레이스 Module Spec 후보 (diff의 1차 입력)
├── run.md             ← 사람용 로그
└── steps/<stepId>/raw.jsonl   ← 그 step의 gateway 메시지 원본 (replay-grade, 전체 tool 호출/결과)
```

Clovex가 주로 읽을 것: **`module.json`**(정규화된 후보) + 필요시 `plan.json`(원본 Activity Log)·`raw.jsonl`(완전 재실행용 인자).

### 1.1 그룹핑 키 (같은 절차 런 묶기 — diff의 전제)
`plan.json`에 기록됨:
- `sopRef?: string` — Execution Plan이 SOP를 참조했으면 그 id (명시적 정체성, 최우선 키)
- `procedureFingerprint: string` — 절차 스켈레톤 해시(툴/액션/구조만, 값·개수 무시). 16hex.
  - 개수 무시의 구체 정의: 연속된 동일 스켈레톤 L7(반복 접힘 여부 무관)은 하나의 토큰으로 접어 해시 → 같은 절차를 1회 돌린 런(N=1)과 N회 돌린 런이 같은 fingerprint를 가짐.
- **moduleKey = `sopRef ?? procedureFingerprint`** → 같은 key의 런들을 한 모듈로 누적.

---

## 2. 스키마 (Clovex가 파싱할 형태)

### 2.1 plan.json (관련 필드만)
```ts
type Plan = {
  id: string
  projectId: string
  title: string
  sourcePrompt: string
  status: 'done' | 'failed' | ...        // diff는 'done'만 사용
  origin?: 'chat' | 'execution-plan'
  executionContext?: string              // L2-L5 상위 맥락 (Execution Plan 런)
  sopRef?: string                        // 그룹핑 키 (위)
  procedureFingerprint?: string          // 그룹핑 키 (위)
  moduleSpec?: ModuleSpec                // = module.json 내용
  steps: PlanStep[]
}
type PlanStep = {                          // = L6 Task
  id, title, detail, acceptance, skillHint, status
  subtasks?: L7Subtask[]                 // ★ Activity Log: 실제 실행된 L7→L8 (측정값)
  procedure?: L7Subtask[]                // SOP가 시킨 절차(Execution Plan 런일 때, 계획값)
}
type L7Subtask = { id, title, purpose?, status, steps: L8Step[] }
type L8Step = {
  id, title
  toolName?: string                      // browser | read | write | edit | tool_write_xlsx | ...
  toolCallId?: string                    // raw.jsonl의 tool 호출 id (완전 재실행 anchor)
  input?: unknown                        // 실제 tool 인자 (replay payload)
  outcome?: 'ok' | 'failed' | 'skipped'
}
```

### 2.2 module.json (단일 트레이스 Module Spec — 정규화된 후보)
```ts
type ModuleSpec = {
  version: 1
  status: 'candidate'                    // 단일 트레이스 ⇒ 항상 후보
  source: { planId: string; generatedAt: string; method: 'single-trace-heuristic' }
  tasks: ModuleTask[]                    // ★ parameters는 plan-wide가 아니라 task(L6)별로 있음
}
type ModuleParam = {
  id: string                             // 'url_1', 'path_2', 'url_list_3' (★ task 내에서 scope/번호)
  kind: 'scalar' | 'list'                // list = 개수 변수(loop)
  valueType: 'url' | 'path' | 'query' | 'text' | 'json'
  label: string
  observed: unknown                      // scalar=값, list=값 배열(이번 런)
  confidence: 'low'
}
type ModuleTask = {                        // L6
  title, detail?, acceptance?, skillHint?
  parameters: ModuleParam[]              // ★ 이 L6의 변수들 (L6별 기록 — Clovex가 L6 단위로 공통점 계산)
  subtasks: ModuleL7[]
}
type ModuleL7 = {
  title: string
  repeat?: { over: string; as: string }  // 있으면 loop: over=list 파라미터 id, as='item'
  steps: ModuleL8[]
}
type ModuleL8 = {
  toolName?: string
  title: string
  inputTemplate?: unknown                // leaf 값이 아래 3가지로 치환된 형태
}
```

### 2.3 inputTemplate 치환 규약 (이미 Twixy가 분류한 결과)
`ModuleL8.inputTemplate`의 각 leaf는:
- **`"{{paramId}}"`** — 변수(scalar 파라미터). 그 L8이 속한 **task(L6)의 `parameters[id].observed`**에 이번 런 값. (paramId는 task 내 scope)
- **`"{{item}}"`** — loop 항목 변수. 그 L7의 `repeat.over` 파라미터(같은 task의 list 파라미터)의 `observed` 배열이 이번 런 값들.
- **`"<runtime>"`** — 실행 중 생성(주입 아님). 아래 §4 RUNTIME 키.
- **그 외 리터럴** — 고정(fixed), 재사용 골격.

---

## 3. Clovex가 구현할 diff 알고리즘 (슬롯 기반 다수결)

> 같은 moduleKey의 여러 module.json을 누적해 confidence를 올리고 변수/고정을 확정한다. **단일 기록의 한계(일회성 결정이 fixed로 굳음)를 다수 런으로 해소.**

### 3.1 슬롯 식별
파라미터를 값이 아니라 **위치(슬롯)**로 식별 (런마다 param id는 새로 생기므로):
```
slot = `T{taskIdx}/L7#{subIdx}/L8#{stepIdx}/{inputKey}`
```
같은 `procedureFingerprint`면 스켈레톤이 동일 ⇒ 슬롯이 1:1 정렬된다.

### 3.2 런 1건에서 슬롯 관측값 추출
`module.json.tasks`를 순회하며 각 `inputTemplate` 키마다:
- `"<runtime>"` → role=runtime (값 없음)
- `"{{item}}"` → role=param, 값 = 같은 task의 `repeat.over` list 파라미터의 `observed`(배열) → 슬롯에 **여러 값**
- `"{{paramId}}"` → role=param, 값 = **그 task(L6)의** `parameters[paramId].observed`(scalar)
- 리터럴 → role=fixed, 값 = 그 리터럴
또한 각 loop L7의 항목 개수(=list 길이)를 기록.

### 3.3 누적 + 재분류 (런들 합산 후)
슬롯별로 모든 런의 관측값을 모은 뒤:
- runtime 키 → **runtime**
- 그 외: `distinct(관측값) > 1` → **param(변수)**, `distinct == 1`(런 ≥2) → **fixed(고정)**, 런 1개 → 후보(원래 role)
- loop 슬롯: 항목 개수 통계(min/max/counts) → **개수 변수 확정**
- **confidence**: 런 1=low, 2=medium, 3+=high

### 3.4 권장 출력 — AggregateModule
```ts
type SlotEvidence = {
  slot: string
  role: 'param' | 'fixed' | 'runtime'
  valueType?: 'url'|'path'|'query'|'text'|'json'
  observed: unknown[]          // 런별 관측값
  distinct: number
  confidence: 'low'|'medium'|'high'
}
type LoopStat = { slot: string; counts: number[]; min: number; max: number }
type AggregateModule = {
  version: 1
  moduleKey: string            // sopRef ?? fingerprint
  fingerprint: string
  sopRef?: string
  runs: { planId: string; finishedAt: string }[]
  runCount: number
  slots: SlotEvidence[]        // 변수/고정/런타임 확정 (권위)
  loops: LoopStat[]            // 개수 변수 통계
  spec: ModuleSpec             // 사람이 읽을 최신 스켈레톤
  updatedAt: string
}
```
> 참고: 이 알고리즘의 레퍼런스 구현이 Twixy 히스토리에 있었음 — git 커밋 `4437eeb`의 `electron/module-library.ts`(현재는 채택 안 함). Clovex가 그대로/유사하게 구현하면 됨.

---

## 4. Twixy가 이미 적용한 분류 규칙 (Clovex가 알아야 할 전제)

`module.json`은 다음 규칙으로 이미 1차 분류돼 있다 (Clovex는 다중 런으로 confidence만 올리면 됨):

- **RUNTIME 키** (값이 실행 중 생성 → `<runtime>`): `targetId`, `content`, `payload`, `html`, `data`, `buffer`.
  - `fn`(browser evaluate JS)은 **runtime 아님 → fixed**(재사용 스크래핑 코드, 길어도 보존).
- **PARAM 키** (변수 후보): 값이 URL(`^https?://`)이거나 키가 `url`/`targetUrl`/`path`/`relPath`/`file_path`/`query`/`q`/`prompt`/`search`.
- **그 외** → fixed (action/kind/selector/profile/timeMs 등 구조).
- **개수 변수(loop)**: 같은 시그니처 L7 연속 반복 → `repeat` 1개 + list 파라미터(길이=개수).
- **부트스트랩 제외**: `SKILLS.md`/`*/SKILL.md`/`skills/*` read는 에이전트 자동 동작이라 module에서 제외됨(원본 `subtasks`엔 남아있음).

---

## 5. 워크드 예시 (Threads & X 스크랩 → Excel)

`module.json`(요약):
```
T0 "Threads 스크랩"  (parameters: url_list_1[list/url ×5], path_2[scalar/path]):
  L7 repeat over url_list_1 → [browser open url={{item}}, browser snapshot targetId=<runtime>]
  L7 "write" → write {path:{{path_2}}, content:<runtime>}
T1 "Excel"  (parameters: path_1[scalar/path], path_2[scalar/path]):
  L7 → [read {path:{{path_1}}}, tool_write_xlsx {relPath:{{path_2}}, payload:<runtime>}]
```
※ parameters는 **task별**로 따로 있음 (id는 task 내 scope — T0의 path_2 ≠ T1의 path_2). Clovex는 L6(task) 단위로 줄 세워 공통점 계산.

런 2회(URL만 바꿔) 누적 후 Clovex 출력:
- T0의 `url_list_1` 슬롯: distinct↑ → **param 확정**, confidence medium→high, loop counts `[5,2]`(개수 변수)
- path 슬롯들: 매번 같으면 **fixed**, 다르면 param
- `targetId`/`content`/`payload`: **runtime**

---

## 6. 상위 클러스터링 (L6 단위 — RPA 규칙 §4 요약)

같은 절차가 아니어도 **비슷한 L6 태스크**끼리 묶어 재사용 모듈을 만들 때(파편화 방지):
1. **결정론적 게이트**: 각 L6의 capability 멀티셋 동일만 후보. (capability = L7의 의미 타입: `web.scrape`/`web.interact`/`file.read`/`file.write`/`doc.render`/`delegate`)
2. **rubric LLM (assign-or-NEW)**: 후보군 기존 클러스터 목록 제시 → 기존 id 선택 or NEW. rubric: 산출물·목표 같고 차이가 값·개수뿐이면 같은 모듈.
3. **메모이즈**: capability signature 키로 캐시 → 같은 시그니처는 LLM 없이 자동 라우팅.
> 이 클러스터링은 Clovex 측 구현. fingerprint(정확 스켈레톤)는 "완전 동일 절차" 묶기, capability 클러스터는 "유사 태스크" 묶기 — 2단계로 쓸 수 있음.

---

## 7. 아직 미확정 (Clovex와 합의 필요)
- **전달 채널**: Clovex가 `<workspace>/user/plans/**` 를 직접 읽나, Twixy가 export/푸시하나? (파일 동기화 vs API)
- RPA 규칙 §9 #2~#5: capability 태그 매핑 확정, 정규화 공격성(wait/retry/중복 snapshot 버릴지/접을지), 태스크 vs 절차 모듈 범위, 클러스터 사람 확정 절차.
- module.json은 단일 run 후보뿐 — **여러 run을 묶어 보관할 위치**(예: `user/modules/<key>.json`)는 Clovex가 소유.

---

## 8. 변경 이력 (이 문서 최초 핸드오프 이후만)

> §1~§7 본문은 모두 최초 핸드오프 시점(2026-05-28)의 확정 스펙. sopRef/fingerprint·fn=fixed·부트스트랩 제외 등은 처음부터 본문에 반영돼 있음(변경 아님). 아래는 **그 이후 바뀐 것**만.

### 2026-05-28 — 프롬프트 수치 인자를 parameter로 lift
- 사용자가 요청에 명시한 수치/한도(예: "댓글 **25**개")가 코드 문자열(`fn`) 안에만 `Math.min(25,…)`처럼 박혀 있으면 Clovex가 변수로 못 봄(tool input leaf만 보므로).
- **변경**: plan.sourcePrompt/executionContext + step title/detail/acceptance에서 추출한 정수(≥2)가 leaf 값에 standalone으로 나오면 → `{{count_N}}` 토큰으로 치환 + `valueType:'number'` scalar 파라미터 등록.
  - `fn`(evaluate JS)은 이제 항상 **fixed로 보존**(length>200이어도 runtime 마스킹 안 함) → 그 안의 의도-숫자만 토큰화.
- **Clovex 적용**: `ModuleParam.valueType`에 **`'number'`** 추가됨. `count_N` 파라미터(observed=숫자)는 다른 param과 동일하게 slot diff 대상. 이름은 결정론적 `count_N`(의미적 이름은 추후 LLM).

### 2026-05-28 — **parameters를 L6 Task별로 이동** (⚠️ breaking)
- **이전**: `ModuleSpec.parameters`(plan 전체 평평한 리스트) — 여러 L6 변수가 섞임.
- **변경**: `ModuleSpec.parameters` **제거** → 각 **`ModuleTask.parameters`**(L6별). param `id`는 **task 내 scope**(예: T0의 `path_2` ≠ T1의 `path_2`).
- **Clovex 적용**:
  - 변수는 `module.json.tasks[].parameters`에서 읽는다 (`module.json.parameters` 없음).
  - `{{paramId}}` resolve는 **그 L8이 속한 task의 parameters**에서. (§2.3·§3.2 반영됨)
  - 슬롯 경로가 이미 `T{taskIdx}/...`라 diff 정렬엔 영향 없음. **L6 단위 공통점 계산**이 자연스러워짐(이게 변경 목적).
