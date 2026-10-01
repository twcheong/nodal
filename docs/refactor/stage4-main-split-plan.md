# Stage 4 — `electron/main.ts` 분할 계획 (코드 변경 없음)

기준 commit `fe63cdf` · `electron/main.ts` **7,058줄 / IPC 등록 214개 / import 54개**.

> 이 문서는 **계획만** 담는다. 추출은 승인 후 슬라이스 단위로 따로 커밋한다.
> 숫자는 전부 스크립트로 센 것이다 (섹션 배너 79개를 책임 단위로 묶어 줄 수·IPC 수·결합도를 집계).

---

## 0. 요약 — 어디에 무게가 있나

| | 줄 | IPC |
|---|---:|---:|
| 순수/준순수 그룹 (얇은 seam 하나면 나간다) | **1,695** | **94** |
| 창·상태 소유 그룹 | 약 450 | 17 |
| 어려운 핵심 (게이트웨이 · ensureWorkspace · 키/모드) | 약 1,900 | 22 |
| 나머지 (IPC 묶음 · 헬퍼 · 라이프사이클) | 약 2,800 | 81 |

**핵심 판단: 줄 수가 문제가 아니라 `openclawProcess` 하나가 문제다.** 모듈 레벨 가변 상태 32개 중
31개는 소유자와 같이 움직이거나 접근자 하나면 되는데, `openclawProcess` 는 **10곳에서 쓰기**가 일어나고
그중 5곳은 같은 4줄(`kill → null → startOpenClaw`)을 복붙한 것이다. 그 중복부터 없애면 (슬라이스 0)
게이트웨이 추출의 난이도가 한 단계 내려간다.

---

## 1. 책임별 인벤토리 (전 7,058줄 · 214 IPC 커버)

결합도는 해당 범위에서 각 기호가 등장한 **줄 수**다. `·` = 0.

| 줄 | 범위 | IPC | 책임 | mainWindow | electron API | 게이트웨이 상태 | getWorkspace | CONFIG_PATH | session |
|---:|---|---:|---|---:|---:|---:|---:|---:|---:|
| 624 | L5501-6124 | 9 | **세션 로그·통계·요약** | · | · | · | 10 | 1 | · |
| 575 | L782-1356 | · | **ensureWorkspace (설정 소유권)** | · | 1 | 1 | 13 | 3 | · |
| 506 | L3575-4080 | 63 | **플랜·워크플로·오케·에이전트 IPC** | 1 | · | · | 60 | · | · |
| 500 | L1579-2078 | · | **키 핸드아웃** (Tavily·OpenRouter·사용량·재발급) | · | 1 | 5 | · | 3 | 1 |
| 443 | L2079-2521 | · | **게이트웨이 수명주기 + 감시** | 5 | 4 | 11 | 1 | 3 | · |
| 418 | L260-677 | · | **Paths · project config · auth 세션 저장** | 6 | 6 | 2 | 2 | 1 | 9 |
| 416 | L4363-4778 | 22 | **auth·pricing·채널·모드·API키 IPC** | 4 | 5 | 8 | 7 | 8 | 5 |
| 350 | L2942-3291 | 21 | **프로젝트·팀·admin·MR IPC** | 10 | 2 | 9 | 4 | · | · |
| 324 | L2597-2920 | · | **BrowserWindow 5종 생성** | 15 | · | · | · | · | · |
| 290 | L6770-7059 | 10 | **Enterprise admin · 메모리 IPC** | 4 | 7 | · | 6 | · | · |
| 282 | L4081-4362 | 12 | logbook · 프로젝트폴더 · 툴권한 IPC | 3 | 3 | 4 | 16 | 2 | · |
| 270 | L6500-6769 | 9 | **Setup 헬퍼 + Setup IPC** (Node 설치·재시도) | 6 | 5 | 3 | 3 | · | · |
| 259 | L1-259 | · | 헤더 · import 54개 · 전역 상태 선언 32개 | · | · | · | · | · | · |
| 223 | L4984-5206 | 19 | **Google · 연동 · MCP · cron IPC** | 1 | 5 | 9 | · | · | · |
| 222 | L1357-1578 | · | **TSL 컴파일 래퍼 · 스킬 워처** | 1 | · | · | 4 | · | · |
| 205 | L4779-4983 | 11 | **문서/데이터 툴 IPC** (pdf·xlsx·pptx·query) | · | · | · | 15 | · | · |
| 198 | L5207-5404 | 2 | **대시보드 스냅샷** | · | · | · | 3 | · | · |
| 169 | L6220-6388 | · | Chrome 프로필 리브랜딩 · 다운로드 후처리 | 1 | · | · | 1 | · | · |
| 126 | L3292-3417 | 17 | **오버레이 3종 IPC** (sidetab·composer·test) | 16 | · | · | · | · | · |
| 111 | L6389-6499 | · | 딥링크 등록 · 앱 라이프사이클 | 4 | 12 | · | 1 | · | · |
| 104 | L678-781 | · | **Node22 탐색** | · | · | · | · | · | · |
| 96 | L5405-5500 | 5 | TSL 스킬 CRUD IPC | 2 | · | · | 6 | · | · |
| 95 | L6125-6219 | 2 | **언어 교정** (서브모델 호출) | · | · | · | · | · | · |
| 90 | L3485-3574 | 5 | 가드레일 팝업 IPC + overwrite-redirect | 1 | · | · | 1 | · | · |
| 75 | L2522-2596 | · | 창 진입(windowEntry) · 발신자 검증 · 외부링크 | · | · | · | · | · | · |
| 67 | L3418-3484 | 7 | 브라우저 프리뷰 IPC | · | · | · | · | · | · |
| 21 | L2921-2941 | · | 트레이 (이미 tray.ts 호출만) | · | · | · | · | · | · |

