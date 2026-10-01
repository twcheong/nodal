# Stage 3 — Harness / Agent 분리 지도 (Track C)

"에이전트를 **어떻게 굴릴지** 정하는 로직" 이 지금 어디에 흩어져 있는지의 전수 조사.

> ### ⚠️ 용어가 바뀌었다 (2026-09-21) — 이전 판을 읽은 사람은 여기부터
>
> 초판은 "엔진을 우리 코드에서 추출한다" 는 틀로 썼다. 현준과 맞춘 결과 그 말이 실제
> 구조와 어긋난다는 게 분명해져서 아래 어휘로 전면 교체했다. **근거(파일·줄)는 하나도
> 바뀌지 않았고 라벨만 바뀌었다.**
>
> | 용어 | 뜻 | 상태 |
> |---|---|---|
> | **Engine** | AI 런타임 그 자체 — openclaw(별도 프로세스, 우리 코드 아님), 그걸 띄우고 설정·키·툴 권한을 주는 main 프로세스 수명주기, 그리고 붙는 transport | **이미 분리돼 있다. 추출 대상이 아니다.** |
> | **Harness** | 주어진 일에 대해 에이전트를 *어떻게 모는가* — 턴 루프, timeout, retry, 노드 시퀀싱, 성공 판정, 비용/시간 집계 | 렌더러 훅에 박혀 있다. **떼어낼 대상.** |
> | **Agent** | *누가 말하는가* — SOUL, 프롬프트 텍스트, tool 카탈로그, `agentId`, 모드 | 여기저기 흩어져 있다. **떼어낼 대상.** |
>
> 초판에서 "엔진" 이라고 부른 것(턴 루프·노드 시퀀스)은 이 어휘에서 **Harness** 다.
> 목표도 "우리 코드에서 엔진을 추출한다" 가 아니라 **"Harness 와 Agent 를 렌더러 훅에서
> 떼어내, 여러 벌의 Harness·Agent 가 하나의 Engine 위에 앉게 한다"** 이다.

**이 문서는 지도다. (§4 Move 1 을 제외하면) 프로덕션 코드는 한 줄도 옮기지 않았다.**

- 기준 commit: `fdbfdd7` (= `origin/main` `cc32297` 머지 이후). 줄 번호는 이후 커밋에서 밀린다 — 심볼명으로 grep 할 것.
- 기준선: `npx vitest run` 37 files / 559 tests green, `tsc -p tsconfig.json` · `tsconfig.electron.json` 둘 다 0 error, `npm run lint` 0 error / 16 warning.
- 읽어서 확인한 것과 **추론한 것을 구분해 표기**한다. 표기 없으면 직접 읽고 줄 번호를 확인한 것이다.

---

## 0. 먼저 — 가이드의 전제 두 개가 코드와 다르다

지도를 그리기 전에 이것부터 짚는다. 여기서 어긋나면 뒤의 경계 제안이 통째로 틀어진다.

### 0.1 `electron/planning.ts` 에는 하네스 로직이 없다

과제 설명은 이 파일을 흩어진 곳 중 하나로 지목했다. 3,129줄 전부 읽고 확인한 결과 **순수 디스크 IO/CRUD 다.**
프롬프트 빌더 없음, SOUL 주입 없음, turn 완료 판정 없음, retry/timeout 없음 (`setTimeout`·`AbortController` 0건),
툴 선택 없음, `PRODUCT.*`·`process.env` 0건, `ipcMain.handle|on` 0건.
파일 자신의 헤더 주석(`electron/planning.ts:1-14`)이 이미 그렇게 말한다 — *"planning loop 자체(플래너 LLM 왕복 + 게이트웨이 단계 구동)는 렌더러에 있다 — 이 파일은 순수 IO"*.

이 파일이 Harness 에 대해 갖는 유일한 지분은 **결과를 받아 적는 쪽**이다:

| 무엇 | 위치 |
|---|---|
| `RunHistoryEntry` 타입 (`harness?: 'v1'\|'v2'\|'v3'\|'off'` 라벨 필드 포함) | `electron/planning.ts:2378-2391` |
| `appendRunHistory` (runs.jsonl append) | `electron/planning.ts:2397-2400` |
| `listRunHistory` (전 워크플로 병합, desc, limit 500) | `electron/planning.ts:2468-2487` |
| `writeRunDetail` / `readRunDetail` (노드별 prompt·output·toolCalls 전문) | `electron/planning.ts:2442-2464` |
| `RUN_LOG_RETENTION_MS = 90일` | `electron/planning.ts:2436` |

→ **planning.ts 는 Harness 가 아니다. Harness 가 호출할 영속화 포트다.** 옮길 대상이 아니라, 주입될 의존성이다.

### 0.2 SOUL 주입 경로가 **둘** 이고, 제품마다 다른 쪽을 쓴다

가이드는 "하나의 공통 층이 SOUL 을 주입한다" 를 전제하는데, 코드에는 서로 다른 두 메커니즘이 있다.

