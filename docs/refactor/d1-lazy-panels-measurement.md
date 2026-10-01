# D1 — 첫 방문 lazy 패널: 초기 JS 측정

- 대상 분류: `d0-panel-classification.md` 의 (B) — DataPanel · SettingsPanel · SkillsPanel · MergeRequestPanel · AdminPanel/TwixyEnterpriseDashboard
- BEFORE: `a469b4a` (코드 기준. `a4d3fa0` 는 문서만 추가) · AFTER: 이 문서가 들어간 커밋
- 환경: Windows 11 x64 · node v24.13.0 · vite 6.4.1 · 제품 프로필 `twixy` (`tmp/product.json`, entry `index.html`)
- 빌드: `node_modules/.bin/vite build` (sourcemap 없음 — production 조건 그대로)

## 재는 법

`node scripts/measure-initial-js.mjs` — dist 의 html 마다 `<script type="module">` 에서 출발해
**정적 import 만** 따라간 폐포의 raw bytes 합. `import("…")` 동적 import 는 첫 방문 때 받으므로 제외한다.
파일 하나의 크기만 보면 "코드가 다른 정적 청크로 옮겨갔을 뿐" 인 경우를 구분할 수 없어서 폐포로 잰다.
결과는 빌드된 `index.html` 의 `modulepreload` 목록(main + 4개)과 일치한다 (BEFORE/AFTER 모두 확인).

Electron 은 JS 를 디스크에서 읽으므로 전송량(gzip)보다 **raw bytes = 파싱·컴파일할 양** 이 의미 있는 숫자다. gzip 은 참고용.

## 결과 요약

| 진입 html | BEFORE 초기 JS | AFTER 초기 JS | 차이 | gzip (참고) |
|---|---|---|---|---|
| **`index.html` (메인 창)** | **1,924,615** | **1,272,367** | **−652,248 (−33.9%)** | 582,302 → 387,534 |
| `sidetab.html` | 867,686 | 336,476 | −531,210 (−61.2%) | 271,492 → 104,778 |
| `test-overlay.html` | 452,191 | 452,191 | 0 | — |
| `guardrail.html` | 203,915 | 203,915 | 0 | — |
| `composer.html` | 200,863 | 200,863 | 0 | — |
| dist/assets JS 전체 | 1,969,111 (10 파일) | 1,971,835 (15 파일) | +2,724 (청크 경계 오버헤드) | — |

**판정: 유지한다.** 메인 창이 시작할 때 파싱하는 JS 가 1/3 줄었다. 전체 JS 는 사실상 그대로(+2.7 KB) — 없앤 게 아니라
"안 여는 화면의 코드를 안 읽는 것" 이다.

## dist/assets JS 청크 (raw bytes)

| BEFORE | bytes | AFTER | bytes |
|---|---|---|---|
| main-BR6vfQXN.js | 873,261 | main-Cc59gEyh.js | 752,223 |
| ChatPanel-ej7qS0Jl.js | 613,024 | ChatPanel-Bvg_VBU3.js | 81,814 |
| useDisplayUsd-DyEj_CtO.js | 200,720 | useDisplayUsd-zsJ3GQ1O.js | 200,720 |
| globals-DF0uggCf.js | 195,467 | globals-D71z3b4D.js | 195,467 |
| marked.esm-Bf3RmHRd.js | 42,143 | marked.esm-Bf3RmHRd.js | 42,143 |
| sidetab-DgCOJ6Pk.js | 16,791 | sidetab-CkGCdMR8.js | 16,791 |
| testOverlay-BbH6RDOL.js | 13,861 | testOverlay-KMzJzBfA.js | 13,861 |
| guardrail-BX2aGdo4.js | 8,448 | guardrail-BgltaCjJ.js | 8,448 |
| composer-16_YoRrK.js | 5,135 | composer-DFjSMOqS.js | 5,135 |
| useOverlaySync-CG0HRYNJ.js | 261 | useOverlaySync-BaydQlo2.js | 261 |
| — | | **DataPanel-CAswM_x0.js** (lazy) | 527,294 |
| — | | **SettingsPanel-BWn5OwYX.js** (lazy) | 69,788 |
| — | | **SkillsPanel-DiekzV0c.js** (lazy) | 33,300 |
| — | | **MergeRequestPanel-CYMCiWxa.js** (lazy) | 13,272 |
| — | | **AdminPanel-BPMgzM3A.js** (lazy) | 11,318 |

