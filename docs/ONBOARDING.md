# Twixy — Developer Onboarding Guide

## 0. 방향성 변경 이력 (반드시 먼저 읽으세요)

> **초기 Twixy는 마케팅을 직접 해주는 프로그램이었습니다.**
> 캠페인 자동 생성, 가설(Hypothesis) 기반 A/B 전략 수립, 포스팅 자동 실행 등을 중심 기능으로 설계했습니다.
>
> **현재 Twixy는 마케팅 업무를 도와주는 어시스턴트입니다.**
> 사용자가 조사하고 판단하는 흐름에서 데이터 수집, 분석, 요약을 보조하는 역할로 전환되었습니다.

**폐기된 개념 (이미 제거됨):**
- `strategy-gen` / `campaign-exec` / `analytics` 스킬 — 자동화 오케스트레이션 layer. 워크플로 시스템으로 대체.
- `strategist` / `executor` / `analyst` 에이전트 — 위 스킬들과 함께 제거.
- TSL의 `HYPOTHESIZE`, `PLAN`, `STRATEGIZE` 스테이지 — 위 파이프라인이 사용하던 것. TSL 자체는 살아있음.

위 항목들은 새 워크플로 빌더 (`/workflow` 탭) 에서 사용자가 직접 그래프로 정의하는 방식으로 흡수되었습니다.

---

## 1. 프로젝트 개요

Twixy는 **개인 마케팅 어시스턴트** macOS/Windows 데스크탑 앱입니다.
OpenClaw AI 에이전트 프레임워크 위에 구축되어, 소셜 미디어 데이터 수집·분석·요약을 대화 기반으로 제공합니다.

**현재 핵심 흐름:** 사용자 요청 → 브라우저 자동화로 데이터 수집 → 정리/요약 → 저장

---

## 2. 기술 스택

| 계층 | 기술 |
|---|---|
| UI 프레임워크 | React 19, TypeScript |
| 데스크탑 셸 | Electron 33 |
| 빌드 도구 | Vite 6 + `vite-plugin-electron` |
| AI 에이전트 | OpenClaw (로컬 게이트웨이, 포트 18789) |
| LLM | OpenRouter (기본: `xiaomi/mimo-v2-pro`) |
| 인증 / DB | Supabase |
| 에디터 | TipTap (Markdown + Table) |
| 스킬 언어 | TSL (Twixy Skill Language, 독자 DSL) |

---

## 3. 저장소 구조

