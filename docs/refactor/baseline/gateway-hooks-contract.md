# 게이트웨이 훅 7개 — 세션 계약표 (A0) + A1 이전 기록

원래는 A1(공유 control-UI transport 추출) **전에** 각 훅이 어떻게 동작하는지 고정하려고 만든 문서다.
A1 이 끝난 지금은 **그 결과의 기록**이기도 하다 — 무엇이 보존됐고, 무엇을 알고 바꿨고, 어떤 결정을
누가 왜 내렸고, 무엇이 아직 티켓으로 남았는지.

- A0 기준 commit `10ae6b6`. 표의 줄번호는 **현재 코드 기준**이고, 옛 위치는 "기준 commit 줄번호" 로 표시했다.
- A0 은 정적 분석(코드 읽기)이었다. A1 의 동작 보존은 **훅별 특성화 테스트**로 확인했다 —
  이전 **전** 구현 위에서 먼저 통과시킨 뒤, 이전 후에도 같은 테스트가 그대로 통과하는 것으로.
- 경로는 `src/hooks/` 기준. 엔드포인트·핸드셰이크·RPC·프레임 demux 는 이제
  `src/lib/gateway/controlUiTransport.ts` 한 곳이다 (훅마다 선언하던 `WS_BASE` 는 없어졌다).

## 비교표

