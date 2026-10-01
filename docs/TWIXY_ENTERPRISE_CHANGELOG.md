# Twixy Enterprise — Change Log

> **2026-04-28 메모 — 명칭 변경 안내:** 이 파일은 원래 `CLOVEX_CHANGELOG.md` 였고, Twixy 와 Clovex 를 같은 브랜치에서 함께 개발하던 시기의 기록을 담고 있다.
> 2026-04-28 부로 **Clovex 는 별도의 신규 프로젝트로 분리** 되었고, 기존 Twixy 리포 안의 "Clovex AI" 모드는 **Twixy 자체의 enterprise(어드민) 모드**로 의미가 바뀌었다.
> 따라서 이 파일 안에 등장하는 모든 `Clovex` / `Clovex AI` 관련 식별자·변수명·UI 텍스트는 일괄로 `Twixy Enterprise` / `twixy-enterprise` 로 재명명되었다.
> 신규 Clovex 프로젝트는 별도 리포에서 진행되며, 이 changelog 와 무관하다.

> 모노레포 전환 시 이 파일을 참조해 `apps/twixy-enterprise`와 `packages/twixy-core`로 코드를 분리하세요.
> 아키텍처 전환 계획은 [MONOREPO_ARCHITECTURE.md](./MONOREPO_ARCHITECTURE.md) 참조.

> **작성 규칙:** 각 업데이트 항목을 두 섹션으로 구분해서 작성.
> - `### Twixy 변경` — Twixy 코어 파일 수정 (커밋 prefix `feat(twixy):` / `fix(twixy):`)
> - `### Twixy Enterprise 변경` — Twixy Enterprise 전용 파일 수정 (커밋 prefix `feat(twixy-enterprise):` / `fix(twixy-enterprise):`)
> - 해당 섹션에 변경사항 없으면 생략 가능.
>
> **커밋 prefix 적용 시점:** `f239d19` (2026-04-23) 이후 커밋부터 `feat(twixy):` / `feat(twixy-enterprise):` prefix 구분 시작.
> 이유: `feature/twixy-enterprise` 브랜치에서 작업하던 중 Twixy 코어 기능 수정이 불가피해졌기 때문.
> 그 이전 커밋들(`545bf94`, `0191456` 등)은 prefix 없이 작성되었으며, 내용상 전부 Twixy Enterprise 관련임.

---

## 2026-04-28 — Clovex 분리 결정, 전 영역 Twixy Enterprise 로 재명명

### 배경
Clovex 는 완전히 별도의 신규 프로젝트로 분리하기로 결정. 기존 Twixy 리포에 남아있던 Clovex AI 모드는
의미가 바뀌어 **Twixy Enterprise (어드민) 모드**로 재명명. 이번 작업은 단순 이름 치환이며, 구조 개편 / 데이터 마이그레이션 / 신규 기능 없음.

### Twixy Enterprise 변경 (전 영역 일괄 rename)

#### 식별자 / 변수명
- TS 인터페이스: `ClovexPlanSummary` → `TwixyEnterprisePlanSummary`, `ClovexAdminData` → `TwixyEnterpriseAdminData`
- React 컴포넌트: `ClovexDashboard` → `TwixyEnterpriseDashboard`
- Electron 플래그: `isClovex` → `isTwixyEnterprise`
- Preload/window 메서드: `clovexPickFolder` / `clovexAdminLoad` / `clovexReadRun` → `twixyEnterprisePickFolder` / `twixyEnterpriseAdminLoad` / `twixyEnterpriseReadRun`
- IPC 채널: `clovex-pick-folder` / `clovex-admin-load` / `clovex-read-run` → `twixy-enterprise-pick-folder` / `twixy-enterprise-admin-load` / `twixy-enterprise-read-run`
- AppMode 타입: `'twixy' | 'clovex'` → `'twixy' | 'twixy-enterprise'`

#### UI 텍스트
- 타이틀바: `'CLOVEX AI'` → `'TWIXY ENTERPRISE'`
- ConnectingSplash: `'Clovex AI'` → `'Twixy Enterprise'`
- Folder picker dialog: `'Clovex — 프로젝트 폴더 선택'` → `'Twixy Enterprise — 프로젝트 폴더 선택'`
- HTML `<title>`: `Clovex AI` → `Twixy Enterprise`

#### 파일 / 디렉토리
- `clovex.html` → `twixy-enterprise.html`
- `src/clovex/` → `src/twixy-enterprise/`
- `src/admin/ClovexDashboard.tsx` → `src/admin/TwixyEnterpriseDashboard.tsx`
- `docs/CLOVEX_CHANGELOG.md` → `docs/TWIXY_ENTERPRISE_CHANGELOG.md`
- `docs/CLOVEX_PHASE1_OPTION_C.md` → `docs/TWIXY_ENTERPRISE_PHASE1.md`

#### 설정 / 빌드
- `vite.config.ts` rollupOptions input: `clovex` → `twixyEnterprise`
- `package.json` npm script: `dev:clovex` / `build:clovex` / `dist:clovex:mac` / `dist:clovex:win` → `dev:twixy-enterprise` / `build:twixy-enterprise` / `dist:twixy-enterprise:mac` / `dist:twixy-enterprise:win`
- `APP_MODE` 환경변수 값: `clovex` → `twixy-enterprise`
- electron-builder `productName`: `"Clovex AI"` → `"Twixy Enterprise"`, `appId`: `com.clovex.app` → `com.twixy-enterprise.app`

#### localStorage 키
- `clovex.projects` → `twixy-enterprise.projects` (아직 배포 전이라 마이그레이션 코드 없음)

#### 문서
- `docs/MONOREPO_ARCHITECTURE.md` 등 docs/ 안의 모든 `Clovex` / `clovex` / `apps/clovex` 참조도 동일하게 치환.
- `docs/branches/*_CHANGELOG.md` 의 `feature/clovex-ai` 텍스트 참조도 `feature/twixy-enterprise` 로 치환.

### 영향 없음
- 기존 git 브랜치명 (`feature/clovex-ai`) 자체는 그대로 유지 — 텍스트 참조만 치환. 추후 `git branch -m` 결정은 사용자 몫.
- 사용자 데이터/userData 마이그레이션 코드 없음 — 아직 배포/실사용자 없음.
- Clovex 신규 프로젝트는 별도 리포에서 처음부터 다시 개발.

---

## 2026-04-22 — Initial implementation (Option C)

### 신규 파일

| 파일 | 설명 | 모노레포 이전 시 위치 |
|------|------|----------------------|
| `twixy-enterprise.html` | Twixy Enterprise entry point HTML | `apps/twixy-enterprise/index.html` |
| `src/twixy-enterprise/main.tsx` | Twixy Enterprise 렌더러 진입점. `<App appMode="twixy-enterprise" />` 렌더링 | `apps/twixy-enterprise/src/main.tsx` |
| `src/admin/TwixyEnterpriseDashboard.tsx` | Twixy Enterprise 전용 어드민 대시보드 컴포넌트 | `apps/twixy-enterprise/src/admin/TwixyEnterpriseDashboard.tsx` |
| `docs/TWIXY_ENTERPRISE_PHASE1.md` | Option C 구현 전략 문서 | 그대로 유지 |
| `docs/MONOREPO_ARCHITECTURE.md` | 모노레포 구조 설명 문서 | 그대로 유지 |

