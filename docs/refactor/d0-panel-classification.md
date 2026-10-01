# D0 — App.tsx 패널 분류 (lazy mount 대상 선정)

- 기준 commit: `a469b4a` (refactor/c-hygiene, nodal 병합 후) · 문서만, 코드 변경 없음
- 대상: `src/App.tsx` 의 `AuthedApp` 이 마운트하는 모든 패널/화면. 진입 html 세 개
  (`index.html`, `twixy-enterprise.html`, `products/nodal/index.html`) 가 전부 같은 `src/App.tsx` 를 쓴다.
  `sidetab` / `composer` / `guardrail` / `test-overlay` 창은 App 을 거치지 않는다.

## 현재 구조

`AuthedApp` 은 패널 10개를 **전부 시작 시 마운트**하고 `display: active ? 'flex' : 'none'` 으로만 가린다.
탭을 오가도 스크롤·세션·실행이 유지되는 대신, 숨겨진 패널도 (1) 코드가 초기 JS 에 들어가고
(2) 마운트 effect 가 시작 직후 돈다 (IPC 조회, 게이트웨이 RPC, Supabase 구독).

분류 기준:

- **(A) eager 필수** — 실행·구독·게이트웨이 세션을 소유하거나, 랜딩 뷰다. 숨겨져 있어도 돌아야 한다.
- **(B) 첫 방문 때 마운트 → 이후 계속 마운트** — 순수 UI. 상태(스크롤, 선택, 편집 중 내용)는 유지돼야 한다.
- **(C) 자유롭게 mount/unmount 가능** — 유지할 상태가 없다.

확신이 없으면 (A).

## 패널별 분류