```
twixy/
├── electron/               # Electron 메인 프로세스
│   ├── main.ts             # 앱 진입점, IPC 핸들러, OpenClaw 게이트웨이 관리
│   ├── preload.ts          # renderer ↔ main 브릿지 (contextBridge)
│   ├── tsl-compiler.ts     # .tskill → SKILL.md 컴파일러 (핵심)
│   ├── tsl-types.ts        # TSL 타입 정의
│   └── watchSync.ts        # 스킬 파일 변경 감지 및 자동 컴파일
│
├── src/                    # React 렌더러 프로세스
│   ├── App.tsx             # 루트 컴포넌트, 라우팅, 인증 게이트
│   ├── main.tsx            # React 진입점
│   ├── components/         # UI 패널들
│   │   ├── ChatPanel.tsx       # 메인 채팅 인터페이스
│   │   ├── DashboardPanel.tsx  # 데이터 시각화 대시보드
│   │   ├── DataPanel.tsx       # 워크스페이스 파일 브라우저
│   │   ├── SkillsPanel.tsx     # 스킬 목록 / 관리
│   │   ├── WatchtowerPanel.tsx # 하트비트
│   │   ├── HeartbeatPanel.tsx  # 에이전트 상태
│   │   ├── SettingsPanel.tsx   # API 키, 플랜, 사용량
│   │   ├── LoginScreen.tsx     # Supabase 소셜 로그인
│   │   ├── ConnectingSplash.tsx # 게이트웨이 연결 대기 스플래시
│   │   ├── Sidebar.tsx         # 탐색 사이드바
│   │   ├── StatusBar.tsx       # 연결 상태 / 사용량 표시
│   │   └── UpgradeModal.tsx    # 플랜 업그레이드 모달
│   ├── hooks/
│   │   ├── useOpenClaw.ts      # WebSocket 채팅 세션 관리
│   │   ├── useDashboardClaw.ts # 대시보드 전용 에이전트 세션
│   │   ├── useAuth.ts          # Supabase 인증 상태
│   │   ├── useEntitlements.ts  # 플랜 할당량 체크
│   │   └── useWatchtowerClaw.ts
│   ├── lib/
│   │   ├── supabase.ts         # Supabase 클라이언트
│   │   └── entitlements.ts     # FREE/PRO 플랜 한도 상수
│   └── global.d.ts         # window.twixy IPC API 타입 선언
│
├── skills/                 # 번들 내장 스킬 (extraResources로 패키징)
│   ├── data-scout/         # 데이터 수집
│   ├── gdoc-report/        # Google Docs 리포트 발행
│   ├── instagram-saved/    # 인스타그램 저장 릴스
│   ├── report-pack/        # PDF + XLSX + PPTX 합본
│   ├── sheet-sync/         # 로컬 XLSX ↔ Google Sheet 동기화
│   ├── watchtower/         # KPI 모니터링
│   └── youtube-transcript/ # YouTube 트랜스크립트 추출
│
├── docs/
│   ├── tskill-writing-guide.md  # .tskill 파일 작성 퀵 레퍼런스
│   └── SOUL.reference.md        # SOUL.md 원본 레퍼런스
│
├── SOUL.md                 # AI 에이전트 시스템 프롬프트 (Twixy의 성격/규칙)
├── AGENTS.md               # 서브에이전트 라우팅 규칙
├── TSL.md                  # TSL 언어 전체 명세
├── openclaw.json           # OpenClaw 게이트웨이 설정
├── package.json
└── vite.config.ts
```

---

## 4. 개발 환경 설정

### 사전 요구사항

- Node.js 20+
- OpenClaw 설치 및 실행 (`~/.openclaw/` 디렉토리 존재)
- macOS (주 개발 플랫폼, Windows도 빌드 가능)

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 개발 서버 실행 (Electron + Vite HMR)
npm run dev

# 프로덕션 빌드
npm run build

# macOS 배포 패키지 (.dmg)
npm run dist:mac

# Windows 배포 패키지 (.exe)
npm run dist:win
```

> `npm run dev` 는 내부적으로 Vite dev server (포트 5173) + Electron을 동시에 실행합니다.

---

## 5. 아키텍처 핵심 개념

### 5-1. OpenClaw 게이트웨이

OpenClaw는 로컬에서 실행되는 AI 에이전트 런타임입니다. Twixy는 이 게이트웨이에 WebSocket으로 연결하여 채팅 세션을 열고 에이전트 응답을 스트리밍합니다.

```
Electron Main ──spawn──▶ OpenClaw 게이트웨이 (localhost:18789)
React Renderer ──WS────▶ OpenClaw 게이트웨이
                              │
                              ├── LLM (OpenRouter)
                              ├── Browser 도구
                              ├── File System 도구
                              └── Sub-agent spawn
```

- **설정 파일:** `openclaw.json` (프로젝트 루트) + `~/.openclaw/openclaw.json` (홈 디렉토리, 런타임에 병합)
- **워크스페이스:** `~/.openclaw/workspace/twixy/` — 에이전트가 읽고 쓰는 모든 데이터의 루트

### 5-1a. openclaw.json overwrite 관계

Twixy 프로젝트 디렉토리와 `~/.openclaw/`는 다른 역할을 합니다.

```
프로젝트 디렉토리 (이 저장소)          ~/.openclaw/ (런타임 홈)
────────────────────────────          ──────────────────────────
openclaw.json                         openclaw.json  ← 실제 게이트웨이가 읽는 파일
  └─ 참고용 기본값 & 주석 포함           └─ Twixy가 앱 시작 시 덮어씀 (merge)
                                      workspace/twixy/  ← 에이전트 데이터
                                      twixy-mode.json   ← hosted/byok 설정
                                      twixy-session.json ← Supabase 세션
                                      twixy-channels.json ← Telegram/Discord 등
