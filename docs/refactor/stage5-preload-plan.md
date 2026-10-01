# Stage 5 — preload 표면 계획 (Track C · 분석만)

`electron/preload.ts` 는 794줄에서 **248개 항목**(함수 247 + 정적 값 `platform`)을 하나의
평평한 `window.twixy` 객체로 노출하고, **창 5개가 전부 같은 표면을 받는다.**

- 기준 commit: `origin/main` 머지 직후. `npx vitest run` 723 green.
- 이 문서는 계획이다. **프로덕션 코드는 한 줄도 쓰지 않았다.** 분석은 일회성 스크립트로 했고 커밋하지 않았다.
- `electron/**` 는 Track B 소유(Stage 4). 여기 제안하는 preload 변경은 **B 가 집행**한다.
  Track C 가 책임지는 건 분석과 렌더러 쪽 영향, 그리고 검사 장치다.
- 숫자는 전부 기계적으로 센 것이다. 추정한 곳은 그렇게 적었다.

---

## 0. 먼저 — 숫자 맞추기와, 이미 있는 선례

**248 = 247 함수 + `platform` 값 1.** `node scripts/refactor-baseline.mjs` 의
`preload fn 247 (+값 1)` 과 정확히 일치한다. 내부 구성:

| | 개수 |
|---|---|
| 최상위 키 | 227 |
| `tools:` 중첩 네임스페이스 안 | 21 |
| 그중 이벤트 리스너(`ipcRenderer.on`) | 32 |
| IPC 채널에 대응하는 것 | 221 |

**이미 네임스페이스가 하나 있다.** `electron/preload.ts:571` 의 `tools: { … }` 21개가
`window.twixy.tools.googleGetStatus()` 처럼 불린다 (`src/components/SettingsPanel.tsx:678-699`).
즉 이 코드베이스에서 네임스페이스는 가설이 아니라 **이미 돌아가는 패턴**이다 — 문법 논쟁은 끝났고,
남은 건 "어디까지 할 값어치가 있나" 뿐이다.

---

## 1. 도메인별 분류

이름 규칙으로 기계 분류했다. `calls` = 렌더러에서 `twixy.<name>` 직접 호출 수(src + products 전수),
`dead` = 그 이름이 렌더러 어디에도 **속성으로조차** 안 나오는 것, `dyn?` = 별칭(`const api = window.twixy`)
으로만 닿아 직접 호출이 0인 것.

| 도메인 | n | 호출부 | dead | dyn? | 쓰는 창 |
|---|---:|---:|---:|---:|---|
| overlay | 28 | 28 | 1 | 5 | main, enterprise, nodal, **sidetab, composer, test-overlay** |
| files | 27 | 61 | 3 | 0 | main, enterprise, nodal |
| enterprise | 23 | 35 | 2 | 0 | main, enterprise, nodal |
| orchestration | 21 | 31 | 6 | 0 | main, enterprise, nodal |
| doc-tools (`tools.*`) | 21 | 7 | 11 | 3 | main, enterprise, nodal |
| workflow | 20 | 41 | 1 | 0 | main, enterprise, nodal |
| gateway | 18 | 40 | 1 | 0 | main, enterprise, nodal |
| plan | 17 | 30 | 1 | 0 | main, enterprise, nodal, **sidetab, composer** |
| guardrail | 11 | 14 | 0 | 0 | main, enterprise, nodal, **guardrail** |
| browser | 10 | 6 | 0 | 6 | main, enterprise, nodal |
| chat | 9 | 18 | 0 | 0 | main, enterprise, nodal |
| mcp | 8 | 16 | 0 | 0 | main, enterprise, nodal |
| skills | 7 | 16 | 0 | 0 | main, enterprise, nodal |
| window | 5 | 19 | 0 | 1 | main, enterprise, nodal, **test-overlay** |
| settings | 5 | 4 | 3 | 0 | main, enterprise, nodal |
| auth | 5 | 6 | 0 | 0 | main, enterprise, nodal |
| channels | 4 | 9 | 0 | 0 | main, enterprise, nodal |
| runLog | 3 | 5 | 0 | 0 | main, enterprise, nodal |
| node-setup | 3 | 2 | 1 | 0 | main, enterprise, nodal |
| misc | 2 | 7 | 0 | 0 | main, enterprise, nodal, sidetab, composer |
| updates | 1 | 2 | 0 | 0 | main, enterprise, nodal |
| **합계** | **248** | **397** | **30** | **15** | |