| 경로 | 구현 | 쓰는 제품 |
|---|---|---|
| **A. 렌더러 prepend** — `.md?raw` 를 첫 메시지 앞에 문자열로 붙인다 | `src/lib/*Soul.ts` → 훅이 `` `${soul}\n\n---\n\n${text}` `` | Twixy (wf / simple / content / workflow builder / orchestration builder) |
| **B. 워크스페이스 파일** — main 이 `SOUL.md`·`AGENTS.md` 를 워크스페이스에 복사하고 openclaw 가 직접 읽는다 | `electron/main.ts:1349-1357` (`PRODUCT.workspaceSeedDir` → `getWorkspace()`) | Nodal (`video` 모드) |

증거 — Nodal 의 모드는 SOUL 을 **붙이지 않는다**:

```ts
// products/nodal/renderer/videoMode.tsx:14-20
// 시스템 프롬프트는 openclaw 가 워크스페이스의 SOUL.md (workspace-seed/) 를 직접 읽으므로 여기서 붙이지 않는다.
agentId: 'main',
buildBody: ({ text, first, transcriptSeed, fileAttach }) =>
  `${first ? transcriptSeed : ''}${fileAttach}${text}`,
```

→ SOUL 책임은 한 층이 통째로 갖는 게 아니라 쪼개진다: **어떤 SOUL 텍스트인가 = Agent**,
**첫 턴에만 한 번 주입한다는 규칙 = Harness**, **경로 B 처럼 워크스페이스에 심는 것 = Engine(main 수명주기)**.
경로 A/B 를 하나로 통일하면 안 된다 — §5.1 #6.

---

## 1. 지금 한 턴은 누가 조립하는가

프로세스 표기: **R** = 렌더러, **M** = Electron main, **G** = openclaw 게이트웨이(별도 프로세스, 우리 코드 아님).
G 와, 그걸 띄우고 설정하는 M 의 일부가 곧 **Engine** 이다 — 이미 분리돼 있으므로 아래 표에서 옮길 대상으로 세지 않는다.

### 1.1 프롬프트 조립

| 무엇 | 위치 | 프로세스 |
|---|---|---|
| **노드 프롬프트 (Test run)** `buildNodePrompt()` | `src/hooks/useWorkflowTest.ts:897-1038` | R |
| **노드 프롬프트 (Orchestration)** `buildNodePrompt()` — **위의 두 번째 사본** | `src/lib/runWorkflowNodes.ts:166-239` | R |
| **노드 프롬프트 (A/B eval)** `buildNodePrompt()` — **세 번째 사본, 이미 낡았다** | `scripts/wf-eval.mjs:115-137` | node CLI |
| Resume 복기문 `buildResumeRecap()` | `src/hooks/useWorkflowTest.ts:878-895` | R |
| 타임아웃 재시도 시 "슬라이스" 지시문 | `src/hooks/useWorkflowTest.ts:579-587` | R |
| 바이너리 문서(.xlsx/.pdf) 텍스트 추출 첨부 | `src/hooks/useWorkflowTest.ts:555-561` | R |
| Copilot 모드 분기 body 조립 | `src/hooks/useCopilotChat.ts:705-777` | R |
| ├ 워크플로 카탈로그 prelude | `src/hooks/useCopilotChat.ts:274-289` | R |
| ├ 이전 대화 복기 `buildTranscriptSeed()` | `src/hooks/useCopilotChat.ts:166-188` | R |
| ├ 워크스페이스 데이터파일 카탈로그 | `src/hooks/useCopilotChat.ts:195-224` | R |
| └ @멘션 파일 첨부 블록 | `src/hooks/useCopilotChat.ts:237-270` | R |
| Workflow builder body | `src/hooks/useWorkflowClaw.ts:145-151` | R |
| Orchestration builder body | `src/hooks/useOrchestrationClaw.ts:104-108` | R |
| Orchestration 그룹 출력 재포맷 프롬프트 | `src/hooks/useOrchestrationRun.ts:168-170` | R |
| URL 로 시작하는 메시지에 더미 서두를 붙이는 우회 | `src/hooks/useOpenClaw.ts:1460-1463` | R |

**세 사본의 실제 격차** (`wf-eval.mjs` 사본에 빠진 것):
`preamble`(상류 출력 체이닝), 단일 depth-1 tool 규칙, `bridgeToolsFor()` 블록, `tool_fetch_to_file` 경고, `inputScope`/`outputScope` 줄.
`useWorkflowTest.ts:984-985` 와 `src/lib/workflowTools.ts:133-136` 에 *"한쪽만 고치면 다른 경로가 조용히 비싼 폴백으로 돈다"* 는 경고 주석이 **이미 박혀 있다**. 중복이 스스로 이음매를 가리키고 있다.

### 1.2 SOUL 주입