```

**덮어쓰기 동작 (`electron/main.ts` → `ensureWorkspace()`):**

앱이 시작될 때마다 `~/.openclaw/openclaw.json`을 다음 규칙으로 **재작성**합니다:

1. 기존 `~/.openclaw/openclaw.json`을 읽어서 spread(`...existingConfig`)로 보존
2. 그 위에 Twixy가 강제 주입하는 값들을 덮어씀:
   - `agents.defaults.workspace` → 항상 `~/.openclaw/workspace/twixy/`로 고정
   - `agents.defaults.model` → twixy 모드이면 `openrouter/minimax/minimax-m3` (2026-08 M2.7→M3 마이그레이션. Fireworks 가 M3 를 서빙하지 않아 provider 핀 제거 — `params.provider.allow_fallbacks=true` 로 OpenRouter 자동 라우팅), byok이면 사용자 저장값 유지
   - `agents.defaults.subagents.model` → twixy 모드이면 `openrouter/google/gemini-2.5-flash-lite`
   - `tools.profile` → `'coding'` 강제 (subagents 툴 노출 필요)
   - `tools.alsoAllow` → `['subagents', 'sessions_spawn', 'sessions_yield', 'browser', 'canvas']` 추가
   - `channels` → `twixy-channels.json`에서 읽어서 주입 (Telegram/Discord/Signal 등)

**프로젝트 루트의 `openclaw.json`은 게이트웨이가 직접 읽지 않습니다.** 개발자 참고용 + `electron-builder`가 `extraResources`로 패키징할 때 사용됩니다. 실제 동작에 영향을 주려면 `ensureWorkspace()` 로직을 수정하세요.

### 5-2. Twixy 모드 (Hosted vs BYOK)

| 모드 | 설명 |
|---|---|
| `twixy` (기본) | Twixy 호스팅 LLM 프록시 사용. API 키 불필요, 쿼터제 과금 |
| `byok` | 사용자가 직접 OpenAI/Anthropic 키 입력 |

모드는 `~/.openclaw/twixy-mode.json`에 저장되며, Settings 패널에서 변경 가능합니다.

### 5-3. IPC 브릿지 (Electron preload)

렌더러에서 메인 프로세스 기능에 접근할 때는 `window.twixy.*` API를 사용합니다.
타입 정의는 `src/global.d.ts`에 있습니다.

```typescript
// 예시
window.twixy.getTwixyMode()         // 현재 LLM 모드 조회
window.twixy.openExternalUrl(url)   // 외부 브라우저 열기
window.twixy.authSaveSession(s)     // Supabase 세션 저장
```

---

## 6. 인증 흐름

1. 사용자가 Twixy 웹사이트에서 소셜 로그인
2. 웹이 `twixy://auth#access_token=...&refresh_token=...` 딥링크로 리다이렉트
3. Electron이 딥링크를 파싱 → `~/.openclaw/twixy-session.json`에 저장
4. 렌더러의 `useAuth` 훅이 Supabase 세션으로 초기화

---

## 7. 에이전트 시스템 (AGENTS.md)

`AGENTS.md`는 에이전트 라우팅 규칙을 정의합니다. 에이전트들은 다음과 같이 분리되어 있습니다.

| 에이전트 | 역할 | 스킬 |
|---|---|---|
| `twixy` (Main) | 마케팅 전략가, 오케스트레이터 | — |
| `instagram-saved` | 인스타그램 저장 릴스 수집 | `instagram-saved` |
| `scout` | 원시 데이터 수집 | `data-scout` |
| `watcher` | 하트비트 | `watchtower` |

**에이전트 인격(SOUL.md):** Twixy AI의 행동 규칙, 위임 규칙, 브라우저 사용 규칙이 모두 `SOUL.md`에 명시되어 있습니다. 에이전트 동작을 수정할 때는 반드시 이 파일을 먼저 읽으세요.

