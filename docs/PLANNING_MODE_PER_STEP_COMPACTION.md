# Planning Mode 의 Per-Step Compaction

> **한 줄 요약**: 멀티-step 플랜에서 매 step 끝마다 LLM 으로 transcript 를 요약하고 gateway 세션을 reset, 다음 step 의 prompt 에 prior compactSummary + 보존된 raw tool 블록을 prefix 로 inject 한다. 결과: step 이 늘어나도 컨텍스트 윈도우가 일정하게 유지되고, SOUL.md / step instructions 가 prompt 앞쪽에서 truncate 안 됨.

---

## 1. 왜 추가했는가

### 1.1 문제

이 feature 전에는 한 plan 의 모든 step 이 **같은 gateway 세션** 위에서 실행됐다. 즉 step N 의 LLM 은 step 1 ~ step N-1 의 모든 tool 호출, 모든 browser snapshot, 모든 thinking block 을 그대로 본다.

문제:

1. **Tool snapshot 누적.** `browser` 툴의 페이지 snapshot 은 한 번에 수만 토큰까지 나온다. step 2 에서 5 개 사이트를 방문하면 step 3 의 prompt 에는 그 5 개의 snapshot 이 다 들어있다. step 3 이 굳이 다시 볼 필요가 없는 데이터.
2. **SOUL.md / step instructions 가 truncate 됨.** 입력 토큰이 200K 를 넘기면 OpenRouter / Anthropic 이 prompt 의 head 를 잘라낸다. 그 head 가 바로 SOUL.md 임. SOUL.md 가 없으면 LLM 이 workspace rules / 저장 경로 / first-actions 를 모르고 헛짓을 한다.
3. **Skill 호출이 무거워짐.** 매 step 마다 SKILLS.md / 관련 SKILL.md 를 모델이 다시 읽는데, 매 read 가 직전 step 의 transcript 위에 또 쌓인다.
4. **Cost 폭증.** input 토큰이 step 마다 누적되는 만큼 OpenRouter input cost 가 step^2 에 가깝게 증가.

### 1.2 해결 전략

각 step 끝에서:

- **Compactor LLM** 이 step 의 transcript 를 마크다운 한 단락으로 요약 (`compactSummary`).
- 동시에 `## Raw retentions` 섹션에 "downstream step 이 다시 봐야 할 toolCallId 들" 을 명시하게 함.
- 그 toolCallId 들의 raw tool_use + tool_result 블록은 디스크에 그대로 보존 (`steps/<stepId>/raw.jsonl`).
- Gateway 세션을 `sessions.reset` 으로 wipe — 새 sessionId, fresh transcript.
- 다음 step 의 prompt 머리에 `=== Prior step summaries (compacted) ===` 블록 + `=== Retained raw tool outputs from prior steps ===` 블록을 inject.

결과: step 이 몇 개든 LLM input 은 "compactSummaries (수백 토큰) + 명시적으로 retain 한 raw blocks (사용자가 통제) + 현재 step instructions" 로 bound 됨. SOUL.md 는 매 step 마다 fresh 세션 위에서 inject 되므로 절대 truncate 안 됨.

---

## 2. 동작 흐름 (Step-by-step)