| 무엇 | 위치 | 프로세스 |
|---|---|---|
| `runnerHarnessPreamble()` 정의 (localStorage `twixy.runnerHarness` 게이트) | `src/lib/runnerHarness.ts:22-35` | R |
| └ 호출 — Test run 첫 노드 | `src/hooks/useWorkflowTest.ts:909` | R |
| └ 호출 — Orchestration 첫 노드 | `src/lib/runWorkflowNodes.ts:172` | R |
| `getWorkflowSoul()` (`<!-- TOOLS_CATALOG -->` 치환) | `src/lib/workflowSoul.ts:23-25` → `src/hooks/useWorkflowClaw.ts:148-150` | R |
| `getOrchestrationSoul(workflows, agents)` (`<!-- WORKFLOWS_CATALOG -->` 치환) | `src/lib/orchestrationSoul.ts:13-30` → `src/hooks/useOrchestrationClaw.ts:106` | R |
| `getCopilotSoul()` / `getSimpleSoul()` (둘 다 끝에 `getWorkflowSoul()` 을 포함) | `src/lib/copilotSoul.ts:42-215` → `src/hooks/useCopilotChat.ts:759, 776` | R |
| `getContentSoul()` | `src/lib/contentSoul.ts:17-19` → `src/hooks/useCopilotChat.ts:771` | R |
| 워크스페이스 `SOUL.md`/`AGENTS.md` 복사 (경로 B) | `electron/main.ts:1349-1357` | M |

**공통 패턴 — 이미 사실상 하나의 규칙이다**: 네 훅 모두 세션당 `soulSentRef`/`soulSentConvs` 플래그로 **첫 메시지에만** 붙이고, 형식은 예외 없이 `` `${soul}\n\n---\n\n${body}` `` 다. 붙이는 *내용*만 다르다. → 규칙은 Harness, 내용은 Agent (§2).

### 1.3 턴이 끝났다는 판정

| 무엇 | 위치 | 프로세스 |
|---|---|---|
| 게이트웨이 프레임 → `chat` / `state: start\|final\|error` (공통 프로토콜) | G → R |  |
| Workflow test 세션 `handleEvent` | `src/hooks/useWorkflowTestSession.ts:273-355` (chat `277-314`) | R |
| Copilot `handleEvent` | `src/hooks/useCopilotChat.ts:460-557` (chat `464-498`) | R |
| Workflow builder | `src/hooks/useWorkflowClaw.ts:59-93` (chat `63-73`) | R |
| Orchestration builder | `src/hooks/useOrchestrationClaw.ts:42-71` (chat `46-56`) | R |
| 메인 채팅 — **손으로 짠 별도 구현**. 서브에이전트 드레인 대기, 15초 fallback 타이머, 400ms 유예 | `src/hooks/useOpenClaw.ts:839-939` | R |
| **`NODE_STATUS: OK\|FAILED` 센티넬** — "게이트웨이가 final 이라 했다" ≠ "노드가 성공했다" | `src/hooks/useWorkflowTest.ts:776-789` (`detectNodeFailure`), `791-795` (`stripNodeStatus`) | R |
| └ 같은 센티넬을 **요구하는** 프롬프트 footer | `src/hooks/useWorkflowTest.ts:1006-1038` (추론: 정확한 footer 줄은 `buildNodePrompt` 말미) | R |

~~⚠️ `runWorkflowNodes.ts` 에는 이 센티넬 판정이 없다. 두 실행 경로가 "성공" 의 정의부터 다르다.~~
→ **해소됨 (2026-09, 커밋 `230d1b2`).** 사용자가 strict 로 통일하기로 결정 — Orchestration 도
`NODE_STATUS` 를 요구하고 같은 파서로 판정한다. 문구·파서는 `src/lib/nodeStatus.ts` 한 곳.
받아들인 대가: 예전에 초록이던 run 일부가 실패로 표시된다 (표시가 정직해지는 것이지,
실제 성공률 하락이 아니다).

### 1.4 retry 와 timeout

| 무엇 | 값 | 위치 | 프로세스 |
|---|---|---|---|
| RPC 기본 timeout | `15_000` | `src/lib/gateway/controlUiTransport.ts:59`, 사용 `81-92` | R |
| 세션 awaiter 안전망 | `10 * 60 * 1000` | `src/hooks/useWorkflowTestSession.ts:447-453` | R |
| 노드 timeout (Test run) | `NODE_TIMEOUT_MS = 540_000` (9분) | `src/hooks/useWorkflowTest.ts:79` | R |
| 노드 timeout (Orchestration) — **상수 없이 리터럴** | `540_000` | `src/lib/runWorkflowNodes.ts:85` | R |
| 슬라이스 재시도 사다리 | `['about half','about a quarter','about an eighth']`, 최대 3회, 취소 후 1500ms 드레인 | `src/hooks/useWorkflowTest.ts:84`, 루프 `579-613` | R |
| └ **Orchestration 경로에는 이 사다리가 없다** (한 번 실패하면 워크플로 중단) | — | `src/lib/runWorkflowNodes.ts:107-119` | R |
| usage 원장 정산 폴링 | 6회 × 500ms | `src/hooks/useWorkflowTest.ts:162-182` · **사본** `src/lib/runWorkflowNodes.ts:147-164` | R |
| Orchestration manager/synthesis LLM | `120_000` | `src/hooks/useOrchestrationRun.ts:104` | R |
| 노트 답신 timeout | `120_000` | `src/hooks/useWorkflowTest.ts:501` | R |
| 재연결 backoff | `min(1500 * 2**n, 12_000)`, auto 8회 / manual 3회 | `src/hooks/useOpenClaw.ts:471-472`, `1243-1252` | R |
| 초기 연결 지연 | `800` | `src/hooks/useOpenClaw.ts:1375` | R |
| LLM idle timeout (게이트웨이 설정) | `idleTimeoutSeconds: 120` | `electron/main.ts` (agents.defaults.llm) | M |
| run 로그 보존 | 90일 | `electron/planning.ts:2436` | M |