---

## 8. TSL 스킬 시스템

### 개요

TSL(Twixy Skill Language)은 마케팅 워크플로우를 선언적으로 표현하는 독자 DSL입니다.

```
source.tskill
  → TSL Compiler (electron/tsl-compiler.ts)
  → SKILL.md (에이전트가 읽는 빌드 아티팩트)
```

**황금 규칙: `.tskill`이 소스, `SKILL.md`는 절대 직접 편집하지 마세요.**

### 스킬 파일 위치

team-collab phase 1+2 도입 후, 스킬은 **3단(bundle → shared → user)** 으로 흐릅니다. SKILLS.md 인덱스는 마지막 단(user)만 스캔합니다.

| 종류 | 위치 | 역할 |
|---|---|---|
| 번들 (source-of-truth) | `<repo>/skills/<name>/` (dev) 또는 `process.resourcesPath/skills/` (packaged) | 앱과 함께 빌드되어 배포되는 마스터 사본. 개발자가 직접 편집하는 곳. |
| 팀 공유 캐시 | `<projectRoot>/shared/skills/<name>/` | 매 launch 시 번들에서 `seedSharedFromBundle()` 로 자동 동기화. 팀과 공유되는 스냅샷. |
| 사용자 워크스페이스 | `<projectRoot>/users/<uid>/skills/<name>/` | 에이전트가 실제로 읽는 곳. SKILLS.md 인덱스 대상. `.twixy-custom` 마커 파일이 있으면 "custom"으로 분류. |

> 레거시 위치 `~/.openclaw/workspace/twixy/skills/custom/<name>/` 는 `electron/main.ts:770` 마이그레이션에서 `users/<uid>/skills/<name>/` 로 자동 이동됩니다. 새로 만들 때는 그 경로 쓰지 마세요.

### 스킬 동기화 파이프라인

```
[1] <repo>/skills/<name>/.tskill                       ← 개발자가 편집 (source-of-truth)
       │
       │  (앱 launch마다 자동) seedSharedFromBundle()
       ▼
[2] <projectRoot>/shared/skills/<name>/.tskill         ← 팀 스냅샷
       │
       │  (수동 IPC: pull-shared) projectSharedIntoUser()
       │  ⚠️ auto-startup 에서 빠짐. 기존 파일은 덮어쓰지 않고 missing 만 clone.
       ▼
[3] <projectRoot>/users/<uid>/skills/<name>/.tskill    ← 에이전트가 읽는 위치
       │
       │  (자동) compileTskillFiles()  → SKILL.md 생성
       │  (자동) regenerateSkillsIndex() → SKILLS.md 갱신
       ▼
[4] <projectRoot>/users/<uid>/SKILLS.md
```

핵심 함수는 모두 `electron/main.ts` 안에 있습니다:
- `seedSharedFromBundle()` (~line 527) — bundle → shared, 매 launch
- `projectSharedIntoUser()` (~line 553) — shared → user, **수동 트리거 (UI: SkillsPanel "Pull shared")**
- `compileTskillFiles()` (~line 799) — `.tskill` → `SKILL.md`, mtime 비교로 skip
- `regenerateSkillsIndex()` (~line 847) — workspace 의 `skills/` 스캔 → `SKILLS.md` 작성

### 스킬 자동 컴파일

`watchSync.ts` (또는 `main.ts` 의 `skillsWatcher`)가 사용자 워크스페이스 `skills/` 를 감시합니다. `.tskill` 변경 시 ~400ms 디바운스 후 `SKILL.md` 재컴파일 + `SKILLS.md` 재생성 + 렌더러 알림.

> **번들 / shared 만 수정해서는 SKILLS.md 가 갱신되지 않습니다.** user 단까지 내려와야 합니다.