### 수정된 파일

#### `src/App.tsx`
- `AppMode = 'twixy' | 'twixy-enterprise'` 타입 추가 및 export
- `App` default export에 `appMode?: AppMode` prop 추가
- `AuthedApp`에 `appMode` prop 전달
- 타이틀바 텍스트 분기: `appMode === 'twixy-enterprise'` → `'TWIXY ENTERPRISE'`
- `ConnectingSplash`에 `appMode` 전달
- admin 뷰: `appMode === 'twixy-enterprise'` → `<TwixyEnterpriseDashboard />`, 아니면 기존 `<AdminPanel />`
- `TwixyEnterpriseDashboard` import 추가
- **모노레포 이전 시**: `appMode` prop 및 Twixy Enterprise 분기 로직은 `apps/twixy-enterprise`로 이동, `twixy-core`의 App은 원래대로 복원

#### `src/components/ConnectingSplash.tsx`
- `appMode?: 'twixy' | 'twixy-enterprise'` prop 추가
- 타이틀 텍스트 분기: `'Twixy Enterprise'` / `'Twixy'`
- **모노레포 이전 시**: prop 제거, Twixy Enterprise는 별도 splash 컴포넌트 사용

#### `src/global.d.ts`
- `TwixyEnterprisePlanSummary` 인터페이스 추가
- `TwixyEnterpriseAdminData` 인터페이스 추가
- `Window.twixy`에 Twixy Enterprise IPC 메서드 타입 추가:
  - `twixyEnterprisePickFolder(): Promise<string | null>`
  - `twixyEnterpriseAdminLoad(projectRoot): Promise<TwixyEnterpriseAdminData>`
  - `twixyEnterpriseReadRun(projectRoot, uid, planId): Promise<string | null>`
- **모노레포 이전 시**: `apps/twixy-enterprise/src/global.d.ts`로 분리

#### `electron/main.ts`
- `const isTwixyEnterprise = process.env.APP_MODE === 'twixy-enterprise'` 추가
- `createWindow()`: `isTwixyEnterprise` 여부에 따라 `twixy-enterprise.html` / `index.html` 로드
- IPC 핸들러 3개 추가 (`// ── Twixy Enterprise admin IPC` 섹션):
  - `twixy-enterprise-pick-folder`: 폴더 다이얼로그 → 선택된 경로 반환
  - `twixy-enterprise-admin-load`: 프로젝트 루트를 받아 어드민 통계 계산 및 반환
  - `twixy-enterprise-read-run`: `users/<uid>/plans/<planId>/run.md` 내용 반환
- **모노레포 이전 시**: Twixy Enterprise IPC 핸들러는 `apps/twixy-enterprise/electron/main.ts`로 분리

#### `electron/preload.ts`
- Twixy Enterprise IPC 노출 3개 추가:
  - `twixyEnterprisePickFolder`
  - `twixyEnterpriseAdminLoad`
  - `twixyEnterpriseReadRun`
- **모노레포 이전 시**: `apps/twixy-enterprise/electron/preload.ts`로 분리

#### `vite.config.ts`
- `rollupOptions.input`에 `twixyEnterprise: path.resolve(__dirname, 'twixy-enterprise.html')` 추가
- **모노레포 이전 시**: `apps/twixy-enterprise/vite.config.ts`로 분리

#### `package.json`
- 스크립트 추가:
  - `dev:twixy-enterprise`: `APP_MODE=twixy-enterprise NODE_ENV=development vite`
  - `build:twixy-enterprise`: `APP_MODE=twixy-enterprise tsc ... && APP_MODE=twixy-enterprise vite build`
  - `dist:twixy-enterprise:mac` / `dist:twixy-enterprise:win`
- **모노레포 이전 시**: `apps/twixy-enterprise/package.json`으로 분리

---

### Twixy Enterprise Dashboard 기능 목록

#### 데이터 소스
- 선택한 프로젝트 폴더의 `users/<uid>/plans/*/plan.json` 전체 스캔
- `shared/skills/` 에서 신규 스킬 탐지

#### 대시보드 섹션
| 섹션 | 내용 |
|------|------|
| Today's Completions by Worker | uid별 오늘 완료 횟수 + 퍼센트 바. 클릭 시 Completed Work 페이지로 이동 |
| Completed Today | 오늘 완료된 플랜 스크롤 목록. 헤더의 `N total →` 클릭 시 Completed Work 이동 |
| Most Used Skills This Month | 이번달 `skillsReferenced` 집계 top 10 |
| New Skills This Month | `shared/skills/` mtime 기준 이번달 생성된 스킬 |

#### Completed Work 페이지
- Date 필터: Today / This week / This month / All time
- Worker 필터: uid 드롭다운
- 플랜 행 클릭 → `run.md` 모달 (마크다운 렌더링)

---

## 업데이트 로그 (이후 내용 여기에 추가)

<!-- 날짜 | 변경 파일 | 변경 내용 -->

---

## 2026-04-23 — Theme, Projects page, Tab order, Build separation

### 수정된 파일

#### `twixy-enterprise.html`
- `<style>` 블록 추가: `:root` CSS 변수 override (`!important`)
  - `--accent: #9a9a9a` (무채색 그레이), `--accent-dim`, `--accent-glow`
  - Vite가 globals.css를 JS 번들로 나중에 inject해도 덮어쓰이지 않도록 `!important` 사용
- **모노레포 이전 시**: `apps/twixy-enterprise/index.html`로 그대로 이동

#### `package.json`
- `dist:twixy-enterprise:mac` / `dist:twixy-enterprise:win` 스크립트에 `--config.productName="Twixy Enterprise" --config.appId="com.twixy-enterprise.app"` 추가
- 배포 시 Twixy(`~/Library/Application Support/Twixy/`)와 Twixy Enterprise(`~/Library/Application Support/Twixy Enterprise/`) userData 경로가 완전 분리됨

#### `src/App.tsx`
- `AuthedApp` 기본 `activeView`를 `appMode === 'twixy-enterprise'`일 때 `'admin'`으로 설정
- `<Sidebar>`에 `appMode` prop 전달

#### `src/components/Sidebar.tsx`
- `appMode?: 'twixy' | 'twixy-enterprise'` prop 추가
- `appMode === 'twixy-enterprise'`일 때 admin 탭을 사이드바 맨 첫 번째로 이동, 나머지는 기존 순서 유지

#### `src/admin/TwixyEnterpriseDashboard.tsx`
- **Projects 랜딩 페이지 추가** (`AppView`에 `{ page: 'projects' }` 추가)
  - 기본 뷰를 `{ page: 'projects' }`로 변경
  - `SavedProject = { root: string; name: string }` 타입 추가
  - `localStorage` 키 `twixy-enterprise.projects`에 프로젝트 목록 저장/로드 (`loadProjects` / `saveProjects`)
  - `ProjectsView` 컴포넌트: 카드 그리드, hover accent border, `×` 제거 버튼, 빈 상태 CTA
