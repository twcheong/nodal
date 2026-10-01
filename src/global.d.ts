// ─────────────────────────────────────────────────────────────────────────────
// global.d.ts — 렌더러에서 참조하는 앰비언트 타입 선언.
//
// 포함 내용:
//   1) TSL 컴파일러 타입 (electron/tsl-types.ts 에서 미러링 — 렌더러는 electron/ import 불가)
//   2) Window 인터페이스 확장 — preload.ts 가 exposeInMainWorld 로 붙이는 window.twixy.*
//      API 의 타입 시그니처. preload.ts 구현과 반드시 동기화 유지.
// ─────────────────────────────────────────────────────────────────────────────

// vite.config.ts 의 define 으로 주입되는 빌드 상수 (package.json 의 version).
declare const __APP_VERSION__: string

// TSL 컴파일러 타입 (electron/tsl-types.ts 에서 미러링)
interface TslError {
  line: number | null
  message: string
  code?: string
}

interface TslWarning {
  line: number | null
  message: string
}

interface TslCompileResult {
  ok: boolean
  markdown: string | null
  errors: TslError[]
  warnings: TslWarning[]
  metadata: {
    skill: string
    version: string
    compiledAt: string
  } | null
}

interface SkillManifest {
  name: string
  displayName: string
  description: string
  tags: string[]
  author: string
  version: string
  platforms: string[]
  schedule?: string
  stages: string[]
  steps: { type: string; label: string }[]
  sourceFile: string
}

// Mobile channel config (Telegram / Discord / Signal / BlueBubbles)
interface ChannelsConfig {
  telegram?:    { enabled: boolean; botToken?: string; allowFrom?: string[]; dmPolicy?: 'pairing' | 'allowlist' | 'open' }
  discord?:     { enabled: boolean; token?: string }
  signal?:      { enabled: boolean; account?: string; cliPath?: string; allowFrom?: string[]; dmPolicy?: 'pairing' | 'allowlist' | 'open' }
  bluebubbles?: { enabled: boolean; serverUrl?: string; password?: string; webhookPath?: string }
  slack?:       { enabled: boolean; botToken?: string; appToken?: string; dmPolicy?: 'pairing' | 'allowlist' | 'open'; allowFrom?: string[] }
}

// Team collaboration (Git-style project layout)
type CollabMode = 'solo' | 'shared-folder' | 'server'
interface ProjectConfig {
  version:   1
  projectId: string
  mode:      CollabMode
  ownerUid?: string
  ownerEmail?: string
  serverUrl?: string
  reviewers?: { uid: string; email?: string }[]
  requiredApprovals?: number
  createdAt: string
}
type ProjectConfigResult = { ok: boolean; error?: string; config?: ProjectConfig }

// Merge Request (Phase 2: local-only)
type MRStatus = 'open' | 'changes_requested' | 'approved' | 'merged' | 'rejected'
interface MRActor { uid: string; email?: string }
type MRChange =
  | { op: 'add';    path: string; blobSha: string }
  | { op: 'modify'; path: string; blobSha: string; prevSha: string }
  | { op: 'delete'; path: string;                  prevSha: string }
interface MRReviewer {
  uid: string; email?: string
  decision: 'approve' | 'reject' | null
  at: string | null
  comment?: string
}
interface MRComment {
  id: string
  author: MRActor
  body: string
  at: string
}
interface MergeRequest {
  id: string
  projectId: string
  title: string
  description?: string
  author: MRActor
  baseSnapshot: string
  status: MRStatus
  changes: MRChange[]
  reviewers: MRReviewer[]
  requiredApprovals: number
  comments: MRComment[]
  createdAt: string
  updatedAt: string
  mergedAt?: string
}
type MRContentInput = string | ArrayBuffer | Uint8Array
type MRChangeInput =
  | { op: 'add';    path: string; content: MRContentInput }
  | { op: 'modify'; path: string; content: MRContentInput }
  | { op: 'delete'; path: string }
type MRCreatePayload = {
  title: string
  description?: string
  reviewers?: { uid: string; email?: string }[]
  requiredApprovals?: number
  changes: MRChangeInput[]
}
type MRResult = { ok: boolean; mr?: MergeRequest; error?: string }
type MRBlobResult = { ok: boolean; text?: string; binary?: boolean; size?: number; dataUrl?: string; error?: string }

// Planning Mode — mirrors electron/planning.ts Plan shape. Duplicated
// here so the renderer can type plan IPC results without importing
// Node-only code.
type TwixyPlanStatus     = 'draft' | 'running' | 'paused' | 'done' | 'aborted' | 'failed'
type TwixyPlanStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'interrupted' | 'failed'
interface TwixyL8Step {
  id:          string
  title:       string
  toolName?:   string
  toolCallId?: string
  input?:      unknown
  outcome?:    'ok' | 'failed' | 'skipped'
  detail?:     string
}
interface TwixyL7Subtask {
  id:       string
  title:    string
  purpose?: string
  status:   'done' | 'failed' | 'partial'
  steps:    TwixyL8Step[]
}
// L7 아웃라인 — 워크플로 authoring/표시 전용 경량 형태. 실행 기록인
// TwixyL7Subtask(status/steps 필수)와 달리 사용자/LLM 이 정의하는 계획
// 단계라 status·steps 가 없다. parseWorkflowSpec 가 이 형태로 생성하고
// WorkflowNodeCard 가 title/purpose 만 표시한다.
interface TwixyL7Outline {
  id:       string
  title:    string
  purpose?: string
}
interface TwixyModuleParam {
  id: string
  kind: 'scalar' | 'list'
  valueType: 'url' | 'path' | 'query' | 'text' | 'json' | 'number'
  label: string
  observed: unknown
  confidence: 'low'
}
interface TwixyModuleL8 { toolName?: string; title: string; inputTemplate?: unknown }
interface TwixyModuleL7 { title: string; repeat?: { over: string; as: string }; steps: TwixyModuleL8[] }
interface TwixyModuleTask { title: string; detail?: string; acceptance?: string; skillHint?: string | null; parameters: TwixyModuleParam[]; subtasks: TwixyModuleL7[] }
interface TwixyModuleSpec {
  version: 1
  status: 'candidate'
  source: { planId: string; generatedAt: string; method: 'single-trace-heuristic' }
  tasks: TwixyModuleTask[]
}
interface TwixyPlanStep {
  id:         string
  title:      string
  detail:     string
  acceptance: string
  skillHint:  string | null
  status:     TwixyPlanStepStatus
  startedAt?: string
  endedAt?:   string
  summary?:   string
  artifacts?: { path: string; kind: string; note?: string }[]
  compactSummary?:    string
  rawToolCallIds?:    string[]
  rawTranscriptPath?: string
  compactedAt?:       string
  subtasks?:          TwixyL7Subtask[]
  procedure?:         TwixyL7Subtask[]
}
interface TwixyPlan {
  version:          1
  id:               string
  projectId:        string
  author:           { uid: string; email?: string }
  createdAt:        string
  updatedAt:        string
  title:            string
  sourcePrompt:     string
  priorRunRefs:     string[]
  skillsReferenced: string[]
  status:           TwixyPlanStatus
  currentStepIdx:   number
  sessionKey?:      string
  pauseRequested:   boolean
  steps:            TwixyPlanStep[]
  origin?:          'chat' | 'execution-plan'
  executionContext?: string
  moduleSpec?:      TwixyModuleSpec
}