목록에 없던 것 중 발견한 것: **Node22 탐색·설치**(208줄, 결합도 0), **Chrome 프로필 리브랜딩**,
**다운로드 후처리 감시**, **언어 교정용 서브모델 호출**, **스킬 사용 통계/패턴 분석 메타**.

---

## 2. 이미 빠져나간 것 — 반복할 패턴

| 모듈 | 줄 | `from 'electron'` |
|---|---:|---|
| planning.ts | 3,129 | 없음 |
| tsl-compiler.ts | 832 | 없음 |
| browserPreview.ts | 786 | 1 |
| mr.ts | 424 | 없음 |
| agent-tool-bridge.ts | 323 | 없음 |
| toolPermissions.ts | 247 | 없음 |
| execution-plan-api.ts | 220 | 없음 |
| trustBoundary.ts / windowEntry.ts / pricing.ts / logbook-bridge.ts / authDeeplink.ts / channelSecrets.ts | 63~171 | 없음 |
| tray.ts / product-ipc.ts | 21~32 | 1 |
| guardrail/ · designated-paths/ · connections/ · tools/files/ · google/ | — | ipc.ts 만 |

**세 가지가 공통이다. 이게 곧 다음 슬라이스의 합격 기준이다.**

1. **상태를 안 가져간다.** 앱의 가변 상태는 main 에 남고, 모듈은 필요한 값을 **thunk 로 주입**받는다
   (`getWorkspace: () => string`, `getMainWindow: () => BrowserWindow | null`). 캐시를 가진 둘
   (`guardrail/ipc.ts`, `designated-paths/ipc.ts`)도 캐시는 자기 것이고 무효화 경로가 명시돼 있다.
2. **electron 을 최대한 안 만진다.** 16개 중 13개가 `from 'electron'` 0줄이다 → vitest 에서 그대로 돌아간다.
   못 피하는 것(`ipcMain`, `BrowserWindow`)은 **등록 함수 하나**(`registerXIpc(deps)`)로 좁혀 둔다.
3. **import 시점 부작용이 없다.** IPC 등록·spawn·파일 쓰기는 전부 호출 시점에만 일어난다.