### `index.html` 정적 폐포

| BEFORE | bytes | AFTER | bytes |
|---|---|---|---|
| main | 873,261 | main | 752,223 |
| ChatPanel | 613,024 | ChatPanel | 81,814 |
| useDisplayUsd | 200,720 | useDisplayUsd | 200,720 |
| globals | 195,467 | globals | 195,467 |
| marked.esm | 42,143 | marked.esm | 42,143 |
| **합** | **1,924,615** | **합** | **1,272,367** |

## 어디서 줄었나

1. **DataPanel 527 KB — 전체 절감의 81%.** tiptap(@tiptap/* → prosemirror) 과 papaparse 는 저장소에서 DataPanel 만 쓴다.
   BEFORE 에서는 이게 `ChatPanel` 청크 안에 있었다: `ChatPanel.tsx` 가 `toCSV`/`downloadCSV` 두 함수 때문에
   `./DataPanel` 을 정적으로 import 했고, `SidetabOverlay` 가 `./ChatPanel` 의 `friendlyTool` 을 쓰므로 Rollup 이
   둘을 한 공유 청크로 묶었다. **App.tsx 에서 DataPanel 을 `lazy()` 로 바꾸기만 했다면 효과는 0 이었다** — 정적 import 가
   하나라도 남으면 모듈은 정적 청크에 남는다. 그래서 두 함수를 `src/lib/csvExport.ts` 로 옮기고 `ChatPanel` 의 import 를
   바꿨다 (DataPanel 은 기존 경로 호환용으로 재-export).
   → sidetab 창의 −531 KB 는 이 분리의 부수 효과다.
2. **Settings + Skills + MR + Admin — lazy 청크 합 128 KB** (69.8 + 33.3 + 13.3 + 11.3). main 청크는 873 → 752 KB (−121 KB).
3. `TwixyEnterpriseDashboard` 는 twixy 빌드 산출물에 **청크 자체가 없다**: `PRODUCT.features.enterpriseAdmin` 이 빌드 시
   상수라 Rollup 이 안 쓰는 쪽 `import()` 를 지웠다. BEFORE 에서는 두 컴포넌트가 모든 제품의 main 에 같이 들어 있었다.

## 바이트로 안 잡히는 효과

숨겨진 채 마운트되던 패널의 시작 직후 작업이 첫 방문으로 미뤄진다:
SettingsPanel 의 1회성 조회 10여 개(`getChannels`, `memoryRead`, `designatedPathsGetConfig`, `getAuthProfiles`,
`getAgentModel`, connections / MCP / gws refresh)와 **게이트웨이 `cron.list` RPC**, SkillsPanel 의 `listSkills`·`getSkillStats`,
MergeRequestPanel·AdminPanel 의 MR/통계 조회. twixy 에서는 skills/mr/admin 이 사이드바에 없어서 대부분 세션에서 아예 안 돈다.
콜드 스타트 시간은 재지 않았다 (기준선에 측정 절차가 아직 없음 — baseline README "아직 기준선에 없는 것").

## 구현 메모

- `src/components/LazyPanel.tsx` 의 `lazyPanel(load)` — `React.lazy` + `<Suspense>`(Spinner) + 에러 바운더리(Retry).
  `React.lazy` 는 실패한 promise 를 캐시하므로 Retry 는 **그 패널의 lazy 만** 새로 만든다 (다른 패널 identity 를 건드리면 상태를 잃는다).
  테스트: `LazyPanel.test.tsx` — 렌더 전에는 load 안 함 / 실패 → Retry → 재로드, 이웃 패널 상태 유지.
- `App.tsx` 의 `visited: Set<View>` — 방문 전에는 lazy 패널을 **렌더하지 않는다** (숨긴 채 렌더하면 import 가 즉시 시작).
  한번 들어가면 빠지지 않으므로 방문 후에는 기존과 동일하게 계속 마운트 + display 토글.
- 동적 import 와 preload 는 전부 상대 URL (`import.meta.url` 기준 `new URL(dep, importer)`) 로 나온다 —
  패키지 앱의 `file://` 에서 정적 청크와 같은 방식으로 풀린다. CSP 없음, `electron-builder` `files: ['**/*']` 라 새 청크도 포함된다.

## 남은 위험 / 패키지 빌드에서 직접 확인할 것

- lazy 패널 5개 각각 첫 진입 (Spinner 가 한 프레임 보일 수 있음) → 다른 탭 → 복귀 시 스크롤·선택·편집 중 내용 유지
- Copilot/Chat 의 파일 링크 클릭 → **DataPanel 이 아직 로드 전인 상태에서** 해당 파일이 열리는지 (`fileToOpen` 은 마운트 시점 값으로 동작)
- DataPanel "Ask about" / "Smart Export" → chat 뷰로 전환 + 칩/프롬프트 전달
- ChatPanel 의 CSV 내보내기 (`toCSV`/`downloadCSV` 이동) — 파일이 BOM 포함 UTF-8 로 열리는지
- twixy-enterprise: 랜딩이 admin 이라 시작 직후 곧바로 lazy 로드된다 — 스플래시 뒤 대시보드가 정상 표시되는지
- 워크플로 실행 중 Settings/Data 를 처음 여는 동안 실행이 끊기지 않는지 (A 패널은 건드리지 않았으므로 기대: 영향 없음)

## 다른 제품 entry (AFTER 만 — 빌드가 깨지지 않는지 확인)

`APP_MODE=<id> tsx scripts/write-product.ts` → `vite build` → `measure-initial-js.mjs`. BEFORE 는 twixy 만 쟀다.

| 제품 | 진입 html | AFTER 초기 JS | lazy 청크 | 비고 |
|---|---|---|---|---|
| twixy-enterprise | `twixy-enterprise.html` | 1,274,304 (5 파일) | DataPanel 527,294 · SettingsPanel 69,788 · SkillsPanel 33,300 · **TwixyEnterpriseDashboard 14,133** · MergeRequestPanel 13,272 | `AdminPanel` 청크는 없다 (빌드 시 상수로 제거). 랜딩이 admin 이라 대시보드 청크는 시작 직후 로드된다 |
| nodal | `products/nodal/index.html` | 1,278,916 (main 1,083,449 + globals 195,467) | DataPanel 527,183 · SettingsPanel 69,682 · SkillsPanel 33,221 · MergeRequestPanel 13,272 · AdminPanel 11,318 | sidetab/test-overlay entry 가 없어 공유 청크 없이 main 하나. BEFORE 는 lazy 청크 합(≈655 KB)만큼 컸을 것으로 **추정** (미측정) |

보조 창(`sidetab` / `composer` / `guardrail` / `test-overlay`)은 App.tsx 를 거치지 않는다 — 위 표의 수치 외 변화 없음.

---

# D3 — `useDisplayUsd-*.js` 청크(≈196 KB)의 정체

방법: AFTER 코드로 `vite build --sourcemap --outDir tmp/dist-sourcemap` (gitignore 된 tmp, 커밋 없음. 청크 해시가
production 빌드와 동일함을 확인) → `.map` 의 mappings 를 디코드해 생성 코드 구간별 바이트를 소스 모듈에 귀속.
플러그인·의존성 추가 없음 (`@jridgewell/sourcemap-codec` 는 vite 가 이미 끌고 온 것).

## 결과 — 97% 가 Supabase SDK 다

| 모듈 | bytes | 비중 |
|---|---|---|
| `@supabase/auth-js` | 91,396 | 45.6% |
| `@supabase/realtime-js` | 28,764 | 14.3% |
| `@supabase/phoenix` (realtime 의 의존성) | 25,017 | 12.5% |
| `@supabase/storage-js` | 19,819 | 9.9% |
| `@supabase/postgrest-js` | 14,068 | 7.0% |
| `@supabase/supabase-js` | 6,644 | 3.3% |
| `iceberg-js` (storage-js 의 의존성) | 5,531 | 2.8% |
| `@supabase/functions-js` | 2,730 | 1.4% |
| `tslib` | 635 | 0.3% |
| **Supabase 계열 소계** | **194,604** | **97.0%** |
| `src/lib/useDisplayUsd.tsx` | 1,893 | 0.9% |
| `src/lib/entitlements.ts` | 1,885 | 0.9% |
| `src/lib/supabase.ts` | 1,057 | 0.5% |
| `products/twixy/profile.ts` | 646 | 0.3% |
| `src/lib/modelPricing.ts` (+ `modelCatalog.json`) | 540 | 0.3% |

훅 자체는 1.9 KB 다. Rollup 은 공유 청크에 "그 안의 모듈 하나" 의 이름을 붙일 뿐이라 이름이 내용을 말해주지 않는다.

## 왜 이 묶음인가

Rollup 은 "어떤 entry 들이 이 모듈에 도달하는가" 가 같은 모듈끼리 한 청크로 묶는다. 이 청크는
**main 과 test-overlay 두 entry 가 공유하는 모듈** 의 집합이고, 그렇게 된 경로는 이렇다:

```
src/test-overlay/TestOverlay.tsx
  → src/lib/useDisplayUsd.tsx        (DisplayCost 표시용)
    → src/lib/modelPricing.ts
      → src/lib/entitlements.ts      (FREE_PLAN 상수 하나 때문에)
        → src/lib/supabase.ts        (모듈 최상위에서 createClient)
          → @supabase/supabase-js    (auth · realtime · storage · postgrest · functions 전부)
```

즉 **워크플로 테스트 진행 overlay 창이 비용 문자열 하나를 찍으려고 Supabase SDK 전체를 받고, 자기 창에서
`createClient({ persistSession, autoRefreshToken })` 를 한 번 더 실행한다.** `test-overlay.html` 초기 JS 452 KB 중 196 KB 가 이것.
메인 창에는 영향이 없다 — 메인은 로그인 게이트(useAuth) 때문에 어차피 첫 화면 전에 Supabase 가 필요하다.

참고로 같은 빌드의 다른 청크:
`globals` 195 KB = react-dom 93% (css 이름이 붙었지만 React 런타임 청크) ·
`DataPanel` 527 KB = prosemirror-* + @tiptap/* 84% (npm 전체 95%), papaparse 3.7%, DataPanel 자체 5.1% ·
`ChatPanel` 82 KB = ChatPanel 47% + dompurify 36% ·
`main` 752 KB 상위 = CopilotView 89.5 KB, OrchestrationCanvas 41.8 KB, `WORKFLOW_SOUL.md?raw` 33.4 KB, TeamDashboardPanel 32.1 KB,
useOpenClaw 30.5 KB, `CONTENT_SOUL.md?raw` 28.9 KB.

## 권고

1. **`manualChunks` 로는 메인 창 초기 JS 가 1 byte 도 줄지 않는다.** Supabase 는 로그인 게이트에 필요해서 어디에 담든
   시작 시 읽힌다. `manualChunks: { supabase: ['@supabase/supabase-js'] }` 는 청크 **이름** 을 바로잡는 효과뿐 — 하려면
   가독성·캐시 안정성 목적으로 leg 2 에서. 크기 최적화로 기대하지 말 것.
2. **실제로 고칠 곳은 import 사슬이다 (leg 2 후보, 작은 변경).** `FREE_PLAN` 은 순수 상수인데 `entitlements.ts` 에 있어서
   `modelPricing → entitlements → supabase` 가 이어진다. `FREE_PLAN`(과 `LIMITS` — 둘 다 순수 상수)을 부작용 없는 모듈
   (예: `src/lib/freePlan.ts`)로 옮기고 `entitlements.ts` 는 재-export 하면:
   - `test-overlay.html` 초기 JS 452 KB → 약 254 KB (−44%, 추정: 현재 폐포에서 SDK 분량을 뺀 값)
   - overlay 창이 두 번째 Supabase auth 클라이언트(자동 토큰 갱신 타이머 포함)를 만들지 않는다 — 크기보다 이쪽이 더 중요하다
   - 메인 창 수치는 변화 없음
   이번 D1 에서 `toCSV` 를 옮긴 것과 같은 종류의 수정이다: **순수 함수·상수가 무거운 모듈에 얹혀 있어서 그래프가 묶이는 패턴.**
   같은 패턴이 하나 더 있다 — `SidetabOverlay → ChatPanel(friendlyTool)` (d0 문서 관찰 2). `friendlyTool` 을 lib 로 빼면
   `sidetab.html` 이 ChatPanel+dompurify 청크(82 KB)를 안 받는다.
3. SDK 안에서 안 쓰는 부분: `supabase.storage` 호출은 저장소에 없다 (storage-js + iceberg-js ≈ 25 KB). 하지만
   `createClient` 가 하위 클라이언트를 전부 정적으로 엮어서 tree-shaking 으로는 안 빠진다. 하위 클라이언트를 직접 조립하는 건
   25 KB 에 비해 유지비가 크다 — **하지 않는 걸 권한다.**

---

# Leg 2 — import 사슬 두 곳 끊기

D3 와 d0 관찰 2 에서 찾은 "순수 상수·함수가 무거운 모듈에 얹혀 있어서 그래프가 묶이는" 패턴 두 건.
BEFORE = leg 1 의 AFTER (`adec419`). 제품 twixy, `vite build`, raw bytes.
재현: `node scripts/measure-initial-js.mjs --contains GoTrueClient`
(`GoTrueClient` 는 auth-js 가 minify 뒤에도 문자열로 남기는 표지 — 이게 폐포에 있으면 그 창은 `supabase.ts` 를 평가하고,
`supabase.ts` 는 import 되는 순간 `createClient({ persistSession: true, autoRefreshToken: true })` 를 실행한다.)

## L2-1. `FREE_PLAN`/`LIMITS` → `src/lib/planLimits.ts` — test-overlay 창의 두 번째 Supabase 클라이언트 제거

`modelPricing.ts` 가 `FREE_PLAN` 상수 하나 때문에 `entitlements.ts` 를 import → `supabase.ts` → SDK 전체.
`Tier`·`TierLimits`·`FREE_PLAN`·`LIMITS` 를 부작용 없는 `planLimits.ts` 로 텍스트 그대로 옮기고, `entitlements.ts` 는 재-export
(나머지 importer 6곳 무변경), `modelPricing.ts` 만 `planLimits` 를 직접 import.

| 진입 html | BEFORE | AFTER | 차이 | Supabase 클라이언트 BEFORE → AFTER |
|---|---|---|---|---|
| `index.html` | 1,272,367 | 1,272,735 | +368 | 있음(필요 — 로그인 게이트) → 있음 |
| **`test-overlay.html`** | **452,191** | **255,051** | **−197,140 (−43.6%)** | **있음(우연) → 없음** |
| `sidetab.html` | 336,476 | 336,476 | 0 | 없음 → 없음 |
| `composer.html` | 200,863 | 200,863 | 0 | 없음 → 없음 |
| `guardrail.html` | 203,915 | 203,915 | 0 | 없음 → 없음 |
| dist/assets JS 전체 | 1,971,835 | 1,972,203 | +368 | |

- AFTER 에서 `GoTrueClient` 를 포함한 파일은 `main-*.js` **하나뿐**이다. 보조 창 폐포의 모든 청크
  (`testOverlay`, `sidetab`, `composer`, `guardrail`, `useOverlaySync`, `useDisplayUsd`, `marked.esm`, `ChatPanel`, `globals`)에서
  `supabase` / `createClient` 문자열 0건, 동적 `import(` 0건 — 나중에 lazy 로 받아올 경로도 없다.
- Supabase 가 실제로 **필요한** 보조 창은 없다 (소스에서도 네 창 모두 supabase 를 import 하지 않는다).
- 청크 구성 변화: SDK 는 이제 main 전용이라 `main` 으로 들어갔다 (752 KB → 950 KB). `useDisplayUsd-*.js` 는 200,720 → **3,580 bytes**
  (훅 + modelPricing + planLimits) — 이름과 내용이 드디어 일치한다. 메인 창 총량은 그대로(+368 bytes).
- 의미: 크기보다 **정합성**. overlay 창이 메인 창과 같은 저장소(localStorage)의 세션으로 auth 클라이언트를 하나 더 띄워
  `autoRefreshToken` 타이머를 돌리고 있었다 — refresh token 회전을 두 클라이언트가 경합할 수 있는 구조였다.

## L2-2. `friendlyTool` → `src/lib/friendlyTool.ts` — sidetab 창이 ChatPanel 을 통째로 받지 않게

`SidetabOverlay.tsx` 가 `friendlyTool` 하나 때문에 `./ChatPanel` 을 import → main 과 sidetab 이 ChatPanel 청크
(ChatPanel 38 KB + dompurify 29 KB + ExecutionPlanReport + PlanCard + useFileDropZone)를 공유하고 있었다.
함수를 텍스트 그대로 lib 로 옮기고 ChatPanel 은 재-export (`ChatPanel.test.ts` 무변경), SidetabOverlay 의 import 한 줄만 변경.
BEFORE = L2-1 의 AFTER (`af4222c`).

| 진입 html | BEFORE | AFTER | 차이 | Supabase 클라이언트 |
|---|---|---|---|---|
| **`sidetab.html`** | **336,476** | **284,404** | **−52,072 (−15.5%)** | 없음 → 없음 |
| `index.html` | 1,272,735 | 1,272,704 | −31 | 있음 → 있음 (main 전용) |
| `test-overlay.html` | 255,051 | 255,046 | −5 | 없음 → 없음 |
| `composer.html` | 200,863 | 200,863 | 0 | 없음 → 없음 |
| `guardrail.html` | 203,915 | 203,920 | +5 | 없음 → 없음 |
| dist/assets JS 전체 | 1,972,203 | 1,972,135 | −68 | |

- d0/D3 에서 "82 KB 를 안 받게 된다" 고 적었던 것은 과대평가였다 — **실제 절감은 52 KB.** `SidetabOverlay` 는 `safeHtml`(dompurify 29.7 KB)을
  직접 쓰므로 그 부분은 sidetab 에 정당하게 남는다. 빠진 것은 ChatPanel·PlanCard·ExecutionPlanReport·useFileDropZone 의 코드다.
- 청크 구성 변화: `ChatPanel-*.js` 청크가 사라지고 (main 전용이 되어 `main` 으로 합쳐짐, 950 KB → 1,002 KB),
  main∩sidetab 공유분은 `safeHtml-*.js` 29,743 bytes (dompurify + safeHtml + friendlyTool) 가 됐다.

## Leg 1 + Leg 2 누적 (twixy, raw bytes)

| 진입 html | 시작점 (`a469b4a`) | 지금 | 누적 |
|---|---|---|---|
| `index.html` | 1,924,615 | 1,272,704 | −651,911 (−33.9%) |
| `sidetab.html` | 867,686 | 284,404 | −583,282 (−67.2%) |
| `test-overlay.html` | 452,191 | 255,046 | −197,145 (−43.6%) |
| `composer.html` | 200,863 | 200,863 | 0 |
| `guardrail.html` | 203,915 | 203,920 | +5 |

Supabase auth 클라이언트를 만드는 창: 시작점 = 메인 + test-overlay → 지금 = **메인 하나**.

## Leg 2 이후 다른 제품 entry (빌드 확인 + 수치)

`APP_MODE=<id> tsx scripts/write-product.ts` → `vite build` → `measure-initial-js.mjs --contains GoTrueClient`. 둘 다 빌드 성공.
확인 뒤 제품은 twixy 로 되돌렸다.

| 제품 | 진입 html | leg 1 AFTER | leg 2 AFTER | Supabase 클라이언트 |
|---|---|---|---|---|
| twixy-enterprise | `twixy-enterprise.html` | 1,274,304 | 1,274,625 (+321) | main 만 |
| twixy-enterprise | `sidetab.html` / `test-overlay.html` / `composer.html` / `guardrail.html` | (twixy 와 동일 구조) | 284,404 / 255,046 / 200,863 / 203,920 | 전부 없음 |
| nodal | `products/nodal/index.html` | 1,278,916 | 1,278,910 (−6) | main 만 |
| nodal | `guardrail.html` | 203,920 | 203,920 | 없음 |

nodal 은 sidetab/test-overlay entry 자체가 없어서(`features.sidetab/workflows = false`) leg 2 의 두 수정이 바이트에 영향을 주지 않는다.