질량은 상위 7개 도메인(overlay·files·enterprise·orchestration·doc-tools·workflow·gateway)에 있다 — **158/248 (64%)**.

---

## 2. 어느 창이 무엇을 쓰는가 — **이 문서에서 제일 중요한 표**

보조 창 4개의 import 폐쇄를 걸어 실제로 부르는 이름을 셌다
(`scripts/check-window-imports.mjs` 의 폐쇄 워커와 같은 방식).

| 창 | 쓰는 메서드 수 | 받는 표면 | 실제 사용 |
|---|---:|---:|---|
| sidetab | **8** | 248 | `planGet onPlanChanged closeSidetab overlayRequestSync overlayStart overlayResume overlaySetOpacity onOverlaySync` |
| composer | **7** | 248 | `planGet onPlanChanged overlayRequestSync overlayStop overlaySend overlayTogglePlanMode onOverlaySync` |
| test-overlay | **8** | 248 | `applyDisplayMarkup refreshMarkup requestSync onSync stop focusMain close sendReviewDecision` |
| guardrail | **3** | 248 | `guardrailPopupRequestSync guardrailPopupDecide onGuardrailPopupSync` |
| main / enterprise / nodal | 대부분 | 248 | — |

**보조 창 4개가 쓰는 이름은 중복 제거하면 26개다. 지금은 248개를 받는다 — 필요한 것의 9.5배.**

이게 per-window 표면의 근거다. 그리고 Track B 가 Stage 4 에서 만든 IPC 발신자 검증을
**preload 층에서 집행 가능**하게 만든다: 지금은 핸들러마다 "이 창이 불러도 되나" 를 되묻지만,
창이 애초에 그 함수를 못 받으면 되물을 일이 없다. 핸들러 쪽 검사는 그대로 두되(심층 방어),
표면이 좁아지면 **새 채널을 추가할 때 실수로 전 창에 노출되는 경로가 사라진다.**

⚠️ 한 가지 주의: `test-overlay` 의 `requestSync / onSync / stop / close / focusMain / sendReviewDecision` 은
이름이 지나치게 일반적이라 **평평한 표면에서 무엇의 stop 인지 읽히지 않는다.** per-window 로 쪼개면
이 이름들이 자기 창 안에서만 보이므로 의미가 분명해진다 — 네임스페이스 없이도 문제의 절반이 해결된다.

---

## 3. 네임스페이스로 바꿀 값어치가 있나 — **대체로 없다**

`window.twixy.readFile` → `window.twixy.files.read` 는 렌더러 전체 + `src/global.d.ts`(1,248줄) 동시 개명이다.
전 그룹을 하려면 **호출부 397곳**이 움직인다.

**권고: 전면 네임스페이스는 하지 말 것.** 이유:

1. **§2 를 하고 나면 네임스페이스가 사던 것의 대부분이 이미 사진다.** 평평한 표면의 진짜 문제는
   "찾기 어렵다" 가 아니라 "모든 창이 다 본다" 였고, 그건 per-window 가 해결한다.
2. 397곳 개명의 이득은 가독성뿐인데, **파일 안 섹션 주석 재배치(개명 0곳)** 로 같은 가독성을 얻는다.
3. 개명 중 오타는 런타임에 `undefined is not a function` 으로만 드러나고, 그것도 **그 창을 열어야** 드러난다.
   비용이 이득보다 크다.

**값어치가 있는 예외 — 이건 하자:**

| 그룹 | 호출부 | 왜 |
|---|---:|---|
| **overlay (28)** | 28 | `stop` · `close` · `requestSync` · `onSync` 처럼 **무엇의 동작인지 이름만으로 못 읽는** 4개가 전부 여기 있다. 유일하게 "이름이 실제로 나쁜" 그룹이다. |
| **doc-tools (21)** | 7 | 이미 `tools.*` 로 네임스페이스 돼 있다. **그대로 둔다** — 추가 작업 없음. |

**하지 말 것으로 권고**: files(61) · workflow(41) · gateway(40) · enterprise(35) · orchestration(31) · plan(30).
이 여섯이 전체 호출부의 **60%(238/397)** 인데, 얻는 건 점 하나 위치뿐이다.