- **폴더 선택 개선**: `pickFolder` 시 projects 목록에 자동 추가 후 dashboard로 이동. 이미 있으면 중복 추가 안 함
- **`openProject(root)`**: 프로젝트 카드 클릭 시 해당 root로 데이터 로드 + dashboard 이동
- **`removeProject(root)`**: 카드 `×` 클릭 시 목록에서 제거
- **`refreshKey`**: 같은 projectRoot를 다시 열 때도 데이터 reload 트리거
- **탑바 네비게이션 변경**:
  - Projects 페이지: `+ Add project` 버튼
  - Dashboard 페이지: `← Projects` 백버튼
  - Completed Work 페이지: `← Dashboard` 백버튼
  - 타이틀에 프로젝트 폴더명(basename) 표시

---

## 2026-04-23 — Pull from shared 수동화, 커밋 prefix 규칙 적용 시작

### Twixy 변경

#### `electron/main.ts`
- `ensureWorkspace()`에서 `projectSharedIntoUser()` 자동 실행 제거
  - 앱 시작 시 자동 pull로 인해 작업 중인 파일이 overwrite될 수 있는 문제 방지
- `ipcMain.handle('pull-shared', ...)` 핸들러 추가: `shared/skills/` → `user/skills/` 복사를 수동 트리거로 변경. 신규 스킬만 복사(기존 파일 overwrite 없음), 복사된 파일 수 반환

#### `electron/preload.ts`
- `pullShared: () => ipcRenderer.invoke('pull-shared')` 노출 추가

#### `src/global.d.ts`
- `TwixyAPI`에 `pullShared: () => Promise<{ ok: boolean; copied: number }>` 추가

#### `src/components/MergeRequestPanel.tsx`
- MR 탭 상단에 "↓ Pull from shared" 버튼 추가
- `pulling` / `pullMsg` 상태 추가. 결과 메시지 3초 후 자동 소멸 ("N files pulled" / "Already up to date" / "Pull failed")
- **버그 수정**: `handlePull` useCallback이 `refresh`보다 먼저 선언되어 dependency array `[refresh]` 평가 시 TDZ ReferenceError 발생 → `refresh` 선언 순서를 `handlePull` 앞으로 이동

#### `docs/TWIXY_ENTERPRISE_CHANGELOG.md`
- 커밋 prefix 적용 시작 시점(`f239d19`) 및 이유 명시 추가

---

## 2026-04-23 — Enterprise Guardrail Mode (Twixy)

### Twixy 변경

엔터프라이즈에서 에이전트가 실수로 파일을 덮어쓰거나 파괴적 쉘 명령을 실행하는 것을 막기 위한 3단계 가드레일 모드 추가. Claude Code 의 accept-edits 모드에 해당하는 UX.

#### 신규 파일

| 파일 | 설명 |
|------|------|
| `electron/guardrail/config.ts` | `~/.openclaw/openclaw.json` 의 `guardrail` 섹션 로드/저장, env 시리얼라이저 |
| `electron/guardrail/ipc.ts` | `guardrail-get-config` / `guardrail-set-config` / `guardrail-remove-allowlist-entry` IPC |
| `src/hooks/useGuardrail.ts` | gateway WS 로 `plugin.approval.requested` 구독, 세션 캐시 + 영구 allowlist 매칭, UI 큐잉 |
| `src/components/GuardrailModal.tsx` | 승인 모달 (fixed overlay 560px, accent `#7c6aff`, diff preview, 승인 / 세션 / 영구기억 / 거부 4-버튼) |

#### 수정된 파일

- `electron/main.ts` — Node22 spawn 시 `TWIXY_GUARDRAIL_MODE` + `TWIXY_GUARDRAIL_ALLOWLIST` env 주입, `registerGuardrailIpc` 등록
- `electron/preload.ts` — `guardrailGetConfig` / `guardrailSetConfig` / `guardrailRemoveAllowlistEntry` / `onGuardrailConfigChanged` 노출
- `src/global.d.ts` — `GuardrailMode`, `GuardrailAllowlist`, `GuardrailConfig`, `GuardrailApprovalRequest` 타입 추가 및 `TwixyAPI` 확장
- `src/App.tsx` — `<GuardrailModal>` 최상단 마운트, `useGuardrail()` 구독
- `src/components/AdminPanel.tsx` — `Guardrail` 섹션 (mode 셀렉터 + 영구 allowlist 리스트 two-state delete)
- `openclaw.json` — `guardrail: { mode: "bypass", allowlist: { write: [], edit: [], bash: [] } }` 기본값 추가

#### OpenClaw 패치 확장 (`patches/openclaw+2026.4.2.patch`)

- `pi-embedded-*.js` 의 `runBeforeToolCallHook` 최상단에 Twixy 가드레일 게이트 주입
- 분류기: Write/Edit/NotebookEdit 는 path 기반, Bash 는 기존 `analyzeShellCommand()` 재사용 (destructive / network 플래그)
- 게이트 대상일 때 환경변수 allowlist 매칭 (exact / `/*` / `/**` prefix) → 미스 시 `callGatewayTool("plugin.approval.request")` + `waitDecision` 로 OpenClaw 기존 승인 시스템 그대로 활용
- 거부 시 `"User denied this action via Guardrail Mode"` 로 툴 차단, SOUL.md 의 action-over-analysis 원칙과 호환

### 검증

- `npx tsc --noEmit` : Guardrail 관련 에러 0. 그 외 사전 존재 에러(ChatPanel 스타일 중복, DashboardPanel `M`, SkillsPanel `getSkillStats`, useOpenClaw `usdActual`) 는 본 변경 범위 밖.
- 수동 E2E 는 다음 세션에서 AdminPanel → Guardrail → Standard 전환 후 drafts 폴더 쓰기 / `rm -rf` 요청으로 확인 예정.

---

## 2026-04-23 — Guardrail bugfix + i18n (Twixy)

### Twixy 변경

- `electron/guardrail/config.ts` — JSON5 파서 버그 수정. 기존 정규식이 `https://` URL 의 `//` 까지 주석으로 오인해 `saveGuardrailConfig` 가 `SyntaxError: Bad control character in string literal` 로 항상 실패. 문자열 인식(string-aware) 토크나이저로 교체.
- `src/components/GuardrailModal.tsx` / `src/components/AdminPanel.tsx` / OpenClaw 패치 — 가드레일 UI 및 메시지 영문화 (유저 요구).

---

## 2026-04-24 — Guardrail: reuse gateway WS (fix handshake spam)

### Twixy 변경

- `src/hooks/useGuardrail.ts` — 별도 WebSocket 연결 제거. `useOpenClaw` 의 이미 인증된 gateway WS 를 재사용하도록 재작성.
  - 원인: 가드레일 전용 WS 가 `connect.challenge` 응답 없이 접속해서 gateway 가 `invalid handshake` + `closed before connect code=1008 reason=invalid request frame` 로 2초마다 거절하며 로그 스팸.