// ── Workflows (Marketing IDE) ─────────────────────────────────────────────
// A named, ordered chain of L6 nodes that the user pre-composes outside any
// single chat session. v1 = read-only viewer. Each node carries the same
// shape as a PlanStep (L6) and reuses TwixyModuleParam to declare what it
// needs as input — so when execution is hooked up later the workflow maps
// 1:1 to a sequence of ModuleTasks for the Clovex handoff.
// ── Workflow node typing (PDF 0613 정의 반영) ───────────────────────────
// 노드 타입 3종: action(원), review(삼각형), validation(사각형).
// action 노드는 tool 필수, review/validation은 tool 불필요(태그가 자동).
// tool은 워크플로용 추상 카탈로그 — src/lib/workflowTools.ts 참고.
// toolSkills는 카탈로그가 정의한 skill 키들 (선택).
// inputScope / outputScope는 노드 펼침 시 표로 표시되는 입/출력 명세.
type WorkflowNodeType = 'action' | 'review' | 'validation'
// MUST match src/lib/workflowTools.ts WORKFLOW_TOOLS[].id exactly. global.d.ts
// is ambient, so we can't `typeof` import without converting the whole file to
// a module (which would break all other ambient globals). The catalog module
// runs a drift assertion at load time — bare console.warn, no throw — so
// mismatches surface immediately in dev console.
type WorkflowTool =
  | 'chrome' | 'web-fetch' | 'read' | 'write' | 'edit'
  | 'api'    | 'app'       | 'mcp'  | 'data'
interface WorkflowScopeField {
  name:        string
  type:        string                              // 'url' | 'json' | 'md' | … 자유 문자열
  description?: string
}
interface TwixyWorkflowNode {
  id:          string
  type:        WorkflowNodeType                    // 기본 'action' (호환)
  title:       string
  detail?:     string
  acceptance?: string
  skillHint?:  string | null
  tool?:       WorkflowTool                        // action 노드 필수
  toolSkills?: string[]                            // 카탈로그 skill 키 (선택)
  subtasks?:   TwixyL7Outline[]                    // L7 리스트 (펼침 시 표시)
  inputScope?:  WorkflowScopeField[]
  outputScope?: WorkflowScopeField[]
  requires?:   TwixyModuleParam[]
}
interface TwixyWorkflow {
  version:      1
  id:           string
  title:        string
  description?: string
  // The LLM instruction body for this workflow. Use {{input_id}} placeholders
  // that match an entry in `inputs` below — the chat will ask the user for
  // each one when Run is pressed.
  prompt?:      string
  inputs?:      TwixyModuleParam[]
  // research = 데이터 생성(write 로 끝/검증-직전-write) / execution = 행동(출력 없음). AI Agent 타입 근거.
  type?:        WorkflowType
  // 산출물 저장 폴더(워크플로 파일 수준 설정). write 노드가 있는 research 워크플로의 파일 위치.
  outputDir?:   string
  // 로컬 분류 태그(소문자, 최대 8개). WF 리스트 표시/필터용. 팀 공유 태그와 별개.
  tags?:        string[]
  // 팀 공유본에서 fork 한 사본의 원본 참조 — stale 감지("원본 업데이트됨" 배지)용.
  // copiedUpdatedAt = 복사 시점의 공유본 updated_at 스냅샷.
  sourceShared?: { sharedId: string; sourceWfId: string; copiedUpdatedAt: string }
  // 팀 실시간 공동편집 문서 id (live_workflows.id). 있으면 이 워크플로는 "함께 편집" 상태 —
  // 서버 라이브 행이 진실이 되고 편집이 Realtime 으로 팀에 전파된다. (US-R1-04)
  liveId?:      string | null
  author:       { uid: string; email?: string }
  createdAt:    string
  updatedAt:    string
  nodes:        TwixyWorkflowNode[]
}
type WorkflowType = 'research' | 'execution'

// run 상세 로그 — electron/planning.ts RunDetail 과 동일 shape (실행 로그 뷰어).
interface TwixyRunDetailNode {
  nodeId:     string
  title:      string
  type?:      string
  tool?:      string
  status:     string
  startedAt?: number
  endedAt?:   number
  durationMs?: number
  costUsd?:   number
  tokensIn?:  number
  tokensOut?: number
  reason?:    string
  prompt?:    string
  output?:    string
  toolCalls?: Array<{ name: string; detail?: string }>
}
interface TwixyRunDetail {
  runId:     string
  wfId:      string
  wfTitle:   string
  status:    'done' | 'failed' | 'aborted'
  startedAt: number
  endedAt:   number
  totals:    { ms: number; usd: number; tokensIn: number; tokensOut: number }
  nodes:     TwixyRunDetailNode[]
}

// run 히스토리 1건 — electron/planning.ts RunHistoryEntry 와 동일 shape.
interface TwixyRunHistoryEntry {
  runId:      string
  wfId:       string
  wfTitle:    string
  status:     'done' | 'failed' | 'aborted'
  startedAt:  number
  endedAt:    number
  durationMs: number
  costUsd:    number
  failReason?: string
  nodeTotal:  number
  nodeDone:   number
  harness?:   'v1' | 'v2' | 'v3' | 'off'
}

// ── Orchestrations (L4 Work Package) ──────────────────────────────────────
// 한 계층 위(L4)에서 여러 Workflow(L5)를 "멤버" 로 참조해 5가지 패턴으로 조율한다.
// 멤버는 L6 노드를 직접 갖지 않고 항상 기존 workflowId 를 가리킨다 (참조 모델).
// 패턴(명칭은 제품 재정의, 괄호는 Azure 원본):
//   pipeline   (Sequential) — 선형 체인, 앞 출력이 다음 입력
//   parallel   (Concurrent) — 동일 입력 동시 실행 후 종합
//   roundtable (Group chat)  — 공유 스레드, 매니저가 발언 순서 관리, maker-checker
//   relay      (Handoff)     — 한 번에 한 멤버, 활성 멤버가 인계 결정
//   conductor  (Magentic)    — 매니저가 task ledger 를 동적으로 구성·갱신
type OrchestrationPattern = 'pipeline' | 'parallel' | 'research' | 'roundtable' | 'relay' | 'conductor'
// 멤버 = 기존 Workflow(L5) 참조(leaf), 또는 서브그룹(children + subPattern).
// 중첩 그룹은 임의 깊이 — children 의 멤버도 다시 그룹일 수 있다(재귀 트리).
// 오케스트레이션 자체가 루트 그룹(pattern + members), 각 그룹이 로컬 패턴을 가진다.
interface OrchestrationMember {
  id:          string                  // 노드 인스턴스 id (트리 전체에서 유일)
  workflowId:  string                  // leaf: → TwixyWorkflow.id (L5). 그룹/agent leaf 면 '' 가능
  agentId?:    string                  // Team leaf: → TwixyAiAgent.id (Orchestration 멤버는 agent 참조)
  label?:      string                  // 표시 override, 기본 workflow.title
  order?:      number                  // 부모 그룹 내 순서
  role?:       'maker' | 'checker' | 'participant' | 'manager'  // roundtable
  handoffTo?:  string[]                // relay: 인계 가능한 멤버 id 들
  // ── 서브그룹 (재귀) ──
  subPattern?: OrchestrationPattern    // children 을 조율하는 패턴 (그룹일 때)
  children?:   OrchestrationMember[]   // 자식 멤버들 (leaf 또는 그룹). 있으면 이 멤버는 그룹
  width?:      number                  // 그룹 박스 폭(px) — 마우스 리사이즈 결과 저장
  // 그룹의 명시적 OUTPUT 정의 (Workflow 노드 outputScope 와 동일 구조). 지정 시 자동 도출보다
  // 우선해 다음 노드 input 호환 검사에 쓰인다. 그룹 노드에만 의미 있음.
  outputScope?: WorkflowScopeField[]
  // Parallel 그룹 전용 — 그룹 output 으로 쓸 멤버(분기) id 들(여러 개 선택 가능). 미지정 = 전체.
  outputFrom?: string[]
  // 그룹 매니저/criteria 설정 (relay 라우팅 기준). 루트 그룹은 config.* 사용.
  managerInstructions?: string
  managerModel?:        string
}
// 빌더/IPC 입력용 재귀 부분 타입 (children 까지 모두 optional).
interface OrchestrationMemberInput {
  id?:          string
  workflowId?:  string
  agentId?:     string
  label?:       string
  order?:       number
  role?:        'maker' | 'checker' | 'participant' | 'manager'
  handoffTo?:   string[]
  subPattern?:  OrchestrationPattern
  children?:    OrchestrationMemberInput[]
  width?:       number
  outputScope?: WorkflowScopeField[]
  outputFrom?:  string[]
  managerInstructions?: string
  managerModel?:        string
}
interface OrchestrationConfig {
  aggregation?: 'concat' | 'vote' | 'synthesize'   // parallel 결과 종합 방식, 기본 synthesize
  maxRounds?:   number                 // roundtable / conductor 루프 캡, 기본 6
  maxHandoffs?: number                 // relay 루프 캡, 기본 6
  // 코디네이터(manager) 노드 설정 — roundtable/conductor 의 매니저, relay 의 라우팅에 사용.
  managerInstructions?: string         // 매니저 커스텀 지시문 (턴 순서/합격 기준/라우팅 규칙 등)
  managerModel?:        string         // 매니저 LLM 모델 id (미지정 시 기본)
}
interface TwixyOrchestration {
  version:      1
  id:           string
  title:        string
  description?: string
  pattern:      OrchestrationPattern
  prompt?:      string                 // L4 목표/지시 (선택), {{input_id}} placeholder
  inputs?:      TwixyModuleParam[]
  members:      OrchestrationMember[]
  config?:      OrchestrationConfig
  author:       { uid: string; email?: string }
  createdAt:    string
  updatedAt:    string
}