> 여섯 그룹만 네임스페이스하고 열넷은 두는 것보다, **한 그룹(overlay)만 하고 나머지는 두는 쪽**을 권한다.
> 대칭성은 여기서 값을 치를 만한 가치가 아니다.

---

## 4. 미참조 후보 — 셋으로 갈린다

baseline 의 `미참조 후보 39` 를 실제로 훑었다. **전부 죽은 게 아니다.**

### 4a. 진짜 죽음 — 렌더러·main·scripts 어디에도 없음 (**18개**)
```
mrGet  workflowGet  orchestrationGet  aiAgentGet  aiAgentRestore  aiAgentRunLoad
aiAgentRunSave  aiAgentRunClear  planMarkAborted  writeWatchFile  getOpenClawStatus
getToolPermissions  checkNode22  getAnalysisMeta  markAnalysisDone
onDesignatedPathsConfigChanged  pickFolder  getProjectRoot*
```
`getProjectRoot*` 만 `electron/main.ts` 에 같은 이름이 있으나 그건 main 내부 함수이고 preload 래퍼와 무관 —
삭제 전 한 번 더 확인할 것.

### 4b. 죽은 게 아니라 **렌더러가 안 쓰는 것** — doc-tools 11개
```
writePdf  writeXlsx  readXlsx  renderDeckSheet  fetchToFile  queryData
writeGdoc  readGdoc  writeGsheet  readGsheet  sendEmail
```
이것들은 **에이전트가 쓴다.** `electron/agent-tool-bridge.ts:25-30` 이 구현을
(`./tools/files/pdf` 등) **직접 import** 해서 loopback HTTP 로 노출한다 — IPC 를 타지 않는다.
즉 채널과 핸들러는 살아 있고 **preload 래퍼만 아무도 안 부른다.**
→ 래퍼는 지워도 되지만 **채널은 남는다.** baseline 의 `main 전용` 카운트가 그만큼 오르는 게 정상 신호다.

### 4c. 살아 있는데 스캔이 놓친 것 (**삭제 금지**)
- **`closeTestOverlay`** — `scripts/ipc-sender-check.mjs` 가 CDP 로 문자열 호출한다. 렌더러엔 없다.
- **browser preview 6개** (`browserPreviewStart/Stop/Refresh/SetViewport`, `onBrowserPreviewFrame/TargetList`) —
  `src/components/workflow/LiveBrowserPreview.tsx:64,82,130` 이 `const api = window.twixy` 로 **별칭**을 잡고 쓴다.
- **pptx 3개** (`readPptx` `editPptx` `renderPptxSketch`) — 같은 별칭 패턴.

> **이 셋이 계획의 핵심 교훈이다.** `twixy.<name>` 만 grep 하면 `closeTestOverlay` 를 죽은 것으로 오판해
> 게이트 스크립트를 깨뜨린다. 삭제 슬라이스는 **렌더러 + `electron/**` + `scripts/**` 3곳**을 전부 봐야 한다.

---

## 5. 슬라이스 순서

각 슬라이스는 독립 검증 가능하고, 앞 슬라이스가 뒤 슬라이스의 안전망이 된다.

### Slice 0 — 표면 정합성 검사 (먼저, 아무것도 안 바꾸고)
**무엇**: `scripts/check-preload-surface.mjs` (신규). 세 가지를 기계적으로 확인:
1. 렌더러가 부르는 `window.twixy.*` 이름 ⊆ preload 가 노출하는 이름 (오타 즉시 실패)
2. `src/global.d.ts` 의 `Window['twixy']` 키 == preload 키 (선언 drift 차단)
3. `const api = window.twixy` 별칭 패턴을 찾아 별칭 경유 호출도 1번에 포함

**왜 먼저인가**: 이게 없으면 뒤의 모든 슬라이스에서 오타가 "안 열어본 창의 런타임 에러"로만 드러난다.
있으면 `npm run lint` 에서 잡힌다. 코디네이터가 지목한 바로 그 위험에 대한 답이다.
**게이트**: 지금 트리에서 통과해야 한다(위반 0). 일부러 오타를 넣어 실패하는 것까지 확인.
**소유**: Track C (scripts/ 는 B 소유가 아니다). `electron/` 을 읽기만 한다.