- `src/hooks/useOpenClaw.ts` — `plugin.approval.requested/resolved` 프레임을 `window.dispatchEvent('twixy:plugin.approval.*')` 로 브로드캐스트, `resolveGuardrail(id, decision)` API 노출.
- `src/App.tsx` — `useGuardrail(openclaw.resolveGuardrail)` 로 resolver 전달.

---

## 2026-04-24 — Guardrail config moved to dedicated file

### Twixy 변경

- `electron/guardrail/config.ts` — 가드레일 설정 저장 위치를 `~/.openclaw/openclaw.json` (root key `guardrail`) → `~/.openclaw/twixy-guardrail.json` (전용 파일) 로 이동.
  - 원인: OpenClaw 의 config validator 가 알려지지 않은 root 키를 거부 (`Unrecognized key: "guardrail"`) → gateway 시작 자체가 실패하던 회귀.
  - load/save 가 더 이상 openclaw.json 을 건드리지 않음.
- `openclaw.json` — `guardrail` 블록 제거.

---

## 2026-04-24 — Guardrail mode hot-reload + AdminPanel UX + verifier parser fix (Twixy)

### Twixy 변경

#### Guardrail mode hot-reload
- `electron/guardrail/ipc.ts` — `registerGuardrailIpc` 가 `onModeChanged` 콜백을 받도록 시그니처 변경. `guardrail-set-config` 핸들러가 mode 필드 변경을 감지하면 콜백 호출. allowlist-only 변경은 세션 보존을 위해 restart 안 함.
- `electron/main.ts` — `registerGuardrailIpc` 에 OpenClaw 재시작 콜백 전달 (`openclawProcess.kill()` → `startOpenClaw()` → `openclaw-ready` 브로드캐스트).
  - 원인: `TWIXY_GUARDRAIL_MODE` env 가 gateway spawn 시점에만 캡처되어, AdminPanel 에서 모드를 바꿔도 다음 앱 재시작 전까지는 적용되지 않던 회귀.
  - 트레이드오프: 진행 중인 에이전트 세션이 끊김 (유저가 명시적으로 수용).

#### AdminPanel UX
- `src/components/AdminPanel.tsx` — Guardrail 섹션 개선:
  - `ModeComparison` 컴포넌트 추가: bypass / standard / strict 3 모드를 6개 항목 (Approval modal, Session memory, Permanent allowlist, Intercepts, Safe Bash, Best for) 으로 비교하는 테이블. 활성 모드 컬럼은 `var(--accent)` 보라색으로 강조.
  - 모드 변경 후 "Saved ✓" 인디케이터 1.8초 노출 (저장 성공 시각 피드백).
  - 설명 문구 업데이트: "Mode changes apply from the next agent action."

#### Verifier 파서 leniency 수정
- `src/hooks/usePlans.ts` — `verifyAndExplain` 의 `RESULT: YES/NO` 파서가 너무 엄격했던 버그 수정:
  - 이전: `/^RESULT:\s*YES/i.test(text)` — 줄 시작 anchored 라 모델이 `twixy:plan {...}` 블록이나 thinking output 을 prefix 로 환각하면 실제 step 이 성공해도 spurious failure 로 plan 전체 stop.
  - 이후: `[...text.matchAll(/RESULT:\s*(YES|NO)\b/gi)]` 로 마지막 verdict 만 추출. cascade machinery (`setRejectNewRuns` / `setRequesterAnnounceFrozen` / "Plan stopped" UI) 는 손대지 않음.
  - 원인: minimax 모델이 verifier 턴에서 plan 블록을 환각하는 사례 발견 (`plan_modp0ri52ebeb56177f03c1e` log 분석으로 확인).

---

## 2026-04-25 — youtube-transcript v1.1: "Show transcript" 버튼 매칭 강화 (Twixy)

### Twixy 변경

#### `skills/youtube-transcript` v1.0 → v1.1
- Phase 3 Step 2 — 버튼 매칭 정규식 `/show transcript|transcript|자막 표시|스크립트 표시/i` (loose) → `/^(show transcript|자막 표시|스크립트 표시)$/i` (exact). `transcript` 단독 매칭 제거.
- Phase 3 Step 2 — 클릭 가능 엘리먼트 검증 (`button` / `[role=button]` / `yt-button-shape` / `ytd-button-renderer`) 추가. 반환값에 `panelBefore` / `segCountBefore` 캡처해서 Step 3 의 wrong-click 감지에 사용.
- Phase 3 Step 3 — 폴링 evaluate 가 `panelPresent` / `panelHidden` / `segCount` 셋 다 반환. 2회차에 `panelPresent === false` 면 잘못된 엘리먼트 클릭으로 간주, 즉시 Phase 4 fallback. 재클릭 금지.
- Anti-pattern 7~9 추가:
  - 7: 버튼 loose text 매칭 — 설명 컬럼의 "Transcript" 헤딩 / "Follow along using the transcript." 문구가 잡혀서 wrong-click 후 6회 폴링 0 으로 빠지는 패턴.
  - 8: 폴링 0 일 때 같은 버튼 재클릭 — 두 번째 클릭은 패널 토글로 닫음.
  - 9: `fn` body 안에서 double-quote selector — `'[class*="x"]'` 가 외부 JSON double-quote 와 충돌해 SyntaxError.
  - 원인: `lOIrdNq8DzQ` 영상 transcript 추출 시도 (세션 `2a9e829a`) 분석 — 스킬 invoke 정상, 광고 없음, "Show transcript" 클릭 후 `clicked-transcript` 반환했으나 segments 0개 유지로 fallback. 로그의 thinking 에서 "panel found → no longer found" 토글 패턴 + selector quote SyntaxError 1회 확인.
- 트레이드오프: exact match 가 YouTube UI 의 사소한 라벨 변경에 민감해질 수 있음 — 한국어/영어 변형 3종만 우선 커버. 그 외 로케일은 추가 케이스 들어왔을 때 확장.

---

## 2026-04-25 — youtube-transcript 스킬 + 스킬 동기화 파이프라인 문서화 (Twixy)

### Twixy 변경

#### 신규 스킬: `youtube-transcript`
- `skills/youtube-transcript/youtube-transcript.tskill` (TSL 소스) — YouTube 영상에서 transcript 추출, 광고 감지/skip/대기, lazy-load 폴링, description+chapter fallback. 4개 phase: Phase 1(open + meta) / Phase 2(ad handling) / Phase 3(transcript panel + segment 일괄 추출) / Phase 4(description fallback).
- `skills/youtube-transcript/SKILL.md` — 컴파일된 인간 친화 문서. 사용 가능한 anti-pattern 6종 명시 (selector cycling / signed timedtext URL fetch / `t=63s` 오인 / 광고 중 full snapshot / sub-agent spawn 등).
  - 원인: 이전 plan 실행에서 49초 영상 transcript 추출에 34번 tool call 낭비 (selector 12회 갈아끼움 + 빈 timedtext endpoint 6회 brute force) 사례 분석 후, 스킬화로 5~7회로 압축 가능하다고 판단.