```bash
# 새 스킬 추가 흐름 (개발 중)
1) <repo>/skills/my-skill/my-skill.tskill 작성
2) 앱 재시작 → shared/skills/my-skill/ 자동 시드
3) UI 에서 "Pull shared skills" 트리거 → users/<uid>/skills/my-skill/ 로 clone
4) 자동 컴파일 + SKILLS.md 갱신 완료
```

### .tskill 파일 기본 구조

```tskill
@workspace twixy          ← 필수: 플랫폼 잠금

SKILL "My Skill"
  version: 1.0
  summary: "SKILLS.md 인덱스에 표시될 한 줄 설명"
  description: "상세 설명 + 트리거 키워드"
  tags: [instagram, analytics]
  trigger: "analyze instagram, reel performance"
  output: "engagement report ($INSIGHTS)"

PLATFORMS {
  INSTAGRAM
}

PHASE "데이터 수집" {
  COLLECT "최근 30일 릴스" {
    USE instagram AS ig
    EXTRACT Post FROM ig WHERE type = "REEL" SINCE 30 days INTO $posts
    STORE $posts AS "posts_raw" IN $RAW
  }
}

PHASE "분석" {
  ANALYZE "참여율 분석" {
    LOAD "posts_raw" FROM $RAW AS $posts
    SPAWN analyst
      TASK "calculate engagement rate and rank top 10 posts"
      USING $posts
      OUTPUT $insights
      AWAIT
    STORE $insights AS "insights" IN $INSIGHTS
  }
}
```

### 파이프라인 스테이지 순서

`GOAL` → `COLLECT` → `ANALYZE` → `STRATEGIZE` → `EXECUTE` → `TRACK`

모든 스테이지는 반드시 `PHASE {}` 블록 안에 있어야 합니다. 스테이지는 이 순서를 지켜야 합니다.

### 예약 경로 별칭

| 별칭 | 실제 경로 |
|---|---|
| `$RAW` | `data/raw/` |
| `$INSIGHTS` | `data/insights/` |
| `$STRATEGIES` | `strategies/` |
| `$DRAFTS` | `content/drafts/` |
| `$PUBLISHED` | `content/published/` |
| `$REPORTS` | `data/reports/` |

### 자주 나오는 컴파일 에러

| 에러 | 원인 | 해결 |
|---|---|---|
| `invalid workspace` | `@workspace twixy` 누락 | 파일 첫 줄 확인 |
| `missing summary` / `missing trigger` | 필수 헤더 필드 누락 | SKILL 블록에 추가 |
| `stage outside PHASE` | 스테이지가 PHASE 밖에 선언됨 | PHASE {} 로 감싸기 |
| `PUBLISH without APPROVE` | POST 전에 APPROVE 게이트 없음 | APPROVE {} 추가 |
| `stage out of order` | 스테이지 순서 틀림 | GOAL→COLLECT→…→TRACK 순서 확인 |

전체 TSL 명세는 `TSL.md`, 퀵 레퍼런스는 `docs/tskill-writing-guide.md`를 참고하세요.

---

## 9. 워크스페이스 구조 (런타임)

team-collab phase 1+2 이후 layout 은 `<projectRoot>` 아래 **3-part** (`.twixy/` / `shared/` / `users/`) 구조입니다. 기본 `<projectRoot>` 는 `~/.openclaw/workspace/twixy/` 이지만, `~/.openclaw/twixy-project.json` 에 다른 경로가 저장돼있으면 그걸 따릅니다 (`getProjectRoot()`).