### Slice 1 — 진짜 죽은 것 18개 삭제
**무엇**: §4a 만. §4b(doc-tools)·§4c 는 건드리지 않는다.
**게이트**:
- `node scripts/refactor-baseline.mjs` — `preload fn` 247 → 229, `미참조 후보` 그만큼 감소,
  **`ipcMain` 220 불변**(채널 자체는 main 에 남는다), `중복 채널 0` 유지.
- `npx tsc` 양쪽 0 error (global.d.ts 에서도 같이 지워야 통과 — 그게 검증이다)
- Slice 0 검사 통과, `npx vitest run`, `npm run lint`
- `node scripts/ipc-sender-check.mjs` — CDP 경로 무회귀
**되돌리기**: 삭제만이라 revert 한 번.

### Slice 2 — doc-tools preload 래퍼 11개 삭제 (별건으로)
**무엇**: §4b. 채널·핸들러·bridge 는 그대로.
**왜 분리**: 1번과 성격이 다르다 — "아무도 안 씀" 이 아니라 "렌더러가 아니라 에이전트가 씀".
베이스라인 신호도 다르게 움직인다.
**게이트**: `main 전용` 카운트가 정확히 +11. 다른 수치 불변. `scripts/e2e-packaged-turn.mjs`
(실제 모델 한 턴)이 통과해야 한다 — 에이전트가 이 툴들을 실제로 부르는 경로가 살아 있음의 증거.

### Slice 3 — per-window 표면 (**가장 값어치 있는 슬라이스**)
**무엇**: preload 가 창을 구분해 각자 필요한 것만 노출. 창 구분은 Track B 가 Stage 4 에서
`electron/windowEntry.ts` 로 이미 갖고 있다.
보조 창 4개 = 26개 이름. main/enterprise/nodal = 나머지 전부(당분간 그대로).
**렌더러 개명 0곳** — 이름은 그대로고 받는 키 집합만 줄어든다.
**게이트**:
- Slice 0 검사를 **창별**로 확장: 각 창의 import 폐쇄에서 부르는 이름 ⊆ 그 창의 표면
- `node scripts/ipc-sender-check.mjs` 확장: 보조 창에서 main 전용 메서드가 `undefined` 인지 CDP 로 확인
  (지금은 "호출하면 null 이 온다" 를 보는데, 앞으로는 "함수 자체가 없다" 가 된다)
- 채널 집합 불변 — `refactor-baseline.mjs` `ipcMain` 220 그대로
**주의**: 이 슬라이스만 `preload.ts` 구조를 바꾼다. Track B 의 Stage 4 와 **같은 파일**이므로
순서를 정해야 한다 — B 의 main 분할이 끝난 뒤가 안전하다.

### Slice 4 — overlay 그룹만 네임스페이스 (선택)
**무엇**: 28개 호출부. `stop`/`close`/`requestSync`/`onSync` 가 무엇의 동작인지 읽히게.
**어떻게**: 손으로 고치지 않는다. 이름 매핑표를 만들고 `ts-morph` 또는 단순 치환 스크립트로
일괄 변환 후, **Slice 0 검사 + tsc** 가 통과할 때까지가 완료 조건.
**게이트**: 채널 집합 불변(순수 개명), Slice 0 검사, tsc 양쪽, `ipc-sender-check`(overlay 메서드를
문자열로 부르므로 **이 스크립트도 같이 고쳐야 한다** — §4c 의 교훈).
**하지 않아도 되는 슬라이스다.** §3 근거로 나머지 13개 그룹은 권고하지 않는다.

---

## 6. 가장 위험한 지점 (한 줄씩)

1. **`scripts/*.mjs` 가 `window.twixy.*` 를 문자열로 부른다** (`ipc-sender-check.mjs:105-126`).
   tsc 가 못 본다. 개명·삭제 슬라이스는 반드시 `scripts/` 를 함께 grep 할 것.
2. **`const api = window.twixy` 별칭** (`LiveBrowserPreview.tsx`). 단순 grep 이 9개를 죽은 것으로 오판한다.
3. **`src/global.d.ts` 가 preload 와 따로 논다.** 둘을 묶는 검사가 없으면 선언만 지우고 구현이 남거나 그 반대가 된다 → Slice 0.
4. **Track B 와 같은 파일.** Slice 3 은 B 의 Stage 4 이후로.