leg 1 의 tray.ts 가 이 패턴의 최소 사례다: 아이콘·이름·콜백 3개를 받고, `tray` 전역은 main 이 계속 쥔다
(Tray 가 GC 되면 아이콘이 사라지므로 **일부러** 안 가져갔다).

---

## 3. 공유 가변 상태 32개 — 진짜 장애물

쓰기 횟수 순. **`이동`** = 소유자와 같이 나간다 · **`접근자`** = main 이 계속 쥐고 thunk 로 노출 ·
**`잔류`** = 움직이면 안 된다.

| 상태 | 쓰기 | 읽기 | 쓰는 곳 | 판정 |
|---|---:|---:|---|---|
| `openclawProcess` | **10** | 21 | spawn · exit핸들러 · stop · respawn · 그리고 **복붙 5곳** | **잔류** (슬라이스 0 이후 5곳으로 축소) |
| `startupErrorMsg` | 5 | 7 | startOpenClaw 실패 · Setup 재시도 | 이동 (게이트웨이와 함께) |
| `overlayWindow` · `composerWindow` · `guardrailWindow` | 각 4 | 17~21 | 생성·closed 핸들러·quit | 이동 (창 모듈로) + 접근자 |
| `openrouterHandoutCache` | 4 | 9 | 발급·갱신·로그아웃·모드전환 | 이동 (키 핸드아웃과) |
| `gatewaySupervised` · `gatewayRestartTimer` · `gatewayRestartAttempts` · `gatewayUptimeTimer` | 2~3 | 1~4 | 감시 로직 전용 | **이동** (한 덩어리, 외부 독자 없음) |
| `openclawLogBuffer` | 3 | 3 | appendOpenClawLog · get-openclaw-log · log-ui | 이동 (로그 모듈) + 접근자 |
| `openrouterKeyMissing` · `openrouterRecoveryAttempts` · `openrouterRecovering` | 2~3 | 1~2 | 키 발급/복구 | 이동 (키 핸드아웃과) |
| **`mainWindow`** | **2** | **82** | createWindow · closed | **접근자** — 읽기 전용 소비가 압도적 |
| `testOverlayWindow` | 2 | 14 | 생성·closed | 이동 + 접근자 |
| `toolBridge` · `executionPlanApi` | 2 | 3~4 | 기동·종료 | 이동 (게이트웨이와) |
| `usageSyncTimer` · `prevUsdActual` | 2 | 0~3 | 사용량 동기화 | 이동 |
| `skillsWatcher` · `skillsDebounce` · `skillsPollInterval` | 2 | 0~1 | 워처 시작/중지 | **이동** (한 덩어리) |
| `wfListCache` | 2 | 1 | 워크플로 목록 캐시 | 이동 |
| `guardrailPopupState` · `testOverlaySnapshot` · `overlaySnapshot` · `overlayOpacity` | 1 | 1~3 | 해당 IPC 전용 | 이동 |
| `tray` | 1 | 2 | createTray · quit | **잔류** (GC 방지용 참조) |
| `appQuitting` | 1 | 2 | before-quit | 잔류 (라이프사이클) |
| `tavilyHandoutCache` | 1 | 5 | 발급 | 이동 |
| `blockedSenderLogged` | 1 | 0 | 발신자 검증 로그 상한 | 이동 |

### 3-1. `mainWindow` 이 겁나 보이지만 실제로는 쉽다
82번 읽지만 **쓰기는 2번**(`createWindow`, `closed`)이고, 읽기는 거의 전부
`mainWindow?.webContents.send(...)` 한 줄이다. 이미 검증된 해법이 코드에 있다 —
`registerGuardrailIpc(() => mainWindow, …)`, `registerDesignatedPathsIpc({ getMainWindow })`.
**슬라이스마다 `getMainWindow` thunk 를 주입**하면 되고, 새 패턴이 아니다.

### 3-2. `openclawProcess` 가 진짜 문제 — 그리고 이미 절반은 풀려 있다
쓰기 10곳 중 **5곳이 같은 4줄의 복붙**이다:

