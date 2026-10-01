// ── 제품 프로필 타입 ─────────────────────────────────────────────────
// 한 레포에서 여러 제품(Twixy / Twixy Enterprise / Nodal)을 빌드한다. 제품마다
// 다른 것 — 앱 정체성, 서비스 엔드포인트, 같은 PC 에서 충돌하는 전역 자원(상태
// 폴더·포트·딥링크 스킴), 켜고 끄는 기능 — 은 전부 이 타입의 값으로만 표현한다.
//
// 규칙: 코어(electron/, src/, shared/)에 제품 이름으로 분기하는 코드를 쓰지 않는다.
// 값은 products/<id>/profile.ts 에 있고, 코어는 shared/product/current.generated.ts
// 가 내보내는 PRODUCT 하나만 읽는다 (scripts/write-product.ts 가 APP_MODE 로 생성).
//
// electron(CommonJS, tsc) 과 renderer(vite) 양쪽이 import 하므로 이 파일과
// profile.ts 는 순수 데이터여야 한다 — node/DOM/React import 금지.

export type ProductId = 'twixy' | 'twixy-enterprise' | 'nodal'

/** 코어에 구현된 사이드바 탭 / 메인 패널 id. src/App.tsx 와 Sidebar.tsx 가 공유한다. */
export type CoreView =
  | 'copilot' | 'chat' | 'workflow' | 'orchestration' | 'data' | 'strategies' | 'reports'
  | 'dashboard' | 'skills' | 'mr' | 'history' | 'admin' | 'settings'

/** 탭 id — 코어 탭이거나, 제품이 src/lib/productShell.ts 에 등록한 탭 (예: Nodal 의 'nodes'). */
export type View = CoreView | (string & {})

/** 제품이 기본 내장하는 MCP 서버 (사용자 등록분과 별개, 같은 id 로 덮어쓸 수 없다). */
export type BuiltinMcpServer =
  | { id: string; kind: 'http'; url: string; transport: 'sse' | 'streamable-http' }
  | { id: string; kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }

export type ProductFeatures = {
  /** 관리형 Chrome 자동화 (browser/canvas 툴, CDP 프로필, 라이브 프리뷰, 병렬 슬롯). */
  browser: boolean
  /** 서브에이전트 위임 (subagents / sessions_spawn / sessions_yield 툴). */
  subagents: boolean
  /** Tavily 웹 검색 토큰 핸드아웃. */
  webSearch: boolean
  /** 모바일/메신저 채널 (Telegram·Signal·Slack). */
  channels: boolean
  /** openclaw cron 예약 작업. */
  cron: boolean
  /** Sidetab overlay + floating composer 창. */
  sidetab: boolean
  /** 워크플로 빌더·러너 (Workflow Test 진행 overlay 창 포함). */
  workflows: boolean
  /** LibreOffice 동봉 (덱 실물 렌더). 패키징에서만 쓰인다. */
  libreoffice: boolean
  /** 기본 제품 스킬(skills/) 동봉·워크스페이스 복사. */
  bundledSkills: boolean
  /** 에이전트에 노출할 브릿지 툴 (openclaw 패치의 tool_* 이름). 'all' = 필터 없음. */
  bridgeTools: 'all' | string[]
  /** 위 플래그들로 표현 안 되는 추가 툴 차단 (openclaw 툴 id). 정책 레이어에서 막으므로
   *  모델에게 아예 보이지 않는다 — 프롬프트 규칙은 지켜지지 않는다는 게 실측 결과다. */
  toolsDeny: string[]
  /** 기본 내장 MCP 서버. */
  builtinMcp: BuiltinMcpServer[]
  /** Copilot 채팅의 모드 칩 (순서대로). 'wf'·'simple'·'content' 는 코어 내장, 그 밖의 id 는
   *  제품이 src/lib/copilotModes.ts 에 등록한 모드다. 하나뿐이면 칩 줄을 숨긴다. */
  copilotModes: string[]
  /** 새 채팅의 기본 모드. */
  defaultCopilotMode: string
  /** 사이드바에 보이는 뷰 (순서대로). settings 는 항상 맨 끝에 붙는다.
   *  코어 탭 id 가 아닌 값은 제품이 registerProductView() 로 등록한 탭이다. */
  views: View[]
  /** 마운트되는 패널. views 의 상위집합 — 사이드바에 없어도 내부 라우팅(Smart Export
   *  등)으로 도달하는 패널이 있다. 여기 없는 패널은 마운트하지 않는다 — 숨긴 채 돌던
   *  워크플로·오케스트레이션·팀 대시보드도 포함 (App.tsx 의 has()). */
  panels: View[]
  /** 팀(조직) 계정 — 조직 멤버십·회사 크레딧 조회. false 면 org 테이블을 아예 조회하지
   *  않는다 (그 테이블이 없는 백엔드를 쓰는 제품). */
  team: boolean
  /** 설정 화면의 Google Workspace 연결 섹션. */
  googleWorkspace: boolean
  /** 앱을 켰을 때 첫 화면. */
  initialView: View
  /** admin 패널을 프로젝트 어드민 대신 Enterprise 멀티-프로젝트 대시보드로 띄운다. */
  enterpriseAdmin: boolean
}