transport 는 자동 재연결을 **일부러 안 한다** — 헤더가 명시한다 (`src/lib/gateway/controlUiTransport.ts:8-11`).

### 1.5 툴 선택 — **두 층, 두 프로세스. 서로 모른다.**

| 층 | 무엇 | 위치 | 프로세스 |
|---|---|---|---|
| **정책(진짜 권한)** | `tools.profile: 'coding'` + `alsoAllow` / `deny`, `PRODUCT.features.{subagents,browser,cron,bridgeTools,toolsDeny}` 로 구성 | `electron/main.ts:1191-1229` | M |
| **정책** | 에이전트별 deny — `builder` = `deny:['*']` (툴 없음), `workflow-runner` = 서브에이전트만 deny | `electron/main.ts:1082-1083` | M |
| **정책** | 내장 MCP 서버 주입 (`PRODUCT.features.builtinMcp`) | `electron/main.ts:1050` | M |
| **선택(어느 에이전트로 세션을 열까)** | `sessions.create({ agentId: 'workflow-runner' })` | `src/hooks/useWorkflowTestSession.ts:393-401` | R |
| **선택** | `agentId: 'builder'` | `src/hooks/useWorkflowClaw.ts:107-112`, `src/hooks/useOrchestrationClaw.ts:83-85` | R |
| **선택 — 제품별** | `getProductCopilotMode(mode)?.agentId ?? 'builder'` | `src/hooks/useCopilotChat.ts:619` | R |
| **프롬프트 유도(권한 아님)** | `bridgeToolsFor(tool, toolSkills)` → "이 툴들을 직접 불러라" 문장 | `src/lib/workflowTools.ts:138-146`, 사용 `useWorkflowTest.ts:986-1005` · `runWorkflowNodes.ts:217-233` | R |
| **카탈로그** | `WORKFLOW_TOOLS` (정적) + `renderToolCatalog()` → SOUL placeholder | `src/lib/workflowTools.ts:27-105, 151-160` | R |
| **게이트키퍼** | `validateTool` / `filterValidSkills` — LLM 이 지어낸 tool 이름 차단 | `src/lib/workflowTools.ts:179-194` | R |
| **사용량 소프트 캡** | `DAILY_SEARCH_CAP = 100` (localStorage) | `src/hooks/useOpenClaw.ts:75-96, 974-979` | R |

⚠️ 이 둘은 **정합성 검사가 없다**. `main.ts` 가 `tool_fetch_to_file` 을 deny 해도 `workflowTools.ts` 의 카탈로그는 그대로 "이 툴을 불러라" 고 프롬프트에 쓴다. Nodal 은 `bridgeTools: []` 이므로 실제로 전부 deny 인데, `workflows: false` 라 이 경로를 안 타서 지금은 드러나지 않을 뿐이다.

### 1.6 run 기록 / 영속화

| 무엇 | 위치 | 프로세스 |
|---|---|---|
| runs.jsonl append 호출부 (`harness: harnessLabel()` 라벨 포함) | `src/components/WorkflowView.tsx:234-248` | R → IPC |
| run 상세(JSON) 저장 호출부 | `src/components/WorkflowView.tsx:250-270` | R → IPC |
| 실제 기록 | `electron/planning.ts:2397-2400, 2442-2464` | M |
| Test run 스냅샷 hydrate / clear | `src/hooks/useWorkflowTest.ts:267, 274-308` | R → IPC |
| Orchestration run 저장 | `src/hooks/useOrchestrationRun.ts:211-217` | R → IPC |
| Copilot 대화 — **localStorage** (msgs 300개 cap, activity 40개 cap) | `src/hooks/useCopilotChat.ts:88-140, 423-443` | R |
| Workflow / Orchestration builder 채팅 — IPC JSONL | `useWorkflowClaw.ts:89,140,167,185` · `useOrchestrationClaw.ts:67,101,119,128` | R → M |
| 메인 채팅 persist + hydrate | `src/hooks/useOpenClaw.ts:445-460, 1264-1311` | R → M |
| 사용량/비용 기록 | `src/hooks/useOpenClaw.ts:346-351, 604-611` → `window.twixy.recordOpenRouterUsage` | R → M |

→ **렌더러 코드 어디에도 Supabase 직접 호출이 없다.** 실행 기록은 전부 `window.twixy.*` IPC 아니면 localStorage 다. (Supabase 쓰기는 main 에 있다 — 추론, 이번에 읽지 않음.)

---

## 2. 제품별 vs 공통 — 공통집합이 떼어낼 Harness·Agent 다

`npm run check:boundary` 가 `PRODUCT.id === …` 분기를 금지하고 있어서 (`scripts/check-product-boundary.mjs:56-58`), 제품차는 **전부 `profile.ts` 의 값**으로만 표현된다. 그래서 경계가 기계적으로 확인 가능하다.

### 2.1 제품별 (= 제품 프로필이 결정 — Harness 로 올라가면 안 되는 것)