```
Plan resume / build
  ↓
runFromCurrent() 진입
  ├─ setRejectNewRuns(false)         # 좀비 guard 클리어
  ├─ resetSession()                  # step 1 은 fresh transcript 에서 시작
  └─ while loop {
       │
       ├─ planGet → pause 체크
       │
       ├─ buildPriorContextBlock()
       │   ├─ 이전 done step 들의 compactSummary 를 모음
       │   ├─ 이전 done step 들의 rawToolCallIds 를 union
       │   ├─ planStepReadRaw 로 raw.jsonl 에서 해당 toolCallIds 의 블록만 추출
       │   └─ "=== Prior step summaries ===" + "=== Retained raw tool outputs ===" 문자열로 조립
       │
       ├─ stepPrompt = priorContext + buildStepPrompt(step)
       │
       ├─ setRejectNewRuns(false)    # 직전 step boundary 의 true 클리어 (race 방지)
       ├─ res = sendAndAwaitFinal(stepPrompt)
       │
       ├─ killActiveSubagents()      # main 이 sessions_spawn 후 yield 한 좀비 차단
       │
       ├─ marker = parseStepMarker(res.text)
       │
       ├─ if (!marker) {
       │     retry sendAndAwaitFinal("Reply with ONLY [step-done]/[step-failed]")
       │   }
       │
       ├─ if (marker == done && step.acceptance) {
       │     verifyAndExplain()      # 별도 LLM 으로 RESULT: YES/NO 판정
       │     if (NO) marker = failed
       │   }
       │
       ├─ planStepEnd(status)        # 디스크 + run.md 기록
       │
       ├─ setRejectNewRuns(true)     # 다음 step 까지 inter-step gap 보호
       ├─ killActiveSubagents()      # 한 번 더 (보험)
       │
       ├─ if (failed/interrupted) {
       │     setRequesterAnnounceFrozen(true)   # gateway-level freeze
       │     addSystemMessage("Plan stopped...")
       │     break
       │   }
       │
       └─ if (success && remaining > 0) {       # ── per-step compaction ──
            ├─ rawSlice = getSessionMessages()  # 현재 gateway 세션 transcript 추출
            ├─ compactRes = sendAndAwaitFinal(buildCompactPrompt(...))   # 90s timeout
            ├─ rawIds = parseRawRetentions(compactRes.text)
            ├─ planStepCompact({ compactSummary, rawToolCallIds: rawIds, rawMessages: rawSlice })
            └─ resetSession()                   # gateway transcript wipe — 다음 step 은 fresh
          }
     }
  ↓
if (anyFailed) markPaused
else outcome LLM round-trip
```

---

## 3. 디스크 레이아웃

```
<workspace>/plans/<planId>/
├── plan.json               # PlanStep 에 compactSummary, rawToolCallIds, rawTranscriptPath, compactedAt, subtasks(L7→L8) 추가
├── plan.md                 # renderPlanMd 가 _Compacted:_ <head>… 라인 자동 append
├── run.md                  # saveStepCompact 가 "Compact summary" + "Raw retained" + "Raw transcript" 블록 append
└── steps/
    └── <stepId>/
        └── raw.jsonl       # 그 step 의 gateway 세션 message slice (verbatim)
```

`raw.jsonl` 은 **그 step 동안의 gateway message 만** 들어있다. step 간 reset 덕분에 깨끗하게 잘림.

`step.rawTranscriptPath` 는 plansRoot 기준 상대경로로 저장됨 (plan 디렉토리를 옮겨도 안 깨짐).

---

## 4. Compactor LLM 의 출력 형식

`buildCompactPrompt` 는 다음 형식을 강제 (기대):

```markdown
## Step <N> Summary — <title>

**완료 여부:** 성공/실패
**수행 내용:** ...
**아티팩트:** `path/to/file.md`

### Step <N>에서 확보한 데이터 (Downstream용)

| 표 형식으로 | 다음 step 이 | 필요로 할 데이터 |

### Downstream Steps 예고

**Step <N+1>:** ...
**Step <N+2>:** ...

---

## Raw retentions

- callId: `call_function_xxx_1` — <왜 raw 로 남겨야 하는지>
- callId: `call_function_yyy_2` — ...
```

`parseRawRetentions` 가 `## Raw retentions` 섹션 아래의 `` `tc_xxx` `` 패턴을 정규식으로 추출 (여러 형식 tolerant — `-`, `*`, `**callId**:` 등).

### 4.1 Work breakdown (L6 → L7 → L8) — 재실행 가능한 기록