| view id | 컴포넌트 (파일) | LOC | 정적으로 끌고 오는 무거운 것 | 숨겨진 채 돌아야 하는 것 | 시작 시 필요 | 분류 |
|---|---|---|---|---|---|---|
| `copilot` | `CopilotView` (`components/copilot/CopilotView.tsx`) | 3695 | marked, dompurify(safeHtml), lucide-react, deck UI(DeckPanel·DeckDesigner·SlidePreview), NodeCanvas, WorkflowNodeCard, LiveBrowserPreview | **있음** — `useCopilotChat`(게이트웨이 세션, 대화 탭별 스트림), `useWorkflowTestSession` + `useWorkflowTest`(테스트 실행), 1초 타이머 | **예 — twixy·nodal 의 랜딩 뷰** | **A** |
| `workflow` | `WorkflowView` (`components/WorkflowView.tsx`) | 980 | marked, lucide-react, NodeCanvas, WorkflowBuilderChat, ToolsCatalog, LiveCollabControls | **있음** — `useWorkflowTest`/`useWorkflowTestSession`(run 소유), `runControlRef`·`onRunStatesChange` 로 Runs 대시보드에 Stop/Resume 브리지 노출, `onTestOverlayStop`·`onTestOverlayReviewDecision` 구독, `useLiveWorkflow`(실시간 공동편집) | 예 (브리지가 App 마운트 시점부터 있어야 함) | **A** |
| `orchestration` | `OrchestrationView` (`components/OrchestrationView.tsx`) | 233 (+ canvas/builder 하위) | OrchestrationCanvas, OrchestrationBuilderChat | **있음** — `useOrchestrationGateway`(자체 게이트웨이 훅) + `useOrchestrationRun`(병렬 실행 소유) | 아니오 (twixy 사이드바에서 숨김) — 그러나 실행 소유 | **A** |
| `dashboard` | `TeamDashboardPanel` (`components/TeamDashboardPanel.tsx`) | 1433 | RunsDashboard, ChatDrawer, WorkflowDiffView, TeamInvite, LiveCollabControls | **있음** — `usePresence`("앱이 켜져 있는 동안" org 채널에 내 상태 track → 언마운트하면 팀원에게 오프라인으로 보임), `subscribeIncomingDMs`(안 읽은 DM 카운트) | 예 (presence) | **A** |
| `chat` | `FilesPanel` + `WorkflowTab` + `ChatPanel` + `WorkflowListsPanel` (+ 조건부 `LiveBrowserPreview`) | 265 + 160 + 2026 + 517 (+418) | marked, dompurify, lucide-react. **`ChatPanel` 이 `./DataPanel` 에서 `toCSV`/`downloadCSV` 를 정적 import → DataPanel + tiptap + papaparse 전체가 따라온다** | 세션 자체는 App 의 `useOpenClaw` 소유라 패널은 표시 계층. 단 `pendingChip` 소비, `onPlanChanged` 프리뷰 갱신, 자동 스크롤, 1초 타이머가 있고 Smart Export·Ask-about·Planning Mode 가 **내부 라우팅으로 이 뷰에 도달**한다 | twixy 에서는 사이드바에 없음(legacy). 내부 라우팅 전용 | **A** (보수적) — 이론상 B 후보지만 Planning/Overlay 경로 검증 없이는 건드리지 않는다. leg 2 후보 |
| `data` (`strategies`·`reports` 공유) | `DataPanel` (`components/DataPanel.tsx`) | 1529 | **tiptap(@tiptap/react, starter-kit, table×4, markdown → prosemirror), papaparse**, marked, lucide-react. tiptap·papaparse 는 저장소 전체에서 이 파일만 쓴다 | 없음 — 구독·타이머·게이트웨이 없음. 마운트 effect 는 디렉터리 목록 조회와 리사이즈 핸들 리스너뿐. `fileToOpen` prop 은 마운트 시점 값으로도 동작(effect 가 마운트 때 실행) | 아니오 | **B** |
| `settings` | `SettingsPanel` (`components/SettingsPanel.tsx`) | 2906 | GuardrailSettings, 자체 코드량이 큼 (useAuth·useEntitlements·supabase 는 이미 App 이 씀) | 없음 — 마운트 effect 10여 개가 전부 1회성 조회(`getChannels`, `memoryRead`, `designatedPathsGetConfig`, `getAuthProfiles`, `getAgentModel`, connections, MCP, gws, **`cron.cronList()` 게이트웨이 RPC**). 60초 `setInterval` 은 "resets in Xh" 라벨 갱신용. 구독 없음. 이미 `visible` prop 으로 usage 조회를 늦춘 전례가 있다("콜드 게이트웨이를 때려 시작이 느려진다") | 아니오 | **B** |
| `skills` | `SkillsPanel` (`components/SkillsPanel.tsx`) | 1276 | 없음 (DisplayCost, safeHtml — 이미 공유) | 없음 — `onSkillsChanged` 구독은 자기 목록 갱신용. 첫 마운트 때 어차피 새로 조회 | 아니오 (twixy 사이드바에서 숨김) | **B** |
| `mr` | `MergeRequestPanel` (`components/MergeRequestPanel.tsx`) | 696 | 없음 | 없음 — `onMRChanged` 는 자기 목록 갱신용. 사이드바 배지 등 패널 밖으로 나가는 상태 없음 | 아니오 (숨김) | **B** |
| `admin` (twixy·nodal) | `AdminPanel` (`components/AdminPanel.tsx`) | 444 | 없음 | 없음 — `onMRChanged` → 자기 통계 갱신 | 아니오 (숨김) | **B** |
| `admin` (twixy-enterprise) | `TwixyEnterpriseDashboard` (`admin/TwixyEnterpriseDashboard.tsx`) | 606 | marked, safeHtml (이미 공유) | 없음 — 조회 + keydown 리스너 | **예 — twixy-enterprise 의 랜딩 뷰** (`initialView: 'admin'`) | **B**, 단 enterprise 에서는 첫 렌더에 곧바로 "방문" 된다 → lazy 로 해도 시작 직후 로드. 랜딩이 한 프레임 fallback 을 거친다는 점만 다르다 |

### 패널이 아닌 셸 구성요소 (전부 eager 유지)