```
if (openclawProcess && !openclawProcess.killed) { openclawProcess.kill(); openclawProcess = null }
await startOpenClaw()
mainWindow?.webContents.send('openclaw-ready')
```

L5116 에 이미 **`respawnGateway()`** 가 이 모양 그대로 있고, 그 주석이 스스로
"same kill()+startOpenClaw()+'openclaw-ready' pattern used by the guardrail / designated-paths handlers"
라고 적고 있다. 즉 작성자도 중복을 알고 있었다. 현재 호출 관계:

| 위치 | 모양 |
|---|---|
| L5116 `respawnGateway()` | 정본. mcp-upsert · mcp-remove · mcp-oauth-connect 가 쓴다 |
| L2967 guardrail onModeChanged | **respawnGateway 와 동일** |
| L2989 designated-paths onChange | **respawnGateway 와 동일** |
| L4142 set-project-dir | + `startUsageSyncTimer()` + `startSkillsWatcher()` + `project-dir-changed` 전송 |
| L4438 save-channels | + `try/catch` 로 `{ok:false,error}` 반환 + `startUsageSyncTimer()` |
| L4560 set-twixy-mode | L4438 과 동일 모양 |
| L1869 OpenRouter 키 재발급 | 자체 변형 (kill → null → start, 세션 중 갱신 경로) |

---

## 4. 슬라이스 순서

각 슬라이스는 **독립 커밋 + 독립 검증**(electron tsc · vitest · `check:boundary` ·
`node scripts/refactor-baseline.mjs` 로 **채널 집합 불변**). 패키지 점검 3종은 코디네이터가 슬라이스 사이에 돌린다.

### 슬라이스 0 — 재기동 경로 통일 (이동 없음, 준비 작업)
`openclawProcess` 쓰기 10 → 5. 복붙 5곳을 하나의 헬퍼로 모은다.
**주의:** 세 가지 모양이 있고 **의미가 다르다.** L4438·L4560 은 `startOpenClaw` 실패를
`{ok:false,error}` 로 **반환**하고, `respawnGateway` 는 **throw** 한다. 파라미터 하나로 뭉개면
save-channels 가 실패 시 throw 로 바뀐다 — 렌더러가 안 보는 반환이라 조용히 깨진다.
→ `respawnGateway(opts?: { after?: () => void })` + 호출부에서 try/catch 유지를 제안.
**이 슬라이스만은 순수 이동이 아니다.** 가장 작지만 가장 조심해야 한다.

### 슬라이스 1 — 세션 로그·통계·요약 (624줄 / 9 IPC) ★ 첫 타자
결합도 `getWorkspace` ×10 뿐. mainWindow·electron·게이트웨이 전부 0.
`sanitizeSessionIdForFilename` · 로그 파서 · 스킬 통계 · 패턴 분석 메타 · 요약 생성이 한 덩어리.
`activeSessionFiles` 맵도 같이 나간다 (이 그룹 전용).
**주의 1개:** `subModelChat`(L6084)이 이 범위 끝에 정의돼 **다음 그룹(언어 교정)이 같이 쓴다.**
→ `electron/subModel.ts` 로 먼저 빼고 양쪽이 import.

### 슬라이스 2 — 문서/데이터 툴 IPC (205줄 / 11) + 대시보드 (198줄 / 2) + 언어 교정 (95줄 / 2)
셋 다 `getWorkspace` 외 결합 0. 이미 `tools/files/*` · `tools/data/*` 가 실제 구현을 갖고 있어
main 쪽은 **얇은 IPC 래퍼**다. 가장 "순수 이동"에 가까운 묶음.

### 슬라이스 3 — 플랜·워크플로·오케·에이전트 IPC (506줄 / **63 채널**)
채널 수 최대. 전부 `planning.ts` 위의 얇은 래퍼(`getWorkspace` ×60)이고 mainWindow 는 **1줄**
(`broadcastPlanChange`). seam 은 `{ getWorkspace, broadcast }` 둘뿐.
**한 커밋에 63채널이 부담이면** plan / workflow / orchestration / aiagent 로 4등분 가능.