export type ProductProfile = {
  id: ProductId

  // ── 앱 정체성 ──────────────────────────────────────────────
  /** 사람이 읽는 제품명 — app.setName, 트레이, 스플래시, 로그인 화면. */
  displayName: string
  /** 타이틀바 워드마크 (대문자 표기). */
  wordmark: string
  /** 로그인 화면 안내 문구에 쓰는 계정 이름. */
  accountName: string
  /** electron-builder appId — 단일 인스턴스 락과 userData 폴더가 여기에 묶인다. */
  appId: string
  /** 로그인 핸드오프 딥링크 스킴 (`<scheme>://auth#...`). OS 에 하나만 등록된다. */
  protocolScheme: string
  /** 렌더러 진입 html (레포 루트 기준). */
  htmlEntry: string
  /** 관리형 Chrome 프로필에 표시되는 이름. */
  chromeDisplayName: string
  /** 새 워크스페이스에 심는 SOUL.md · AGENTS.md 가 있는 폴더 (레포 루트 기준, '' = 루트).
   *  openclaw 가 워크스페이스의 SOUL.md 를 에이전트의 기본 시스템 프롬프트로 읽는다. */
  workspaceSeedDir: string

  // ── 같은 PC 에서 충돌하는 전역 자원 ────────────────────────
  /** openclaw 상태 폴더 이름 (홈 디렉터리 기준). 게이트웨이에 OPENCLAW_STATE_DIR 로도 전달. */
  stateDirName: string
  /** 상태 폴더 안 제품 소유 파일들의 접두사 (`<prefix>-session.json.enc` 등). */
  stateFilePrefix: string
  /** 프로젝트 폴더를 고르기 전의 기본 워크스페이스 이름 (`<stateDir>/workspace/<name>`). */
  defaultWorkspaceName: string
  /** 로그·portable Node 를 두는 OS 앱 데이터 폴더 이름. */
  appDataDirName: string
  /** openclaw 게이트웨이 포트 (HTTP + WebSocket). */
  gatewayPort: number
  /** 채팅용 관리형 Chrome CDP 포트. */
  cdpPort: number
  /** 워크플로 병렬 슬롯 wf-1..N 의 CDP 포트. */
  workflowCdpPorts: number[]

  // ── 워크스페이스 ────────────────────────────────────────────
  /** 새 워크스페이스에 미리 만들어 두는 제품별 폴더 (chat/·memory/·logs/ 같은 코어 폴더 제외). */
  workspaceDirs: string[]
  /** 에이전트가 파일을 쓸 수 있는 워크스페이스-상대 폴더의 기본값 (사용자가 Settings 에서
   *  바꾸기 전). allowedSubdirs 는 `<root>/<subdir>/<file>` 한 단계를 허용할 하위 폴더. */
  designatedPaths: { roots: string[]; allowedSubdirs: Record<string, string[]> }

  // ── 서비스 레이어 ──────────────────────────────────────────
  supabase: { url: string; anonKey: string }
  /** 웹 백엔드 루트 — 키 발급·사용량·entitlements·로그인 콜백. 계약: docs/BACKEND_CONTRACT.md */
  webUrl: string
  /** 요금제 페이지. */
  pricingUrl: string

  features: ProductFeatures

  /** 패키징(electron-builder)에서 제품만 싣는 것. electron-builder.config.mjs 가 읽는다. */
  packaging?: {
    /** resources/ 에 더 실을 파일 (electron-builder extraResources 형식, 경로는 레포 루트 기준). */
    extraResources?: Array<{ from: string; to: string; filter?: string[] }>
    /** Windows 설치 파일 아키텍처. 기본 x64 + arm64. */
    winArch?: Array<'x64' | 'arm64'>
  }
}

// ── 제품의 메인 프로세스 확장 (products/<id>/electron/index.ts 의 registerMain 이 받는다) ──
export type ProductHandler = (payload: unknown) => unknown | Promise<unknown>

export interface ProductMainContext {
  /** renderer 의 window.twixy.productInvoke(name, payload) 가 부를 핸들러를 등록한다. */
  handle(name: string, fn: ProductHandler): void
  /** 현재 사용자의 워크스페이스 폴더 (절대 경로). */
  getWorkspace(): string
  /** 앱 경로 — 제품이 자기 데이터·동봉 리소스를 찾을 때. */
  paths: {
    /** OS 앱 데이터 폴더 (Electron userData). */
    userData: string
    /** 패키지 앱의 resources 폴더 (extraResources 가 여기 풀린다). dev 에서는 레포 루트. */
    resources: string
    /** 레포 루트 (dev) 또는 app.asar 경로 (패키지). */
    appRoot: string
    isPackaged: boolean
  }
  /** 게이트웨이(에이전트 런타임)를 띄우기 **전에** 기다릴 일. 부팅 때 한 번, 등록 순서대로.
   *  예: 에이전트가 붙을 로컬 MCP 서버를 먼저 띄운다. 오래 걸리면 앱 시작이 늦어지므로
   *  제품 쪽에서 상한을 둘 것 — 여기서 throw 해도 게이트웨이는 그대로 뜬다. */
  onBeforeGatewayStart(fn: () => Promise<void>): void
  /** 앱 종료 직전 (before-quit). 동기로 끝나야 한다 — 자식 프로세스 kill 등. */
  onQuit(fn: () => void): void
  /** 게이트웨이를 다시 띄운다. 에이전트 세션은 MCP 툴 목록을 세션 시작 때 한 번 읽으므로,
   *  제품이 MCP 서버를 재시작했거나 툴이 바뀌었으면 이걸 불러야 새 툴이 보인다.
   *  진행 중인 채팅 턴은 끊긴다. */
  restartAgentRuntime(): Promise<void>
}