```
<projectRoot>/                       # 사용자가 picker 로 선택한 폴더 (기본 ~/.openclaw/workspace/twixy/)
├── .twixy/                          # 메타데이터 (config, snapshots, MR) — git 의 .git 같은 역할
│   ├── config.json
│   ├── snapshots/
│   └── mr/
├── shared/                          # 팀 공유 스냅샷 (개인 user 에 read-only)
│   └── skills/<name>/               # 번들에서 매 launch 시드됨
└── users/
    └── <uid>/                       # 개인 OpenClaw 워크스페이스 (= getWorkspace())
        ├── data/
        │   ├── raw/                 # Scout/수집 에이전트가 저장
        │   ├── insights/            # Analyst가 처리한 인사이트
        │   ├── saved/               # 사용자 수동 저장
        │   └── reports/             # 분석 리포트
        ├── strategies/              # (폐기 예정)
        ├── campaigns/               # 활성 캠페인 플랜
        ├── drafts/                  # 컨텐츠 초안
        ├── exports/                 # CSV/데이터 내보내기
        ├── logs/
        │   └── sessions/            # 세션별 JSONL
        ├── skills/<name>/           # 컴파일된 스킬 (built-in + custom)
        │                            # `.twixy-custom` 마커 파일로 custom 구분
        ├── SOUL.md / AGENTS.md / TOOLS.md / ...
        └── SKILLS.md                # 자동 생성 스킬 인덱스 (편집 금지)
```

> `SKILLS.md` 는 startup 시 + 워크스페이스 `skills/` 변경 감지 시 자동 갱신됩니다 (§8 동기화 파이프라인 참고). 번들/shared 단계 수정만으로는 갱신되지 않으니, 변경을 user 단까지 pull 해야 합니다.

---

## 10. 엔타이틀먼트 / 플랜

`src/lib/entitlements.ts`에 `FREE_PLAN` / `PRO_PLAN` 상수가 정의되어 있습니다.
`useEntitlements` 훅이 Supabase에서 사용량을 가져오고, 메시지 전송 시 쿼터를 선제 체크합니다.

**중요:** 엔타이틀먼트 API 오류 시 Fail-CLOSED(전송 차단)입니다. 와이파이를 끊어 우회하는 것을 방지합니다. (`App.tsx:79`)

---

## 11. 브라우저 자동화 주의사항

SOUL.md에 명시된 규칙이 있습니다. 브라우저 관련 코드를 건드릴 때 반드시 숙지하세요.

- 브라우저 프로파일은 항상 `profile: "twixy"` 사용 (`user` 프로파일은 비활성화)
- 풀페이지 스냅샷 금지 → 항상 `selector`로 범위 지정
- 페이지당 스냅샷 최대 2회
- 로그인이 필요한 플랫폼에 `web_fetch` / `web_search` 사용 금지 → 반드시 `browser` 사용

---

## 12. 주요 파일 빠른 참조

| 목적 | 파일 |
|---|---|
| 에이전트 인격/규칙 수정 | `SOUL.md` |
| 에이전트 라우팅 수정 | `AGENTS.md` |
| TSL 언어 명세 | `TSL.md` |
| 스킬 작성 퀵 레퍼런스 | `docs/tskill-writing-guide.md` |
| 첨부 파일(xlsx/docx/pptx/pdf) 인제스트 | `docs/FILE_INGEST.md` · `electron/tools/files/extractText.ts` |
| 덱 생성 구조 (1차: 공유 코어 / 2차: 목적·얼굴·시각 QA·편집 / 3·4차: 실측 루프 / 5–11차: 밴드·기하 검사·언어·페이지 타입) | `docs/PPTX_DECK_GENERATION.md` · `docs/PPTX_UPGRADE_2.md` · `docs/PPTX_UPGRADE_3.md` · `docs/PPTX_UPGRADE_4.md` |
| 덱 템플릿 카탈로그 (비개발용 — 뭐가 되나) | `docs/DECK_TEMPLATE_CATALOG.md` |
| 스킬 수정이 워크스페이스까지 안 갈 때 | `docs/SKILL_PROPAGATION.md` |
| OpenClaw 게이트웨이 설정 | `openclaw.json` |
| Electron 메인 로직 | `electron/main.ts` |
| TSL 컴파일러 | `electron/tsl-compiler.ts` |
| React 앱 진입점 | `src/App.tsx` |
| IPC 타입 | `src/global.d.ts` |
| 플랜 한도 상수 | `src/lib/entitlements.ts` |

---

## 13. 실제 사용 예시 (로그 기반)