#### 스킬 동기화 파이프라인 문서화
- `docs/ONBOARDING.md` §8 — "스킬 파일 위치" 표를 legacy 2단(`skills/<name>/` + `~/.openclaw/workspace/twixy/skills/custom/<name>/`) 에서 team-collab phase 1+2 의 3단 (bundle / shared / user) 으로 갱신. `.twixy-custom` 마커 설명 추가.
- `docs/ONBOARDING.md` §8 — 신규 서브섹션 **"스킬 동기화 파이프라인"** — 4단계 흐름 다이어그램 + 핵심 함수 4개 (`seedSharedFromBundle` / `projectSharedIntoUser` / `compileTskillFiles` / `regenerateSkillsIndex`) 의 `electron/main.ts` 라인 번호 명시. `projectSharedIntoUser()` 가 auto-startup 에서 빠지고 UI "Pull shared skills" 트리거가 필요하다는 점 강조.
- `docs/ONBOARDING.md` §9 — 워크스페이스 트리를 레거시 flat layout (`~/.openclaw/workspace/twixy/skills/custom/`) 에서 `<projectRoot>` 기반 3-part (`​.twixy/` + `shared/` + `users/<uid>/`) 로 갱신. `getProjectRoot()` 동작 + `~/.openclaw/twixy-project.json` 명시.
  - 원인: 이번 세션에 youtube-transcript 스킬을 프로젝트 디렉토리에 만들었더니 `SKILLS.md` 인덱스에 안 떠서 디버깅한 결과, shared → user 단계가 manual pull 이라는 사실이 어떤 문서에도 명시 안 돼있던 것을 발견.

---

## 2026-04-25 — youtube-transcript v1.2 → v1.5: 클릭 정확도 + raw verbatim 저장 강제 (Twixy)

### Twixy 변경

#### `skills/youtube-transcript` v1.1 → v1.5

`lOIrdNq8DzQ` (메타 페이스북 비즈니스계정) 영상으로 4번 연속 실행하며 매번 다른 단계에서 막혀서 단계별로 디버깅. 각 버전이 직전 실행의 로그를 근거로 수정됨.

- **v1.2** — Phase 3 Step 3 wrong-click 가드 제거. 패널 selector 를 `ytd-transcript-panel-renderer` (단일) → `ytd-transcript-panel-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]` (dual) 로 확장. 폴링은 오직 `segCount` 만 본다 (panel 정보는 진단용).
  - 원인: v1.1 의 wrong-click 가드(2회차에 `panelPresent: false` 면 즉시 fallthrough)가 false negative 로 발화. YouTube 가 패널을 다른 부모 태그 아래 렌더하면 단일 selector miss → 가드가 정상 클릭을 wrong-click 으로 오인 → 캡션 없는 영상 오진 마스킹.
  - Anti-pattern 10 추가.

- **v1.3** — Phase 3 Step 2 에 `isVisible(el)` 필터 (`offsetParent !== null && getBoundingClientRect()` size > 0). `candidates.find(...)` → `matches.filter(...).find(isVisible)`. `reason` 필드 분리 (`no-transcript-button-in-known-locale` vs `all-candidates-hidden`), `matchCount` 진단 필드 추가.
  - 원인: v1.2 실행 로그(세션 `534187ba`)에서 `clicked: true, panelHidden: true` 로 6회 폴링 → fallback. 다운로드 받은 BEFORE/AFTER HTML 분석 결과 YouTube 가 description transcript section 을 **2회 렌더** (양쪽 다 동일한 `aria-label="Show transcript"` 버튼) — `find(...)` 가 hidden/inactive 첫 번째 인스턴스를 잡고 있었음.
  - Anti-pattern 11 추가.

- **v1.4** — Phase 3 Step 2 에서 visible candidate 선정 후 `candidate.querySelector('button')` 으로 innermost native `<button>` drill-down 후 클릭. 결과에 `clickedTag` 필드 추가 (검증용 — `"button"` 이어야 정상).
  - 원인: v1.3 실행 로그(세션 `a75ef3c3`)에서 `clicked: true, matchCount: 6, panelHidden: true` 로 다시 fallback. matchCount 6 = `aria-label="Show transcript"` 버튼이 3겹 nested (`ytd-button-renderer > yt-button-shape > <button>`) × 2 인스턴스. innerText 가 cascade 되니 wrapper 까지 다 매치. `.click()` 을 wrapper 에 호출하면 YouTube 의 click handler (innermost `<button>` 에 바인딩) 까지 propagate 안 됨.
  - Anti-pattern 12 추가.

- **v1.5** — TRACK 섹션에 raw-verbatim 저장 의무 명문화. 금지 항목: 인접 segment 결합, 임의 section heading 추가 (`### 0:00 ~ 0:42 — 소개` 류), bullet 요약, 번역, 정제된 punctuation, commentary, segment 스킵. 파일 layout (헤더 5줄 + `---` + `[ts] text` × N) 강제. Filename `youtube_{videoId}_{date}.md` 패턴 정확히 (suffix 없음) 강제.
  - 원인: v1.4 실행 로그(세션 `6f5c3ee7`)에서 클릭/추출/저장 모두 성공했지만, 저장된 파일이 raw 237 segments 가 아니라 에이전트가 plan 의 다음 step ("계정 생성 단계 정리") 까지 미리 합쳐서 만든 5KB 요약본. raw 보존 의무가 spec 에 강제 어휘로 안 박혀있던 것이 원인.
  - Anti-pattern 13 추가.

#### Phase 2 광고 skip — KNOWN ISSUE 코멘트 추가

- `.ytp-ad-skip-button*` selectors 가 modern overlay/side-panel/countdown skip 변종을 놓치는 경우가 있어, 최근 실행에서 `"clicked"` 반환했으나 광고가 계속 재생되어 사용자가 수동 skip 한 사례 다수. 추후 selector 확장 + Phase 3 처럼 inner `<button>` drill-down 적용 + post-click `.ad-showing` clearing 검증 필요.

### Twixy 변경 — pull-shared IPC 크기 기반 overwrite

#### `electron/main.ts` `pull-shared` 핸들러
- 기존: 사용자 디렉토리에 파일이 이미 존재하면 무조건 skip (never-overwrite). shared 쪽 스킬 업데이트가 사용자에게 반영 안 되는 문제 발생.
- 변경: 파일별로 `fs.statSync(srcFile).size !== fs.statSync(dstFile).size` 비교 → 크기 다르면 `safeCopyFile` 로 덮어쓰고 `updated++`, 같으면 skip. 신규 파일은 `copied++`.
- 반환 타입 `{ ok, copied, skipped, error? }` → `{ ok, copied, updated, skipped, details: { skill, file, action }[], error? }`.

#### `src/global.d.ts`
- `pullShared` 반환 타입 확장 (`updated` / `details` 필드 추가).

#### `src/components/MergeRequestPanel.tsx`
- `handlePull` 메시지 포맷팅 수정 — `"X new, Y updated"` / `"Already up to date"` / `"Pull failed: <error>"`. refresh trigger 를 `(copied + updated) > 0` 으로 변경.
- 원인: youtube-transcript 스킬 v1.1 → v1.2 업데이트 후 사용자가 pull 했는데 사용자 디렉토리에 변화 없어서 디버깅. 기존 코드가 `if (!fs.existsSync(dstFile))` 로만 분기되어 있던 것을 발견.

