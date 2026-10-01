# feature/windows-compat vs main — 변경사항 상세

이 문서는 현재 `feature/windows-compat` 브랜치가 `main` 과 비교해 어떤 변경을 포함하는지 정리한다.
커밋된 2건 + 워킹트리의 미커밋 변경 + 새로 추가된 8개 파일을 모두 포함.

**요약 통계**


| 지표                | 값      |
| ----------------- | ------ |
| 신규 파일 (untracked) | 8      |
| 수정 파일             | 10     |
| 삭제 파일             | 4      |
| 삽입 라인             | ~1,993 |
| 삭제 라인             | ~2,246 |
| 브랜치 커밋 수          | 2      |


---

## Theme A — Planning Mode (신규, 미커밋)

Cursor 스타일의 계획 → 승인 → 스텝 실행 → 일시정지/재개 흐름.
사용자 프롬프트를 단일 턴 tool-loop 으로 쏘지 않고, 먼저 **plan.json** 을 만들어 UI 에 보여주고 승인 후에 **스텝 단위 `sessions.send`** 로 실행한다. 모든 진행 기록은 **run.md** 에 라이브로 append 된다.

### 신규 파일

#### `[electron/planning.ts](electron/planning.ts)` (458 lines)

LLM 호출 없음. 순수 Plan 파일 IO 모듈.

- **디스크 레이아웃** (각 프로젝트의 `user/plans/<plan_id>/` 하위):
  - `plan.json` — 머신 권위 상태 (source of truth)
  - `plan.md` — 사람이 읽기용 draft (JSON 바뀔 때마다 재생성)
  - `run.md` — 실행 라이브 로그 (스텝마다 append)
- **주요 함수**:
  - `createPlan()` — 디렉토리 scaffold + plan.json/plan.md 기록
  - `readPlan` / `writePlan` / `listPlans` — 기본 CRUD, createdAt desc 정렬 + status 필터
  - `beginRun()` — `status='running'` 전환, run.md 헤더 초기화
  - `startStep()` / `endStep()` — plan.json step 상태 갱신 + run.md 에 마커/소요시간/요약/tool 콜/artifact 추가
  - `requestPause()` / `markPaused()` / `markAborted()` / `finalizePlan()` — 라이프사이클 전환
  - `renderPlanMd()` — plan.json → plan.md 직렬화
- **타입**: `Plan`, `PlanStep`, `PlanStepStatus`, `PlanStatus`, `CreatePlanInput`, `StepEndPayload`, `PlanPatch`

#### `[src/hooks/usePlans.ts](src/hooks/usePlans.ts)` (536 lines)

Planning Mode 오케스트레이터 React hook. LLM 플래너 호출 + 스텝 실행 + PlanCard 메시지 관리 담당.

- **주요 export**:
  - `enterPlanMode(userPrompt)` — 유저 프롬프트 → 플래너 LLM → JSON 파싱 → planCreate → PlanCard 버블 삽입
  - `updatePlanViaChat(userMessage)` — draft/paused plan 을 유저의 후속 채팅으로 편집 → `buildPatchPrompt` 로 planner 재호출 → planUpdate → 원본 JSON 버블 제거
  - `runFromCurrent(planId)` — `currentStepIdx` 부터 스텝 루프 실행 (pauseRequested 체크 + `sendAndAwaitFinal` + 마커 파싱 + run.md append)
  - `pausePlan` / `resumePlan` / `buildPlan` / `revealRun`