| 무엇 | 읽는 값 | 위치 | 제품차 |
|---|---|---|---|
| 게이트웨이 WS 엔드포인트 | `PRODUCT.gatewayPort` | `src/lib/product.ts:10` → `src/lib/gateway/rendererTransport.ts:4,11` | twixy 18789 / nodal 18889 |
| Chrome CDP 포트 | `PRODUCT.cdpPort`, `workflowCdpPorts` | `src/lib/product.ts:13-15` | nodal 은 `workflowCdpPorts: []` |
| 기본 Copilot 모드 · 모드 집합 | `PRODUCT.features.defaultCopilotMode`, `copilotModes` | `src/hooks/useCopilotChat.ts:30,37` | twixy `['simple','wf','content']` / nodal `['video']` |
| **모드별 에이전트 + body 조립 전체** | `getProductCopilotMode(mode)` | `src/lib/copilotModes.ts:32-56`, 사용 `useCopilotChat.ts:619, 705-714` | nodal 만 등록 (`products/nodal/renderer/videoMode.tsx`) |
| 툴 정책(권한) | `features.{subagents,browser,cron,bridgeTools,toolsDeny,builtinMcp}` | `electron/main.ts:1191-1229, 1050` | nodal 은 exec/web/이미지생성 전부 deny |
| SOUL 씨앗 폴더 | `PRODUCT.workspaceSeedDir` | `electron/main.ts:1353` | twixy `''` / nodal `products/nodal/workspace-seed` |
| 워크스페이스 레이아웃 · designated paths | `PRODUCT.workspaceDirs`, `designatedPaths` | `profile.ts` | 완전히 다름 |
| 워크플로 기능 자체 | `PRODUCT.features.workflows` | `profile.ts` | nodal `false` |
| Supabase 프로젝트 · webUrl · 브랜딩 | `PRODUCT.supabase` 등 | `profile.ts` | 계정·과금 분리 |

### 2.2 공통 (= Harness·Agent 후보) — 두 제품에서 **문자 그대로 같은 코드가 돈다**

| 무엇 | 근거 |
|---|---|
| **게이트웨이 핸드셰이크 · RPC · 이벤트 fan-out** | `src/lib/gateway/controlUiTransport.ts` — `PRODUCT` 참조 0건. 이미 추출돼 7개 훅이 공유 중 (`3cbe89e`). **이건 Engine 쪽(transport)이고 이미 한 곳이다 — 손댈 일 없음.** |
| **세션 생성** | `src/lib/gateway/sessionClient.ts:7-10` `createSession(transport, params)` — `PRODUCT` 참조 0건 |
| **턴 완료 판정 프로토콜** (`chat` / `start\|final\|error`) | 4개 훅이 같은 모양을 각자 구현. 게이트웨이 프로토콜이라 제품 무관 |
| **SOUL 을 첫 메시지에만 `soul\n\n---\n\n${body}` 로 한 번 붙이는 규칙** | 4곳 동일 (§1.2). 붙이는 *텍스트*만 다름 |
| **노드 루프** (순차 실행, 비용/시간 delta, 실패 시 중단, review 노드 처리) | `useWorkflowTest.ts` 와 `runWorkflowNodes.ts` 가 같은 정책의 두 사본 |
| **usage delta 계산** (`extractTotals`/`pickNum`/`nonNegDelta` + 6×500ms 폴링) | `runWorkflowNodes.ts:130-164` 가 `useWorkflowTest.ts:162-182` 의 사본이라고 주석이 명시 |
| **노드 프롬프트 형식** | 사본 3개 (§1.1) |
| **하네스 preamble 게이트** | `runnerHarness.ts` — `PRODUCT` 참조 0건 |
| **tool 카탈로그 → 브리지툴 매핑 + 게이트키퍼** | `workflowTools.ts` — `PRODUCT` 참조 0건 |

→ **이 표에서 transport·세션생성을 뺀 나머지가 떼어낼 Harness 와 Agent 다.**
노드 루프·usage delta·turn 완료 판정 = Harness. 프롬프트 형식·SOUL 주입 규칙·tool 카탈로그 = Agent.
transport 만 한 곳에 있고, 나머지는 2~3 사본으로 흩어져 있다.

---

## 3. 제안하는 모듈 경계

### 3.1 이 코드베이스에서 Engine / Harness / Agent 는 무엇인가

| 층 | 소유하는 것 | 소유하지 않는 것 |
|---|---|---|
| **Engine** — *AI 런타임* | openclaw 프로세스 자체, 그걸 띄우고 죽이는 main 수명주기(`electron/main.ts`), openclaw.json 설정·모델 키 핸드아웃·툴 권한(`main.ts:1191-1229`), 워크스페이스 SOUL 씨앗(`main.ts:1349-1357`), transport(`src/lib/gateway/*`) | 턴 정책, 프롬프트 문구, 노드 시퀀스 |
| **Harness** — *어떻게 모는가* | 턴 루프(보내고 → final 대기 → 성공 판정), timeout, retry/슬라이스 사다리, abort, 노드 시퀀싱, 비용/시간 delta 집계, SOUL 을 **언제** 주입할지(첫 턴 1회) | 프롬프트 문구, 어떤 SOUL 인지, WS 프레임 모양, 어디에 저장하는지, openclaw 를 어떻게 띄우는지 |
| **Agent** — *누가 말하는가* | SOUL/프롬프트 텍스트 조립(`getXSoul`, `buildNodePrompt`), tool 카탈로그와 브리지툴 문구, `NODE_STATUS` 같은 프로토콜 문자열, `agentId`, Copilot 모드 | 전송, 재시도, 영속화, 노드 순서 |
| *(주입되는 포트)* | Harness 가 바깥과 닿는 구멍: send·session·usage·run기록. 구현은 훅/IPC/Engine 이 채운다 | 스스로는 아무 정책도 없다 |