// ── AI Agents (Specialist 단위) ───────────────────────────────────────────
// AI Agent = criteria + 옵션(workflow leaf 또는 pipeline 서브체인) 목록. 입력에 가장 적합한
// 옵션 1개를 골라 실행. agentType 은 옵션 워크플로 타입에서 도출(research=출력생성/execution=행동).
type AiAgentType = 'research' | 'execution'
interface TwixyAiAgent {
  version:      1
  id:           string
  title:        string
  description?: string
  criteria?:    string
  agentType:    AiAgentType
  options:      OrchestrationMember[]
  author:       { uid: string; email?: string }
  createdAt:    string
  updatedAt:    string
}

// logbook 작업 컨텍스트 마커 — electron/logbook-bridge.ts 의 LogbookMarker 미러.
// (logbook 의 ContextMarkerModel 과 1:1; ts 는 epoch 초, 생략 시 main 이 채움)
interface TwixyLogbookMarker {
  event:      'start' | 'end'
  task_id:    string
  level?:     'L6' | 'L7' | 'L8'
  title?:     string
  actor?:     'AI' | 'HUMAN'
  parent_id?: string
  plan_id?:   string
  ts?:        number
}

// Enterprise Guardrail Mode — intercept file-modifying / destructive
// tool calls and require user approval before execution.
type GuardrailMode = 'bypass' | 'standard' | 'strict'
interface GuardrailAllowlist {
  write: string[]
  edit:  string[]
  bash:  string[]
}
interface GuardrailConfig {
  mode:      GuardrailMode
  allowlist: GuardrailAllowlist
}
type GuardrailConfigResult = { ok: boolean; error?: string; config: GuardrailConfig }

// Designated paths — workspace-relative roots LLM file-writes may target.
// Edited via SettingsPanel; mirrored to the OpenClaw subprocess at spawn
// via TWIXY_DESIGNATED_ROOTS / TWIXY_ALLOWED_SUBDIRS env.
interface DesignatedPathsConfig {
  version: 1
  roots: string[]
  allowedSubdirs: Record<string, string[]>
}

// Approval request shape broadcast by OpenClaw gateway's plugin.approval.requested
interface GuardrailApprovalRequest {
  id:            string
  // 요청을 보낸 플러그인 — "twixy.guardrail"(모드 게이트) | "twixy.overwrite"
  // (기존 파일 덮어쓰기 승인 — guardrail 이 bypass 여도 항상 사람이 결정).
  pluginId?:     string
  toolName:      string      // Write | Edit | NotebookEdit | Bash
  title:         string
  description:   string
  // Gateway sends one of "info" | "warning" | "critical" — see TypeBox enum
  // in PluginApprovalRequestParamsSchema. "danger" is kept here for legacy
  // payloads from older gateway builds.
  severity?:     'info' | 'warning' | 'critical' | 'danger' | null
  params?:       Record<string, unknown>   // raw tool params
  createdAtMs:   number
  expiresAtMs:   number
}

// Admin panel stats payload (server-walked, best-effort up to 200k files per dir)
interface AdminDirStats { size: number; files: number; capped: boolean }
interface AdminStats {
  paths: { projectRoot: string; user: string; shared: string; meta: string }
  storage: {
    user:   AdminDirStats
    shared: AdminDirStats
    meta:   AdminDirStats
    blobs:  { count: number; size: number }
  }
  mrs:   { open: number; merged: number; other: number }
  actor: MRActor
}

// Live-preview screencast metadata — CSS viewport size + scroll offset.
interface BrowserPreviewFrameMeta {
  deviceWidth: number
  deviceHeight: number
  pageScaleFactor: number
  offsetTop: number
  scrollOffsetX: number
  scrollOffsetY: number
}

