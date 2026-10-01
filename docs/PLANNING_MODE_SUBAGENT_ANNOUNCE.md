# Planning Mode에서 Subagent Announce를 차단하는 법

> **한 줄 요약**: Plan이 실패해도 비동기 subagent가 뒤늦게 끝나면서 `subagent_announce` 이벤트를 쏘고, 이게 main 세션의 LLM을 자동으로 깨워서 계속 실행시키는 문제가 있었다. React 레이어에서 막으려는 모든 시도가 race로 실패했고, 최종적으로 **gateway에 module-level Set을 추가해서 특정 requester 세션에 대한 announce를 무조건 drop하는 구조**로 해결했다.

---

## 1. 문제 상황

### 증상

Plan mode로 작업을 돌리다가 한 step이 실패하면, "Plan stopped — Step N failed" 메시지가 뜨고 멈춰야 한다. 그런데 실제로는:

1. Verify가 `RESULT: NO`를 리턴해서 plan을 중단시킨다.
2. `sendAndAwaitFinal`이 리턴되고, 코드 흐름상 끝났다고 표시된다.
3. **30초~2분 뒤**, 갑자기 main LLM이 혼자 깨어나서 실행을 재개한다.
4. 존재하지 않는 파일을 읽으려 하거나, 새 subagent를 스폰하거나, 엉뚱한 툴 콜을 돌린다.

유저 입장에선 "Plan stopped"라고 말해놓고 LLM이 계속 떠드는 걸로 보인다.

### 왜 중요한가

- 비용 낭비 (중단돼야 할 LLM이 계속 돈다)
- 사이드이펙트 위험 (파일 쓰기, 툴 실행 등이 계속 일어남)
- 유저 신뢰 손상 ("stop"이 stop 아님)

### 근본 원인

OpenClaw의 subagent는 **비동기**로 실행된다. `sessions_spawn(mode: "run")`을 호출하면 main LLM은 2초 내에 tool_result를 받고 턴을 끝낼 수 있지만, subagent는 그 뒤에도 계속 실행된다. 그 subagent가 나중에 완료/에러나면 gateway가 `subagent_announce` 이벤트를 쏘는데, 이 이벤트가 **main 세션키**에 주입되면서 main LLM을 autonomous하게 재실행시킨다.

즉 "step을 끝냈다"는 React 코드의 판단과 "subagent가 아직 돌고 있다"는 gateway의 실제 상태가 어긋나서 생기는 race였다.

---

## 2. 배경 지식

### 2.1 subagent lifecycle 이벤트의 runId 두 종류

같은 subagent라도 이벤트에 붙는 `runId`가 두 가지 형식이다:

| 형식 | 붙는 곳 | 위험도 |
|---|---|---|
| `announce:v1:agent:main:subagent:<child>:<uuid>` | **메인 세션키**에 붙음. `event: agent`, `stream: lifecycle` | **높음** — main LLM을 깨움 |
| plain UUID | subagent 자신의 세션키에 붙음 | 낮음 |

앞의 `announce:v1:...` runId가 메인 세션에 도착하면 gateway의 `runSubagentAnnounceFlow`가 main LLM을 새 턴으로 깨운다. 이게 바로 우리가 막아야 할 경로다.

### 2.2 `sessions.abort`는 subagent를 안 죽인다

이전에 "sessions.abort가 announce를 막는다"고 잘못 기록했던 것을 정정:

- `sessions.abort`는 현재 **chat run만** 중단시킨다.
- subagent의 `endedReason`은 여전히 `subagent-complete` 또는 `subagent-error`로 남는다.
- announce는 **그대로 송출**된다.

실제로 subagent를 kill하고 announce를 막으려면 `sessions.delete(key, {deleteTranscript: false})`를 호출해서:
```
cleanupSessionBeforeMutation
  → ensureSessionRuntimeCleanup
  → stopSubagentsForRequester
  → markSubagentRunTerminated({reason: "killed"})
```
여기까지 도달해야 `suppressAnnounceReason = "killed"`가 세팅되고, 그게 gateway의 announce suppress 조건이 된다.

참고 코드:
- `gateway-cli-CWpalJNJ.js:9315`
- `pi-embedded-BYdcxQ5A.js:17344`

### 2.3 `sessions_spawn mode: "run"`은 main을 block 안 함

- tool_result는 `{meta: "task prompt"}` 형태로 **2초 내 리턴**
- subagent는 백그라운드에서 비동기 실행
- main LLM이 명시적으로 기다리지 않으면 바로 턴 끝냄