### 3.2 위치

초판은 이 폴더를 `src/lib/engine/` 이라 불렀다. 이 어휘에서 그 이름은 **openclaw 를 가리키게 되므로 쓰면 안 된다.**

```
src/lib/harness/           ← 신규. React·window.twixy·PRODUCT 를 쓰지 않는 순수 TS.
  nodeRun.ts               노드 시퀀스 + 턴 정책 (두 러너의 합류점)
  usage.ts                 usage delta + 정산 폴링
  ports.ts                 주입되는 의존성의 타입 (구현 없음)
src/lib/nodeStatus.ts      ← 이미 있다. Agent: NODE_STATUS 프로토콜 정본.
src/lib/*Soul.ts           ← Agent 텍스트. 그대로 둔다 (제품이 아니라 *모드* 별이므로).
src/lib/gateway/           ← 이미 있다. Engine 쪽 transport. 그대로 둔다.
```

**순수 TS 제약은 취향이 아니다.** 서버/씬클라이언트 계획에서 이 루프가 Electron 밖에서 돌아야 하고,
훅은 옮길 수 없다. React·`window.twixy`·`PRODUCT` 중 하나라도 import 하는 순간 그 길이 막힌다.
`PRODUCT` 금지는 `scripts/check-product-boundary.mjs` 에 규칙 한 줄로 기계화할 수 있다.

### 3.3 공개 표면 (구체 시그니처)

```ts
// src/lib/harness/ports.ts — 주입되는 의존성. 전부 이미 존재하는 모양이다.

/** 한 세션에 텍스트를 보내고 turn final 까지 기다린다. */
export interface SendPort {
  (sessionKey: string, text: string, opts?: { timeoutMs?: number; model?: string }):
    Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
}
//  ↑ 새로 짓는 모양이 아니다. `OrchestrationGateway.send` (src/hooks/useOrchestrationGateway.ts:34)
//    가 이미 **글자 그대로 이 시그니처**다. runWorkflowNodes.MemberSendFn
//    (src/lib/runWorkflowNodes.ts:18-21) 은 여기서 sessionKey 만 빠진 형태다.

export interface SessionPort { create(agentId: string): Promise<string>; cancel(key: string): Promise<void> }
export interface UsagePort   { (): Promise<{ totals: Record<string, number> } | null> }
export interface HistoryPort {
  appendRun(wfId: string, entry: RunHistoryEntry): Promise<void>
  saveDetail(wfId: string, detail: TwixyRunDetail): Promise<void>
}

// ── Harness ────────────────────────────────────────────────────────────────
// src/lib/harness/nodeRun.ts — 턴 정책

export interface TurnPolicy {
  timeoutMs: number
  /** 재시도마다 프롬프트에 덧붙일 문구. null 반환 = 더 안 함. 슬라이스 사다리가 이 형태다. */
  retryNote?: (attempt: number, lastError: string) => string | null
  /** 응답 본문으로 성공/실패를 판정. null = 성공. NODE_STATUS 센티넬이 이 형태다. */
  verify?: (text: string) => string | null
  /** 취소 후 게이트웨이가 정리할 시간. 현재 1500ms. */
  drainMs?: number
}

export interface TurnResult {
  text: string; toolCalls: Array<{ name: string; detail?: string }>
  attempts: number; startedAt: number; endedAt: number
}

/** 한 턴: 보내고 · final 대기 · verify · 실패 시 retryNote 로 재시도 · abort 존중. */
export function runTurn(
  send: SendPort, sessionKey: string, prompt: string,
  policy: TurnPolicy, abort: { aborted: boolean },
): Promise<TurnResult>

// src/lib/harness/nodeRun.ts — 노드 시퀀스 (runWorkflowNodes 를 승격)

export interface NodeRunDeps {
  send: SendPort; sessionKey: string
  usage: UsagePort
  abort: { aborted: boolean }
  onNode?: (nodeId: string, metrics: NodeRunMetrics) => void
  reviewMode?: 'auto-approve' | 'auto-skip' | 'human'   // 'human' = 콜백으로 사람에게 물음
  onReview?: (node: TwixyWorkflowNode) => Promise<'approve' | 'skip' | 'abort'>
  preamble?: string
  resumeFrom?: { startIndex: number; preserved: Record<string, NodeRunMetrics> }
  policy?: Partial<TurnPolicy>
}

export function runWorkflow(
  workflow: TwixyWorkflow, inputs: Record<string, string>, deps: NodeRunDeps,
): Promise<RunWorkflowResult>   // 기존 src/lib/runWorkflowNodes.ts:32-39 타입 그대로

// src/lib/harness/usage.ts
export function usageDelta(prev: UsageTotals, cur: UsageTotals): { usd: number; tokensIn: number; tokensOut: number }
export function settledUsage(usage: UsagePort, prev: UsageTotals, attempts?: number, intervalMs?: number): Promise<UsageTotals>

// ── Agent ──────────────────────────────────────────────────────────────────
// 프롬프트 빌더 합류는 Harness 통합과 별건이다 (Agent 쪽) — 사본 3개의 단일 정본

export interface NodePromptCtx {
  workflow: TwixyWorkflow; node: TwixyWorkflowNode
  inputs: Record<string, string>
  isFirst: boolean
  preamble?: string          // 상류 멤버 출력 (orchestration)
  resumeRecap?: string       // Resume 복기 (test run)
  harness?: string           // runnerHarnessPreamble() 결과. 주입은 호출자가 결정.
  attachments?: string       // 추출된 바이너리 문서 텍스트
  slotProfile?: string       // 병렬 슬롯 브라우저 프로필
  requireNodeStatus?: boolean // NODE_STATUS 프로토콜 footer 를 요구할지
}
export function buildNodePrompt(ctx: NodePromptCtx): string
```