### 미해결 이슈 (다음 세션으로 이월)

- **Guardrail approval IPC 스키마 회귀** — 세션 `011d0029` 에서 transcript fallback 후 `write` 가 `Guardrail check failed: invalid plugin.approval.request params` (at root: unexpected property `request`; at `/severity`: must be equal to allowed values) 로 두 번 거부. youtube-transcript 스킬 자체와 무관, `electron/guardrail/ipc.ts` 의 approval payload 생성/검증 로직 점검 필요. → **다음 항목에서 해결**.

---

## 2026-04-25 — Guardrail 스키마 fix + run.md 실패/재시도 기록 + Sidetab 가드레일 패널 (Twixy)

### Twixy 변경 — Guardrail approval IPC 스키마 회귀 fix

#### `patches/openclaw+2026.4.2.patch`
- gateway 의 `PluginApprovalRequestParamsSchema` (TypeBox) 가 `severity: 'info' | 'warning' | 'critical'` 만 허용하는데, 어디선가 `severity: 'danger'` 와 root-level `request` 필드를 같이 보내서 두 번 reject. patch 에서 payload 생성부 정리 — `severity` 매핑을 `critical` 로 수정, root-level `request` 필드 제거.
- 원인: 세션 `011d0029` 에서 transcript fallback 후 `write` 가 두 번 거부된 사건의 직접 원인.

#### `src/components/GuardrailModal.tsx`
- 기존 코드가 `severity === 'danger'` 일 때만 빨강색을 적용했는데, gateway 가 이제 `'critical'` 로 보내므로 둘 다 빨강 처리.
- `(request.severity === 'critical' || request.severity === 'danger') ? 빨강 : 노랑` 로 변경 (background + color 두 곳).

#### `src/global.d.ts`
- `GuardrailApprovalRequest.severity` 타입을 `'info' | 'warning' | 'critical' | 'danger' | null` 로 확장 (gateway 신/구 schema 둘 다 수용).

### Twixy 변경 — run.md 실패/재시도 기록 구조화

`조영수 song list` 플랜 실행 분석 결과, verifier 가 RESULT: NO 로 step 1 을 stop 시켰는데 run.md 에는 멈춘 이유도 없고, 사용자가 retry 했을 때 재시도 기록도 없음. 원인을 코드 레벨에서 추적해서 3 곳을 고침.

#### `electron/planning.ts` — `beginRun` overwrite 버그 수정

- 기존: `if (plan.currentStepIdx === 0) fs.writeFileSync(...)` 로 step 1 retry 시마다 run.md 통째로 덮어써져서 직전 실패 기록이 사라지는 구조.
- 변경: `if (!fs.existsSync(runPath))` 게이트로 변경. 이미 존재하면 `appendFileSync` 로 `_Resumed at ... — retrying Step N_` 헤더만 덧붙임.

#### `electron/planning.ts` — `startStep` 재시도 라벨

- `plan.steps[idx].endedAt != null` 이면 기존 step 의 재실행이므로 `## Step N — Title (재시도)` 로 헤딩에 라벨링.
- 사용자가 run.md 만 보고도 "이건 재시도한 거구나" 를 파악 가능.

#### `electron/planning.ts` — `endStep` 실패 사유 명시

- 기존: `payload.summary` 가 있으면 무조건 `**Summary:** ...` 로 기록.
- 변경: `step.status === 'failed' && payload.summary` 인 경우 `**⚠️ Plan stopped — Reason:** ...` 으로 prefix 변경. 일반 성공 케이스는 기존대로 `**Summary:**` 유지.
- verifier 의 RESULT: NO reason 이 그대로 run.md 에 박혀서 사용자가 왜 멈췄는지 즉시 알 수 있음.

### Twixy 변경 — Guardrail 승인 sidetab 패널 (popup window 로 다시 분리 예정)

채팅 입력 sidetab 이 always-on-top 으로 떠있는 상황에서 가드레일이 메인 윈도우에 modal 로 뜨면 사용자가 메인 창을 띄워야 보임. 우선 sidetab 안에 인라인 패널로 띄워보고, 다음 세션에서 별도 BrowserWindow popup 으로 재구조화 예정.

#### `electron/main.ts`
- `ipcMain.handle('overlay-guardrail-decide')` 추가 — sidetab 창에서 받은 결정을 mainWindow 로 forward.

#### `electron/preload.ts`
- `overlayGuardrailDecide(payload)` 와 `onOverlayGuardrailDecide(cb)` 두 IPC 브리지 추가.

#### `src/global.d.ts`
- `OverlaySnapshot` 에 `pendingGuardrail: GuardrailApprovalRequest | null` + `guardrailMode: GuardrailMode` 추가.
- `TwixyAPI` 에 위의 두 메서드 타입 추가.

#### `src/App.tsx`
- 메인 창 → sidetab 으로 push 하는 OverlaySnapshot 에 `pendingGuardrail` / `guardrailMode` 포함.
- `onOverlayGuardrailDecide` 리스너 등록 — sidetab 에서 결정 오면 `guardrail.decide(req, action)` 호출.

#### `src/components/SidetabOverlay.tsx`
- `OverlayGuardrailPanel` 컴포넌트 (~140 줄) 추가. plan 블럭과 메시지 리스트 사이에 렌더. 헬퍼: `extractGuardrailTarget`, `buildGuardrailPreview`, `guardrailToolLabel`, `overlayBtnGhost`.
- **다음 작업 예정:** 이 패널을 sidetab 안에서 빼고, 별도 `guardrail-popup.html` BrowserWindow 로 분리 (composer 윈도우 분리 패턴 따라).

### 미해결 이슈 (다음 세션으로 이월)

- **Guardrail popup window 분리** — `SidetabOverlay.tsx` 에서 `OverlayGuardrailPanel` 제거, 별도 BrowserWindow 로 spawn 하는 구조로 재작업. → **다음 항목에서 해결**.
- **planning.ts 수정 검증** — verifier 실패가 발생하는 다음 플랜 실행 시 run.md 에 두 시도 모두 기록되는지 확인.

---

## 2026-04-25 (계속) — Guardrail popup BrowserWindow 분리 + ChatPanel preview UX + Spaces-following + verifier prompt 강화 (Twixy)

### Twixy 변경 — Guardrail popup 별도 BrowserWindow 로 분리

직전 세션의 sidetab inline panel 접근을 폐기하고, 가드레일 승인을 **자체 BrowserWindow** 로 띄우도록 재구조화. always-on-top + 모든 Space 표시 + fullscreen 위로 떠야 하는 보안 프롬프트라서 별도 윈도우가 맞음. Composer/Sidetab 분리 패턴 그대로 따름.

#### 신규 파일