`~/.openclaw/workspace/twixy/logs/sessions/` 세션 로그에서 추출한 실제 유저 요청 패턴입니다.
Heartbeat / cron 자동 트리거는 제외했습니다.

### 인스타그램 데이터 수집

- **저장한 릴스 5개 수집**: "나 최근에 저장한 릴스 5개 바로가기링크, 좋아요수, 댓글수랑 댓글도 5개씩 저장해서 테이블 데이터로 알려줘" → `instagram-saved` 스킬 실행, 서브에이전트가 브라우저로 인스타그램 접근, 결과를 테이블로 저장
- **저장 릴스 재수집**: "내 최근 인스타 릴스 5개 수집좀 저장한거" → 동일 스킬, 브라우저 자동화
- **타계정 분석**: "인스타에서 @nyung.sy 이 사람 계정 분석 좀" → 브라우저로 해당 계정 접근, 팔로워/게시물/참여율 수집
- **최근 30개 포스트 수집**: "Collect my last 30 Instagram posts" → 브라우저 자동화로 내 피드 스크롤, 데이터 저장

### 유튜브 리서치

- **반응 수집**: "카리나 솔로곡 유튜브 반응 요약 유튜브켜봐" → 브라우저로 유튜브 열어서 댓글/반응 영상 탐색, 요약 작성
- **반응 수집 2**: "유튜브 김하온 파이널 무대 반응좀 모아줘" → 유튜브 브라우저 탐색 후 반응 정리
- **반응 수집 3**: "브라우저 켜서 유튜브 BTS신곡 뮤비 반응" → 브라우저 직접 열기, 반응 수집
- **채널 전략 분석**: "어떤 비즈니스적 어드벤티지가있길래 계정 두개로 운영하는걸까? 하나는 콜라보영상만 올리고 하나는 일반 콘텐츠도 올리고 [OWIS 유튜브 링크]" → 해당 유튜브 채널 분석, 운영 전략 리포트
- **유튜버 에코시스템**: "어떻게하면 유튜버들을 이용할수있을까? 소프트웨어 사업하는데 유튜버들이 콘텐츠를 자발적으로 생성하는 이코시스템을 만들려고 하는중, 좋은 성공 예시좀 알려줘" → 웹 리서치 후 사례 분석 (Discord Nitro, Canva, Notion 등)
- **채널 애널리틱스**: "유튜브채널 애널리틱스 봐줘" → 유튜브 스튜디오 접근, 구독자/시청수/demographics 수집 (워크플로 빌더에서 `chrome` + `youtube` + `data-scout` 로 구성 가능)
- **브라우저 직접 열기**: "브라우저 켜서 유튜브 들어가줘" → 브라우저 프로필 `twixy`로 유튜브 열기

### 뉴스 스크래핑

- **네이버 뉴스 수집**: "네이버에서 ARA코리아 관련 기사 3개 수집" → 브라우저로 네이버 뉴스 검색, 기사 3개 본문 추출 후 저장
- **뉴스 스크랩 + 요약**: "레일바이크 네이버 뉴스 3개 스크랩후 요약해줘" → 브라우저 탐색, 요약 작성
- **서브에이전트 지정 스크랩**: "OWIS관련 네이버 뉴스 3개 스크랩 브라우저 켜서해줘, 그리고 브라우저쓸떄는 서브에이전트 생성해서해줘" → 메인 에이전트가 서브에이전트 spawn, 서브에이전트가 브라우저 처리

### 자동화 / 모니터링 (cron 트리거)

- **인스타그램 참여율 주기 감시**: `[cron] instagram_engagement_watch` — 인스타그램 참여율 체크 → 기준선 대비 20% 하락 시 알림, `data/saved/instagram_engagement.csv`에 기록
- **일별 팔로워 모니터**: `[cron] Daily Instagram follower + engagement monitor` — 매일 팔로워 수 / 참여율 변화 요약
- **워치타워 설정**: "Watch Instagram engagement rate every 6 hours and alert if drops 20% week over week" → `watchtower` 스킬로 cron 등록, 임계값 설정