**`soulOnce` 는 만들지 않는다.** 네 훅이 `soulSentRef` 한 줄로 이미 하고 있고, 래퍼를 씌워도 줄 수가 줄지 않는다. SOUL 주입은 "첫 턴 한 번" 이라는 *규칙*만 문서화하고 현재 구현을 유지한다.
`AgentDef` 인터페이스도 만들지 않는다 — 구현이 `agentId: string` 하나뿐이다.

---

## 4. 첫 세 번의 기계적 이동

⚠️ **전제: `buildNodePrompt` 를 덮는 테스트가 지금 하나도 없다.** (`grep -rln "runWorkflowNodes|buildNodePrompt" --include=*.test.ts src` → 0건.)
그래서 1번은 "옮기기" 가 아니라 "옮길 수 있게 만들기" 다. 이걸 건너뛰면 프롬프트 문구가 조용히 바뀌어도 아무도 모른다.

**진행 상황 (2026-09-21):** Move 1 완료(`ca3e145`). Move 2·3 은 Harness 통합(§3.2 `src/lib/harness/`)으로 합쳐 진행한다.

### Move 1 — `buildNodePrompt` 특성화(characterization) 테스트를 먼저 쓴다 · 코드 이동 0

- **하는 일**: `src/lib/runWorkflowNodes.ts` 의 `buildNodePrompt` 를 `export` 로 바꾸고 (그 한 글자가 프로덕션 변경의 전부), `src/hooks/useWorkflowTest.ts` 의 것도 `export`. 대표 워크플로 3종(첫 노드 / bridge tool 있는 노드 / validation 노드) × 두 사본의 출력을 골든 문자열로 고정.
- **여기서 드러날 것**: 두 사본의 diff 가 테스트로 박제된다. 지금은 주석으로만 경고돼 있다.
- **검증**: 신규 `src/lib/runWorkflowNodes.test.ts` + `src/hooks/useWorkflowTest.prompt.test.ts`. 기존 `npx vitest run` 559 tests 그대로 green.
- **위험**: 없음. `export` 추가는 번들에 영향 없음.

### Move 2 — `buildNodePrompt` 단일 정본으로 합류 (Agent 쪽)

- **하는 일**: Move 1 의 골든이 통과하는 단일 함수를 만들고, 두 호출부를 `NodePromptCtx` 로 어댑트. 두 사본 삭제. `scripts/wf-eval.mjs` 는 **이번엔 건드리지 않는다** (ESM/`?raw` 때문에 별건 — §5).
- **검증**: Move 1 의 골든 테스트가 그대로 통과해야 한다. 추가로 `src/lib/workflowTools.test.ts` (bridge tool 매핑), `npx tsc -p tsconfig.json --noEmit`.
- **위험**: 두 사본이 다르므로 **합치는 순간 한쪽의 프롬프트가 바뀐다**. → §5 참조. 합치지 말고 `requireNodeStatus` / `preamble` 플래그로 차이를 **명시적 파라미터화**해서 두 호출부의 출력이 골든과 바이트 단위로 같게 유지한다. 동작 변경은 별도 결정 사항.

### Move 3 — `runWorkflowNodes.ts` → `src/lib/harness/nodeRun.ts` + `usage.ts` 로 승격, usage 사본 제거

- **하는 일**: 파일 이동 + `MemberSendFn` → `SendPort`(sessionKey 추가). `extractTotals`/`pickNum`/`nonNegDelta`/`fetchUsageWithRetry` 를 `harness/usage.ts` 로 빼고, `useWorkflowTest.ts:162-182` 가 그걸 import 하게 한다 (사본 1개 제거).
- **검증**: Move 1 의 골든 + 기존 `src/hooks/useWorkflowTestSession.test.ts`, `src/hooks/useOrchestrationGateway.test.ts`. usage 헬퍼는 순수 함수라 신규 단위 테스트 한 파일이 싸다.
- **위험**: 낮음. `runWorkflowNodes` 의 **런타임 호출부는 `src/hooks/useOrchestrationRun.ts:122` 딱 하나**다 (`src/lib/orchestrationPatterns/types.ts:8` 은 타입 import 뿐). 다만 그 한 곳이 `src/hooks/*` 라 Track A 와 한 줄 겹친다.