즉 "mode: run이니까 wait한다"는 가정은 틀렸다. 이게 문제의 핵심 구조였다.

### 2.4 `sessions.changed` 이벤트의 실제 형식

문서와 실제가 다른 부분들:
- `sessions.changed reason: "create"` 이벤트의 `kind`는 **"direct"**이다. `"subagent"`가 아님. 따라서 `kind === 'subagent'` 필터는 절대 매칭 안 됨 → `sessionKey.includes(':subagent:')` 경로 검사로 감지해야 함.
- subagent 종료 시 `subagent-complete`/`subagent-error`/`killed` reason은 **절대 안 쏜다**. 실제로는 `phase: "end"` (reason 필드 없음)만 나옴 → `isEndReason` 판정에 `phaseVal === 'end' || 'error'`를 포함시켜야 ref에서 제거됨.

### 2.5 runId 키 혼용 주의

React에서 `subagentSessionsRef`로 subagent를 tracking할 때, 같은 Map에 두 종류의 키가 들어간다:
- `sessions.changed reason: "create"` 핸들러 → 세션키 (`agent:main:subagent:<uuid>`)
- `agent` lifecycle 핸들러 → runId (`announce:v1:...`)

kill할 때 `k.startsWith('agent:') && k.includes(':subagent:')` 필터를 써서 세션키 엔트리만 골라내야 한다.

---

## 3. 실패한 접근들 (교훈)

### 3.1 React 레이어 방어선의 한계

다음을 전부 시도했다:
1. Step 경계마다 `killActiveSubagents()` + `setRejectNewRuns(true)` 호출
2. `subagentSessionsRef`로 subagent tracking
3. `chat.final` 핸들러에서 ref bulk-clear
4. Plan 실패 시 interceptor로 `sessions.abort` 쏘기

**전부 race 때문에 실패했다.** 특히:
- Provider 에러(OpenRouter, Gemini 등)로 subagent가 step 경계 **이전**에 먼저 죽는 경우
- gateway의 `completeSubagentRun`이 즉시 `startSubagentAnnounceCleanupFlow`를 호출
- 뒤늦게 도착한 React의 `sessions.delete`는 no-op

### 3.2 Gateway 3곳 패치 (1차 해결, 여전히 race 있음)

`patches/openclaw+2026.4.2.patch`로 gateway 소스를 3곳 고쳤다:

1. **`pi-embedded-BYdcxQ5A.js` `markSubagentRunTerminated`**: `if (typeof entry.endedAt === "number") continue;` 가드를 뚫어서 이미 종료된 entry에도 `suppressAnnounceReason="killed"` 세팅 (단, `cleanupCompletedAt` 전에만).
2. **`pi-embedded-BYdcxQ5A.js` `runSubagentAnnounceFlow`**: module-level `subagentRuns` Map을 `childRunId`로 조회해서 `suppressAnnounceReason === "killed"`면 두 지점에서 `return false`.
3. **`abort-CNknHetJ.js` `stopSubagentsForRequester`**: `if (!run.endedAt)` 가드에 `else` 브랜치 추가, ended entry에도 `markSubagentRunTerminated({reason:"killed"})` 호출.

**핵심 통찰**: announce 차단의 진짜 병목은 gateway의 `markSubagentRunTerminated`가 "이미 ended"된 subagent를 무시한다는 것. provider-error 경로에서 항상 이 조건이 걸리므로 React 방어선은 원천적으로 효과 없음.

### 3.3 그래도 남은 race

위 패치로 많이 좋아졌지만, 여전히 한 가지 race가 있었다:
- `markSubagentRunTerminated`로 `suppressAnnounceReason="killed"` 세팅
- 직후 `completeSubagentRun` L17069가 `subagent-complete` 이벤트 처리하면서 그 플래그를 **un-set**
- 결국 announce가 뚫고 나감

이 race는 subagent 자신의 lifecycle과 결합돼있어서 subagent state에 의존하는 한 피할 수 없다는 결론.

---

## 4. 최종 해결: Requester-Level Freeze

### 4.1 핵심 아이디어

**Subagent state와 완전히 독립적인 차단 레이어를 추가한다.** Subagent가 이미 끝났든, 에러났든, 살아있든, 상관없이 특정 requester 세션으로 향하는 announce를 **모조리 drop**하는 module-level Set을 둔다.

### 4.2 아키텍처