---

## 7. 한 줄 권고

> **Slice 0(검사) → 1(죽은 것 18개) → 2(doc-tools 래퍼 11개) → 3(per-window)** 까지 하고 멈추자.
> per-window 가 이 스테이지 가치의 대부분이고 렌더러 개명이 0곳이다.
> 네임스페이스는 overlay 하나만 선택적으로, 나머지 397곳 중 238곳은 건드리지 않는 쪽을 권한다.

---

## 8. 갱신 (2026-09-21, slice 0 이후)

### 8.1 결정 반영
- **네임스페이스는 전혀 하지 않는다.** §3 에서 예외로 뒀던 overlay 도 제외 — per-window 가
  끝나면 그 그룹은 7~8개짜리 작은 표면 안에 놓이므로 `stop`/`requestSync` 가 더는 모호하지
  않다. slice 3 이후에도 이름이 나쁘게 읽히면 그때 다시 꺼낸다.
- slice 0 완료(`8163a69`). slice 1·2 는 Track C, **slice 3 은 Track B 가 Stage 4 분할 이후 집행**.

### 8.2 per-window 표면의 선례는 이미 있다
`electron/preload.ts:782` 의 `contextBridge.exposeInMainWorld('twixyTestOverlay', { … })` —
Test Progress 오버레이 창만 받는 **두 번째 브릿지**, 6개. 타입은 `src/test-overlay/TestOverlay.tsx:85-95`
에 지역 `declare global` 로 있다.

→ slice 3 은 새 패턴을 도입하는 게 아니라 **이미 한 번 쓰인 패턴을 나머지 창으로 넓히는 것**이다.
`tools: { }` 가 네임스페이스 문법 논쟁을 끝냈듯, 이쪽이 per-window 구조 논쟁을 끝낸다.

### 8.3 Slice 3 인계 — 창별 이름 목록 (Track B 용)

아래는 각 창의 import 폐쇄에서 실제로 호출되는 이름 전부다. **이 목록이 곧 그 창이 받아야 할
표면**이고, `npm run check:preload` 가 슬라이스 후 이를 강제한다.

**sidetab** (8)
```
planGet  onPlanChanged  closeSidetab
overlayRequestSync  overlayStart  overlayResume  overlaySetOpacity  onOverlaySync
```

**composer** (7)
```
planGet  onPlanChanged
overlayRequestSync  overlayStop  overlaySend  overlayTogglePlanMode  onOverlaySync
```

**guardrail** (3)
```
guardrailPopupRequestSync  guardrailPopupDecide  onGuardrailPopupSync
```

**test-overlay** — `twixy` 에서는 2개만 쓰고, 나머지는 이미 전용 브릿지에 있다.
```
twixy:            applyDisplayMarkup  refreshMarkup
twixyTestOverlay: requestSync  onSync  stop  focusMain  close  sendReviewDecision   ← 이미 분리됨
```

**main / twixy-enterprise / nodal** — 당분간 현행 전체 표면. 좁히는 건 별도 과제
(세 창 모두 `src/App.tsx` 를 공유하므로 이득이 작다).

공통으로 필요한 것: `platform`(정적 값), `theme` 계열은 위 목록에 이미 포함돼 있다.

> ⚠️ 인계 시 주의: 이 목록은 **정적 import 폐쇄 기준**이다. `scripts/ipc-sender-check.mjs` 가
> CDP 로 문자열 호출하는 이름(`openTestOverlay`, `getGatewayToken`, `authGetSession`,
> `overlaySend`, `getChannels`, `closeTestOverlay`)은 폐쇄에 안 잡힌다. slice 3 에서 창 표면을
> 좁히면 그 스크립트가 **의도적으로** 실패할 수 있다 — 그건 회귀가 아니라 검사가 작동한 것이고,
> 스크립트를 같이 갱신해야 한다.

---

## 9. 집행 결과 (2026-09-21, slice 1·2·3)

### 9.1 숫자
| | preload fn | ipcMain | main 전용 | 미참조 후보 |
|---|---:|---:|---:|---:|
| slice 0 직후 | 247 | 220 | 1 | 39 |
| slice 1 (죽은 것 18개) | 229 | 220 | 18 | 21 |
| slice 2 (doc-tools 11개) | 218 | 220 | 29 | 10 |
| slice 3 (per-window) | 218 | 220 | 29 | 10 |