**여기서 멈춘다.** Move 4 이후(턴 루프 통합, `runTurn` 추출)는 `useWorkflowTest.ts` 의 React state 와 슬라이스 사다리를 건드리므로 Track A 와 충돌한다(§5.2).

---

## 5. 동작 변경 없이는 못 옮기는 것 / Track A 충돌

### 5.1 옮기면 동작이 바뀌는 것 — **결정이 필요하다**

| # | 무엇 | 지금 | 합치면 |
|---|---|---|---|
| 1 | ~~**`NODE_STATUS` 센티넬**~~ **결정·반영 완료** | 양쪽 다 요구·검사 (`src/lib/nodeStatus.ts` 공유) | ✅ 2026-09 `230d1b2` — 사용자가 strict 로 통일 선택. 멈춤 방식은 Test run 의 `markRemainingAborted` 가 아니라 **기존 throw 경로와 동일**(실패 노드만 보고 후 즉시 반환): 멤버 사이 정책은 패턴이 이미 갖고 있다. 슬라이스 재시도 사다리(#2)는 범위 밖으로 남음 |
| 2 | **슬라이스 재시도 사다리** | Test run 만 있음 (최대 3회, 9분×4 = 최악 36분) | Orchestration 에 적용하면 워크플로 하나가 지금보다 4배 오래 걸릴 수 있다. 비용도 |
| 3 | **review 노드** | Test run = 사람이 누름 / Orchestration = auto-approve | `reviewMode: 'human'` 로 통합하려면 콜백 계약이 필요. 잘못 합치면 무인 실행이 멈춘다 |
| 4 | **`preamble` (상류 체이닝)** | Orchestration 만 | Test run 에 들어가도 무해(빈 문자열)하지만 프롬프트 바이트가 바뀜 → A/B 기준선(`runnerHarness.ts:7`, v3 8.3 vs 6.95)이 무효화 |
| 5 | **`scripts/wf-eval.mjs`** | `.mjs`, `?raw` import 불가, `WORKFLOW_RUNNER_V3_SOUL.md` 를 자기가 읽음 | Harness 모듈을 그대로 못 쓴다. `harness/` 를 빌드 산출물로 내보내거나 eval 을 `tsx` 로 바꿔야 한다 — 별도 과제 |
| 6 | **SOUL 경로 A/B 통합** (§0.2) | Twixy 는 prepend, Nodal 은 워크스페이스 파일 | 하나로 통일하면 **두 제품 중 하나의 시스템 프롬프트가 통째로 바뀐다**. 통일하지 말 것 — 경로 B 는 Engine 이 이미 하고 있는 일이다 |
| 7 | **툴 정책 vs 프롬프트 카탈로그 정합성 검사** (§1.5) | 검사 없음 | 검사를 넣으면 지금 deny 된 툴을 프롬프트가 권하는 케이스가 에러로 뜬다. 고칠 가치는 있으나 별건 |

### 5.2 Track A (`src/hooks/*`) 와 충돌하는 지점

Track A 가 방금 7개 훅을 `controlUiTransport` 로 옮겼다 (`3cbe89e`). 그 작업과 겹치는 파일:

| 파일 | Track C 가 건드려야 하는 것 | 충돌 정도 |
|---|---|---|
| `src/hooks/useWorkflowTest.ts` | Move 1 의 `export` 한 줄, Move 3 의 usage import 한 줄 | **낮음** — 둘 다 한 줄. 단 Move 4 이후(턴 루프)는 `579-613` 재시도 루프를 통째로 들어내므로 **높음** |
| `src/hooks/useWorkflowTestSession.ts` | `sendAndAwaitFinal` 을 `SendPort` 로 노출 | **중간** — transport 마이그레이션 직후라 이 파일이 가장 최근에 움직였다 |
| `src/hooks/useOpenClaw.ts` | **transport 로 아직 안 옮겨졌다.** 자체 WS·핸드셰이크·pendingRpc·backoff 를 그대로 갖고 있다 (`689-753`, `514-534`, `1225-1252`) | Track A 의 미완 작업. Track C 는 손대지 않는다 |
| `src/hooks/useCopilotChat.ts` | 제품 모드 분기(`705-777`)는 Agent 쪽이고 Track A 소유 — Track C 이동 대상 아님 | 없음 |

**제안**: Move 1~3 은 `src/lib/*` 안에서 끝나고 `src/hooks/*` 에는 각각 한 줄만 닿는다. 그 세 번은 Track A 와 병행 가능하다. Move 4(턴 루프) 부터는 Track A 의 훅 작업이 끝난 뒤 순차로.

### 5.3 이번에 읽지 않아 확인 못 한 것 (추론 표기)

- main 의 Supabase 쓰기 경로 — 실행 기록이 최종적으로 어디 가는지 (`window.twixy.recordOpenRouterUsage` 의 main 쪽 구현).
- `useWorkflowTest.ts:1006-1038` 의 `NODE_STATUS` footer 정확한 문구 — Move 1 의 골든 테스트가 어차피 박제한다.
- `src/lib/orchestrationPatterns/` 의 전략 구현체들 — `RunWorkflowResult` 를 타입으로만 쓰므로 Move 3 의 영향은 없다고 봤으나, 각 전략이 `deps` 를 어떻게 조립하는지는 안 읽었다.