```
┌──────────────────────────────────────────────────────────────────┐
│ React (useOpenClaw.ts)                                            │
│                                                                   │
│  usePlans.ts 가 plan-fail 감지                                     │
│       ↓                                                           │
│  deps.setRequesterAnnounceFrozen(true)                            │
│       ↓                                                           │
│  rpc('twixy.freezeRequesterAnnounce', {key, frozen: true})        │
└─────────────┬─────────────────────────────────────────────────────┘
              │ WebSocket RPC
              ↓
┌──────────────────────────────────────────────────────────────────┐
│ Gateway (pi-embedded-BYdcxQ5A.js)                                 │
│                                                                   │
│  module-level: frozenAnnounceRequesters: Set<string>              │
│                                                                   │
│  runSubagentAnnounceFlow(params):                                 │
│    [gate 1 — 진입 직후]                                            │
│      if (isRequesterAnnounceFrozen(params.requesterSessionKey))   │
│        return false;                                              │
│                                                                   │
│    ...target resolution...                                        │
│                                                                   │
│    [gate 2 — delivery 직전]                                        │
│      if (isRequesterAnnounceFrozen(targetRequesterSessionKey))    │
│        return false;                                              │
└──────────────────────────────────────────────────────────────────┘
```

이 구조가 중요한 이유:
- **Subagent lifecycle 이벤트와 무관** — subagent가 뭘 하든 gate가 먼저 체크
- **Race-free** — `completeSubagentRun`의 un-set 로직이 건드릴 수 없음
- **Freeze는 명시적 해제 전까지 유지** — 유저가 새 입력 보낼 때(`sendMessage`)만 자동으로 풀림

### 4.3 구현 세 레이어

**(1) Gateway 패치 — `pi-embedded-BYdcxQ5A.js`**

`runSubagentAnnounceFlow` 직전에 module-level 상태와 helper 함수 3개 추가:
```js
const frozenAnnounceRequesters = new Set();
function freezeRequesterAnnounce(sessionKey)   { /* add */ }
function unfreezeRequesterAnnounce(sessionKey) { /* delete */ }
function isRequesterAnnounceFrozen(sessionKey) { /* has */ }
```

그리고 `runSubagentAnnounceFlow` 내부 두 지점에서 gate:
- L11468 (진입 직후, `try` 블록 전): `params.requesterSessionKey`만 체크
- L11632 (fallback resolution 후): `params.requesterSessionKey` + `targetRequesterSessionKey` 둘 다 체크

**주의**: 첫 번째 gate에서 `targetRequesterSessionKey`를 참조하면 `ReferenceError`로 gateway가 crash한다. 그 변수는 try 블록 안에서만 선언되기 때문.

**(2) WS RPC — `gateway-cli-CWpalJNJ.js`**

새 RPC `twixy.freezeRequesterAnnounce`를 세 곳에 등록:
- `sessionsHandlers` 객체에 핸들러 구현
- `BASE_METHODS` allowlist에 method 이름 추가
- 파일 상단 import에 pi-embedded의 freeze 함수들 가져오기

scope는 따로 안 적어도 됨 — `useOpenClaw`가 이미 `operator.admin` scope를 가지고 있어서 admin bypass.

**(3) React 배선 — `useOpenClaw.ts` + `usePlans.ts` + `App.tsx`**

- `useOpenClaw.setRequesterAnnounceFrozen(frozen: boolean)` helper 추가
- `useOpenClaw.sendMessage` 맨 앞에 **auto-unfreeze** 삽입: `rpc('twixy.freezeRequesterAnnounce', {key, frozen: false}, 5000).catch(() => {})`
- `usePlans`의 plan-fail 블록(`status === 'failed' || 'interrupted'`)에서 `await deps.setRequesterAnnounceFrozen(true)` 호출
- `App.tsx`에서 `PlanRunnerDeps`로 주입

**`sendAndAwaitFinal`에는 unfreeze를 절대 넣지 않는다.** 이유는 §5.1 참고.

### 4.4 Freeze semantic: drop이지 queue가 아님

Freeze 중 들어온 announce는 **영구적으로 버려진다**. 큐에 쌓였다가 unfreeze 시 쏟아지지 않는다.

내부 동작:
```
runSubagentAnnounceFlow → gate에서 return false
  → didAnnounce = false
  → finalizeAnnounceCleanup(false)
  → beginSubagentCleanup 은 one-shot이라 재진입 불가
```

한 번 drop된 announce는 unfreeze해도 재시도되지 않음. 유저가 다음 메시지를 보내도 "쌓였던 반응이 쏟아지는" 일은 없음 — 이건 의도된 설계.

---

## 5. 운영 규칙 — 앞으로 조심할 것

### 5.1 `sendAndAwaitFinal`에 unfreeze 절대 넣지 말 것