### 슬라이스 4 — 브라우저 프리뷰 IPC (67줄 / 7) + 가드레일 팝업 IPC (90줄 / 5)
프리뷰는 `browserPreview.ts` 위 래퍼라 결합 0. 가드레일 팝업은 창 참조가 1줄.

### 슬라이스 5 — 창 5종 + 오버레이 IPC (324 + 126줄 / 17)
`electron/windows.ts`. `mainWindow` 외 4개 창 상태가 여기로 **이동**하고, main 은
`getMainWindow()` 접근자만 남긴다. 오버레이 IPC(`mainWindow` ×16)가 자연히 따라온다.
**이 슬라이스가 끝나면 나머지 전부가 thunk 하나로 창을 본다** — 이후 슬라이스가 쉬워진다.

### 슬라이스 6 — Node22 탐색·설치 + Setup IPC (208 + 270줄 / 9)
Node22 탐색은 결합도 0(완전 순수). Setup IPC 는 `startupErrorMsg` · 재시도(게이트웨이)에 붙어 있어
**슬라이스 7 이후가 더 안전**하다 — 순서를 바꿔도 된다.

### 슬라이스 7 — TSL 워처 + 스킬 CRUD (222 + 96줄 / 5)
워처 상태 3개가 한 덩어리로 이동. `regenerateSkillsIndex` 가 ensureWorkspace 와 스킬 IPC 양쪽에서
불리므로 공용 모듈로.

### 슬라이스 8 — 게이트웨이 수명주기 + 감시 (443줄)
슬라이스 0·5 가 끝난 뒤. 감시 상태 4개는 외부 독자가 없어 통째로 이동하고,
`openclawProcess` 는 **모듈 안으로 들어가고 main 은 `isGatewayAlive()` 정도만** 본다.
키 핸드아웃(L1579-2078)과 붙어 있어 같이 가거나 바로 뒤따라야 한다.

### 나중 / 별도 승인
- **ensureWorkspace (575줄)** — §5 참고. Stage 4 범위에서 **제외** 권장.
- **auth·pricing·채널·모드·키 IPC (416줄)** — 게이트웨이·CONFIG_PATH·세션 셋 다 만진다. 마지막.
- **Paths·project config·auth 세션 (418줄)** — 거의 모든 모듈이 여기서 값을 얻는다.
  가장 먼저 **읽히고** 가장 나중에 **움직여야** 한다.

**슬라이스 1~5 만으로 2,235줄 / 116채널이 나간다 (main.ts 7,058 → 약 4,820).**

---

## 5. 움직이면 동작이 바뀌는 것 — 따로 부른다

### 5-1. `ensureWorkspace()` 와 openclaw.json 소유권 (B7) — **이번 스테이지에서 건드리지 말 것**
`openclaw.json` 에는 **쓰는 주체가 5개**다:

| 쓰는 곳 | 방식 |
|---|---|
| L1094 `ensureWorkspace` | 전체 재작성 (read-modify-write) |
| L1947 `patchOpenClawOpenRouterProvider` | apiKey 블록만 |
| L4615 `save-subagent-model` | model 필드만 |
| L4661 `save-api-keys` | model 필드만 |
| **게이트웨이 자신** | `gateway.auth.token` 이 없으면 스스로 만들어 쓴다 |

L1291 의 주석이 사고 이력을 그대로 남기고 있다: gateway 블록을 보존하지 않으면 rewrite 마다
`auth.token` 이 사라지고 → 게이트웨이가 "token missing" 으로 재생성 → **openclaw 가 gateway 재시작** →
Windows in-process 재시작 불안정 → 렌더러 WS 끊김/로그인 흔들림. 로그인으로 uid 가 바뀌어
`ensureWorkspace` 가 재실행되면 이 사이클이 매번 돌았다. 기준선 README 의 "재로그인 시 게이트웨이
재시작 루프"가 이것이다.