- **헬퍼**:
  - `[extractPlanJson](src/hooks/usePlans.ts:51)` — 먼저 ````twixy:plan` 블록, 없으면 generic JSON fence, 그것도 없으면 bare JSON 객체 regex 순으로 fallback
  - `[correctPlannerText](src/hooks/usePlans.ts:74)` — Flash 2.5 (`correctLanguage` IPC) 로 플래너 raw 응답 한글 교정. 교정 후 `extractPlanJson` 재파싱으로 JSON 구조 깨지면 원본으로 회귀 (safety guard).
  - `[parseStepMarker](src/hooks/usePlans.ts:91)` — `[step-done]` / `[step-failed]` 마커 추출
  - `[loadPriorRunSamples](src/hooks/usePlans.ts:102)` — 완료된 plan 의 run.md 들을 planner 에 "prior runs" 로 주입 (work template 재사용)
  - `[loadInstalledSkills](src/hooks/usePlans.ts:120)` — 설치된 skill 목록을 planner 에 주입
- **프롬프트 빌더** (이번 세션에서 SOUL.md 우선순위 이슈로 크게 수정됨):
  - `[buildPlannerPrompt](src/hooks/usePlans.ts:135)` — 플래너에게 3–7 스텝 JSON 스펙 + SOUL.md 침범 금지 가이드
  - `[buildStepPrompt](src/hooks/usePlans.ts:234)` — 스텝을 "유저의 다음 메시지" 로 프레이밍. SOUL.md/SKILLS.md 등 워크스페이스 규칙이 **언제나** 우선한다고 명시
  - `[buildPatchPrompt](src/hooks/usePlans.ts:196)` — plan 편집용
  - `[buildOutcomePrompt](src/hooks/usePlans.ts:268)` — 완료 후 Outcome 3문장 요약

#### `[src/components/PlanCard.tsx](src/components/PlanCard.tsx)` (264 lines)

Assistant 메시지 버블 자리에 들어가는 plan 카드 UI. `msg.planId` 있으면 텍스트 버블 대신 이게 렌더됨.

- **Props**: planId, generating, onBuild/onPause/onResume/onDelete/onRevealRun
- **렌더**: 제목 + status 배지 + progress 카운터 + skillsReferenced + 스텝 리스트 (✅/❌/⏸/⤼/▶/·)
- **라이브 업데이트**: `window.twixy.onPlanChanged` 구독으로 disk 변경 시 자동 리프레시
- **액션 바**: draft → ▶ Build, running → ⏸ Pause, paused → ▶ Resume + 편집 안내, done → 📄 View run log, + Delete
- **상태 색상**: done=#4ade80, failed=#f87171, running=#60a5fa, paused=#fbbf24

### 수정된 파일

#### `[src/hooks/useOpenClaw.ts](src/hooks/useOpenClaw.ts)` (+166 lines)

- **Message 필드 확장**: `planId?: string` (PlanCard 렌더링 트리거), `toolCalls?: Array<{name, detail?}>` (run.md 기록용)
- **Turn awaiters 시스템**: `TurnAwaiter` 타입 + `turnAwaitersRef` 큐 — 플래너/스텝 실행이 UI 스트리밍 없이 raw LLM 응답을 기다릴 수 있게 함
- **신규 primitive**:
  - `addUserMessage(text)` — 게이트웨이 전송 없이 synthetic user 버블만 삽입
  - `insertPlanMessage(planId)` — synthetic assistant 버블에 planId 설정 → PlanCard 로 렌더됨
  - `patchMessage(id, patch)` — 버블 in-place 갱신 (예: content → planId 스왑)
  - `removeMessage(id)` — 버블 삭제 (plan 편집 후 원본 raw JSON 버블 제거용)
  - `sendAndAwaitFinal(text, opts?)` — raw 프롬프트 전송 후 `chat.final` 대기, `{text, messageId, toolCalls}` 반환 (UI 에 렌더 안 함)
- **Tool 콜 interception**: 진행 중 awaiter 의 `toolCalls` 배열에 session.tool 이벤트 자동 누적
- **NO_REPLY 필터 정리**: 구 heartbeat 용 `HEARTBEAT_OK` 필터 제거, `NO_REPLY` 만 남김
- **Disconnect cleanup**: WebSocket 닫힐 때 pending awaiter 전부 reject

#### `[src/App.tsx](src/App.tsx)` (+114 lines)

- `planMode` state (localStorage 영속화, 기본 ON), `togglePlanMode`, `planGenerating` 스피너 플래그
- `activePlanIdRef` — 가장 최근 plan id 기억 → 후속 채팅이 새 plan 생성 대신 해당 plan 편집으로 라우팅
- `usePlans` 훅 초기화 + `useOpenClaw` primitive 연결
- `sendMessage` 재라우팅:
  - planMode OFF → `rawSendMessage` (기존 경로)
  - planMode ON & 활성 draft/paused plan 존재 → `plans.updatePlanViaChat`
  - planMode ON & 활성 plan 없음 → `plans.enterPlanMode`
- `useProjectDir` 훅 연결 (ChatPanel 에 전달)
- View enum 에 `'mr' | 'admin'` 추가 (heartbeat 제거 반영)

#### `[src/components/ChatPanel.tsx](src/components/ChatPanel.tsx)` (+158 lines)

- 신규 props: `projectDir`, `planMode`, `onTogglePlanMode`, `planHandlers`, `planGenerating` 등
- **Project directory badge**: "+ New Chat" 옆에 현재 프로젝트 폴더 배지. 없으면 "Choose Project Folder" 버튼
- **Plan 토글 버튼**: "📋 Plan ON/OFF", 툴팁으로 현재 상태 설명
- **프로젝트 미설정 시 전송 차단**: `handleSend` 가 `projectDir` 없으면 picker 호출하고 return
- **PlanCard 렌더 분기**: `msg.planId` 있으면 MessageBubble 대신 PlanCard 렌더, planHandlers 전달

#### 이번 세션 마지막 수정 (중요)

SOUL.md 가 plan detail 에 의해 덮이는 문제 해결. **단순히 경로 리스트를 프롬프트에 주입하는 band-aid 가 아니라 구조적 프레이밍 변경**.

1. `[buildPlannerPrompt](src/hooks/usePlans.ts:181)` — 플래너에게 IMPORTANT 블록 추가:
  - step.detail 은 나중에 **실행 에이전트의 유저 메시지**로 전달됨
  - 실행 에이전트는 SOUL.md/SKILLS.md 등 자체 규칙이 있고, 그것들이 plan 보다 우선
  - 따라서: 절대/상대 경로 하드코딩 금지, bare 파일명 지시 금지, WHAT/형태만 묘사하고 HOW/이름/위치는 에이전트에 맡길 것
2. `[buildStepPrompt](src/hooks/usePlans.ts:234)` — 전면 재작성:
  - "You are the same Twixy agent … workspace rules ALWAYS take precedence" 를 맨 앞에 명시
  - step 내용을 `---` 로 감싸 "유저의 다음 메시지" 처럼 포맷
  - bare 파일명/규칙 위반 경로가 메시지에 있어도 **규칙대로 올바른 디렉토리에 저장**하라고 지시
  - 마커 지시는 "orchestrator 가 다음 스텝으로 진행하기 위함" 이라는 메타 이유로 배치 (명령이 아닌 프로토콜로 포지셔닝)

---

## Theme B — Team Collaboration / Merge Requests (신규, 미커밋)

Git-스타일 code review 의 Phase 2 구현. 로컬 전용 (서버 동기화는 Phase 3 예정). content-addressed blob 저장으로 불변성 보장. Solo 셀프 머지 지원.

### 신규 파일

#### `[electron/mr.ts](electron/mr.ts)` (418 lines)

MR 데이터 모델 + 디스크 IO.

- **타입**: `MRStatus` (open|changes_requested|approved|merged|rejected), `MRChange` (op: add/modify/delete + path + blobSha/prevSha), `MRReviewer`, `MRComment`, `MergeRequest`
- **경로 검증** (`assertSharedPath`): 상대 경로 강제, `shared/` prefix 필수, `..` 이스케이프 차단
- **함수**:
  - `createMR()` — content → sha256 hash → blob 저장 → meta.json 기록 (`.twixy/mr/<id>/`)
  - `reviewMR()` — reviewer 결정 upsert + 자동 status 전환 (reject → changes_requested, 모두 approve 면 approved)
  - `mergeMR()` — **rebase 체크**: 모든 modify/delete op 의 prevSha 가 현재 shared/ 와 일치하는지 검증 → 변경 적용 → caller `cloneInto` 콜백으로 user/ 미러링 → 머지 타임스탬프 기록
  - `addComment` / `cancelMR` / `readBlob` / `readSharedFile` / `listMRs`
- **Blob 저장**: content-addressed (sha256) → MR 내 자동 dedup

#### `[src/components/MergeRequestPanel.tsx](src/components/MergeRequestPanel.tsx)` (643 lines)

Split-panel MR 리뷰 UI.

- **MRList (좌, 320px)**: 필터 버튼 (All/Open/Approved/Merged/Rejected) + MR 행 (제목+상태 pill+저자+상대시간+파일 수)
- **MRDetail (우, flex)**: 헤더(상태+ID+제목+메타) / Reviewers 섹션 / Changes 섹션(lazy diff) / Comments 스레드 / 액션 바 (Approve/Request changes/Merge/Cancel)
- **ChangeRow**: 기본 접힘, 펼치면 `mrReadBlob` / `mrReadShared` 로 before/after 로드
- **BlobPreview**: text `<pre>`, image `<img src=dataUrl>`, binary 는 바이트 수 표시

#### `[src/components/AdminPanel.tsx](src/components/AdminPanel.tsx)` (443 lines)

프로젝트 레벨 설정 + 통계.

- 섹션: Project (collab mode: solo|shared-folder|server), Ownership & Team (claim owner, required approvals, 기본 reviewers), Server connection (Phase 3), Storage (shared/user/.twixy 크기 스캔), Activity (MR 통계 타일), Identity (현재 actor)
- Reviewers 서브컴포넌트: UID+email 로 추가/제거
- StorageRow / StatTile 내장 유틸 컴포넌트

#### `[docs/ONBOARDING.md](docs/ONBOARDING.md)` (427 lines)

한글 팀원 온보딩 가이드. 스택 / 레포 구조 / 개발 세팅 / 아키텍처 / Agent 시스템(AGENTS.md) / TSL Skill Language / Workspace 구조 / Entitlements / 실제 세션 예시 등 포함.

중요: Twixy 가 **자동 실행 → 어시스턴스 기반 코파일럿** 으로 피봇했다는 점을 본문 상단에서 명시 (heartbeat 제거의 배경).

#### `[docs/TEAM_COLLAB_OPEN_QUESTIONS.md](docs/TEAM_COLLAB_OPEN_QUESTIONS.md)` (101 lines)

Phase 1~3 미결정 설계 이슈 9개 정리. Init vs Clone UX, Blob 크기 한도, APFS CoW fallback, 삭제 전파 정책, 온프렘 Supabase 인증, Binary diff UI, 동시 편집 락, openclaw.json 저장 위치, SOUL.md 공유 여부.

### 수정된 파일

#### `[src/global.d.ts](src/global.d.ts)` (+166 lines)

신규 타입 대량 추가:

- `CollabMode`, `ProjectConfig`, `ProjectConfigResult`
- `MRStatus`, `MRActor`, `MRChange`, `MRReviewer`, `MRComment`, `MergeRequest`, `MRContentInput`, `MRChangeInput`, `MRCreatePayload`, `MRResult`, `MRBlobResult`
- `TwixyPlanStatus`, `TwixyPlanStepStatus`, `TwixyPlanStep`, `TwixyPlan`
- `AdminDirStats`, `AdminStats`

TwixyAPI 인터페이스에 새 IPC 메서드 추가:

- 프로젝트: `getProjectConfig`, `setProjectConfig`, `claimProjectOwnership`
- Admin: `adminStats`, `adminReveal`
- MR: `mrCurrentActor`, `mrList`, `mrGet`, `mrCreate`, `mrReview`, `mrComment`, `mrCancel`, `mrMerge`, `mrReadBlob`, `mrReadShared`, `onMRChanged`
- Plan: `planList`, `planGet`, `planCreate`, `planUpdate`, `planDelete`, `planBeginRun`, `planStepStart`, `planStepEnd`, `planRequestPause`, `planMarkPaused`, `planMarkAborted`, `planFinalize`, `planReadRun`, `onPlanChanged`, `correctLanguage`

#### `[electron/preload.ts](electron/preload.ts)` (+112 lines)

MR + Plan IPC 브릿지. **중요**: 이번 세션에서 9개 plan 변이 IPC 가 `{ok, plan, error}` wrapper 를 unwrap 안 해서 renderer 에서 `plan.id === undefined` 가 되던 버그 수정 (`planCreate`, `planUpdate`, `planBeginRun`, `planStepStart`, `planStepEnd`, `planRequestPause`, `planMarkPaused`, `planMarkAborted`, `planFinalize` 전부 unwrap 추가).

---

## Theme C — 커밋 완료된 변경 (2 commits)

### Commit 1 — `8b4de38 refactor: remove all heartbeat-related code` (2,078 삭제)

**배경**: Twixy 가 "백그라운드 모니터링 + 자동 실행" 에서 "사용자 주도 on-demand 코파일럿" 으로 피봇 → heartbeat 인프라 orphan.

**삭제된 파일**:

- `electron/watchSync.ts` (155 lines) — .tskill 변경 감시 → SKILL.md 자동 컴파일
- `src/components/HeartbeatPanel.tsx` (787 lines) — 마지막 heartbeat LLM 응답 표시
- `src/components/WatchtowerPanel.tsx` (787 lines) — `watchtower` 스킬 (cron 에이전트) UX
- `src/hooks/useWatchtowerClaw.ts` (232 lines) — Watchtower subagent WebSocket 세션

**수정 (−)**:

- `[electron/main.ts](electron/main.ts)` −105: `pingGateway`, `healthPoller`, `markGatewayRestarting`, `startWatchSync`/`stopWatchSync`, `purgeEmptySessionLogs` 제거
- `[src/App.tsx](src/App.tsx)` −7: heartbeat view type + 조건부 렌더 제거
- `[src/components/Sidebar.tsx](src/components/Sidebar.tsx)` −3: heartbeat 네비 항목 제거
- `[src/hooks/useOpenClaw.ts](src/hooks/useOpenClaw.ts)` −8: `HEARTBEAT_OK` 필터 제거

### Commit 2 — `ab95718 feat: dynamic project directory — user picks workspace from chat UI` (316 삽입, 134 삭제)

**배경**: 하드코딩된 `~/.openclaw/workspace/twixy/` 를 사용자 선택 프로젝트 디렉토리로 교체. 팀 협업 시 구성원마다 다른 폴더에서 작업 가능.

**신규**:

- `[src/hooks/useProjectDir.ts](src/hooks/useProjectDir.ts)` (65 lines) — `getProjectDir` / `pickAndSet` React hook, `onProjectDirChanged` 이벤트 구독

**수정**:

- `[SOUL.md](SOUL.md)` (+80, −80) — 모든 하드코딩 경로를 절대 경로 (`~/.openclaw/workspace/twixy/...`) 로 교체. File System Boundaries 재작성. File Path Display 규칙 추가 ("twixy/" prefix 로 shorten).
- `[AGENTS.md](AGENTS.md)` (+18) — 에이전트 경로 표기 업데이트
- `[electron/main.ts](electron/main.ts)` (+195, −134) — `getWorkspace()` 추가 (`~/.openclaw/twixy-project.json` 우선), `ensureWorkspace(dir)` (blocklist 검증 + 하위 디렉토리 생성 + SOUL.md/AGENTS.md 복사 + activeSessionFiles 캐시 초기화), IPC `set-project-dir` / `pick-project-dir` (Electron `dialog.showOpenDialog`)
- `[electron/preload.ts](electron/preload.ts)` (+8) — `setProjectDir` / `pickProjectDir` 노출
- `[src/App.tsx](src/App.tsx)` / `[src/components/ChatPanel.tsx](src/components/ChatPanel.tsx)` — useProjectDir 연결, 프로젝트 폴더 badge UI

---

## Theme D — 작은 산발적 변경

### `[src/components/SkillsPanel.tsx](src/components/SkillsPanel.tsx)` (+213)

**Shared/ 충돌 시 MR 제안 플로우**:

- 유저가 skill 을 만들거나 편집했는데 `shared/` 에 같은 이름의 버전이 있으면 "Propose update to shared" 옵션 노출
- `proposeUpdateToShared()` — .tskill 컴파일 → `{ op: 'modify', path: 'shared/skills/<name>/<name>.tskill' }` + `{ op: 'modify', path: 'shared/skills/<name>/SKILL.md' }` 로 MR 생성 → Merge Requests 탭에서 리뷰
- `sharedConflict` state + `mrMsg` 피드백 ("Merge request opened — review in Merge Requests tab")

### `[src/components/DataPanel.tsx](src/components/DataPanel.tsx)` (+179)

`shared/` 디렉토리 별도 섹션/탭 추가. 개인 `user/` 워크스페이스와 분리해서 팀 라이브러리 탐색 가능.

### `[electron/tsl-types.ts](electron/tsl-types.ts)` (+1)

1줄짜리 소규모 타입 보강.

### `[src/components/SettingsPanel.tsx](src/components/SettingsPanel.tsx)` (+1)

1줄짜리 소규모 수정.

### `[src/components/Sidebar.tsx](src/components/Sidebar.tsx)` (+5, 커밋된 −3 포함)

heartbeat 제거 + MR/Admin 네비 항목 추가.

---

## 핵심 설계 결정 (코드에서 읽을 수 있는 것들)

1. **Planning Mode 기본 ON** — 모든 프롬프트가 planner 를 먼저 거침. localStorage 로 토글 영속화.
2. **Plan 은 개인 전용** — 항상 `user/plans/` 하위. 팀과 공유하려면 별도 MR 플로우 (아직 미구현).
3. **SOUL.md 우선 원칙** — 스텝 프롬프트가 SOUL.md 를 절대 덮지 않도록 구조적으로 프레이밍 (이번 세션 수정).
4. **Content-addressed blobs** — MR 첨부 파일은 sha256 으로 dedup.
5. **Rebase 체크** — 머지 전 prevSha 검증으로 shared/ drift 방지.
6. **Flash 2.5 언어 교정** — 플래너 raw 응답이 CJK 섞임일 때 교정 후 JSON 파싱.
7. **APFS CoW fallback** — shared ↔ user 복사 시 3단계 fallback (ficlone force → ficlone → std copy).

---

## 이번 세션에서 고친 주요 버그 3건

1. **PlanCard 안 뜨던 버그** — preload 의 plan IPC 들이 `{ok, plan, error}` wrapper 를 unwrap 안 해서 renderer 가 `plan.id === undefined` → ChatPanel 이 MessageBubble 로 fallthrough. 9개 IPC 에 unwrap 추가.
2. **Plan 편집 시 중복 버블** — `updatePlanViaChat` 이 성공 후 원본 planner raw JSON assistant 버블을 남겨두고, 기존 PlanCard 는 `onPlanChanged` 로 자동 리프레시 → 같은 plan 2개 표시. `removeMessage` primitive 추가해서 편집 성공 후 원본 버블 제거.
3. **Plan JSON 언어 오염** — planner 출력에 CJK mid-token hallucination ("biography 형식의散文에서曲명...") 섞임. 정규 채팅용 언어 교정은 UI 메시지에만 작동, planner 응답은 바이패스. `correctPlannerText` 헬퍼 + `extractPlanJson` 재파싱 safety guard 추가. `enterPlanMode` / `updatePlanViaChat` 둘 다 적용.

### 미해결 (일단 보류)

- ChatPanel.tsx:143,144 중복 스타일 키 TS 에러
- DashboardPanel.tsx:295 undefined M
- SkillsPanel.tsx:741 `getSkillStats` 가 TwixyAPI 에 없음
- useOpenClaw.ts:462 `usdActual` 잘못된 반환 타입
- sub-agent tool call 추적, pause UX 메시지, marker 재질문 시 tool call 유실, outcome turn timeout, Windows 경로 안전성 등