`useOpenClaw.ts` L1350의 `sendAndAwaitFinal`는 plan-mode step 실행, verify, outcome, planner 등에서 **광범위하게** 쓰인다. 여기에 unfreeze를 넣으면:

- Plan-fail 직후 `addSystemMessage("Plan stopped")`가 뜨기 전에 다른 sendAndAwaitFinal이 어디서든 발사되면 freeze가 즉시 풀려서 방어선이 무너진다.
- 구현 중 한 번 실수로 넣었다가 바로 제거했다. 다시 넣지 말 것.

**원칙: freeze를 푸는 건 오직 유저 입력(`sendMessage`)뿐이다.**

### 5.2 ⚠️ Latent bug: `resumePlan`이 freeze 해제 안 함

확인된 latent bug:

```ts
// App.tsx:298
if (action.actionId === 'plan-resume' && action.planId) {
  openclaw.setRejectNewRuns(false)
  plans.resumePlan(action.planId)  // ← sendMessage를 우회함
}
```

`resumePlan → runFromCurrent → sendAndAwaitFinal` 경로를 타므로, 유저가 "Try again" 버튼을 눌러도 freeze는 true로 유지된다.

**왜 실제 오동작이 안 보이는가**: 현재 plan-mode step 의미론상 subagent announce에 의존하지 않는다.
- Main LLM이 `[step-done]` 쓰고 턴 종료 → `chat.final` 발사 → sendAndAwaitFinal 정상 resolve (freeze는 chat.final에 영향 없음)
- 비동기 subagent의 announce는 어차피 원치 않는 wake-up이라 drop되는 게 맞음

**수정 방향** (미래에 필요하면):
```ts
if (action.actionId === 'plan-resume' && action.planId) {
  openclaw.setRejectNewRuns(false)
  await openclaw.setRequesterAnnounceFrozen(false)  // ← 추가
  plans.resumePlan(action.planId)
}
```
또는 `resumePlan` 내부 진입점에서 unfreeze.

**지금 안 고친 이유**: 실질적 오동작이 관찰되지 않아 변경 범위 최소화. 하지만 구조적으로는 잘못됐으므로 언젠가 고치는 게 맞음.

### 5.3 Dashboard는 완전히 격리됨

`useDashboardClaw`는 자체 `sessions.create`로 **별도 세션키**를 만든다 (`useDashboardClaw.ts:133`). 따라서:
- Main 세션의 freeze는 dashboard 세션에 영향 0
- Main plan-fail 중에 dashboard 위젯 요청해도 정상 렌더
- Dashboard에 freeze 도입 필요 없음 (위젯 요청은 one-shot request/response 패턴)

### 5.4 외부 트리거는 반드시 `sendMessage` 거치게

현재 잘 지켜지고 있는 예:
- `window.twixy.onOverlaySend` → `sendMessage(text)` (`App.tsx:252`)

**규칙**: 앞으로 추가할 "유저 의도 입력" 트리거(사이드탭, 딥링크, 핫키, 자동 트리거 등)는 반드시 `sendMessage`를 거치게 한다. 직접 `rpc('sessions.send', ...)`나 `sendAndAwaitFinal`을 부르면 freeze 상태에 갇힌 세션에서 subagent announce가 계속 drop된다.

### 5.5 Background/cron 트리거 없음 (전수조사)

현재 앱에는 자동으로 LLM을 깨우는 `setInterval`/`setTimeout`/cron이 **없다**:
- `DashboardPanel.tsx:849` — 6초 데이터 sync (LLM 호출 없음)
- `SettingsPanel.tsx:92` — 60초 usage label 갱신 (LLM 호출 없음)
- `ChatPanel.tsx:566`, `SidetabOverlay.tsx:289` — UI tick counter

향후 자동 트리거(예: "5분마다 알림 체크", "앱 포커스 시 auto-summary")를 추가할 때:
- Main 세션키를 공유한다면 freeze 기간 중 drop될 가능성을 인지
- 격리가 필요하면 dashboard처럼 별도 `sessions.create`로 session 생성

### 5.6 두 방어선 모두 유지할 것

비슷해 보이는 두 개를 혼동하지 말고 둘 다 유지:

| 방어선 | 레이어 | 특성 |
|---|---|---|
| `setRejectNewRuns(true)` | React (`useOpenClaw.ts:626`의 interceptor) | announce 도착 시 `sessions.abort` 쏨. Subagent state에 의존적. Race 가능. |
| `setRequesterAnnounceFrozen(true)` | Gateway (module-level Set) | `runSubagentAnnounceFlow` 진입 자체를 차단. Subagent state 무관. Race-free. |