즉 **정확한 read-modify-write 순서 자체가 버그 수정**이다. 옮기는 것만으로도 위험하고, 이득은 작다
(575줄이지만 IPC 0개라 다른 슬라이스를 막지 않는다).
→ **제안: Stage 4 에서 제외.** 손대려면 별도 스테이지 + 사용자 승인 + 패키지 재로그인 시나리오 필수.

### 5-2. `tray` 전역
GC 되면 트레이 아이콘이 사라진다. 참조는 main 에 **남아야** 한다 (leg 1 에서 이미 그렇게 처리).

### 5-3. import 시점 부작용
`installConsoleSecretMasking()`(L253 에서 즉시 호출) 은 import 시점에 `console.*` 를 감싼다. 옮기면
**감싸는 시점이 달라져** 그 사이 로그가 마스킹되지 않는다. 순서 의존이라 이동 시 명시 필요.

### 5-4. 딥링크·single-instance 등록 (L6389-6499)
`app.setAsDefaultProtocolClient` · `requestSingleInstanceLock` 은 **app ready 전에, 모듈 최상위에서**
실행돼야 한다. 함수로 감싸 호출 시점이 늦어지면 두 번째 인스턴스의 `twixy://` 가 유실된다.

### 5-5. 발신자 검증(`senderBlocked`)
창 목록을 `windowOf(kind)` 로 직접 읽는다. 슬라이스 5 에서 창이 이동하면 **같은 커밋에서**
접근자를 따라가야 한다. 어긋나면 정상 창이 거부되고, 증상은 "게이트웨이에 안 붙는다" 로만 보인다.

---

## 6. 슬라이스마다 돌릴 게이트

1. `node_modules/.bin/tsc -p tsconfig.electron.json --noEmit` → 0
2. `node_modules/.bin/tsc -p tsconfig.json --noEmit` → 0
3. `node_modules/.bin/vitest run` → 전부 통과
4. `node_modules/.bin/eslint electron src` → error 0
5. `npm run check:boundary` → ok
6. `node scripts/refactor-baseline.mjs` → **`ipcMain[].channel` 집합 불변** (증감은 발견이지 디테일이 아니다)
7. (코디네이터) `smoke-packaged.mjs` · `e2e-packaged-turn.mjs` · `ipc-sender-check.mjs`

슬라이스 5·8 은 패키지 점검을 **반드시** 통과해야 한다 — 창 참조와 게이트웨이 수명주기는
vitest 가 못 보는 영역이다.

---

## 12. 진행 현황 (슬라이스 0~14 완료)