| 파일 | 설명 |
|------|------|
| `guardrail.html` | Guardrail popup entry HTML |
| `src/guardrail/main.tsx` | Popup 렌더러 진입점 — `<GuardrailPopupWindow />` 마운트 |
| `src/components/GuardrailPopupWindow.tsx` | 가드레일 승인 UI 본체 (~349 줄). 마운트 시 `guardrailPopupRequestSync()` 으로 메인 상태 pull, 이후 `onGuardrailPopupSync` 로 push 받음. directory-scope 선택지(파일 경로 → 부모 디렉토리 `/**` allowlist) 포함. |

#### `electron/main.ts`
- `guardrailWindow: BrowserWindow | null` + `guardrailPopupState: unknown` 모듈-레벨 캐시 추가 (popup 이 mount 직후 첫 request 를 놓치지 않도록).
- `createGuardrailWindow()` 추가 — 520×520 frame:false transparent vibrancy:hud, `screen-saver` level + `visibleOnAllWorkspaces:true {visibleOnFullScreen:true}` 로 fullscreen 앱 위에 떠야 하는 보안 프롬프트 성격 반영.
- `closeGuardrailWindow()` 추가 — listener 정리 후 `close()`.
- IPC 핸들러 4개 (`// ── Guardrail popup IPC` 섹션):
  - `guardrail-popup-show`: payload 캐시 + `createGuardrailWindow()` + 이미 떠있으면 즉시 `guardrail-popup-sync` push
  - `guardrail-popup-close`: 캐시 clear + 윈도우 destroy
  - `guardrail-popup-request-sync`: popup mount 시 캐시 반환 (pull 패턴)
  - `guardrail-popup-decide`: popup 의 결정을 mainWindow 로 forward (allowlist/세션캐시 처리는 메인 렌더러의 `useGuardrail.decide` 가 담당)
- **legacy 제거**: `overlay-guardrail-decide` IPC 핸들러 제거.

#### `electron/preload.ts`
- `guardrailPopupShow(payload)`, `guardrailPopupClose()`, `guardrailPopupRequestSync()`, `onGuardrailPopupSync(cb)`, `onGuardrailPopupDecide(cb)`, `guardrailPopupDecide(payload)` 6개 IPC 브리지 추가.
- `overlayGuardrailDecide` / `onOverlayGuardrailDecide` 제거.

#### `src/global.d.ts`
- `OverlaySnapshot` 에서 `pendingGuardrail` / `guardrailMode` 제거 (sidetab 패널 폐기로 더 이상 sidetab 에 push 할 필요 없음).
- `TwixyAPI` 에 popup IPC 6개 타입 추가, overlay 가드레일 메서드 2개 제거.

#### `src/App.tsx`
- `GuardrailModal` import + 렌더 제거 (메인 윈도우 inline modal 폐기).
- popup lifecycle effect 추가: `guardrail.current` non-null 이면 `guardrailPopupShow({request, mode})`, null 이면 `guardrailPopupClose()`. 큐가 진행되면 자동으로 다음 request 가 push 됨.
- `onGuardrailPopupDecide` 리스너에서 `params` 도 같이 받아 effective request 재구성 (popup 의 directory-scope 선택이 fingerprint 에 반영되도록).
- OverlaySnapshot push 에서 가드레일 필드 제거.

#### `src/components/SidetabOverlay.tsx`
- 직전 세션에 추가했던 `OverlayGuardrailPanel` 컴포넌트(~140 줄) + 관련 헬퍼 + 렌더 위치 제거.
- 더 이상 sidetab 에서 가드레일 결정 안 함 — popup 윈도우가 단일 진입점.

#### `vite.config.ts`
- `rollupOptions.input` 에 `guardrail: path.resolve(__dirname, 'guardrail.html')` 추가.
- electron `external` 옵션에 `bufferutil`, `utf-8-validate` 추가 — `ws` 의 optional native acceleration deps. 번들 안 되도록 명시 (이전에 silent warning 발생).

#### `patches/openclaw+2026.4.2.patch`
- 30 줄 변경 — gateway 측에서 popup 윈도우와 호환 위해 approval 페이로드 schema 미세 정리.

### Twixy 변경 — ChatPanel preview pane UX 개선

#### `src/components/ChatPanel.tsx` (~196 줄 변경)
- **드래그 리사이즈** — `previewWidth` state(기본 420px) + `previewResizingRef` + `startPreviewResize` mousedown 핸들러. 좌측 6px col-resize grip(`zIndex:2`) 추가. clamp 범위 `[280, window.innerWidth - 360]`. 드래그 중엔 `body.style.cursor='col-resize'` + `userSelect='none'` 으로 텍스트 선택 차단.
- **Preview width 토글** — preview 닫혀있을 때 width 0, 열리면 `previewWidth`. transition 은 비-드래그 시점에만 유지.
- **마크다운 렌더링 일치** — 기존 `markdown-body` 클래스 → DataPanel 과 동일한 `md-render` 클래스로 변경. `marked(content, { breaks: true, gfm: true })` 시그니처 일치.
- **외부 링크 처리** — preview pane 내 `<a>` 클릭은 `e.preventDefault()` 후 `window.twixy.openExternal(href)`. 팝업이 in-app 브라우저로 변하지 않도록.

#### `src/styles/globals.css`
- `.md-render` 에 `user-select: text; -webkit-user-select: text; cursor: text;` 추가. 글로벌 `body { user-select: none }` 가 차단하던 Cmd+C 복사를 preview pane 안에서만 풀어줌.

### Twixy 변경 — 외부 링크 가드 + Sidetab/Composer Spaces-following 복구

#### `electron/main.ts` `wireExternalLinks(win)` 헬퍼
- `setWindowOpenHandler({url}) → if (https/mailto) shell.openExternal(url); return {action:'deny'}` — `target=_blank` / `window.open` 호출이 새 BrowserWindow 띄우는 것 차단.
- `will-navigate` 리스너 — origin+pathname 동일하면 통과(in-app 라우팅), 아니면 차단 + https/mailto 만 외부로.
- 4개 윈도우 모두에 적용: `mainWindow`, `overlayWindow`, `composerWindow`, `guardrailWindow`.
- 원인: 직전 패치에서 popup 안 markdown 의 YouTube URL 클릭 시 popup 자체가 브라우저처럼 작동(YouTube 페이지 로드)하던 버그.

#### `electron/main.ts` Sidetab/Composer always-on-top level
- `overlayWindow` / `composerWindow` 의 `setAlwaysOnTop(true, 'screen-saver')` → **`'floating'`** 으로 환원 + `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})` 유지.
- 원인: `'screen-saver'` level 이 fullscreen 위로는 떠도 일부 macOS 버전에서 단일 Space 에 pinned 되어 Cmd+→ 했을 때 sidetab/composer 가 따라오지 않는 회귀 발생. `'floating'` + visibleOnAllWorkspaces 조합이면 두 동작 모두 만족.
- `guardrailWindow` 만 `'screen-saver'` 유지 — 보안 프롬프트는 fullscreen 게임/영상 위로 강제 표시되어야 함.

### Twixy 변경 — verifier false-fail 감소 (plan-stop 오발 방지)