Freeze는 근본 해결, rejectNewRuns는 빠른 피드백(announce가 gateway에서 drop되기 전에 React가 먼저 알아챌 때). 어느 하나만으로 안전하다고 판단해서 제거하지 말 것.

### 5.7 Freeze는 `sendAndAwaitFinal`/`chat.final`에 영향 없음 (오해 금지)

자주 혼동되는 부분:
- Freeze는 **subagent_announce 이벤트만** 차단한다.
- Main LLM의 정상 실행/`chat.final`/`sessions.send`는 그대로 동작한다.
- 따라서 freeze=true 상태에서도 `sendAndAwaitFinal`은 정상적으로 main LLM 턴을 돌리고 결과를 받아온다.

유일하게 영향받는 경로:
- `sessions_spawn(mode: "run")` → 비동기 subagent → 종료 후 main 세션에 autonomous wake-up 이벤트 주입

`mode: "await"` (동기) subagent는 tool_result로 결과 받으니 freeze 중에도 정상 동작.

### 5.8 Gateway 재시작 시 freeze Set 소실

`frozenAnnounceRequesters`는 module-level Set이라 gateway 프로세스가 재시작되면 전부 사라진다. 영속화 안 됨.

- **장점**: crash recovery 시 좀비 freeze가 남지 않음
- **주의사항**: plan-fail 직후 gateway가 죽으면 freeze 풀린 상태로 부팅됨. 하지만 실제론 문제 안 됨 — gateway 재시작 중에는 WS 연결이 끊기므로 React가 먼저 reconnect해서 새 세션을 만들기 때문.

---

## 6. 코드 위치 레퍼런스

### Gateway (node_modules 안, patch로 유지)
- `pi-embedded-BYdcxQ5A.js` — freeze Set과 helper 함수 추가, `runSubagentAnnounceFlow`의 두 gate
- `gateway-cli-CWpalJNJ.js` — `twixy.freezeRequesterAnnounce` RPC 핸들러, `BASE_METHODS` 등록
- `abort-CNknHetJ.js` — `stopSubagentsForRequester`의 ended entry 처리

### React
- `src/hooks/useOpenClaw.ts` L1473 — `setRequesterAnnounceFrozen` helper
- `src/hooks/useOpenClaw.ts` L1117 — `sendMessage` 내 auto-unfreeze
- `src/hooks/usePlans.ts` L583 — plan-fail 시 freeze(true) 호출
- `src/App.tsx` L90 — `PlanRunnerDeps`에 helper 주입

### 패치 파일
- `patches/openclaw+2026.4.2.patch` — `npx patch-package openclaw`로 재생성
- postinstall hook이 `npm install` 시 자동 적용

---

## 7. 부록: 디버깅 팁

### 7.1 Dev 빌드 재주의사항

- `npm run dev`는 vite만 띄운다. Electron은 별도.
- `NODE_ENV !== 'development'`이면 Electron이 `dist/index.html`(file://)을 로드하므로 vite 변경사항 반영 안 됨.
- 수정 후 `npx vite build` → Electron 창 재시작 필수.
- 검증: 빌드 타임스탬프 vs 로그 타임스탬프 비교.

### 7.2 로그에서 announce 경로 식별

좀비 autonomous wake-up을 감지하는 패턴:
- `runId: announce:v1:agent:main:subagent:<uuid>`가 **main 세션키**에 phase:start 이벤트로 도착하면 LLM이 자동 깨어남
- Plan "Plan stopped" 메시지 시각과 그 announce 도착 시각의 간격을 보면 얼마나 늦게 좀비가 깨어났는지 확인 가능
- 실제 예시(2026-04-21 23:53 세션): `[step-done]` 기록 95초 후 `announce:v1:agent:main:subagent:175d7d94-...` 발사 — 이게 typical한 race window

### 7.3 Freeze 동작 확인

Chrome DevTools에서 WS 트래픽 보면:
- Plan 실패 직후 `twixy.freezeRequesterAnnounce {key:<session>, frozen:true}` RPC가 나가야 함
- 유저가 새 메시지 보낼 때 `{frozen:false}`가 나가야 함
- 둘 다 `{ok: true, key, frozen: <state>}` 응답 받아야 함

### 7.4 Openclaw export alias 관례

pi-embedded의 export list는 minified alias(`as zt` 같은 1-2글자)를 쓰지만, full name alias(`as twixyFreezeRequesterAnnounce`)를 같이 붙여도 정상 동작한다. Minifier가 수정 부분을 건드리지 않아서 가능. 단, gateway-cli의 import 구문과 정확히 이름이 일치해야 함.