목적: plan 실행 기록을 **다른 프로그램이 읽어 똑같이 재실행할 수 있는 input** 으로 만든다 (회사 프로젝트 계층 정의서 `프로젝트_계층_정의서.docx` 의 L6/L7/L8 에 정렬). Twixy 의 책임은 L6/L7/L8 구조화 기록까지이고, 실제 replay 는 downstream 프로그램이 처리한다.

- **L6 Task = `PlanStep` 자체** (이미 존재)
- **L7 Sub-task** = 한 목적을 공유하는 tool 호출 묶음
- **L8 Step = 실제 실행된 `tool_use` 하나** — `toolName` + `input`(인자 전체) + `toolCallId` 보유. raw.jsonl 의 tool_use 블록에 1:1 앵커링되는 replay 단위.

**핵심 설계 — L8/L7 둘 다 LLM 이 아니라 실제 tool 호출에서 결정론적으로 만든다.**

처음엔 compactor LLM 에게 `## Work breakdown` 을 callId 로 그룹핑하게 시켰지만, minimax 가 그 형식을 자주 누락해서 모든 호출이 단일 catch-all L7 로 떨어졌다. machine-consumable replay 기록은 LLM 품질에 의존하면 안 되므로 **완전히 결정론적**으로 전환:

1. `extractToolUses(rawSlice)` — transcript 에서 모든 tool 호출(`{type:'toolCall', id, name, arguments}` — OpenClaw 스키마)을 추출. id+name+arguments 보존. 이게 L8 의 canonical floor.
2. `buildWorkBreakdown(toolUses)` — LLM 없이 순서 보존하며 L7 로 그룹핑:
   - browser `open`/`navigate` 는 **새 L7 시작**(새 페이지 = 새 논리 단위). 그 뒤 같은 페이지의 browser `act`/`snapshot`/`evaluate`/`wait` 는 같은 L7 로 fold.
   - 비-browser tool(`read`/`write`/`tool_write_*`/`sessions_spawn` …)은 각자 L7.
   - 각 L7 제목은 첫 호출의 salient 인자에서 파생(`deriveStepLabel` — url/targetUrl/path/relPath/…).

실증(plan_mpp0ltm…): s1 22콜→9 L7(SKILLS read → 게시물별 browser 그룹 → write → read), s2 7→5, s3 2→2.

결과 `L7Subtask[]` 는 `step.subtasks` 로 plan.json 에 저장(각 L8 에 full `input` 포함). `saveStepCompact` 가 run.md 에 `**Work breakdown — L6 Task: <title>**` 트리 블록(각 L8 아래 `input:` 미리보기 200자 cap)을 append, `renderPlanMd` 가 plan.md 에 `- L7:` / `- L8: [tool]` 라인으로 노출.

compactor LLM 은 이제 **요약(compactSummary) + raw retentions 만** 담당하고 work breakdown 에는 일절 관여하지 않는다 (prompt 에서 해당 섹션 제거).

---

## 5. 다음 Step 의 Prompt 구조

`buildPriorContextBlock` 이 만든 prefix:

```
=== Prior step summaries (compacted) ===

--- Step 1: <title> ---
<step 1 의 compactSummary 전문>

--- Step 2: <title> ---
<step 2 의 compactSummary 전문>

=== Retained raw tool outputs from prior steps ===

[step 1, callId: tc_aaa] tool: write
input: {...}
result: {...}

[step 2, callId: tc_bbb] tool: browser
...

=== End of prior context — your actual instruction follows ===

You are the same Twixy agent as in any other chat turn. ...
For context: this turn is step N of M in a plan titled "...".
---
User's message for this turn:
<step.title>
<step.detail>
(I'll consider this done when: <step.acceptance>)
(The "<step.skillHint>" skill may be relevant.)
---
When you finish this turn, end your reply with EXACTLY ONE marker on its own line:
- `[step-done] <summary>` on success
- `[step-failed] <reason>` if you cannot complete it
```

여기 핵심: **"=== End of prior context ==="** 라인이 LLM 에게 "이 위는 read-only 컨텍스트, 아래가 실제 instruction" 이라고 명시. SOUL.md 의 workspace rules 우선 원칙도 항상 먼저 박힘.