// Input forwarded from the preview panel to the headless Chrome. Coords are
// fractions (0..1) of the displayed frame; main maps them to viewport pixels.
type BrowserPreviewInput =
  | { targetId: string; kind: 'click'; xFrac: number; yFrac: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { targetId: string; kind: 'move';  xFrac: number; yFrac: number }
  | { targetId: string; kind: 'wheel'; xFrac: number; yFrac: number; deltaX: number; deltaY: number }
  | { targetId: string; kind: 'text';  text: string }
  | { targetId: string; kind: 'key';   action: 'down' | 'up'; key: string; code: string; keyCode: number; text?: string }

interface TwixyAPI {
  platform: NodeJS.Platform
  getWorkspace: () => Promise<string>
  // TWIX-26: 현재 실행 중인 앱 버전 문자열(예: "0.1.0").
  getAppVersion: () => Promise<string>
  getProjectDir:       () => Promise<string | null>
  setProjectDir:       (dir: string) => Promise<{ ok: boolean; error?: string }>
  pickProjectDir:      () => Promise<{ ok: boolean; canceled?: boolean; dir?: string }>
  onProjectDirChanged: (cb: (dir: string) => void) => () => void
  getCollabMode:    () => Promise<CollabMode>
  getProjectConfig: () => Promise<ProjectConfig | null>
  setProjectConfig: (patch: Partial<ProjectConfig>) => Promise<ProjectConfigResult>
  claimProjectOwnership: () => Promise<ProjectConfigResult>

  // Enterprise Guardrail
  guardrailGetConfig: () => Promise<GuardrailConfig>
  guardrailSetConfig: (patch: Partial<GuardrailConfig>) => Promise<GuardrailConfigResult>
  guardrailRemoveAllowlistEntry: (payload: { tool: 'write' | 'edit' | 'bash'; entry: string }) => Promise<GuardrailConfigResult>
  /** 덮어쓰기 승인창의 "Save as…" — <승인 id> → 새 경로 매핑을 등록한다.
   *  성공하면 게이트웨이가 그 승인 건의 write 경로를 relPath 로 갈아끼운다. */
  guardrailOverwriteRedirect: (payload: { id: string; originalRel: string; fileName: string }) =>
    Promise<{ ok: boolean; relPath?: string; error?: string }>
  onGuardrailConfigChanged: (cb: (cfg: GuardrailConfig) => void) => () => void

  // Designated paths — workspace bucket whitelist (LLM file-write scope)
  designatedPathsGetConfig: () => Promise<DesignatedPathsConfig>
  designatedPathsSetConfig: (patch: Partial<DesignatedPathsConfig>) =>
    Promise<{ ok: boolean; error?: string; config: DesignatedPathsConfig }>

  // Admin panel: storage + MR stats for the current project
  adminStats: () => Promise<AdminStats>
  adminReveal: (absPath: string) => Promise<boolean>

  // Merge Request (Phase 2: local-only)
  mrCurrentActor: () => Promise<MRActor>
  mrList:         (payload?: { status?: MRStatus }) => Promise<MergeRequest[]>
  mrCreate:       (payload: MRCreatePayload) => Promise<MRResult>
  mrReview:       (payload: { id: string; decision: 'approve' | 'reject'; comment?: string }) => Promise<MRResult>
  mrComment:      (payload: { id: string; body: string }) => Promise<MRResult>
  mrCancel:       (id: string) => Promise<MRResult>
  mrMerge:        (id: string) => Promise<MRResult>
  mrReadBlob:     (payload: { id: string; sha: string; path?: string }) => Promise<MRBlobResult>
  mrReadShared:   (relPath: string) => Promise<MRBlobResult>
  onMRChanged:    (cb: (e: { id: string; kind: string }) => void) => () => void
  openExternal: (url: string) => Promise<void>
  /** 제품 전용 IPC (electron/product-ipc.ts). 핸들러는 products/<id>/electron 이 등록한다. */
  productInvoke: (name: string, payload?: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
  revealInFinder: (filePath: string) => Promise<boolean>
  moveFile: (from: string, toDir: string) => Promise<{ ok: boolean; to?: string }>
  deleteFile: (filePath: string) => Promise<{ ok: boolean }>
  recentFiles: (limit?: number) => Promise<TwixyRecentFile[]>
  // 파일→텍스트 인제스트 (확장자별 extractor 레지스트리, electron/tools/files/extractText.ts).
  // xlsx/pdf/csv/json/… 를 AI 가 읽을 텍스트로 추출 — 플래너·러너가 참조 파일 첨부에 사용.
  extractFileText: (payload: { relPath: string; maxChars?: number }) =>
    Promise<{ ok: boolean; kind?: string; text?: string; truncated?: boolean; note?: string; error?: string }>
  // 채팅/Copilot 컴포저에 드래그앤드랍한 파일을 workspace(data/raw)로 복사하고
  // 상대경로를 돌려준다 — @상대경로 로 참조해 에이전트가 읽을 수 있게.
  importDroppedFile: (payload: { name: string; bytes: ArrayBuffer }) =>
    Promise<{ ok: boolean; path?: string; relPath?: string; name?: string }>
  // (타입 정의는 파일 하단 TwixyRecentFile 참고)
  dashboardSnapshot: () => Promise<TwixyDashboardSnapshot>
  readFile:  (filePath: string) => Promise<string | null>
  readFileBytes: (filePath: string) => Promise<Uint8Array | null>
  writeFile: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>
  readImage: (filePath: string) => Promise<string | null>
  listDir: (dirPath: string) => Promise<{ name: string; isDir: boolean; mtimeMs?: number }[]>
  listSharedDir: (dirPath: string) => Promise<{ name: string; isDir: boolean }[]>
  getGatewayToken: () => Promise<string | null>
  getChannels:  () => Promise<ChannelsConfig>
  saveChannels: (payload: ChannelsConfig) => Promise<{ ok: boolean; error?: string }>

  // Auth (Supabase via web sign-in handoff)
  authGetSession:  () => Promise<{ access_token: string; refresh_token: string; expires_at?: number | null } | null>
  authSaveSession: (s: { access_token: string; refresh_token: string; expires_at?: number | null } | null) => Promise<{ ok: boolean }>
  authSignIn:      () => Promise<{ ok: boolean }>
  authSignOut:     () => Promise<{ ok: boolean }>
  onAuthSession:   (cb: (s: { access_token: string; refresh_token: string; expires_at?: number | null }) => void) => () => void
  getTwixyMode: () => Promise<'twixy' | 'byok'>
  setTwixyMode: (mode: 'twixy' | 'byok') => Promise<{ ok: boolean; error?: string }>
  getAuthProfiles: () => Promise<Record<string, unknown> | null>
  getAgentModel: () => Promise<string | null>
  saveApiKeys: (payload: { keys: { anthropic: string; openai: string }; model: string }) => Promise<{ ok: boolean }>
  getSubagentModel:  () => Promise<string | null>
  saveSubagentModel: (model: string) => Promise<{ ok: boolean; error?: string }>
  /** 게이트웨이가 LLM 키 없이 떴다 (세션 만료 + 갱신 실패). */
  onOpenRouterKeyMissing: (cb: () => void) => () => void
  onOpenRouterLimitExceeded: (cb: () => void) => () => void
  onOpenClawReady: (cb: () => void) => () => void
  onOpenClawError: (cb: (err: string) => void) => () => void
  onSkillsChanged: (cb: () => void) => () => void

  // Display pricing — raw $ value in, marked-up value out. multiplier itself
  // lives only in main process (Supabase-fetched). On error (Supabase down,
  // not signed in, etc.) IPC returns { ok: false } so UI can show "⚠ pricing".
  applyDisplayMarkup: (rawUsd: number) => Promise<{ ok: true; value: number } | { ok: false; error: string }>
  refreshMarkup:      () => Promise<{ ok: true }>

  // Setup / first-run
  getStartupError:  () => Promise<string | null>
  getOpenClawLog:   () => Promise<string>
  openLogFile:      () => Promise<void>
  logUi:            (line: string) => Promise<boolean>
  openFile:         (path: string) => Promise<{ ok: boolean; error?: string }>
  installNode22:   () => Promise<{ ok: boolean; version?: string; error?: string }>
  retryOpenClaw:   () => Promise<{ ok: boolean; error?: string }>
  onNodeInstallProgress: (cb: (p: { phase: string; pct: number }) => void) => () => void

  // OpenRouter usage tracking (per-message, Twixy mode only)
  recordOpenRouterUsage: (delta: { tokensIn: number; tokensOut: number; usdDelta: number }) => Promise<{ ok: boolean; usdActual?: number }>

  // Session logging (Twixy-native, OpenClaw-independent)
  appendSessionLog: (payload: { sessionId: string; line: string }) => Promise<void>
  listSessionLogs: () => Promise<{ date: string; sessionId: string; filePath: string; mtimeMs: number; preview: string }[]>
  readSessionLog: (filePath: string) => Promise<{ role: string; text: string; tools: string[]; timestamp: string }[]>
  generateSessionSummary: (sessionId: string) => Promise<{ ok: boolean; filePath?: string; error?: string }>

  // Planning Mode — per-user plan storage + run orchestration IO.
  // The plan is referenced only by id; the renderer never sees the
  // full shape from main except through the typed planning module.
  planList:         (payload?: { status?: string }) => Promise<TwixyPlan[]>
  planGet:          (id: string) => Promise<TwixyPlan | null>
  planCreate:       (payload: {
    title: string
    sourcePrompt: string
    priorRunRefs?: string[]
    skillsReferenced?: string[]
    steps: Array<{ title: string; detail?: string; acceptance?: string; skillHint?: string | null }>
  }) => Promise<TwixyPlan>
  planUpdate:       (id: string, patch: unknown) => Promise<TwixyPlan>
  planDelete:       (id: string) => Promise<{ ok: boolean }>

  // Workflow Test browser slot — sessionKey → leased Chrome profile (wf-1..3).
  browserSlotSet: (payload: { sessionKey: string; profile: string | null }) => Promise<{ ok: boolean; error?: string }>
  // 워크플로 슬롯 전역 lease — 탭(훅 인스턴스) 간 슬롯 충돌/이중 실행 방지.
  wfSlotLease:    (payload: { workflowId: string }) => Promise<{ ok: boolean; profile?: string; reason?: string }>
  wfSlotRelease:  (payload: { workflowId: string }) => Promise<{ ok: boolean }>
  wfSlotClearAll: () => Promise<{ ok: boolean }>
  // Workflows — named ordered chain of L6 nodes; read-only viewer in v1.
  workflowList:   () => Promise<TwixyWorkflow[]>
  // run 히스토리 (runs.jsonl, append-only) — Runs 대시보드의 로컬 데이터.
  workflowRunHistoryAppend: (id: string, entry: TwixyRunHistoryEntry) => Promise<{ ok: boolean; error?: string }>
  workflowRunHistoryList:   (limit?: number) => Promise<TwixyRunHistoryEntry[]>
  // run 상세 로그 (runs/<startedAt>.json) — 실행 로그 뷰어.
  workflowRunDetailSave: (id: string, detail: TwixyRunDetail) => Promise<{ ok: boolean; error?: string }>
  workflowRunDetailLoad: (id: string, startedAt: number) => Promise<TwixyRunDetail | null>
  workflowCreate: (payload: {
    title: string
    description?: string
    prompt?: string
    inputs?: TwixyModuleParam[]
    type?: WorkflowType
    outputDir?: string
    sourceShared?: { sharedId: string; sourceWfId: string; copiedUpdatedAt: string }
    nodes?: Array<{
      id?: string; title?: string; detail?: string; acceptance?: string;
      skillHint?: string | null; requires?: TwixyModuleParam[];
      type?: 'action' | 'review' | 'validation';
      tool?: string; toolSkills?: string[];
      inputScope?: Array<{ name: string; type: string; description?: string }>;
      outputScope?: Array<{ name: string; type: string; description?: string }>;
      subtasks?: TwixyL7Outline[];
    }>
  }) => Promise<TwixyWorkflow>
  workflowUpdate: (id: string, patch: unknown) => Promise<TwixyWorkflow>
  workflowDelete: (id: string) => Promise<{ ok: boolean }>
  workflowRestore: (snapshot: TwixyWorkflow) => Promise<TwixyWorkflow>
  // Builder chat persistence — per-workflow jsonl on disk.
  workflowChatLoad:   (id: string) => Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }>>
  workflowChatAppend: (id: string, line: { id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }) => Promise<{ ok: boolean; error?: string }>
  workflowChatClear:  (id: string) => Promise<{ ok: boolean; error?: string }>
  // Main chat persistence — workspace-level jsonl + gateway session key.
  mainChatLoad:   () => Promise<Array<{
    id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number
    tokens?: number; planId?: string; toolCalls?: Array<{ name: string; detail?: string }>; actions?: unknown[]
  }>>
  mainChatAppend: (line: {
    id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number
    tokens?: number; planId?: string; toolCalls?: Array<{ name: string; detail?: string }>; actions?: unknown[]
  }) => Promise<{ ok: boolean; error?: string }>
  mainChatClear:  () => Promise<{ ok: boolean; error?: string }>
  mainSessionGet: () => Promise<{ ok: boolean; sessionKey: string | null }>
  mainSessionSet: (payload: { sessionKey: string | null }) => Promise<{ ok: boolean; error?: string }>
  // Last test run state (persisted across app restart). state is the renderer's
  // WorkflowTestState — main process treats it as opaque blob.
  workflowTestRunLoad:  (id: string) => Promise<unknown | null>
  workflowTestRunSave:  (id: string, state: unknown) => Promise<{ ok: boolean; error?: string }>
  workflowTestRunClear: (id: string) => Promise<{ ok: boolean; error?: string }>
  workflowRawScratchClear: (relDir: string) => Promise<{ ok: boolean; error?: string }>
  // ── Orchestrations (L4) — workflow* 미러 ────────────────────────────────
  orchestrationList:   () => Promise<TwixyOrchestration[]>
  orchestrationCreate: (payload: {
    title: string
    description?: string
    pattern?: OrchestrationPattern
    prompt?: string
    inputs?: TwixyModuleParam[]
    members?: OrchestrationMemberInput[]
    config?: OrchestrationConfig
  }) => Promise<TwixyOrchestration>
  orchestrationUpdate:  (id: string, patch: unknown) => Promise<TwixyOrchestration>
  orchestrationDelete:  (id: string) => Promise<{ ok: boolean }>
  orchestrationRestore: (snapshot: TwixyOrchestration) => Promise<TwixyOrchestration>
  orchestrationChatLoad:   (id: string) => Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }>>
  orchestrationChatAppend: (id: string, line: { id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }) => Promise<{ ok: boolean; error?: string }>
  orchestrationChatClear:  (id: string) => Promise<{ ok: boolean; error?: string }>
  orchestrationRunLoad:  (id: string) => Promise<unknown | null>
  orchestrationRunSave:  (id: string, state: unknown) => Promise<{ ok: boolean; error?: string }>
  orchestrationRunClear: (id: string) => Promise<{ ok: boolean; error?: string }>
  // ── AI Agents (Specialist 단위) — orchestration* 미러 ─────────────────────
  aiAgentList:    () => Promise<TwixyAiAgent[]>
  aiAgentCreate:  (payload: { title: string; description?: string; criteria?: string; options?: OrchestrationMemberInput[] }) => Promise<TwixyAiAgent>
  aiAgentUpdate:  (id: string, patch: unknown) => Promise<TwixyAiAgent>
  aiAgentDelete:  (id: string) => Promise<{ ok: boolean }>
  planBeginRun:     (id: string, sessionKey: string) => Promise<TwixyPlan>
  planStepStart:    (id: string, stepId: string) => Promise<TwixyPlan>
  planStepEnd:      (id: string, stepId: string, result: unknown) => Promise<TwixyPlan>
  planStepCompact:  (id: string, stepId: string, compact: {
    compactSummary: string
    rawToolCallIds?: string[]
    rawMessages?: unknown[]
    subtasks?: TwixyL7Subtask[]
  }) => Promise<TwixyPlan>
  planStepReadRaw:  (id: string, stepId: string) => Promise<unknown[]>
  planRequestPause: (id: string) => Promise<TwixyPlan>
  planMarkPaused:   (id: string) => Promise<TwixyPlan>
  planFinalize:     (id: string, outcome: string) => Promise<TwixyPlan>
  planReadRun:      (id: string) => Promise<string>
  onPlanChanged:    (cb: (e: { id: string; kind: string }) => void) => () => void
  // Main window fullscreen state (mac green button / Cmd+Ctrl+F). Renderer
  // adapts the custom titlebar so the macOS traffic-light padding is dropped
  // when no buttons are present.
  onMainFullscreenChanged: (cb: (isFs: boolean) => void) => () => void

  // logbook 작업 마커 — plan 실행 중 L6/L7/L8 start/end 를 로컬 logbook
  // (127.0.0.1:8765, POST /context) 으로 중계. fire-and-forget (반환값 없음).
  logbookContext: (marker: TwixyLogbookMarker) => void

  // Execution Plan ingestion (separate from the chat planning flow).
  // import → creates a draft plan (origin 'execution-plan'); the UI shows it for
  // review and the user starts it manually. The API path (electron) auto-runs
  // by emitting 'execution-plan-run', which onExecutionPlanRun delivers here.
  executionPlanImport: (plan: unknown) => Promise<TwixyPlan>
  onExecutionPlanRun:  (cb: (e: { planId: string }) => void) => () => void

  // TSL skill platform
  readSkillSource: (name: string) => Promise<{ ok: boolean; source: string; error?: string }>
  compileTskill: (payload: { source: string; filename: string }) => Promise<TslCompileResult>
  installSkill:  (payload: { source: string; name: string }) => Promise<{ ok: boolean; errors: TslError[] }>
  deleteSkill:   (name: string) => Promise<{ ok: boolean; error?: string }>
  listSkills:    () => Promise<SkillManifest[]>
  // Per-skill execution stats (from session logs). Keyed by skill name.
  getSkillStats: () => Promise<Record<string, {
    executions: number; avgTokens: number; totalCost: number
    lastUsed: number; models: Record<string, number>
  }>>

  // Language correction
  correctLanguage: (payload: { text: string; userSample: string }) => Promise<{ ok: boolean; text?: string; tokensIn?: number; tokensOut?: number; error?: string }>
  correctLanguageBatch: (payload: { items: string[]; userSample: string }) => Promise<{ ok: boolean; items?: string[]; tokensIn?: number; tokensOut?: number; error?: string }>

  pullShared: () => Promise<{
    ok: boolean
    copied: number
    updated: number
    skipped: number
    details: { skill: string; file: string; action: 'copied' | 'updated' | 'skipped' }[]
    error?: string
  }>

  // 장기 기억(Memory) — MEMORY.md 읽기/쓰기 + memory/*.md 일일 노트 목록/읽기.
  // 모든 경로는 현재 사용자 워크스페이스로 한정. note 이름은 main 에서 검증.
  memoryRead:      () => Promise<{ ok: boolean; content: string; error?: string }>
  memoryWrite:     (content: string) => Promise<{ ok: boolean; error?: string }>
  memoryListNotes: () => Promise<{ ok: boolean; notes: { name: string; mtime: number }[]; error?: string }>
  memoryReadNote:  (name: string) => Promise<{ ok: boolean; content: string; error?: string }>

  exportPDF: (html: string, filename: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  // 원본 파일 옆에 같은 이름의 .pdf 로 저장. 이미 있으면 exists 로 돌려주고
  // overwrite: true 로 다시 부르면 덮어쓴다.
  exportPdfBeside: (payload: { html: string; srcPath: string; overwrite?: boolean }) =>
    Promise<{ ok: boolean; exists?: boolean; path?: string; error?: string }>
  exportMd:  (content: string, filename: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>

  // Document tools (file-io) — renderer-callable only. The doc/data/Google tools the agent uses (pdf, xlsx,
  // fetchToFile, queryData, gdoc/gsheet, sendEmail) are NOT here: their channels and
  // handlers are alive, but the agent reaches the implementations over loopback HTTP
  // via electron/agent-tool-bridge.ts, so the preload wrappers were dead weight.
  tools: {
    writePptx: (payload: { relPath: string; payload: TwixyWritePptxPayload }) => Promise<TwixyToolResult>
    readPptx:  (payload: { relPath: string }) => Promise<TwixyReadPptxResult>
    /** 원본 디자인 유지 편집 — electron/tools/files/pptxEdit.ts. 실패 시 원본 무손상. */
    editPptx:  (payload: { relPath: string; outRelPath?: string; ops: TwixyPptxEditOp[] }) => Promise<TwixyEditPptxResult>
    /** 남의 덱 와이어프레임 시트 — electron/tools/files/pptxSketch.ts. */
    renderPptxSketch: (payload: { convId: string; relPath: string }) =>
      Promise<{ ok: true; absPath: string; dataUrl: string; slideCount: number; summary: { slide: number; title?: string; shapes: string; unplaced: number }[]; layouts: { index: number; name: string; placeholders: string[] }[]
        /** 슬라이드별 이미지(data URL) — 페이지별 보기. */
        pages: string[]
        /** 'libreoffice' = 실물 렌더, 'sketch' = 근사 와이어프레임. */
        via: 'libreoffice' | 'sketch' } | { ok: false; error: string }>

    // Google Workspace
    googleGetStatus:   () => Promise<TwixyGoogleStatusResult>
    googleGetClient:   () => Promise<{ ok: boolean; hasClient?: boolean; clientId?: string | null; error?: string }>
    googleSetClient:   (cfg: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; error?: string }>
    googleClearClient: () => Promise<{ ok: boolean; error?: string }>
    googleConnect:     () => Promise<TwixyGoogleStatusResult>
    googleDisconnect:  () => Promise<{ ok: boolean; error?: string }>
  }

  // Connections (설정 > 연동) — service-card status / connect / disconnect /
  // token save. Raw tokens never reach the renderer.
  connectionsList:       () => Promise<TwixyConnectionsListResult>
  connectionsConnect:    (service: TwixyConnectionService) => Promise<TwixyConnectionResult>
  connectionsDisconnect: (service: TwixyConnectionService) => Promise<TwixyConnectionResult>
  connectionsSetToken:   (service: TwixyConnectionService, token: string) => Promise<TwixyConnectionResult>

  // MCP client servers (설정 > 연동 > MCP 서버) — user-registered external MCP
  // servers consumed by the embedded OpenClaw runtime. Token-free metadata
  // only over IPC; Bearer tokens stay in the main-process vault.
  mcpList:   () => Promise<TwixyMcpListResult>
  mcpUpsert: (def: TwixyMcpServerMeta, token?: string) => Promise<TwixyMcpMutationResult>
  mcpRemove: (id: string) => Promise<TwixyMcpMutationResult>
  // OAuth connect (Phase 2). Twixy brokers the token via the system browser.
  mcpOAuthConnect: (args: { url: string; label?: string; clientId?: string }) => Promise<TwixyMcpOAuthResult>

  // Cron scheduled tasks (설정 > 예약 작업) — 잡 CRUD 는 렌더러(useOpenClaw)가
  // 게이트웨이 WS 의 cron.* RPC 로 직접 호출한다. window.twixy IPC 브리지는 제거됨.

  // Sidetab overlay — small always-on-top floating window that mirrors
  // the main chat/plan state. See `overlayPayload` shape comment below.
  openSidetab:        () => Promise<{ ok: boolean }>
  closeSidetab:       () => Promise<{ ok: boolean }>
  overlaySyncPush:    (snapshot: OverlaySnapshot) => Promise<{ ok: boolean }>
  overlayRequestSync: () => Promise<OverlaySnapshot | null>
  overlayStop:        () => Promise<{ ok: boolean }>
  overlaySend:        (text: string) => Promise<{ ok: boolean }>
  overlayStart:       () => Promise<{ ok: boolean }>
  overlayResume:      () => Promise<{ ok: boolean }>
  overlayTogglePlanMode: () => Promise<{ ok: boolean }>
  overlaySetOpacity:  (value: number) => Promise<{ ok: boolean; value: number }>

  // Workflow Test progress overlay (별도 floating 윈도우).
  openTestOverlay:         () => Promise<{ ok: boolean }>
  closeTestOverlay:        () => Promise<{ ok: boolean }>
  pushTestOverlaySnapshot: (snapshot: unknown) => Promise<{ ok: boolean }>
  onTestOverlayStop:       (cb: () => void) => (() => void)
  onTestOverlayReviewDecision: (cb: (payload: { nodeId: string; action: 'approve' | 'note' | 'skip'; comment?: string }) => void) => (() => void)

  // Live browser preview — headless Chrome streamed into the app so the user
  // can watch AND drive workflows without any Chrome window stealing focus.
  // cdpPort selects WHICH Chrome (18800 chat, 18801-3 workflow slots wf-1..3);
  // events carry cdpPort so multiple panels can filter their own stream.
  browserPreviewStart:     (opts?: { cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  browserPreviewStop:      (opts?: { cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  // ⟳ 하드 재연결 — "Waiting for first frame" 걸림 해소 (CDP 끊고 재attach).
  browserPreviewRefresh:   (opts?: { cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  browserPreviewSetActive: (payload: { targetId: string; cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  browserPreviewCloseTarget: (payload: { targetId: string; cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  browserPreviewSetViewport: (dims: { width: number; height: number; cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  browserPreviewInput:     (payload: BrowserPreviewInput & { cdpPort?: number }) => Promise<{ ok: boolean; error?: string }>
  onBrowserPreviewFrame: (
    cb: (payload: { cdpPort: number; targetId: string; base64: string; ts: number; meta?: BrowserPreviewFrameMeta }) => void
  ) => (() => void)
  onBrowserPreviewTargetList: (
    cb: (payload: { cdpPort: number; targets: Array<{ targetId: string; title: string; url: string; isActive: boolean }> }) => void
  ) => (() => void)
  onOverlaySync:      (cb: (snapshot: OverlaySnapshot) => void) => () => void
  onOverlayStop:      (cb: () => void) => () => void
  onOverlaySend:      (cb: (text: string) => void) => () => void
  onOverlayStart:     (cb: () => void) => () => void
  onOverlayResume:    (cb: () => void) => () => void
  onOverlayTogglePlanMode: (cb: () => void) => () => void

  // Guardrail popup window — separate BrowserWindow that surfaces
  // pending tool approvals above whatever app the user is in, so a
  // strict-mode write doesn't silently block while the user is in
  // another window. Main renderer drives lifecycle.
  guardrailPopupShow:        (state: GuardrailPopupState) => Promise<{ ok: boolean }>
  guardrailPopupClose:       () => Promise<{ ok: boolean }>
  guardrailPopupRequestSync: () => Promise<GuardrailPopupState | null>
  guardrailPopupDecide:      (payload: { id: string; action: 'approve' | 'session' | 'remember' | 'deny' | 'save-as'; params?: Record<string, unknown>; saveAsName?: string }) => Promise<{ ok: boolean }>
  onGuardrailPopupSync:      (cb: (state: GuardrailPopupState) => void) => () => void
  onGuardrailPopupDecide:    (cb: (payload: { id: string; action: 'approve' | 'session' | 'remember' | 'deny' | 'save-as'; params?: Record<string, unknown>; saveAsName?: string }) => void) => () => void
}

// Document tool payloads — kept in sync with electron/tools/files/*.
// 일부(TwixyWritePdfPayload·TwixyFetchToFile*·TwixyQueryData*·Gdoc/Gsheet·SendEmail)는 Stage 5 에서
// preload 래퍼가 빠진 뒤 참조가 없다. 채널은 살아 있고 이 타입들이 그 페이로드 모양의 유일한
// 문서라서 남겼다 — 지우려면 의존 타입까지 묶어서 따로 슬라이스로.
type TwixyToolResult =
  | { ok: true; relPath: string; bytes: number }
  | { ok: false; error: string }

type TwixyPdfBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'table'; headers: string[]; rows: (string | number | null)[][] }
  | { type: 'spacer' }
interface TwixyWritePdfPayload {
  title?: string
  blocks: TwixyPdfBlock[]
}

interface TwixySheetSpec {
  name: string
  rows: (string | number | boolean | null)[][]
}
interface TwixyWriteXlsxPayload {
  sheets: TwixySheetSpec[]
}
interface TwixyReadSheetResult {
  name: string
  /** 시트 범위 — 값 없이 서식만 남은 꼬리 행까지 센다. */
  rowCount: number
  /** 실제로 값이 있는 행 수. 모델에게 보고할 숫자는 이쪽이다. */
  actualRowCount: number
  columnCount: number
  rows: (string | number | boolean | null)[][]
  truncated: boolean
}
// 최근 파일 1건 (recent-files IPC). @-멘션 드롭다운 / 드래그앤드랍에서 사용.
interface TwixyRecentFile { name: string; path: string; mtime: number; dir: string }
type TwixyReadXlsxResult =
  | { ok: true; relPath: string; sheets: TwixyReadSheetResult[] }
  | { ok: false; error: string }

// ── Data tools — kept in sync with electron/tools/data/*. ───────────
type TwixyPagination =
  | { mode: 'none' }
  | { mode: 'page';   param: string; start?: number; step?: number }
  | { mode: 'offset'; param: string; size: number }
  | { mode: 'cursor'; param: string; cursorPath: string }
  | { mode: 'link' }
interface TwixyFetchToFileRequest {
  destDir:          string
  url:              string
  pagination?:      TwixyPagination
  maxPages?:        number
  itemsPath?:       string
  minItemsPerPage?: number
  headers?:         Record<string, string>
  delayMs?:         number
  timeoutMs?:       number
}
type TwixyFetchToFileResult =
  | {
      ok: true
      requests: number
      files: string[]
      bytes: number
      items?: number
      lastCursor?: string
      stoppedBy: string
      errors: string[]
    }
  | { ok: false; error: string }

interface TwixyQueryDataRequest {
  sql:            string
  /** table name → workspace-relative source file */
  inputs:         Record<string, string>
  output?:        string
  maxInlineRows?: number
}
type TwixyQueryDataResult =
  | {
      ok: true
      rows: number
      columns: string[]
      output?: string
      bytes?: number
      inline?: Record<string, unknown>[]
      truncated?: boolean
    }
  | { ok: false; error: string }

// Deck types come straight from the shared layout core — this used to be a
// hand-written mirror and it drifted (it still advertised themes the tool had
// already dropped). `import()` type syntax is the one form that does NOT turn
// this global script into a module, which would un-global every Twixy* alias
// and the Window augmentation below.
type TwixySlideSpec = import('../shared/deck/spec').SlideSpec
type TwixyWritePptxPayload = import('../shared/deck/spec').WritePptxPayload

// .pptx importer — see electron/tools/files/pptxRead.ts. `payload` is the
// best-effort mapping into our spec, ready for the Content-mode editor.
type TwixyReadPptxResult =
  | { ok: true; relPath: string; slideCount: number
      slides: { index: number; title?: string; body: { text: string; level: number }[]
                table?: { headers: string[]; rows: string[][] }; notes?: string
                textShapes: { shape: number; first: string; paragraphs: number }[] }[]
      payload: TwixyWritePptxPayload }
  | { ok: false; error: string }
// 원본 유지 편집 op — electron/tools/files/pptxEdit.ts 의 PptxEditOp 와 1:1.
type TwixyPptxEditOp = import('./lib/parsePptxEdit').PptxEditOp
type TwixyEditPptxResult =
  | { ok: true; relPath: string; slideCount: number; applied: string[]
      outline: { slide: number; title?: string; texts: number; shapes?: string; textShapes?: { shape: number; first: string; paragraphs: number }[] }[]
      layouts?: { index: number; name: string; placeholders: string[] }[] }
  | { ok: false; error: string }
type TwixyPptxTheme = import('../shared/deck/theme').ThemeName
type TwixyPptxStyle = import('../shared/deck/theme').StyleName

// Google Workspace payloads — kept in sync with electron/google/*.
type TwixyGoogleStatusResult =
  | { ok: true; connected: boolean; hasClient: boolean; email?: string | null; scopes?: string[]; expiresAt?: number | null }
  | { ok: false; error: string }

type TwixyGdocBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'spacer' }
interface TwixyWriteGdocPayload {
  title:  string
  blocks: TwixyGdocBlock[]
}
type TwixyWriteGdocResult =
  | { ok: true; documentId: string; url: string; title: string }
  | { ok: false; error: string }
type TwixyReadGdocResult =
  | { ok: true; documentId: string; title: string; text: string; blocks: TwixyGdocBlock[] }
  | { ok: false; error: string }

interface TwixyWriteSheetSpec {
  name: string
  rows: (string | number | boolean | null)[][]
}
interface TwixyWriteGsheetPayload {
  title?:         string
  spreadsheetId?: string
  sheets:         TwixyWriteSheetSpec[]
}
type TwixyWriteGsheetResult =
  | { ok: true; spreadsheetId: string; url: string; sheets: string[] }
  | { ok: false; error: string }
type TwixyReadGsheetResult =
  | { ok: true; spreadsheetId: string; range: string; rowCount: number; columnCount: number; rows: (string | number | boolean | null)[][] }
  | { ok: false; error: string }

// Gmail send (Connections Phase 1) — mirrors electron/google/gmail.ts.
interface TwixySendEmailPayload {
  to:       string | string[]
  cc?:      string | string[]
  bcc?:     string | string[]
  subject:  string
  body:     string
  html?:    boolean
}
type TwixySendEmailResult =
  | { ok: true; messageId: string; threadId: string | null; to: string[]; subject: string }
  | { ok: false; error: string }

// Connections (설정 > 연동) — mirrors electron/connections/registry.ts.
// Status only: tokens never cross the IPC boundary.
type TwixyConnectionService = 'google' | 'notion' | 'slack' | 'discord' | 'kakao'
type TwixyConnectionState   = 'connected' | 'disconnected' | 'needs_reauth' | 'coming_soon'
interface TwixyConnectionInfo {
  service:   TwixyConnectionService
  connected: boolean
  state:     TwixyConnectionState
  account?:  string | null
  detail?:   string | null
}
type TwixyConnectionsListResult =
  | { ok: true; connections: TwixyConnectionInfo[] }
  | { ok: false; error: string }
type TwixyConnectionResult =
  | { ok: true; connection: TwixyConnectionInfo }
  | { ok: false; error: string }

// MCP client servers (설정 > 연동 > MCP 서버) — mirrors
// electron/connections/mcp-servers.ts. Token-free metadata only.
type TwixyMcpAuthMode = 'none' | 'token' | 'oauth'
type TwixyMcpServerMeta =
  | { id: string; label: string; kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { id: string; label: string; kind: 'http'; url: string; transport: 'sse' | 'streamable-http'; hasToken: boolean; authMode?: TwixyMcpAuthMode }
type TwixyMcpListResult =
  | { ok: true; servers: TwixyMcpServerMeta[] }
  | { ok: false; error: string }
type TwixyMcpMutationResult =
  | { ok: true }
  | { ok: false; error: string }
type TwixyMcpOAuthResult =
  | { ok: true; server: TwixyMcpServerMeta }
  | { ok: false; error: string }

// Cron scheduled tasks (설정 > 예약 작업) — 게이트웨이 cron.list 가 돌려주는 잡
// 객체를 느슨하게 미러. 버전에 따라 필드가 달라질 수 있어 핵심 필드만 선택적으로
// 타이핑하고 [key]: unknown 으로 확장 허용. SettingsPanel 의 cron 리스트 렌더에서
// 사용. (cron CRUD 자체는 useOpenClaw 의 cron.* WS RPC 로 처리.)
interface TwixyCronJob {
  id:           string
  name?:        string
  description?: string
  enabled?:     boolean
  schedule?:    { kind?: string; expr?: string; every?: string; at?: string; tz?: string } | string
  sessionTarget?: string
  lastRunAt?:   string | number | null
  nextRunAt?:   string | number | null
  lastStatus?:  string | null
  [key: string]: unknown
}

// Dashboard snapshot (Phase 3 / dashboard-v2). One round-trip that powers
// the Recent Reports / Data Sources / Next Actions sections at the top of
// the dashboard. Polled every few seconds by DashboardPanel.
type TwixyReportKind = 'pdf' | 'xlsx' | 'pptx' | 'other'
interface TwixyDashboardReport {
  name:      string
  relPath:   string
  kind:      TwixyReportKind
  mtime:     number
  sizeBytes: number
}
interface TwixyDashboardNextAction {
  id:      string
  label:   string
  hint:    string
  /** Optional one-shot prompt the renderer can drop into the chat. */
  prompt?: string
}
interface TwixyDashboardSnapshot {
  recentReports: TwixyDashboardReport[]
  dataSources: {
    google: { connected: boolean; email: string | null }
    workspace: {
      rawCount:      number
      savedCount:    number
      insightsCount: number
      exportsCount:  number
      reportsCount:  number
    }
    lastReportAt:  number | null
    lastInsightAt: number | null
  }
  nextActions: TwixyDashboardNextAction[]
}

interface GuardrailPopupState {
  request: GuardrailApprovalRequest | null
  mode:    GuardrailMode
}

// Snapshot pushed by mainWindow to overlayWindow on every state change.
// Shape matches what SidetabOverlay needs to render — we keep it thin
// (last N messages only, condensed tool activity) to avoid IPC bloat.
interface OverlaySnapshotMessage {
  id:        string
  role:      'user' | 'assistant' | 'system'
  content:   string
  planId?:   string
}
interface OverlaySnapshot {
  messages:       OverlaySnapshotMessage[]
  isThinking:     boolean
  toolActivity:   {
    name:           string
    isSubagent:     boolean
    detail?:        string
    subagentLabel?: string
    callId?:        string
  } | null
  toolStats:      {
    count:         number
    startedAt:     number | null
  } | null
  activePlanId:   string | null
  planStatus:     TwixyPlanStatus | null
  planMode:       boolean
  connected:      boolean
}

// ── Twixy Enterprise admin ───────────────────────────────────────
interface TwixyEnterprisePlanSummary {
  id:               string
  uid:              string
  title:            string
  updatedAt:        string
  skillsReferenced: string[]
}
interface TwixyEnterpriseAdminData {
  projectRoot:         string
  todaySkills:         string[]
  donePlansToday:      TwixyEnterprisePlanSummary[]
  topSkillsThisMonth:  { name: string; count: number }[]
  newSkillsThisMonth:  { name: string; mtime: string }[]
  allDonePlans:        TwixyEnterprisePlanSummary[]
}

interface Window {
  twixy: TwixyAPI & {
    pickOutputDir: () => Promise<{ ok: true; relPath: string } | { ok: false; reason: string } | null>
    twixyEnterprisePickFolder: () => Promise<string | null>
    twixyEnterpriseAdminLoad:  (projectRoot: string) => Promise<TwixyEnterpriseAdminData>
    twixyEnterpriseReadRun:    (projectRoot: string, uid: string, planId: string) => Promise<string | null>
  }
}

// Vite ?raw imports — text files brought in verbatim at build time. Used by
// workflowSoul.ts to ship WORKFLOW_SOUL.md as a single source of truth.
declare module '*.md?raw' {
  const content: string
  export default content
}

// 이미지 에셋 import (Vite → URL). 사이드바 로고 등.
declare module '*.png' {
  const src: string
  export default src
}