#### `src/hooks/usePlans.ts` `verifyAndExplain` (L110-145, L541-544)
- `stepContext` 시그니처에 `markerSummary?: string` 추가 → `marker?.summary` 가 verifier prompt 의 별도 first-class 필드로 노출. 기존엔 finalText 마지막 2000자 안에 묻혀있어서 verifier 가 마커 본문을 못 보거나 다른 noise 와 헷갈리는 케이스 발생.
- prompt 에 명시적 판정 규칙 4개 추가:
  - 같은 turn 안에서 한 도구가 먼저 실패했다가 같은 target 으로 retry 성공한 경우 = 성공
  - sub-agent 가 dispatch 만 되고 결과 미확인 = 실패
  - `(no output)` / silent termination / 마커 후 artifact 누락 = 실패
  - `[step-done]` 마커 + concrete evidence(file 생성, data 반환, 결과 확인)면 중간 에러 있어도 성공
- 원인: 2026-04-26 세션 `f979a112` 에서 minimax 모델이 같은 path 에 `content:""` 빈 문자열로 두 번 write 시도(툴이 reject) 후 세번째에 성공했는데, verifier 가 finalText 의 retry 노이즈 보고 `RESULT: NO` 판정 → "Plan stopped" 표시 → "Try again" 으로 재실행하니 정상 종료. 즉 false-fail. freeze 메커니즘(plan-fail 시 `setRequesterAnnounceFrozen(true)` 로 좀비 subagent announce 차단)은 보존해야 하므로 verifier 를 단순 trust 로 우회하지 않고 prompt 자체를 강화하는 방향.

### 검증 노트

- Sidetab/composer Cmd+→ Space-following 정상 (사용자 확인: "굿 해당 문제는 해결됨").
- popup 안 YouTube URL 클릭 시 시스템 브라우저로 열림 — popup 은 그대로 유지.
- preview pane Cmd+C 복사 가능, 280-window-360 범위 드래그 리사이즈 동작.
- verifier prompt 강화 효과는 다음 minimax/transient-retry 세션에서 검증 예정.

---

## 2026-04-25 (계속) — Settings 탭 BYOK 섹션 숨김 + Mobile Channels Beta 라벨 (Twixy)

### Twixy 변경 — `src/components/SettingsPanel.tsx`

#### BYOK 관련 4개 섹션 단일 플래그로 숨김

컴포넌트 상단에 `const SHOW_BYOK = false` 추가. 다음 4개 섹션을 `{SHOW_BYOK && (...)}` 로 감쌈:

- **LLM Mode** — Twixy hosted vs Bring-Your-Own-Key 라디오 토글
- **API Keys** — Anthropic/OpenAI 프로바이더별 key 입력 카드
- **Active Main Model** — `keys[p.id]` 가 있어야 선택 가능한 메인 모델 라디오
- **Sub-Agent Model** — 사용자 지정 (browser automation, file parsing, OCR 등 위임 작업용)

state(`twixyMode`, `keys`, `subagentModel` 등)와 load/save effect 는 모두 그대로 유지 — 플래그 한 줄만 `true` 로 바꾸면 즉시 복원됨. 사용자 요청 사유: "나중에 활성화하고 싶을 수도 있어서". 그래서 삭제가 아닌 토글-가능한 hide 로 처리.

side effect: `twixyMode` 가 default 'twixy' 로 고정 → Language Correction 섹션(`twixyMode === 'twixy'` 분기)은 그대로 표시됨. 의도된 동작.

#### Mobile Channels 라벨에 Beta 표기

`Mobile Channels` → `Mobile Channels — Beta` (h3 텍스트 한 줄 변경). Telegram/iMessage/WhatsApp 채널이 안정화 전 단계임을 표시.

---

## Push 이력

| 날짜 | 브랜치 | 커밋 | 내용 |
|------|--------|------|------|
| 2026-04-22 | `feature/twixy-enterprise` | `545bf94` | Twixy Enterprise initial implementation — entry point, TwixyEnterpriseDashboard (worker freq, completed today, completed work page, run.md modal), Electron IPC, dev/build scripts |
| 2026-04-23 | `feature/twixy-enterprise` | `0191456` | Theme color (무채색), Projects landing page with localStorage persistence, admin tab first in sidebar, Twixy Enterprise-specific build config for userData separation |
| 2026-04-23 | `feature/twixy-enterprise` | `00b25ac` | feat(twixy): manual pull-from-shared — remove auto-pull on startup, add Pull button in MR tab, fix TDZ crash |
| 2026-04-23 | `feature/twixy-enterprise` | `6b16f57` | feat(twixy): Enterprise Guardrail Mode — bypass/standard/strict modes, AdminPanel toggle, runtime IPC enforcement |
| 2026-04-23 | `feature/twixy-enterprise` | `d54cb4d` | fix(twixy): Guardrail config parser fix + English UI strings for AdminPanel guardrail section |
| 2026-04-24 | `feature/twixy-enterprise` | `2b1eb04` | fix(twixy): Guardrail reuse gateway WS connection — stop handshake spam on every IPC call |
| 2026-04-24 | `feature/twixy-enterprise` | `38d5644` | fix(twixy): move guardrail config to dedicated `twixy-guardrail.json` file (out of main config) |
| 2026-04-25 | `feature/twixy-enterprise` | `2f68143` | feat(twixy): new youtube-transcript skill (TSL v1.0) + skill sync pipeline docs (ONBOARDING §8/§9 — bundle/shared/user 3단 구조 + manual pull 강조) |
| 2026-04-25 | `feature/twixy-enterprise` | `48aa92d` | fix(twixy): Guardrail mode hot-reload + AdminPanel UX polish + verifier parser leniency (last-match RESULT extraction) |
| 2026-04-25 | `feature/twixy-enterprise` | `a263232` | fix(twixy): youtube-transcript v1.1 — exact-match `^show transcript$` (한/영) + isClickable filter + wrong-click fallthrough on 2nd poll |
| 2026-04-25 | `feature/twixy-enterprise` | `286f317` | fix(twixy): youtube-transcript v1.2→v1.5 (4단계 디버깅: dual panel selector / isVisible 필터 / inner button drill-down / raw verbatim 강제) + pull-shared size-based overwrite IPC |
| 2026-04-25 | `feature/twixy-enterprise` | `461dba6` | docs: backfill TWIXY_ENTERPRISE_CHANGELOG push history (Apr 23-25) |
| 2026-04-25 | `feature/twixy-enterprise` | `5b19b26` | fix(twixy): guardrail approval IPC 스키마 회귀 fix + run.md 실패/재시도 구조적 기록 + sidetab 가드레일 패널 (popup 분리는 다음 세션) |
| 2026-04-25 | `feature/twixy-enterprise` | `19ee4ab` | fix(twixy): guardrail popup BrowserWindow 분리 + ChatPanel preview drag-resize/md-render/text-selection + wireExternalLinks 4창 적용 + sidetab/composer floating level 환원 + verifier prompt false-fail 가드 |
| 2026-04-25 | `feature/twixy-enterprise` | `5524d0a` | fix(twixy): Settings 탭 BYOK 섹션 4개 (LLM Mode / API Keys / Active Main Model / Sub-Agent Model) SHOW_BYOK 플래그로 hide + Mobile Channels Beta 라벨 |