---

## 6. 실패 / 중단 처리

### 6.1 Step 자체가 실패

`marker.kind === 'failed'` 이거나 `verifyAndExplain` 에서 NO 면:
- compaction round-trip **건너뜀** (실패 step 의 결과를 다음 step 이 안 봐야 함)
- `setRequesterAnnounceFrozen(true)` (gateway-level freeze, 좀비 announce 차단)
- "Plan stopped — Step N failed" 시스템 메시지 + Try again / No thanks 버튼
- run.md 에 `_Paused at <ts>_` 라인 append (markPaused)
- **`status: "failed"` 가 아니라 `"paused"` 로 마킹.** Try again 시 같은 step idx 부터 재시도 가능.

### 6.2 Compactor LLM 자체가 실패

`buildCompactPrompt` round-trip 이 throw 되거나 timeout 되면:
```ts
catch (err) {
  console.warn('[plan/compact] round-trip failed', err)
}
// fallback
compactSummary: '_(compaction failed — raw transcript retained)_'
```
다음 step 의 priorContext 에 placeholder 가 들어가지만 raw.jsonl 은 정상 저장됨. step 자체는 **success 로 유지** — compaction 실패가 step 실패로 이어지진 않음.

### 6.3 마지막 step (no remaining)

> **변경 (L6/L7/L8 기능)**: 예전엔 마지막 step 의 compaction 을 통째로 건너뛰었다. 지금은 **L7/L8 work breakdown 을 모든 L6 Task 에 기록**해야 하므로 마지막 step 도 compaction round-trip 을 실행한다.

- compactSummary + work breakdown + raw.jsonl 모두 마지막 step 에서도 생성
- 단, `resetSession()` 만 생략 (다음 step 이 없으니 fresh transcript 가 필요 없음)
- 비용: plan 당 LLM round-trip 1회 추가. work breakdown 기록 가치가 이를 상회한다고 판단.

---

## 7. 동시에 닫은 race 버그 두 개

### 7.1 Inter-step abort race (step N → step N+1)

증상: step 2 끝나고 step 3 prompt 보낸 직후 4 초 이내에 `stopReason:"aborted"` + `content:[]` 메시지로 죽음. UI 는 무한 thinking.

원인: step boundary 에서 `setRejectNewRuns(true)` (L770) 가 다음 step 의 `sendAndAwaitFinal` 까지 클리어 안 됨. Compaction `chat.final` 직후 ~ step N+1 awaiter push 사이의 짧은 window 에서 자동 lifecycle phase=start 가 fire 되면 interceptor 가 `sessions.abort` 를 fire-and-forget 호출 → step N+1 의 `sessions.send` 와 race → step N+1 abort.

해결: `sendAndAwaitFinal(stepPrompt)` **직전** 에 `setRejectNewRuns(false)` 호출. race window 를 0 으로.

### 7.2 sessions_yield false-positive

증상: step 2 시작 후 21 초만에 `Error: run_aborted` 로 interrupted 마킹 → plan paused / Resume 상태. 하지만 sub-agent 는 background 에서 계속 실행돼 [step-done] 까지 emit. 받아주는 awaiter 가 이미 reject 돼있어서 결과가 사라짐.

원인: useOpenClaw 의 abort 핸들러가 `!text && (stopReason ∈ {aborted, error} || errorMessage)` 조건에서 firing. `sessions_yield` 시 gateway 가 transient WS-only `session.message` 를 emit 하는데 그게 abort-like field 를 갖고 있음 (jsonl 에는 안 저장됨, WS 만).

해결: abort 핸들러에 sub-agent in-flight guard 추가:
```ts
const subagentInFlight = subagentSessionsRef.current.size > 0
                      || rootFinaledWhileSubagentBusy.current
if (looksAborted && !subagentInFlight) { /* 진짜 abort */ }
if (looksAborted &&  subagentInFlight) { /* yield 가능성, 무시 */ }
```
진짜 abort 는 sub-agent 도 함께 죽이고 `phase:'end'/'error'` 로 ref 에서 빠지므로 다음 abort 메시지에서 정상 firing.