| 항목 | useOpenClaw (1948, **transport ✔**) | useCopilotChat (929, **transport ✔**) | useWorkflowTestSession (612, **transport ✔**) | useOrchestrationGateway (240, **transport ✔**) | useWorkflowClaw (209, **transport ✔**) | useDashboardClaw (200, **transport ✔**) | useOrchestrationClaw (149, **transport ✔**) |
|---|---|---|---|---|---|---|---|
| **연결 시점** | 마운트 +800ms (:1350), `openclaw-ready` IPC (:1293), 수동 (:1486) | 첫 send 때 lazy (:680) | 첫 send 때 lazy (:432) | **마운트 즉시** (:216) | 첫 send 때 lazy (:143) | 첫 request 때 lazy (:137), 겹친 요청은 직렬화 큐 (#9 수정) | 첫 send 때 lazy (:103) |
| **핸드셰이크 displayName / 토큰** | `Twixy` (:1185) / 토큰 try-catch 는 transport (#6 해소) | `Twixy Copilot` (:561) / 토큰 try-catch 는 transport | `Twixy Workflow Test` (:359) | `Twixy Orchestration` (:131) | `Twixy Workflow Builder` (:49) | `Twixy Dashboard` (:76) | `Twixy Orchestration Builder` (:39) |
| **agentId** | 없음(기본=main) | `builder` (3모드 전부, 제품 등록 모드는 그 모드의 agentId, :606) | `workflow-runner` (:399) | `workflow-runner` (:156) | `builder` (:112) | **없음** (:114) | `builder` (:85) |
| **세션 생성 시점** | 첫 send 때 lazy (:635) | conv×mode 별 lazy | workflowId 별 lazy + create-lock (:390) | **호출자가 `createSession()` 명시 호출** (:151) | **핸드셰이크 직후, 같은 lock 안에서** (:112) | 핸드셰이크 직후, 같은 lock 안에서 (:114) | 핸드셰이크 직후, 같은 lock 안에서 (:85) |
| **세션 수 / 복원** | 1개 / **디스크에 key 저장·복원** (:641, :1244) + 전역 `sessions.subscribe` (:646) | ≤3 LRU (:44, :574) / key 복원 없음 (transcript seed 로 재구성) | N개(상한 없음) / 없음 | N개 / 없음 | 1개 / transcript 만 디스크 | 1개 / 없음 | 1개 / transcript 만 디스크 |
| **SOUL 주입** | 클라 주입 없음 (URL 패딩만 :1459) | 모드별 3종 (:744/:756/:761), `Set<sessKey>` 로 추적 (:348) | 없음 (호출자가 프롬프트 조립) | 없음 | `getWorkflowSoul()` 첫 메시지 1회, bool ref (:38) | `DASHBOARD_PREFIX` **매 메시지** (:159) | `getOrchestrationSoul()` 1회, bool ref (:29) |
| **RPC 타임아웃** | 15s 기본, send 10분, 5/10s 변형 | **15s 고정 (send 포함)** | 15s 기본+인자, send 10분 | 15s 기본+인자, send 10분 | **15s 고정** | 15s + 별도 45s 응답 슬롯 (:144, send 시점부터) | **15s 고정** |
| **close 시 pending RPC** | 에러 프레임으로 **resolve** — transport 의 `ws_closed` 거절을 rpc 래퍼가 변환 (:516) | transport 가 즉시 reject (`Connection closed`) | transport 가 즉시 reject (`Connection closed`), awaiter 는 `ws_closed` (:262) | transport 가 즉시 reject (`Connection closed`), awaiter 는 `ws_closed` (:71) | transport 가 즉시 reject (`Connection closed`) | transport 가 즉시 reject + `pendingResponse` reject (:81) | transport 가 즉시 reject (`Connection closed`) |
| **재연결** | **자동** 8회/수동 3회, `min(1500·2^n, 12s)` (:1177), 게이트웨이 재시작 경로 (:1293) | 없음 (다음 send 때 lazy) | 없음 | 없음 | 없음 | 없음 | 없음 |
| **완료 판정** | `chat` final/error + 서브에이전트 지연 + 400ms/15s 타이머 (:772), awaiter 는 isThinking edge (:262) | `chat` final/error, conv 라우팅 (:464) | `chat` final/error + 10분 turn timeout (:286, :451) | `chat` final/error + 10분 turn timeout (:86, :168) | assistant 메시지 도착 (:75) + 내 세션의 `chat` final/error·close 에서 thinking 해제 (:63, #8 수정) | **첫 assistant 메시지**, 45s 상한 (:88) | assistant 메시지 도착 (:58) + 내 세션의 `chat` final/error·close 에서 thinking 해제 (:46, #8 수정) |
| **언마운트 정리** | `dispose()` + 타이머 + IPC 해제 (:1344) — 재연결 재무장 문제(#5) 해소. 세션은 **반납하지 않는다**(디스크 재개 설계) | transport `dispose()` + 살아 있던 연결이면 장부 리셋 (:581, #12 수정) | transport `dispose()` + 살아 있던 연결이면 장부 비움·awaiter `ws_closed` (:581) | transport `dispose()` + 살아 있던 연결이면 awaiter `ws_closed` (:233) | transport `dispose()` (:202, #12 수정) | `dispose()` + 대기 요청 reject (:189, #12 수정) | transport `dispose()` (:142, #12 수정) |

## 7개 전부 동일 — transport 로 추출해도 안전한 것

> A0 시점의 관찰이다. 아래는 전부 `controlUiTransport.ts` / `sessionClient.ts` 로 옮겨졌다.

- 엔드포인트 + 환경 가드 (`typeof window !== 'undefined' && !!window.twixy`)
- RPC 요청 프레이밍: `{type:'req', id: crypto.randomUUID(), method, params}` + `Map<id, resolve>` + timeout 시 delete 후 `RPC timeout: <method>` reject
- RPC 응답 demux: `frame.id && typeof frame.ok === 'boolean'` → get → delete → cb
- `connect` rpc payload 전부 (`displayName` 제외): protocol 3, `client.id 'openclaw-control-ui'`, `mode:'ui'`, `caps:[]`, `auth: token ? {token} : undefined`, `role:'operator'`, scopes 3종
- **토큰은 connect 시도마다 `window.twixy.getGatewayToken()` 로 새로 읽는다 (시도 간 캐시 없음).** 게이트웨이 재시작을 버티는 이유 — transport 계약 테스트에 포함할 것
- `extractText(content)` — 6개 훅에서 바이트 단위 동일 (`[[tag]]` strip 포함).
  useOpenClaw 만 `stripInternalTags` 로 쪼개져 있었지만 동작은 같았고, 마지막에 그 사본도 지웠다 →
  지금은 `sessionClient.ts` 한 곳뿐
- `session.tool` phase 파싱 — 3개 훅에서 동일
- create 직후 `sessions.messages.subscribe {key}`
- `onmessage` 전체를 감싼 `try { JSON.parse } catch {}`
- `connectLock` / `ensureConnected` 관용구 — 6개 훅에서 동일 (**공통 잠재 버그 포함**, 아래 #1)

## 훅마다 달라야 하는 것 — transport 에 넣지 말 것

- `displayName` (7종), `agentId` (없음 / builder / workflow-runner)
- 세션을 **언제** 만드는가: 핸드셰이크 안 / 첫 send lazy / 호출자 명시 호출
- 세션 개수와 장부 모양: ref 1개 / workflowId Map / conv×mode Map + LRU / key 무제한
- 세션 key 영속화 (useOpenClaw 만 디스크) — transcript 영속화는 별개의 훅별 관심사
- 전역 `sessions.subscribe {}` (useOpenClaw 만)
- SOUL 텍스트·주입 시점·"보냄" 추적 방식
- 완료 판정 의미: `chat` 상태기계 + awaiter 큐 vs 첫 assistant 메시지. **transport 는 raw 이벤트만 내고 판정은 훅이 한다**
- 타임아웃 값 (15s 고정 / 15s+override / 10분 turn / 45s 위젯)
- 재연결·backoff·게이트웨이 재시작 teardown (useOpenClaw 만)
- `onclose` 에서 "소켓 ref 와 lock 해제" 이상의 모든 것 (어느 장부를 비우고 어느 awaiter 를 reject 하고 어느 React state 를 되돌리는지)

> **A1 이전 완료 (7/7).** 7개 훅 전부 `src/lib/gateway/controlUiTransport.ts` 위에서 돈다.
> 훅마다 특성화 테스트가 이전 전/후 동일하게 통과하는 것으로 동작 보존을 확인했다.
> transport 가 소유하지 않는 것(재연결·세션·SOUL·완료 판정·영속화)은 전부 훅에 남아 있다.

## 이전 순서

1. **`useWorkflowClaw`** — 단일 send 경로, 세션 1개, soul bool 1개, 15s 고정, 재연결·awaiter·`chat` 처리 없음. transport 가 connect+핸드셰이크+RPC+raw 이벤트만 다루면 되는 최소 사례. 다른 훅들의 복사 원본이기도 함.
2. **`useOrchestrationClaw`** — 위의 거의 그대로인 사본 (soul 인자와 IPC 채널명만 다름). 두 번째 호출자로 추출을 검증.
3. `useDashboardClaw` — 작지만 agentId 없음 + 별도 45s 슬롯 + 단일슬롯 버그가 있는 outlier. 첫 대상으로는 부적합.
4. `useOrchestrationGateway` → `useWorkflowTestSession` (쌍둥이, awaiter 큐)
5. `useCopilotChat` (다중 세션 + LRU)
6. **`useOpenClaw` 마지막** — 자동 재연결, close 시 pending resolve, 디스크 세션 복원, 서브에이전트 지연 상태기계를 혼자 갖고 있음.

## 발견된 잠재 버그 — 별도 수정 티켓으로 (이전 PR 에 섞지 않는다)

가이드 v2 규칙: 잘못된 동작은 "보존 대상" 이 아니라 별도 티켓. transport 이전 PR 은 동작을 그대로 옮기고,
아래는 각각 회귀 테스트와 함께 따로 고친다. ✔ = 직접 코드로 재확인함. 나머지는 정적 분석 보고 — 티켓화 전 재확인.

> **12건 전부 종결.** 9건은 회귀 테스트와 함께 고쳤고(#2·#3·#4·#7·#8·#9·#10·#11·#12),
> 3건은 transport 이전으로 구조적으로 사라졌다(#1·#5·#6). 이 중 #4·#11 은 제품 오너 결정(D2)을 따른 것이다.
> "수정됨" 은 **수정 전에 실패하는 회귀 테스트를 먼저 확인했다**는 뜻이다.

| # | 위치 | 내용 | 확인 |
|---|---|---|---|
| 1 | 6개 훅 `ensureConnected` | `doConnect` 가 reject 하면 `connectLock.current = null` 에 도달 못 해 **거절된 promise 가 계속 남는다** → 이후 모든 `ensureConnected` 가 같은 거절을 재-await (`onclose` 가 null 로 만들 때까지). transport 에서 한 번에 고칠 것 | transport 에서 **구조적으로 제거** (계약 테스트) — 이전된 6개 훅은 해소. useOpenClaw 는 자체 재연결 루프라 해당 없음 |
| 2 | useCopilotChat:620 vs :633, :635 | create-lock 을 `sk`(`convId::mode`)로 읽고 `convId` 로 쓰고 지운다 → **직렬화가 작동하지 않음**, 같은 대화의 두 모드가 서로의 lock 을 덮어씀 | ✔ **수정됨** — 회귀 테스트 `useCopilotChat.test.ts` |
| 3 | useCopilotChat:849 (기준 commit 줄번호) | `deleteConversation` 이 `['wf','simple']` 만 돌아 **content 모드 세션이 게이트웨이에 남는다** | content 는 nodal 병합에서 목록 확장으로 이미 해소. 근본 원인(모드 목록 하드코딩)은 **수정됨** — 장부를 prefix 로 훑는다. 회귀 테스트 `useCopilotChat.test.ts` |
| 4 | useCopilotChat:546 | sessionKey 없는 `session.message` 가 **현재 활성 대화**로 떨어짐 → 백그라운드 탭의 답이 화면의 탭에 붙을 수 있음 | **수정됨**(사용자 결정) — 폴백 제거, 라우팅 안 되는 프레임은 drop. evict/삭제된 세션의 늦은 답장도 포함 |
| 5 | useOpenClaw:1375 → :1224 → :1247 (기준 commit 줄번호) | 언마운트 cleanup 이 `reconnectTimer` 를 지운 **뒤** `ws.close()` → `onclose` 가 재연결 타이머를 다시 건다. 언마운트 후 소켓 재오픈 + setState 가능 | **해소됨**(이전 시 구조적으로) — `dispose()` 는 onClose 를 부르지 않아 재연결 경로가 아예 없다. 수동 reconnect·게이트웨이 재시작 경로도 같은 이유로 정리됐다 |
| 6 | useOpenClaw:694 (기준 commit 줄번호) | `getGatewayToken()` try-catch 없음 — IPC 가 reject 하면 connect 밖으로 throw (나머지 6개는 토큰 없이 연결로 degrade) | **해소됨**(이전 시 구조적으로) — 토큰 조회는 transport 가 try-catch 로 감싼다. 7개 훅이 같은 degrade 동작 |
| 7 | useOpenClaw:404, :468 (기준 commit 줄번호) | `finalFallbackTimer`, `usageSyncTimer` 가 cleanup 에서 안 지워짐 | **수정됨** — 언마운트에서 둘 다 정리. 회귀 테스트 `useOpenClaw.test.ts` |
| 8 | useWorkflowClaw:143, useOrchestrationClaw:102 (기준 commit 줄번호) | assistant 메시지 없이 turn 이 죽으면 `isThinking` 이 영원히 true (useCopilotChat:491 주석이 같은 버그를 거기서만 고쳤다고 말함) | **수정됨** — 회귀 테스트 `builderClawHooks.test.ts` |
| 9 | useDashboardClaw:215, :221 (기준 commit 줄번호) | 단일 슬롯 `pendingResponse` — 동시 `requestWidget` 2개면 #1 의 45s 타이머가 #2 의 핸들을 null 로 만들고 #2 는 소켓이 닫힐 때까지 hang | **수정됨** — 요청 직렬화 큐 + 슬롯 identity 가드. 회귀 테스트 `useDashboardClaw.test.ts` |
| 10 | useOrchestrationGateway:232 vs :218 | 에러 경로는 `q.pop()`, timeout 경로는 identity splice — 한 key 에 turn 2개가 큐잉되면 pop 이 엉뚱한 awaiter 를 버릴 수 있음 | **수정됨** — identity 로 제거. **쌍둥이 useWorkflowTestSession 도 같은 줄이 있어 함께 수정.** 회귀 테스트는 각 훅의 test 파일 |
| 11 | useWorkflowTestSession:353 vs useOrchestrationGateway:139 | key 없는 프레임을 한쪽은 active key 로 fallback, 한쪽은 drop — 쌍둥이 훅이 같은 프레임에 다르게 반응 | **수정됨**(사용자 결정) — TestSession 도 drop 으로 통일. 3개 훅 동작이 같아졌다 |
| 12 | useCopilotChat / WorkflowClaw / DashboardClaw / OrchestrationClaw | 언마운트 cleanup 없음 → 소켓과 게이트웨이 세션 누수 | 4개 훅 전부 **수정됨** (StrictMode 이중 마운트 테스트 포함) |

## 결정 기록 — 제품 오너 판단

"동작 보존" 으로 답이 안 나오는 갈림길(= 사용자에게 보이는 선택)은 구현자가 고르지 않고 멈춰서 물었다. 세 건이다.

| # | 갈림길 | 결정 | 이유 |
|---|---|---|---|
| D1 | #9 대시보드 동시 요청 — 직렬화 큐 / 오래된 요청 reject | **직렬화 큐** | 완료 판정이 "첫 assistant 메시지" 라, 한 세션에 턴이 둘 떠 있으면 어느 답이 누구 것인지 가릴 수 없다. 오래된 쪽을 reject 하면 그 턴은 게이트웨이에서 계속 돌다가 답이 먼저 도착해 **새 요청을 틀린 차트로 resolve** 한다 |
| D2 | #4/#11 key 없는 프레임 — 활성 대화/세션 폴백 / drop | **drop (3개 훅 통일)** | 번들 게이트웨이는 key 없는 프레임을 내지 않아 폴백은 도달 불가였다. 반대로 `chat` 은 모든 소켓에 브로드캐스트되므로, 폴백이 발동한다면 **남의 턴으로 내 노드를 끝내는** 쪽으로만 틀린다. 잘못 붙은 답은 사용자가 오귀속을 알아챌 방법이 없어서, 안 보이는 것보다 나쁘다 |
| D3 | 게이트웨이 세션 누수 — 언마운트 반납 / 재연결마다 반납 / 방치 | **언마운트에서만 반납** | 세션에는 LLM 대화 기억이 붙어 있다. 재연결마다 지우면 "끊겼다 돌아와서 이어서 쓰기" 가 깨진다. 언마운트(로그아웃·종료)는 어차피 기억이 끊기는 지점이라 안전하다 |

코드 변경이 없는 부수 결정 둘:
- **#8 의 에러 문구** — 턴이 답 없이 죽으면 스피너만 내리고 에러 텍스트는 띄우지 않는다.
  문구 정책은 나중에 7개 훅에 한 번에 정한다.
- **`connect.challenge` 가 raw 세션 로그에서 빠지는 것** — 받아들인다. 디버그 부산물 한 줄 때문에
  transport 계약(무엇을 `onEvent` 로 흘릴지)을 넓히지 않는다.

## 의도한 동작 변화 — "보존" 이 아닌 것들

이전 PR 의 원칙은 "동작을 그대로 옮긴다" 지만, 아래는 **알고 바꾼 것**이다. 회귀로 오인하지 말 것.

| 변화 | 어디 | 왜 |
|---|---|---|
| close 때 떠 있던 RPC 가 15s 타임아웃 대신 **즉시** 실패 | 6개 훅 | transport 가 소켓 사망 시 pending 을 바로 정리한다. **useOpenClaw 만 예전처럼 에러 프레임으로 resolve** — 호출부 29곳이 throw 가 아니라 `res.ok` 로 분기하기 때문 (transport 의 `ws_closed` 코드를 rpc 래퍼가 변환) |
| connect 가 거절돼도 다음 호출이 **재시도**한다 | 전 훅 (#1) | 예전엔 거절된 promise 가 lock 에 남아 이후 호출이 같은 거절을 재-await 했다 |
| key 없는/장부에 없는 프레임을 **버린다** | Copilot, TestSession (D2) | Copilot 은 **evict·삭제된 세션의 늦은 답장**도 버린다. 같은 폴백 식이 두 경우를 함께 처리했고 **실제로 도달 가능한 건 이쪽**이었다 — 그 답장이 화면의 다른 탭에 붙던 동작이 사라진다 (대신 그냥 사라진다) |
| 언마운트 때 게이트웨이 세션을 **반납**한다 | 6개 훅 (D3) | **useOpenClaw 는 예외** — 세션 키를 디스크에 저장해 다음 실행에서 같은 세션을 재개하는 설계라, 반납하면 그 설계가 깨진다 |
| 재시작 경로 pending 에러 코드 `gateway_restart` → `ws_closed` | useOpenClaw | 읽는 곳이 없다 (호출부는 `ok` 만 본다). 코드를 붙이는 지점이 transport 한 곳이라 통일됐다 |
| 인증 거절이 **아닌** 핸드셰이크 실패는 `errorMsg` 를 남기지 않는다 | useOpenClaw | 상태(재연결 중 / 포기)는 close 핸들러가 소유한다. connect 의 catch 가 덮으면 재시도를 다 쓴 뒤의 `disconnected` 가 `error` 로 바뀐다 (특성화 테스트가 잡았다) |
| `connect.challenge` 가 raw 세션 로그에 안 남는다 | useOpenClaw | transport 가 challenge 를 소비하고 `onEvent` 로 넘기지 않는다. 세션 기록의 의미에는 영향 없다 |
| `ws.onopen`/`onerror` 의 일시적 status 깜빡임이 없다 | useOpenClaw | 정지 상태는 동일 |

## 번들 openclaw 에서 확인한 것 (A1 leg 2)

`node_modules/openclaw/dist/gateway-cli-*.js` (2026.4.2, 읽기 전용) 정적 분석. 런타임 미검증.
`patches/openclaw+2026.4.2.patch` 는 이벤트 emit/broadcast 경로를 건드리지 않는다.

| 프레임 | key 필드 | 누구에게 가는가 |
|---|---|---|
| `chat` (delta/final/error/aborted) | 항상 top-level `sessionKey` (emit 자체가 `if (… && sessionKey)` 안). `key` 필드는 없음. **`state:"start"` 는 emit 되지 않는다** | **연결된 모든 클라이언트** — `EVENT_SCOPE_GUARDS` 에 `chat` 이 없어 구독·scope 필터가 없다 |
| `session.message` | 항상 top-level `sessionKey` (`if (!sessionKey …) return` 뒤에서만 emit) | `sessions.messages.subscribe {key}` 한 연결 ∪ 전역 `sessions.subscribe` 한 연결 |
| `session.tool` | 항상 top-level `sessionKey` (`if (sessionKey)` 안). `payload.data` 에는 보장 없음 | **전역 `sessions.subscribe` 한 연결만** — key 별 구독으로는 오지 않는다 |
| `agent` (tool stream) | `sessionKey` 있으면 포함 | connect `caps` 에 tool-events 가 있는 연결만 (훅들은 전부 `caps: []`) |

따라서:
- **#4 / #11 의 keyless 폴백은 이 게이트웨이 버전에선 도달 불가 코드**였다. 반대로 `chat` 은 남의 세션 것까지 전부
  브로드캐스트되므로, keyless 프레임이 혹시 생긴다면 폴백은 **남의 턴을 내 활성 세션에 붙이는** 쪽으로 틀린다.
  → 사용자 결정으로 **3개 훅 모두 drop 으로 통일**했다. Copilot 은 키가 장부에 없는 경우(evict/삭제된 세션의
  늦은 답장)도 같은 식으로 drop 한다 — 실제로 도달 가능한 경로는 이쪽이었다.
- `sessions.subscribe` 를 부르는 건 useOpenClaw 뿐이라, 나머지 훅의 `session.tool` 처리(toolActivity / toolCalls)는
  자기 소켓으로는 프레임을 받지 못하는 것으로 보인다 — 별도 확인 티켓.
- 소켓이 닫혀도 게이트웨이는 그 연결이 만든 세션을 **회수하지 않는다** (close 핸들러는 구독 해제·presence 뿐).
  세션은 `sessions.delete` 전까지 남는다 → 재연결·언마운트마다 옛 세션이 쌓인다.
  → 사용자 결정으로 **언마운트에 한해** best-effort `sessions.delete` 를 넣었다(6개 훅). 재연결 경로는 그대로 둔다
  (세션에는 LLM 대화 기억이 붙어 있어, 끊겼다 돌아왔을 때 이어서 쓰는 동작이 바뀐다). 주기적 sweep 은 티켓으로 남김.

## 남은 티켓 (이 트랙에서 고치지 않음)

- **`runLogs.categorizeError` 가 연결 끊김을 `agent` 로 분류한다.** `ws_closed` / `Connection closed` 가 system 패턴
  (`timeout|network|socket|…`)에 안 걸려 "노드 지시문을 고치라" 는 엉뚱한 안내가 뜬다. `closed|ws_closed` 추가 필요 —
  `src/lib/runLogs.ts` 는 다른 트랙 소관이라 여기서 건드리지 않는다.
- **`session.tool` 이 훅들에 도달하는지 미확인.** 전역 `sessions.subscribe` 연결에만 가는데 그걸 부르는 건 useOpenClaw 뿐이다
  (위 표). 나머지 훅의 toolActivity/toolCalls 가 죽은 코드일 가능성 — **패키지 빌드에서 런타임 확인 대기 중.**
  확인 전에는 고치지 않는다. 고치는 방법에 따라 D2 와 충돌할 수 있다: 전역 `sessions.subscribe` 를 붙이면
  그 소켓이 **모든 세션의** `session.message` 를 받게 돼 key 라우팅이 훨씬 중요해진다.
- **주기적 세션 sweep 이 없다.** 언마운트 반납(D3)은 정상 종료 경로만 덮는다 — 크래시·강제 종료로 버려진
  세션은 게이트웨이에 그대로 남는다 (게이트웨이는 연결이 끊겨도 세션을 회수하지 않는다). main 에서 주기적으로
  훑어 정리하는 건 별도 티켓 — 이 트랙에서 만들지 않았다.
- **핸드셰이크 타임아웃이 어디에도 없다.** 소켓은 열렸는데 게이트웨이가 `connect.challenge` 를 영영 안 보내면
  `ensureConnected()` 는 그대로 매달린다 (A0 때도 같았다). 계약에 없던 동작이라 이번에 넣지 않았다.

## 패키지 빌드에서 확인할 것 — 테스트가 못 덮는 것

단위 테스트는 가짜 WebSocket 위에서 돈다. 프레임 모양과 훅의 반응은 고정하지만 진짜 게이트웨이의
타이밍·재시작·`file://` origin 은 보지 못한다 (2026-09 회귀 4건은 전부 패키지 빌드에서만 났다).

**이미 확인된 것**: 패키지 빌드에서 렌더러 연결 → `get-gateway-token` → 실제 모델 턴 완료까지 정상.
즉 transport 경로 자체는 vitest 밖에서도 동작한다.

| 시나리오 | 왜 위험한가 | 테스트가 덮는 정도 |
|---|---|---|
| **게이트웨이 재시작 (메인 챗이 살아 있는 채로)** | `openclaw-ready` 경로가 수동 teardown → `dispose()` 로 이번에 가장 많이 바뀐 자리. 복구되고 스피너가 안 멈춰야 한다 | 훅 단위만 (IPC 콜백을 직접 발화) |
| **진짜 끊김 뒤 재연결** | 턴 도중 게이트웨이를 죽였을 때: 턴이 hang 대신 에러로 끝나고 → backoff 재연결 → 상한 뒤 **`disconnected`(≠`error`)**. 이어서 수동 Reconnect 버튼 | backoff·상한·상태 전이는 있음. 실제 소켓 종료 타이밍은 미검증 |
| **앱 재시작 후 세션 재개** | 메인 챗만 디스크 키로 같은 게이트웨이 세션을 이어야 한다 (언마운트 반납 예외가 맞는지) | 키를 넘기는 것까지만 |
| **로그아웃 (세션 살아 있는 상태)** | 게이트웨이 로그에 훅별 `sessions.delete` 가 찍히고 고아 연결이 없어야 한다. 진행 중이던 답장은 더 이상 디스크/localStorage 에 안 남는다 | 요청을 보내는 것까지만 (게이트웨이 반응은 미검증) |
| **Copilot 다중 탭** | 답이 맞는 탭에 붙는지. **삭제·evict 된 대화의 늦은 답장이 화면 탭에 안 붙는지** (D2 의 실제 경로) | 라우팅·drop 둘 다 단위 테스트 있음 |
| **플랜 모드 / 서브에이전트** | 400ms 유예 + 15s 안전망 상태기계가 그대로 옮겨졌지만 커버리지가 얇다 | 거의 없음 — "이전 시 무변경" 만 확인 |
| **워크플로 Test / 오케스트레이션 병렬 run** | 노드 완료 판정과 browser 슬롯이 같은 세션에 붙는지 | 훅 단위만 |

## 코드에서 확정할 수 없던 것

- 게이트웨이가 렌더러 소켓에 `CloseEvent.code === 1008` 을 보내는 경우 — **어떤 훅도 `code` 를 읽지 않는다.** 정책 거절과 정상 종료를 구분 못 함 (useOpenClaw 는 재시도 루프로, 나머지는 다음 lazy send 까지 down)
- agentId 없는 `sessions.create({})` 가 `main` 에이전트로 해석되는지 — 기본 선택 규칙은 게이트웨이 쪽
- useOrchestrationGateway:229 의 `opts.model` 을 게이트웨이가 존중하는지 (코드 주석도 "미지원이면 무시")