채널은 한 번도 안 줄었다 — 이 스테이지는 **렌더러 표면만** 건드린다.
slice 3 은 숫자가 아니라 **창별 표면**을 바꾼다: sidetab 8 · composer 7 · guardrail 3 ·
testOverlay 1(+전용 브릿지 6) · main/enterprise/nodal 218(전체).

### 9.2 계획과 달랐던 것
1. **§8.2 의 "선례" 는 절반만 맞았다.** `twixyTestOverlay` 는 *이름*만 전용이었고
   `exposeInMainWorld` 는 조건 없이 돌아서 **전 창이 받고 있었다**. slice 3 이 그걸
   진짜 per-window 로 만들었다 (`windowKind === 'testOverlay'` 일 때만 노출).
2. **test-overlay 의 twixy 표면은 2개가 아니라 1개다.** `refreshMarkup` 은
   `src/lib/useDisplayUsd.tsx` 의 **주석**에만 나온다 (그래서 baseline 의 "미참조" 에도
   안 걸렸다). 실제 호출은 `applyDisplayMarkup` 뿐.
3. **보조 창이 쓰는 이름은 중복 제거하면 26이 아니라 15다** (+ 전용 브릿지 6 = 21).
   §2 의 26 은 창별 목록의 단순 합에 가깝다.
4. **`closeTestOverlay` 는 안 깨졌다.** `ipc-sender-check.mjs` 는 그걸 **메인 창**에서
   부른다(`main.eval`). 실제로 깨진 건 보조 창에서 부르던 4개
   (`getGatewayToken` `authGetSession` `overlaySend` `getChannels`) 이고, 그건 검사가
   작동한 것이라 스크립트를 같이 고쳤다 — §9.3.
5. **§4a 의 18개는 지금 트리에서도 전부 죽어 있었다.** Stage 4 의 모듈 분할이 되살린
   이름은 없었다. `getProjectRoot` 는 `electron/paths.ts` 의 동명 함수와 무관(main 내부용),
   `pickFolder` 는 `TwixyEnterpriseDashboard` 의 지역 콜백과 동명이인.

### 9.3 창 구분 방식과 검사
- 창은 `electron/windows.ts` 의 `additionalArguments: ['--twixy-window=<kind>']` 로 자기
  종류를 알린다. preload 는 `process.argv` 에서 읽고, 표식이 없으면 전체 표면(main).
  sandbox preload 라 `windowEntry.ts` 를 import 할 수 없어서(상대 require 불가) kind
  문자열만 공유한다.
- `npm run check:preload` 가 창별로 확장됐다: PER_WINDOW 의 이름이 `twixyApi` 에 있는지,
  그 창의 **import 폐쇄**가 부르는 이름이 전부 목록에 있는지, 목록에 **안 부르는 이름이
  섞여 있지 않은지**(표면이 도로 넓어지는 걸 막는다). 폐쇄 계산은
  `scripts/module-closure.mjs` 로 빼서 `check:windows` 와 공유한다.
- 목록을 **적용하는 코드**(kind 파싱·필터·조건부 브릿지)는 `electron/preload.perWindow.test.ts`
  가 electron 없이 검증한다. 창 생성 쪽 표식은 `windows.contract.test.ts`.
- `scripts/ipc-sender-check.mjs` [1] 은 "불러 보고 거부되는가" 대신 "**그 함수가 아예 없는가**"
  를 본다. 더 강한 보장이지만, 진짜 창에서 핸들러 거부 경로를 불러 보는 건 이제 불가능하다
  (부를 함수가 없다) — 그쪽은 `windowEntry.test.ts` · `windows.contract.test.ts` 가 덮는다.

### 9.4 안 한 것
- 네임스페이스: 전혀 안 했다(§8.1 결정 그대로).
- main/enterprise/nodal 표면 좁히기: 셋이 `src/App.tsx` 를 공유해 이득이 작다.
- slice 2 로 참조가 0이 된 payload 타입 15개는 `src/global.d.ts` 에 남겼다 — 채널이 살아
  있고 그 타입이 페이로드 모양의 유일한 문서다. 지우려면 의존 타입까지 묶어 별도 슬라이스.