---

## 8. 한계 / 향후 작업

- **Compactor LLM 의 quality 의존성.** Compactor 가 toolCallId 를 빼먹거나 summary 에 핵심 데이터를 누락하면 다음 step 이 헤맴. 현재는 prompt 에 "Downstream용 데이터" 표 형식을 강제하지만 모델이 안 따를 수 있음.
- **Raw retention 폭증 가능성.** Compactor 가 너무 많은 toolCallId 를 retain 하면 priorContext 가 다시 커짐. 현재 cap 없음 — observation 후 필요하면 토큰 budget 추가.
- **Parallel step 미지원.** 모든 step 이 직렬. 만약 step 2 와 step 3 이 독립적이면 병렬화 가능하겠지만 현재 runner 는 single while loop.
- **Resume 시 compactSummary 가 비어있는 step 처리.** 만약 resumePlan 직전에 compaction round-trip 이 crash 했다면 그 step 의 compactSummary 는 placeholder. priorContext 에 `_(compaction failed — raw transcript retained)_` 가 박혀 있음 — LLM 이 이 placeholder 를 보고 헷갈릴 수 있음. 필요시 raw.jsonl 만 inject 하는 fallback 가능.
- **UI 노출 미완성.** PlanCard 의 PlanStep 인터페이스에 4 개 컴팩션 필드를 추가했지만 실제 렌더는 아직 안 함. plan.md / run.md 의 텍스트로만 보임.

---

## 9. 관련 파일

| 레이어 | 파일 | 추가된 핵심 |
|---|---|---|
| Disk / Plan model | `electron/planning.ts` | `saveStepCompact`, `readStepRaw`, `StepCompactPayload`, `PlanStep.compactSummary/rawToolCallIds/rawTranscriptPath/compactedAt/subtasks`, `L7Subtask`/`L8Step` 타입, `renderPlanMd` 의 L7/L8 노출 |
| IPC | `electron/main.ts` | `plan-step-compact`, `plan-step-read-raw` 핸들러 |
| Bridge | `electron/preload.ts` | `planStepCompact`, `planStepReadRaw` 노출 |
| Types | `src/global.d.ts` | `TwixyPlanStep` + `TwixyAPI` 시그니처 |
| Gateway 클라이언트 | `src/hooks/useOpenClaw.ts` | `resetSession`, `getSessionMessages`, abort handler + sub-agent guard |
| Plan runner | `src/hooks/usePlans.ts` | `verifyAndExplain`, `buildCompactPrompt`, `parseRawRetentions`, `extractToolUses`, `browserAction`, `deriveStepLabel`, `buildWorkBreakdown`(결정론적 L7 그룹핑), `buildPriorContextBlock`, `runFromCurrent` (last-step 도 compact) |
| Renderer 타입 | `src/components/PlanCard.tsx`, `src/global.d.ts` | `L7Subtask`/`L8Step` 미러, `PlanStep.subtasks?`, `planStepCompact` 시그니처 |
| App wiring | `src/App.tsx` | deps 에 `resetSession`/`getSessionMessages` 추가, `handleResume` helper |
| UI | `src/components/PlanCard.tsx` | PlanStep 인터페이스에 4 필드 추가 (렌더는 미연결) |

## 10. 관련 문서

- [PLANNING_MODE_SUBAGENT_ANNOUNCE.md](./PLANNING_MODE_SUBAGENT_ANNOUNCE.md) — subagent announce 차단 메커니즘 (이 문서의 §7.1, §7.2 race 들과 깊게 엮임)
- [docs/branches/AGENT_TOOLS_BRIDGE_CHANGELOG.md](./branches/AGENT_TOOLS_BRIDGE_CHANGELOG.md) 의 2026-04-30 entry — 실제 변경된 파일/함수 목록