| 슬라이스 | 내용 | main.ts | IPC |
|---|---|---:|---:|
| 0 | 재기동 상태 정리를 killGatewayIfRunning 으로 (이동 없음) | 7,058 → 7,065 | 0 |
| 1 | 세션 로그·통계·요약 → `sessionLogs.ts` | → 6,526 | 7 |
| 2 | 문서·데이터 툴 → `fileToolsIpc.ts` · 대시보드 → `dashboard.ts` | → 6,202 | 12 |
| 2b | 언어 교정 + 서브모델 → `languageCorrection.ts` | → 6,072 | 2 |
| 3-seam | plan-changed 브로드캐스트 → `planBroadcast.ts` | → 6,071 | 0 |
| 3-1 | 플랜 → `planIpc.ts` | → 5,915 | 16 |
| 3-2 | 워크플로 → `workflowIpc.ts` | → 5,688 | 17 |
| 3-3 | 오케스트레이션 → `orchestrationIpc.ts` | → 5,827 | 12 |
| 3-4 | AI 에이전트 → `aiAgentIpc.ts` | → 5,880 | 9 |
| 4 | 브라우저 프리뷰 → `browserPreviewIpc.ts` | → 5,626 | 7 |
| 5 | 창 5종 → `windows.ts` · 오버레이·가드레일 IPC → `overlayIpc.ts` | → 5,114 | 22 |
| 6 | Tavily·OpenRouter 자격증명 핸드아웃 → `keyHandout.ts` | → 4,743 | 0 |
| 7 | 게이트웨이 수명주기·감시 → `gateway.ts` | → 4,310 | 0 |
| 8a | 경로·프로젝트 설정 → `paths.ts` | → 4,180 | 0 |
| 8b | 인증 세션 저장 → `authSession.ts` | → 4,027 | 0 |
| 9 | 계정·과금·모드 IPC → `accountIpc.ts` | → 3,735 | 16 |
| 10 | 스킬 워처·TSL 컴파일 → `skills.ts` | → 3,514 | 0 |
| 11 | MR·admin 통계 IPC → `mrIpc.ts` | → 3,274 | 12 |
| 12 | Setup 헬퍼·IPC → `setupIpc.ts` | → 3,076 | 7 |
| 13 | 다운로드 후처리 → `downloadWatcher.ts` | → 2,960 | 0 |
| 14 | Enterprise admin → `enterpriseIpc.ts` · 장기 기억 → `memoryIpc.ts` | → 2,739 | 8 |
| 15 | Google·Gmail·Connections·MCP IPC → `integrationsIpc.ts` | → 2,491 | 19 |
| 16 | TSL 스킬 CRUD IPC → `skills.ts` (워처와 같은 파일) | → 2,398 | 5 |
| 17 | Node 경로·Node22 탐색 → `nodeRuntime.ts` | → 2,283 | 0 |
| 18 | 채널 로더 → `paths.ts`(load/save) · `channelSecrets.ts`(블록 조립) | → 2,216 | 0 |

**누적 -4,322줄 / IPC 147개 이동.** main.ts 는 7,058 → 2,739 (61% 감소). 등록 채널 집합은 매 커밋 불변 — 현재 220개(handle 219 + on 1),
preload API 247개도 불변. (이전 표의 "214" 는 오기였다. inventory.json 이 기준.)

### 배운 것 — 다음 슬라이스에도 그대로 적용한다

1. **"범위 밖 호출자" 를 줄 수보다 먼저 본다.** 세 번 연속 이게 이동 가능성을 갈랐다:
   `looksBinary`(밖 3곳) · `createExecutionPlanDraft`(Execution Plan HTTP API) ·
   `activeSessionFiles.clear()`(set-project-dir). 결합도 수치보다 예측력이 높았다.
2. **다중집합 줄 비교로 검증한다.** tsc·테스트가 전부 초록인데 주석 3줄(문서 주석 포함)이
   사라진 걸 이것만 잡았다. 순서 비교는 쓰면 안 된다 — 블록을 재배치하면 정당하게 실패한다.
3. **범위를 채우려고 성격이 다른 코드를 끌고 오지 않는다.** 모듈 이름이 거짓이 되고 나중에
   다시 쪼개야 한다. 지금까지 5번 좁혔다 (list-dir · looksBinary/read-image · 언어 교정 ·
   브라우저 슬롯/메인 채팅 · 가드레일 팝업).
4. **seam 을 먼저 뺀다.** 브로드캐스트를 먼저 분리해 두니 플랜 IPC 16채널이 창 전역을
   건드리지 않고 나갔다.
5. **`initX(deps)` 를 넣었으면 "부르는 곳" 을 즉시 감사한다.** 슬라이스 5 에서 `initWindows()`
   호출을 빠뜨렸는데 tsc·테스트 전부 초록이었다 — 창을 만드는 순간에만 throw 한다. export 가
   실제로 쓰이는지 grep 하는 게 유일한 자동 방어였다.
8. **deps 구조분해가 seam 을 0 에 가깝게 만든다.** 슬라이스 9 는 IPC 16개·292줄을
   옮기면서 바뀐 줄이 **2개**였다 — `const { ... } = deps` 로 이름을 그대로 살리면
   핸들러 본문을 한 글자도 안 고친다. 값을 `need().x` 로 바꾸는 방식(슬라이스 6·7)은
   비IPC 모듈에만 쓰고, IPC 묶음은 이 패턴을 기본으로 한다.