`Sidebar`(108) · `StatusBar`(245) · `UpdateBanner`(71) · `UpgradeModal`(211) · `NoCreditsModal`(59) ·
`LoginScreen`(85) · `ConnectingSplash`(54) · `SetupScreen`(310). 합쳐 1.1k LOC, 무거운 의존성 없음.
모달·SetupScreen 은 (C) 로 볼 수 있지만 얻는 게 수 KB 라 손대지 않는다. SetupScreen 은 기동 오류 복구 화면이라
"청크 로드 실패" 와 겹칠 수 있는 경로에 두지 않는 게 맞다.

## 결론 — D1 에서 lazy 로 돌릴 대상

| 대상 | 분류 | 근거 | 기대 효과 |
|---|---|---|---|
| `DataPanel` | B | 순수 UI. tiptap/prosemirror + papaparse 의 유일한 사용처 | 가장 큼. **단, `ChatPanel → DataPanel` 정적 import (`toCSV`/`downloadCSV`) 를 끊어야** 실제로 초기 그래프에서 빠진다. 안 끊으면 Rollup 이 DataPanel 을 정적 청크에 그대로 둔다 |
| `SettingsPanel` | B | 순수 UI + 1회성 조회 | 자체 코드 2.9k LOC + 시작 직후 IPC 10여 회·`cron.list` RPC 가 첫 방문으로 미뤄짐 |
| `SkillsPanel` | B | 순수 UI | 1.3k LOC. twixy 에서는 사이드바에 없어 대부분 세션에서 아예 로드 안 됨 |
| `MergeRequestPanel` | B | 순수 UI | 0.7k LOC. 위와 같음 |
| `AdminPanel` / `TwixyEnterpriseDashboard` | B | 순수 UI. 제품 플래그로 둘 중 하나만 로드 | 지금은 두 컴포넌트가 모든 제품 번들의 초기 JS 에 같이 들어 있다 |

**eager 로 남기는 것과 이유**

- `CopilotView` — 랜딩 + 게이트웨이 세션 + 테스트 실행 소유.
- `WorkflowView` — run 브리지(`runControlRef`/`onRunStatesChange`) + test-overlay 구독. 다른 탭에 있는 동안 실행이 계속돼야 한다.
- `OrchestrationView` — 자체 게이트웨이 훅 + 병렬 실행 소유.
- `TeamDashboardPanel` — presence track 과 DM 구독이 앱 수명 동안 유지돼야 한다.
- chat 컨테이너(`ChatPanel` 등) — 내부 라우팅(Smart Export, Ask-about, Planning Mode PlanCard)의 도착지. 표시 계층이긴 하지만
  overlay/plan 경로를 패키지 빌드에서 검증하기 전에는 옮기지 않는다.

## 관찰 (이번 단계에서 고치지 않음)

1. **`PRODUCT.features.panels` 는 선언만 있고 App.tsx 가 읽지 않는다.** `shared/product/types.ts` 주석은
   "여기 없는 패널은 번들에서도 빠진다(lazy import)" 라고 하지만, nodal(`panels: ['copilot','data','settings']`) 도
   WorkflowView·OrchestrationView·TeamDashboardPanel 을 마운트한다 (= 워크플로 러너 훅·presence 구독이 nodal 에서도 돈다).
   B 패널은 D1 의 "방문 전에는 렌더 안 함" 으로 자연히 해결되지만, A 패널을 제품별로 빼는 것은 제품 결정이다.
2. **`SidetabOverlay` 가 `./ChatPanel` 에서 `friendlyTool` 하나를 가져오느라 sidetab 창이 ChatPanel 청크 전체
   (≈613 KB, DataPanel·tiptap 포함)를 받는다.** `sidetab.html` 초기 JS 868 KB 중 대부분. `friendlyTool` 을 lib 로
   빼면 해결되지만 App.tsx/lazy 와 무관한 별도 작업.
3. `src/components/DashboardPanel.tsx` 는 어디서도 import 되지 않는다 (DataPanel 의 `buildTable` 을 쓰는 죽은 코드 후보).