7. **치환 스크립트가 주석까지 고친다.** 슬라이스 7 에서 `CONFIG_PATH` → `need().configPath`
   치환이 주석 속 이름까지 바꿔, 되돌릴 때 `configPath` 라는 존재하지 않는 이름이 산문에
   남았다. 다중집합 비교가 잡았다 — 주석은 코드가 아니라 산문이라 치환 대상에서 빼야 한다.
6. **electron 을 못 띄우는 검증은 소스 모양 테스트로 대신한다.** 창 보관소가 둘로 갈라지면
   증상이 "게이트웨이 장애" 로 보인다. `windows.contract.test.ts` 가 생성자와 `senderBlocked`
   가 같은 출처를 읽는지 소스에서 고정하고, 변이 3종(두 번째 보관소·getWindow 가 null 반환·
   initWindows 호출 삭제)으로 가드가 실제로 실패하는지 확인했다.

## 13. 남은 그룹 지도 (슬라이스 5 이후)

현재 main.ts 5,626줄 / 등록 132개 기준, 40줄 이상 섹션만.

| 줄 | 범위 | IPC | 그룹 | 비고 |
|---:|---|---:|---|---|
| 575 | L827-1401 | 0 | **ensureWorkspace** | **제외 확정** (§5-1, 사용자 결정) |
| 443 | L2124-2566 | 0 | 게이트웨이 수명주기 + 감시 | 슬라이스 0 으로 쓰기 9→4 준비됨 |
| 321 | L4035-4355 | 14 | Twixy 모드·API 키·채널 IPC | 게이트웨이·CONFIG_PATH·세션 셋 다 |
| 256 | L1868-2123 | 0 | OpenRouter 키 재발급 | 게이트웨이와 한 몸 |
| 235 | L3677-3911 | 9 | 프로젝트 폴더·툴권한·logbook IPC | |
| 227 | L5399-5625 | 8 | Enterprise admin · 메모리 IPC | D2 미결정 구간 포함 |
| 177 | L1447-1623 | 0 | 스킬 워처 | 상태 3개가 한 덩어리 |
| 165 | L3166-3330 | 10 | Merge Request IPC | |
| 159 | L497-655 | 0 | auth 세션 저장 | 거의 모든 모듈이 여기서 값을 얻는다 |
| 270 | L5067-5336 | 9 | Setup 헬퍼 + Setup IPC | startupErrorMsg·재시도로 게이트웨이와 연결 |
| 117 | L4839-4955 | 0 | 다운로드 후처리 | |
| 106 | L199-304 | 0 | 오버레이 스냅샷 | 슬라이스 5 와 함께 |
| 104 | L723-826 | 0 | Node22 탐색 | 결합도 0 — 아무 때나 |
| 96 | L4653-4748 | 5 | TSL 스킬 CRUD | 워처와 함께 |
| 89 | L4484-4572 | 4 | MCP 서버 IPC | respawnGateway 사용 |
| 83 | L3331-3413 | 10 | 오버레이 IPC | **슬라이스 5** |
| 78 | L4360-4437 | 10 | Google Workspace IPC | |

### 슬라이스 5 범위 (창) — 시작 전 승인 필요
창 5종 생성 + 오버레이 IPC 10 + **가드레일 팝업 IPC 4 + guardrail-overwrite-redirect 1**.
슬라이스 4 에서 가드레일 쪽을 뺀 이유가 이것이다 — createGuardrailWindow ·
closeGuardrailWindow · guardrailWindow · mainWindow 에 얹혀 있고,
overwrite-redirect 는 거기 더해 **senderBlocked** 를 쓴다. senderBlocked 의 창 조회는
창과 **같은 커밋**에 움직여야 하고, 어긋나면 증상이 "게이트웨이에 안 붙는다" 로 나온다.
