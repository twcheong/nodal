import { contextBridge, ipcRenderer } from 'electron'

// ─────────────────────────────────────────────────────────────────────────────
// preload.ts — 렌더러(React)와 메인(Node) 프로세스 사이의 안전한 브릿지.
//
// Electron 보안 모델상 렌더러는 Node API에 직접 접근할 수 없고,
// 여기서 `contextBridge.exposeInMainWorld('twixy', ...)` 로 화이트리스트된
// 함수만 `window.twixy.*` 로 노출한다.
// 각 함수는 `ipcRenderer.invoke(채널, 페이로드)` 호출을 감싸는 얇은 래퍼이며,
// 실제 구현은 electron/main.ts 의 `ipcMain.handle(채널, ...)` 핸들러에 있다.
// 타입 선언은 src/global.d.ts 의 Window 인터페이스 확장과 일치해야 한다.
//
// **창마다 받는 표면이 다르다.** 여기 정의한 이름 전부를 받는 건 main/enterprise/nodal
// 뿐이고, 보조 창 4개는 자기가 부르는 것만 받는다 — 파일 끝의 PER_WINDOW.
// ─────────────────────────────────────────────────────────────────────────────

// 노출 가능한 이름 전부. **어느 창이 그중 무엇을 실제로 받는지는 파일 끝의 PER_WINDOW**
// 가 정한다 — 이 객체가 곧 표면이던 시절과 달리, 여기 추가한다고 모든 창이 받지 않는다.
const twixyApi = {
  // 현재 OS 플랫폼 ('darwin' | 'win32' | 'linux' …).
  // 앱 수명 동안 바뀌지 않으므로 IPC 호출이 아닌 정적 값으로 노출한다.
  // 훅(useOpenClaw 등)이 연결 시점에 동기적으로 읽어 OS별 분기에 사용.
  platform: process.platform,

  // 렌더러에 드롭된 파일 바이트를 샌드박스된 Twixy 워크스페이스로 복사한다.
  // 저장 경로: data/raw/<timestamp>-<파일명>. 복사된 절대경로를 반환.
  importDroppedFile: (payload: { name: string; bytes: ArrayBuffer }) =>
    ipcRenderer.invoke('import-dropped-file', payload),
  getWorkspace: () => ipcRenderer.invoke('get-workspace'),
  // TWIX-26: 현재 앱 버전 (예: "0.1.0"). 업데이트 알림 UI에서 현재 버전 표시용.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getProjectDir:  () => ipcRenderer.invoke('get-project-dir'),
  setProjectDir:  (dir: string) => ipcRenderer.invoke('set-project-dir', dir),
  pickProjectDir: () => ipcRenderer.invoke('pick-project-dir'),
  // ── Team collaboration (Git-style project layout) ─────────────
  getCollabMode:  () => ipcRenderer.invoke('get-collab-mode'),
  getProjectConfig: () => ipcRenderer.invoke('get-project-config'),
  setProjectConfig: (patch: unknown) => ipcRenderer.invoke('set-project-config', patch),
  claimProjectOwnership: () => ipcRenderer.invoke('claim-project-ownership'),

  // ── Admin panel: storage + MR stats for the current project ──
  adminStats:  () => ipcRenderer.invoke('admin-stats'),
  adminReveal: (absPath: string) => ipcRenderer.invoke('admin-reveal', absPath),

  // ── Merge Request (Phase 2: local-only) ───────────────────────
  mrCurrentActor: () => ipcRenderer.invoke('mr-current-actor'),
  mrList:         (payload?: { status?: string }) =>
    ipcRenderer.invoke('mr-list', payload),
  mrCreate:       (payload: {
    title: string; description?: string
    reviewers?: { uid: string; email?: string }[]
    requiredApprovals?: number
    changes: unknown[]
  }) => ipcRenderer.invoke('mr-create', payload),
  mrReview:       (payload: { id: string; decision: 'approve' | 'reject'; comment?: string }) =>
    ipcRenderer.invoke('mr-review', payload),
  mrComment:      (payload: { id: string; body: string }) =>
    ipcRenderer.invoke('mr-comment', payload),
  mrCancel:       (id: string) => ipcRenderer.invoke('mr-cancel', id),
  mrMerge:        (id: string) => ipcRenderer.invoke('mr-merge', id),
  mrReadBlob:     (payload: { id: string; sha: string; path?: string }) =>
    ipcRenderer.invoke('mr-read-blob', payload),
  mrReadShared:   (relPath: string) => ipcRenderer.invoke('mr-read-shared', relPath),
  onMRChanged:    (cb: (e: { id: string; kind: string }) => void) => {
    const handler = (_e: unknown, payload: { id: string; kind: string }) => cb(payload)
    ipcRenderer.on('mr-changed', handler)
    return () => ipcRenderer.removeListener('mr-changed', handler)
  },

  // ── Planning Mode ─────────────────────────────────────────────
  // Plans are stored per-user under user/plans/<planId>/ (plan.json +
  // plan.md + run.md). The planner LLM round-trip and step execution loop
  // live in the renderer; these IPC calls are pure disk IO.
  planList:   (payload?: { status?: string }) => ipcRenderer.invoke('plan-list', payload),
  planGet:    (id: string) => ipcRenderer.invoke('plan-get', id),
  // All mutating plan IPCs return { ok, plan?, error? } on main. Unwrap here
  // so the renderer gets the plan directly (or null/throws on failure).
  planCreate: async (payload: {
    title: string
    sourcePrompt: string
    priorRunRefs?: string[]
    skillsReferenced?: string[]
    steps: Array<{ title: string; detail?: string; acceptance?: string; skillHint?: string | null }>
  }) => {
    const r = await ipcRenderer.invoke('plan-create', payload)
    if (!r?.ok) throw new Error(r?.error ?? 'plan_create_failed')
    return r.plan
  },
  planUpdate: async (id: string, patch: unknown) => {
    const r = await ipcRenderer.invoke('plan-update', { id, patch })
    if (!r?.ok) throw new Error(r?.error ?? 'plan_update_failed')
    return r.plan
  },
  planDelete: (id: string) => ipcRenderer.invoke('plan-delete', id),

  // ── Workflows (Marketing IDE) ──────────────────────────────────
  // Per-user named L6 chains. v1: read-only viewer + basic CRUD;
  // execution wiring lands later.
  workflowList:   () => ipcRenderer.invoke('workflow-list'),
  workflowCreate: async (payload: {
    title: string
    description?: string
    prompt?: string
    inputs?: unknown[]
    type?: 'research' | 'execution'
    outputDir?: string
    sourceShared?: { sharedId: string; sourceWfId: string; copiedUpdatedAt: string }
    nodes?: Array<{
      id?: string; title?: string; detail?: string; acceptance?: string;
      skillHint?: string | null; requires?: unknown[];
      type?: 'action' | 'review' | 'validation';
      tool?: string; toolSkills?: string[];
      inputScope?: unknown[]; outputScope?: unknown[];
      subtasks?: unknown[];
    }>
  }) => {
    const r = await ipcRenderer.invoke('workflow-create', payload)
    if (!r?.ok) throw new Error(r?.error ?? 'workflow_create_failed')
    return r.workflow
  },
  workflowUpdate: async (id: string, patch: unknown) => {
    const r = await ipcRenderer.invoke('workflow-update', { id, patch })
    if (!r?.ok) throw new Error(r?.error ?? 'workflow_update_failed')
    return r.workflow
  },
  workflowDelete: (id: string) => ipcRenderer.invoke('workflow-delete', id),
  workflowRestore: async (snapshot: unknown) => {
    const r = await ipcRenderer.invoke('workflow-restore', snapshot)
    if (!r?.ok) throw new Error(r?.error ?? 'workflow_restore_failed')
    return r.workflow
  },
  // Workflow Test browser slot — register/clear a gateway session's leased
  // Chrome profile (wf-1..3). Main mirrors the map to a file the openclaw
  // hook patch reads to force `params.profile` on browser tool calls.
  browserSlotSet: (payload: { sessionKey: string; profile: string | null }) =>
    ipcRenderer.invoke('browser-slot-set', payload) as Promise<{ ok: boolean; error?: string }>,
  // 워크플로 슬롯 전역 lease — 탭(훅 인스턴스) 간 슬롯 충돌/이중 실행 방지.
  wfSlotLease: (payload: { workflowId: string }) =>
    ipcRenderer.invoke('wf-slot-lease', payload) as Promise<{ ok: boolean; profile?: string; reason?: string }>,
  wfSlotRelease: (payload: { workflowId: string }) =>
    ipcRenderer.invoke('wf-slot-release', payload) as Promise<{ ok: boolean }>,
  wfSlotClearAll: () =>
    ipcRenderer.invoke('wf-slot-clear-all') as Promise<{ ok: boolean }>,
  // ── Builder chat persistence (per workflow, jsonl on disk) ───────────
  workflowChatLoad:   async (id: string) => {
    const r = await ipcRenderer.invoke('workflow-chat-load', id) as {
      ok: boolean
      lines?: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }>
      error?: string
    }
    if (!r?.ok) throw new Error(r?.error ?? 'workflow_chat_load_failed')
    return r.lines ?? []
  },
  workflowChatAppend: (id: string, line: { id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }) =>
    ipcRenderer.invoke('workflow-chat-append', { id, line }) as Promise<{ ok: boolean; error?: string }>,
  workflowChatClear:  (id: string) =>
    ipcRenderer.invoke('workflow-chat-clear', id) as Promise<{ ok: boolean; error?: string }>,
  // ── Main chat persistence (workspace-level jsonl + session key) ──────
  mainChatLoad:   async () => {
    const r = await ipcRenderer.invoke('main-chat-load') as {
      ok: boolean
      lines?: Array<{
        id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number
        tokens?: number; planId?: string; toolCalls?: Array<{ name: string; detail?: string }>; actions?: unknown[]
      }>
      error?: string
    }
    if (!r?.ok) throw new Error(r?.error ?? 'main_chat_load_failed')
    return r.lines ?? []
  },
  mainChatAppend: (line: {
    id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number
    tokens?: number; planId?: string; toolCalls?: Array<{ name: string; detail?: string }>; actions?: unknown[]
  }) => ipcRenderer.invoke('main-chat-append', line) as Promise<{ ok: boolean; error?: string }>,
  mainChatClear:  () => ipcRenderer.invoke('main-chat-clear') as Promise<{ ok: boolean; error?: string }>,
  mainSessionGet: () => ipcRenderer.invoke('main-session-get') as Promise<{ ok: boolean; sessionKey: string | null }>,
  mainSessionSet: (payload: { sessionKey: string | null }) =>
    ipcRenderer.invoke('main-session-set', payload) as Promise<{ ok: boolean; error?: string }>,
  // ── Last test run persistence (canvas restores per-node statuses after restart)
  workflowTestRunLoad: async (id: string) => {
    const r = await ipcRenderer.invoke('workflow-test-run-load', id) as { ok: boolean; state?: unknown; error?: string }
    if (!r?.ok) throw new Error(r?.error ?? 'workflow_test_run_load_failed')
    return r.state ?? null
  },
  workflowTestRunSave: (id: string, state: unknown) =>
    ipcRenderer.invoke('workflow-test-run-save', { id, state }) as Promise<{ ok: boolean; error?: string }>,
  workflowTestRunClear: (id: string) =>
    ipcRenderer.invoke('workflow-test-run-clear', id) as Promise<{ ok: boolean; error?: string }>,
  workflowRawScratchClear: (relDir: string) =>
    ipcRenderer.invoke('workflow-raw-scratch-clear', relDir) as Promise<{ ok: boolean; error?: string }>,
  // run 히스토리 (runs.jsonl) — Runs 대시보드.
  workflowRunHistoryAppend: (id: string, entry: unknown) =>
    ipcRenderer.invoke('workflow-run-history-append', { id, entry }) as Promise<{ ok: boolean; error?: string }>,
  workflowRunHistoryList: (limit?: number) =>
    ipcRenderer.invoke('workflow-run-history-list', limit) as Promise<unknown[]>,
  // run 상세 로그 (runs/<startedAt>.json) — 실행 로그 뷰어.
  workflowRunDetailSave: (id: string, detail: unknown) =>
    ipcRenderer.invoke('workflow-run-detail-save', { id, detail }) as Promise<{ ok: boolean; error?: string }>,
  workflowRunDetailLoad: (id: string, startedAt: number) =>
    ipcRenderer.invoke('workflow-run-detail-load', { id, startedAt }) as Promise<unknown | null>,
  // ── Orchestrations (L4) — workflow* 미러 ────────────────────────────────
  orchestrationList: () => ipcRenderer.invoke('orchestration-list'),
  orchestrationCreate: async (payload: {
    title: string
    description?: string
    pattern?: string
    prompt?: string
    inputs?: unknown[]
    members?: Array<{
      id?: string; workflowId: string; label?: string; order?: number;
      role?: 'maker' | 'checker' | 'participant' | 'manager';
      isEntry?: boolean; handoffTo?: string[];
    }>
    config?: unknown
  }) => {
    const r = await ipcRenderer.invoke('orchestration-create', payload)
    if (!r?.ok) throw new Error(r?.error ?? 'orchestration_create_failed')
    return r.orchestration
  },
  orchestrationUpdate: async (id: string, patch: unknown) => {
    const r = await ipcRenderer.invoke('orchestration-update', { id, patch })
    if (!r?.ok) throw new Error(r?.error ?? 'orchestration_update_failed')
    return r.orchestration
  },
  orchestrationDelete: (id: string) => ipcRenderer.invoke('orchestration-delete', id),
  orchestrationRestore: async (snapshot: unknown) => {
    const r = await ipcRenderer.invoke('orchestration-restore', snapshot)
    if (!r?.ok) throw new Error(r?.error ?? 'orchestration_restore_failed')
    return r.orchestration
  },
  orchestrationChatLoad: async (id: string) => {
    const r = await ipcRenderer.invoke('orchestration-chat-load', id) as {
      ok: boolean
      lines?: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }>
      error?: string
    }
    if (!r?.ok) throw new Error(r?.error ?? 'orchestration_chat_load_failed')
    return r.lines ?? []
  },
  orchestrationChatAppend: (id: string, line: { id: string; role: 'user' | 'assistant' | 'system'; content: string; ts: number }) =>
    ipcRenderer.invoke('orchestration-chat-append', { id, line }) as Promise<{ ok: boolean; error?: string }>,
  orchestrationChatClear: (id: string) =>
    ipcRenderer.invoke('orchestration-chat-clear', id) as Promise<{ ok: boolean; error?: string }>,
  orchestrationRunLoad: async (id: string) => {
    const r = await ipcRenderer.invoke('orchestration-run-load', id) as { ok: boolean; state?: unknown; error?: string }
    if (!r?.ok) throw new Error(r?.error ?? 'orchestration_run_load_failed')
    return r.state ?? null
  },
  orchestrationRunSave: (id: string, state: unknown) =>
    ipcRenderer.invoke('orchestration-run-save', { id, state }) as Promise<{ ok: boolean; error?: string }>,
  orchestrationRunClear: (id: string) =>
    ipcRenderer.invoke('orchestration-run-clear', id) as Promise<{ ok: boolean; error?: string }>,

  // ── AI Agents (Specialist 단위) — orchestration* 미러 ─────────────────────
  aiAgentList: () => ipcRenderer.invoke('aiagent-list'),
  aiAgentCreate: async (payload: { title: string; description?: string; criteria?: string; options?: unknown[] }) => {
    const r = await ipcRenderer.invoke('aiagent-create', payload)
    if (!r?.ok) throw new Error(r?.error ?? 'aiagent_create_failed')
    return r.agent
  },
  aiAgentUpdate: async (id: string, patch: unknown) => {
    const r = await ipcRenderer.invoke('aiagent-update', { id, patch })
    if (!r?.ok) throw new Error(r?.error ?? 'aiagent_update_failed')
    return r.agent
  },
  aiAgentDelete: (id: string) => ipcRenderer.invoke('aiagent-delete', id),

  planBeginRun:    async (id: string, sessionKey: string) => {
    const r = await ipcRenderer.invoke('plan-begin-run', { id, sessionKey })
    if (!r?.ok) throw new Error(r?.error ?? 'plan_begin_run_failed')
    return r.plan
  },
  planStepStart:   async (id: string, stepId: string) => {
    const r = await ipcRenderer.invoke('plan-step-start', { id, stepId })
    if (!r?.ok) throw new Error(r?.error ?? 'plan_step_start_failed')
    return r.plan
  },
  planStepEnd:     async (id: string, stepId: string, result: unknown) => {
    const r = await ipcRenderer.invoke('plan-step-end', { id, stepId, result })
    if (!r?.ok) throw new Error(r?.error ?? 'plan_step_end_failed')
    return r.plan
  },
  planStepCompact: async (id: string, stepId: string, compact: {
    compactSummary: string
    rawToolCallIds?: string[]
    rawMessages?: unknown[]
    subtasks?: unknown[]
  }) => {
    const r = await ipcRenderer.invoke('plan-step-compact', { id, stepId, compact })
    if (!r?.ok) throw new Error(r?.error ?? 'plan_step_compact_failed')
    return r.plan
  },
  planStepReadRaw: (id: string, stepId: string) => ipcRenderer.invoke('plan-step-read-raw', { id, stepId }),
  planRequestPause: async (id: string) => {
    const r = await ipcRenderer.invoke('plan-request-pause', id)
    if (!r?.ok) throw new Error(r?.error ?? 'plan_request_pause_failed')
    return r.plan
  },
  planMarkPaused:   async (id: string) => {
    const r = await ipcRenderer.invoke('plan-mark-paused', id)
    if (!r?.ok) throw new Error(r?.error ?? 'plan_mark_paused_failed')
    return r.plan
  },
  planFinalize:     async (id: string, outcome: string) => {
    const r = await ipcRenderer.invoke('plan-finalize', { id, outcome })
    if (!r?.ok) throw new Error(r?.error ?? 'plan_finalize_failed')
    return r.plan
  },
  planReadRun:     (id: string) => ipcRenderer.invoke('plan-read-run', id),
  // ── logbook 작업 마커 ──────────────────────────────────────────
  // plan 실행 중 L6/L7/L8 start/end 마커를 main 경유로 logbook 에 송신.
  // fire-and-forget: 반환값 없음, 실패는 main 쪽에서 조용히 무시된다.
  logbookContext: (marker: {
    event: 'start' | 'end'
    task_id: string
    level?: 'L6' | 'L7' | 'L8'
    title?: string
    actor?: 'AI' | 'HUMAN'
    parent_id?: string
    plan_id?: string
    ts?: number
  }): void => {
    ipcRenderer.invoke('logbook-context', marker).catch(() => { /* never throws into caller */ })
  },
  onPlanChanged:   (cb: (e: { id: string; kind: string }) => void) => {
    const handler = (_e: unknown, payload: { id: string; kind: string }) => cb(payload)
    ipcRenderer.on('plan-changed', handler)
    return () => ipcRenderer.removeListener('plan-changed', handler)
  },

  // Main window fullscreen state — renderer subscribes so the custom
  // titlebar can drop its macOS traffic-light padding when there are no
  // buttons to dodge.
  onMainFullscreenChanged: (cb: (isFs: boolean) => void) => {
    const handler = (_e: unknown, payload: boolean) => cb(!!payload)
    ipcRenderer.on('main-fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('main-fullscreen-changed', handler)
  },

  // ── Execution Plan ingestion (separate from chat planning) ────
  // import → creates a draft plan for human review (no auto-run).
  executionPlanImport: async (plan: unknown) => {
    const r = await ipcRenderer.invoke('execution-plan-import', plan)
    if (!r?.ok) throw new Error(r?.error ?? 'execution_plan_import_failed')
    return r.plan
  },
  // API path auto-run signal: main emits 'execution-plan-run' after creating
  // the plan; the renderer subscribes and starts the run.
  onExecutionPlanRun: (cb: (e: { planId: string }) => void) => {
    const handler = (_e: unknown, payload: { planId: string }) => cb(payload)
    ipcRenderer.on('execution-plan-run', handler)
    return () => ipcRenderer.removeListener('execution-plan-run', handler)
  },
  onProjectDirChanged: (cb: (dir: string) => void) => {
    const handler = (_e: unknown, dir: string) => cb(dir)
    ipcRenderer.on('project-dir-changed', handler)
    return () => ipcRenderer.removeListener('project-dir-changed', handler)
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  // 제품 전용 IPC — 핸들러는 products/<id>/electron 이 등록한다 (electron/product-ipc.ts).
  productInvoke: (name: string, payload?: unknown) => ipcRenderer.invoke('product-invoke', name, payload),
  revealInFinder: (filePath: string) => ipcRenderer.invoke('reveal-in-finder', filePath),
  moveFile: (from: string, toDir: string) => ipcRenderer.invoke('move-file', { from, toDir }),
  deleteFile: (filePath: string) => ipcRenderer.invoke('delete-file', filePath),
  recentFiles: (limit?: number) => ipcRenderer.invoke('recent-files', { limit }), // 최근 생성/수정 파일 N개
  extractFileText: (payload: { relPath: string; maxChars?: number }) =>
    ipcRenderer.invoke('extract-file-text', payload), // 파일→텍스트 인제스트(레지스트리)
  dashboardSnapshot: () => ipcRenderer.invoke('dashboard-snapshot'),               // Dashboard v2 위젯 상태 스냅샷
  readFile:  (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  readFileBytes: (filePath: string) => ipcRenderer.invoke('read-file-bytes', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('write-file', { filePath, content }),
  exportPDF: (html: string, filename: string) => ipcRenderer.invoke('export-pdf', { html, filename }),   // HTML → PDF
  // HTML → PDF, 다이얼로그 없이 srcPath 옆에 `<basename>.pdf` 로 저장.
  exportPdfBeside: (payload: { html: string; srcPath: string; overwrite?: boolean }) =>
    ipcRenderer.invoke('export-pdf-to', payload),
  exportMd:  (content: string, filename: string) => ipcRenderer.invoke('export-md', { content, filename }), // 마크다운 내보내기
  readImage: (filePath: string) => ipcRenderer.invoke('read-image', filePath),    // 이미지 파일을 base64/데이터URL로
  listDir: (dirPath: string) => ipcRenderer.invoke('list-dir', dirPath),
  // FilesPanel (Marketing IDE) — shared/ root browser.
  listSharedDir: (dirPath: string) => ipcRenderer.invoke('list-shared-dir', dirPath),

  // ── OpenClaw 로컬 게이트웨이 상태 ────────────────────────────────────────
  // OpenClaw 는 자식 프로세스로 돌아가는 로컬 에이전트 런타임. 렌더러는 이 토큰으로 인증된
  // WebSocket을 열어 에이전트 세션을 사용한다 (useOpenClaw.ts 참고).
  getGatewayToken: () => ipcRenderer.invoke('get-gateway-token'),
  // 커스텀 채널(예: 데이터 소스) 설정의 영속 저장/로드
  getChannels: () => ipcRenderer.invoke('get-channels'),
  saveChannels: (payload: unknown) => ipcRenderer.invoke('save-channels', payload),

  // ── 인증 (Supabase, 웹 로그인 핸드오프 방식) ─────────────────────────────
  // 로그인은 외부 브라우저에서 처리하고 딥링크(twixy://) 로 세션을 받는다.
  authGetSession:  () => ipcRenderer.invoke('auth-get-session'),                  // 현재 세션 조회
  authSaveSession: (s: unknown) => ipcRenderer.invoke('auth-save-session', s),    // 세션 저장
  authSignIn:      () => ipcRenderer.invoke('auth-sign-in'),                      // 브라우저 로그인 트리거
  authSignOut:     () => ipcRenderer.invoke('auth-sign-out'),
  // 딥링크로 세션이 들어오면 브로드캐스트되는 이벤트. 구독 해제 함수를 반환.
  onAuthSession: (cb: (s: { access_token: string; refresh_token: string; expires_at?: number | null }) => void) => {
    const handler = (_e: unknown, s: { access_token: string; refresh_token: string; expires_at?: number | null }) => cb(s)
    ipcRenderer.on('auth-session', handler)
    return () => ipcRenderer.removeListener('auth-session', handler)
  },

  // ── 모델 모드 (Twixy 호스팅 vs BYOK=Bring Your Own Key) ──────────────────
  getTwixyMode: () => ipcRenderer.invoke('get-twixy-mode'),
  setTwixyMode: (mode: 'twixy' | 'byok') => ipcRenderer.invoke('set-twixy-mode', mode),

  // 사용자가 본인 API 키(Anthropic/OpenAI)를 쓰는 BYOK 모드 전용 설정들
  getAuthProfiles: () => ipcRenderer.invoke('get-auth-profiles'),
  getAgentModel:   () => ipcRenderer.invoke('get-agent-model'),                    // 메인 에이전트 모델 조회
  saveApiKeys:     (payload: { keys: { anthropic: string; openai: string }; model: string }) =>
    ipcRenderer.invoke('save-api-keys', payload),
  getSubagentModel:  () => ipcRenderer.invoke('get-subagent-model'),               // 서브에이전트용 모델
  saveSubagentModel: (model: string) => ipcRenderer.invoke('save-subagent-model', model),

  // OpenRouter 사용량 한도 초과 통지 (Twixy 호스팅 모드에서 쿼터 초과 시)
  // 게이트웨이가 LLM 키 없이 떴다 — 세션 만료 + 갱신 실패. 이 상태로는 모든
  // 요청이 조용히 타임아웃하므로 사용자에게 알려야 한다.
  onOpenRouterKeyMissing: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('openrouter-key-missing', handler)
    return () => ipcRenderer.removeListener('openrouter-key-missing', handler)
  },
  onOpenRouterLimitExceeded: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('openrouter-limit-exceeded', handler)
    return () => ipcRenderer.removeListener('openrouter-limit-exceeded', handler)
  },

  // OpenClaw 게이트웨이 준비 완료 / 에러 이벤트 구독
  onOpenClawReady: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('openclaw-ready', handler)
    return () => ipcRenderer.removeListener('openclaw-ready', handler)
  },
  onOpenClawError: (cb: (err: string) => void) => {
    const handler = (_e: unknown, err: string) => cb(err)
    ipcRenderer.on('openclaw-error', handler)
    return () => ipcRenderer.removeListener('openclaw-error', handler)
  },

  // ── 첫 실행 / 셋업 플로우 ────────────────────────────────────────────────
  // Twixy 는 Node.js 22가 필요. 없을 경우 이 API들로 감지/설치/재시도 한다.
  getStartupError:  () => ipcRenderer.invoke('get-startup-error'),    // 기동 실패 원인 문자열
  getOpenClawLog:   () => ipcRenderer.invoke('get-openclaw-log'),     // OpenClaw 프로세스 로그 경로/내용
  openLogFile:      () => ipcRenderer.invoke('open-log-file'),        // 로그 파일 열기
  logUi:            (line: string) => ipcRenderer.invoke('log-ui', line),  // 렌더러 진단 한 줄 → 같은 로그 파일
  // 워크스페이스 내부 임의 파일을 시스템 기본 앱으로 연다 (워크플로 write 노드의
  // "Open" 버튼 등). workspace 밖 경로는 main 에서 거부.
  openFile:         (p: string) => ipcRenderer.invoke('open-file', p) as Promise<{ ok: boolean; error?: string }>,
  installNode22:   () => ipcRenderer.invoke('install-node22'),        // Node 22 자동 설치
  retryOpenClaw:   () => ipcRenderer.invoke('retry-openclaw'),        // 게이트웨이 재기동
  // Node 설치 진행률 이벤트(phase: 다운로드/압축 해제 등, pct: 0~100)
  onNodeInstallProgress: (cb: (p: { phase: string; pct: number }) => void) => {
    const handler = (_e: unknown, p: { phase: string; pct: number }) => cb(p)
    ipcRenderer.on('node-install-progress', handler)
    return () => ipcRenderer.removeListener('node-install-progress', handler)
  },

  // ── Pricing IPC ──────────────────────────────────────────────────────────
  // Display markup 적용 (Supabase 에서 main process 가 multiplier fetch). renderer
  // 는 raw $ 값을 보내고 marked-up 결과만 받음 — multiplier 자체는 노출 안 됨.
  // Supabase 못 받아오면 { ok: false, error } 반환 → UI 에서 "⚠ pricing" 표시.
  applyDisplayMarkup: (rawUsd: number) =>
    ipcRenderer.invoke('apply-display-markup', rawUsd) as Promise<{ ok: true; value: number } | { ok: false; error: string }>,
  refreshMarkup: () =>
    ipcRenderer.invoke('refresh-markup') as Promise<{ ok: true }>,

  // 스킬 디렉터리가 변경되면(추가/삭제/수정) UI에 재로드 신호를 보낸다.
  onSkillsChanged: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('skills-changed', handler)
    return () => ipcRenderer.removeListener('skills-changed', handler)
  },

  // ── 세션 로그 & 요약 ─────────────────────────────────────────────────────
  // 채팅 세션을 파일에 append 하고, 과거 세션을 나열/읽기/LLM 요약 할 수 있다.
  appendSessionLog: (payload: { sessionId: string; line: string }) =>
    ipcRenderer.invoke('session-log-append', payload),
  listSessionLogs: () =>
    ipcRenderer.invoke('list-session-logs'),
  readSessionLog: (filePath: string) =>
    ipcRenderer.invoke('read-session-log', filePath),
  generateSessionSummary: (sessionId: string) =>
    ipcRenderer.invoke('generate-session-summary', sessionId),        // LLM 으로 세션 요약 생성

  // 메시지 1건마다 Supabase 에 OpenRouter 사용량(토큰/비용) 누적 기록.
  recordOpenRouterUsage: (delta: { tokensIn: number; tokensOut: number; usdDelta: number }) =>
    ipcRenderer.invoke('record-openrouter-usage', delta),

  // ── TSL(Twixy Skill Language) 스킬 플랫폼 ──────────────────────────────
  // TSL.md 에 정의된 DSL을 컴파일/설치/삭제/조회한다. 컴파일은 tsl-compiler.ts 수행.
  readSkillSource: (name: string) =>
    ipcRenderer.invoke('read-skill-source', name),                    // 설치된 스킬 원본 .tskill 읽기
  compileTskill: (payload: { source: string; filename: string }) =>
    ipcRenderer.invoke('compile-tskill', payload),                    // 문법 검사 + 실행 플랜 생성
  installSkill:  (payload: { source: string; name: string }) =>
    ipcRenderer.invoke('install-skill', payload),                     // skills/<name>/ 에 설치
  deleteSkill:   (name: string) =>
    ipcRenderer.invoke('delete-skill', name),
  listSkills:    () =>
    ipcRenderer.invoke('list-skills'),                                // 설치된 스킬 목록
  getSkillStats: () =>
    ipcRenderer.invoke('get-skill-stats'),                            // 스킬별 호출/성공률 통계

  pullShared: () => ipcRenderer.invoke('pull-shared'),

  // ── 장기 기억(Memory) 보기·편집 ──────────────────────────────────
  // MEMORY.md 읽기/쓰기 + memory/*.md 일일 노트 목록/읽기. 모든 경로는
  // 현재 사용자 워크스페이스로 한정되며, note 이름은 main 에서 traversal 검증.
  memoryRead:      () => ipcRenderer.invoke('memory-read'),
  memoryWrite:     (content: string) => ipcRenderer.invoke('memory-write', { content }),
  memoryListNotes: () => ipcRenderer.invoke('memory-list-notes'),
  memoryReadNote:  (name: string) => ipcRenderer.invoke('memory-read-note', { name }),

  // ── Enterprise Guardrail ─────────────────────────────────────────
  guardrailGetConfig: () => ipcRenderer.invoke('guardrail-get-config'),
  guardrailSetConfig: (patch: unknown) => ipcRenderer.invoke('guardrail-set-config', patch),
  guardrailRemoveAllowlistEntry: (payload: { tool: 'write' | 'edit' | 'bash'; entry: string }) =>
    ipcRenderer.invoke('guardrail-remove-allowlist-entry', payload),
  // 덮어쓰기 승인창의 "Save as…" — 새 파일명을 등록하고 확정된 상대경로를 받는다.
  guardrailOverwriteRedirect: (payload: { id: string; originalRel: string; fileName: string }) =>
    ipcRenderer.invoke('guardrail-overwrite-redirect', payload),
  onGuardrailConfigChanged: (cb: (cfg: unknown) => void) => {
    const handler = (_e: unknown, cfg: unknown) => cb(cfg)
    ipcRenderer.on('guardrail-config-changed', handler)
    return () => ipcRenderer.removeListener('guardrail-config-changed', handler)
  },

  // ── Designated paths (workspace bucket whitelist) ────────────────
  designatedPathsGetConfig: () => ipcRenderer.invoke('designated-paths-get-config'),
  designatedPathsSetConfig: (patch: unknown) => ipcRenderer.invoke('designated-paths-set-config', patch),

  // ── Document tools (file-io) ────────────────────────────────────
  // 마케팅 리포트 포맷용 구조화 writer/reader. 모든 경로는 workspace 상대 경로이고,
  // 메인 프로세스가 사용자 workspace root 를 벗어나는 경로는 거부한다.
  // 여기 있는 건 **렌더러가 직접 부르는** 것뿐이다. writePdf/writeXlsx/readXlsx/
  // renderDeckSheet/fetchToFile/queryData/writeGdoc/readGdoc/writeGsheet/readGsheet/
  // sendEmail 래퍼는 Stage 5 에서 지웠다 — **채널과 핸들러는 살아 있다.** 에이전트는
  // IPC 가 아니라 loopback HTTP 로 닿는다: electron/agent-tool-bridge.ts 가 구현
  // (./tools/files/pdf, ./tools/data/queryData, ./google/gmail …)을 직접 import 해
  // 127.0.0.1 엔드포인트로 노출한다. 그래서 refactor-baseline 의 "main 전용" 채널이
  // 11 늘어난 건 정상이다 — 죽은 채널이 아니라 렌더러를 안 거치는 채널이다.
  tools: {
    writePptx: (payload: { relPath: string; payload: unknown }) =>
      ipcRenderer.invoke('tool-write-pptx', payload),
    readPptx: (payload: { relPath: string }) =>
      ipcRenderer.invoke('tool-read-pptx', payload),
    // 원본 디자인 유지 편집 — Content 모드 pptx-edit 블록의 Apply 가 부른다.
    editPptx: (payload: { relPath: string; outRelPath?: string; ops: unknown[] }) =>
      ipcRenderer.invoke('tool-edit-pptx', payload),
    // 남의 덱 와이어프레임 시트 — 원본 유지 편집 패널 + 모델의 눈.
    renderPptxSketch: (payload: { convId: string; relPath: string }) =>
      ipcRenderer.invoke('pptx-render-sketch', payload),

    // Google Workspace — 한 번 연결해두면 read/write 호출 자유롭게 가능.
    googleGetStatus:    () => ipcRenderer.invoke('google-get-status'),
    googleGetClient:    () => ipcRenderer.invoke('google-get-client'),
    googleSetClient:    (cfg: { clientId: string; clientSecret: string }) =>
      ipcRenderer.invoke('google-set-client', cfg),
    googleClearClient:  () => ipcRenderer.invoke('google-clear-client'),
    googleConnect:      () => ipcRenderer.invoke('tool-google-connect'),
    googleDisconnect:   () => ipcRenderer.invoke('tool-google-disconnect'),
  },

  // ── Connections (설정 > 연동) ────────────────────────────────────
  // 서비스 카드 상태/연결/해제/토큰 저장. 토큰 원문은 절대 렌더러로 오지
  // 않는다 — { service, connected, account? } 상태만 IPC 로 전달된다.
  connectionsList:       () => ipcRenderer.invoke('connections-list'),
  connectionsConnect:    (service: string) => ipcRenderer.invoke('connections-connect', service),
  connectionsDisconnect: (service: string) => ipcRenderer.invoke('connections-disconnect', service),
  connectionsSetToken:   (service: string, token: string) =>
    ipcRenderer.invoke('connections-set-token', { service, token }),

  // ── MCP 클라이언트 서버 (설정 > 연동 > MCP 서버) ──────────────────
  // 사용자가 등록한 외부 MCP 서버. 메타만 렌더러로 오고(토큰 제외), 저장/삭제
  // 시 게이트웨이가 재시작된다(openclaw.json 의 mcp.servers 재적용).
  mcpList:   () => ipcRenderer.invoke('mcp-list'),
  mcpUpsert: (def: unknown, token?: string) => ipcRenderer.invoke('mcp-upsert', { def, token }),
  mcpRemove: (id: string) => ipcRenderer.invoke('mcp-remove', id),
  // OAuth 연결(Phase 2). Twixy 가 토큰 브로커 — 시스템 브라우저로 OAuth 를
  // 끝내고 토큰을 vault 에 저장한 뒤 게이트웨이를 재시작한다.
  mcpOAuthConnect: (args: { url: string; label?: string; clientId?: string }) => ipcRenderer.invoke('mcp-oauth-connect', args),

  // ── Cron 예약 작업 (설정 > 예약 작업) ──────────────────────────────
  // 잡 CRUD 는 렌더러(useOpenClaw)가 이미 인증된 게이트웨이 WS 연결로 cron.* RPC 를
  // 직접 호출한다 — IPC 브리지/메인 핸들러 제거됨. (게이트웨이 client.id:"cli" 는
  // 페어링 미승인으로 1008 거부됐기 때문.)
  // Workflow output-folder picker — constrained to the workspace; returns a
  // workspace-relative path or a rejection. See main.ts 'pick-output-dir'.
  pickOutputDir: () => ipcRenderer.invoke('pick-output-dir') as Promise<
    { ok: true; relPath: string } | { ok: false; reason: string } | null
  >,

  // ── Twixy Enterprise admin ───────────────────────────────────────
  twixyEnterprisePickFolder: () => ipcRenderer.invoke('twixy-enterprise-pick-folder'),
  twixyEnterpriseAdminLoad:  (projectRoot: string) => ipcRenderer.invoke('twixy-enterprise-admin-load', projectRoot),
  twixyEnterpriseReadRun:    (projectRoot: string, uid: string, planId: string) =>
    ipcRenderer.invoke('twixy-enterprise-read-run', { projectRoot, uid, planId }),

  // 어시스턴트의 최종 응답 언어를 사용자의 언어에 맞춰 재작성한다.
  // 고유명사/브랜드/URL/코드 블록은 그대로 보존.
  correctLanguage: (payload: { text: string; userSample: string }) =>
    ipcRenderer.invoke('correct-language', payload),

  // 덱 전용 — 프로즈 교정기는 코드블록을 보존하므로 deck-spec 안의 언어
  // 혼입은 손대지 못한다. 문자열 배열만 주고 같은 길이로 돌려받는다.
  correctLanguageBatch: (payload: { items: string[]; userSample: string }) =>
    ipcRenderer.invoke('correct-language-batch', payload),

  // ── Sidetab overlay ──────────────────────────────────────────────
  // Small always-on-top floating window that mirrors the main chat/plan
  // state. mainWindow pushes snapshots via overlaySyncPush; overlayWindow
  // pulls the latest cache via overlayRequestSync on mount and subscribes
  // to pushes via onOverlaySync. Overlay user actions (Stop / Send) are
  // forwarded back to mainWindow, which owns the real chat session.
  openSidetab:  () => ipcRenderer.invoke('open-sidetab'),
  closeSidetab: () => ipcRenderer.invoke('close-sidetab'),
  overlaySyncPush:     (snapshot: unknown) => ipcRenderer.invoke('overlay-sync-push', snapshot),
  overlayRequestSync:  () => ipcRenderer.invoke('overlay-request-sync'),
  overlayStop:         () => ipcRenderer.invoke('overlay-stop'),
  overlaySend:         (text: string) => ipcRenderer.invoke('overlay-send', text),
  overlayStart:        () => ipcRenderer.invoke('overlay-start'),
  overlayResume:       () => ipcRenderer.invoke('overlay-resume'),
  overlayTogglePlanMode: () => ipcRenderer.invoke('overlay-toggle-plan-mode'),
  overlaySetOpacity:   (value: number) => ipcRenderer.invoke('overlay-set-opacity', value),

  // ── Workflow Test progress overlay ───────────────────────────
  // 메인 윈도우(WorkflowView)가 test 가 시작될 때 openTestOverlay() 호출,
  // testState 변경마다 pushTestOverlaySnapshot() 으로 스냅샷 전달.
  // overlay 의 Stop 버튼은 main 에서 onTestOverlayStop 으로 받는다.
  openTestOverlay:           () => ipcRenderer.invoke('open-test-overlay'),
  closeTestOverlay:          () => ipcRenderer.invoke('close-test-overlay'),
  pushTestOverlaySnapshot:   (snapshot: unknown) => ipcRenderer.invoke('test-overlay-sync-push', snapshot),
  onTestOverlayStop: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('test-overlay-stop', handler)
    return () => ipcRenderer.removeListener('test-overlay-stop', handler)
  },
  onTestOverlayReviewDecision: (cb: (payload: { nodeId: string; action: 'approve' | 'note' | 'skip'; comment?: string }) => void) => {
    const handler = (_e: unknown, payload: { nodeId: string; action: 'approve' | 'note' | 'skip'; comment?: string }) => cb(payload)
    ipcRenderer.on('test-overlay-review-decision', handler)
    return () => ipcRenderer.removeListener('test-overlay-review-decision', handler)
  },

  // ── Live browser preview (headless Chrome streamed into the app) ─
  // The React <LiveBrowserPreview> panel calls start() on mount, stop() on
  // unmount, and setActive(targetId) when the user clicks a thumbnail. The
  // main process pushes per-target JPEG frames and target-list updates.
  // Every call/event carries cdpPort (default 18800 = chat Chrome; workflow
  // Test slots wf-1..3 live on 18801-18803) so panels watching different
  // Chromes can coexist and filter their own events.
  browserPreviewStart:     (opts?: { cdpPort?: number }) => ipcRenderer.invoke('browser-preview:start', opts),
  browserPreviewStop:      (opts?: { cdpPort?: number }) => ipcRenderer.invoke('browser-preview:stop', opts),
  browserPreviewRefresh:   (opts?: { cdpPort?: number }) => ipcRenderer.invoke('browser-preview:refresh', opts),
  browserPreviewSetActive: (payload: { targetId: string; cdpPort?: number }) => ipcRenderer.invoke('browser-preview:set-active', payload),
  browserPreviewCloseTarget: (payload: { targetId: string; cdpPort?: number }) => ipcRenderer.invoke('browser-preview:close-target', payload),
  // Report the preview panel's pixel size so main can match the Chrome viewport
  // aspect to it (removes the letterbox black bars).
  browserPreviewSetViewport: (dims: { width: number; height: number; cdpPort?: number }) => ipcRenderer.invoke('browser-preview:set-viewport', dims),
  // Forward a click / key / scroll captured on the preview panel to the
  // headless Chrome (the panel is the only interaction surface).
  browserPreviewInput:     (payload: unknown) => ipcRenderer.invoke('browser-preview:input', payload),
  onBrowserPreviewFrame: (cb: (payload: { cdpPort: number; targetId: string; base64: string; ts: number; meta?: unknown }) => void) => {
    const handler = (_e: unknown, payload: { cdpPort: number; targetId: string; base64: string; ts: number; meta?: unknown }) => cb(payload)
    ipcRenderer.on('browser-preview-frame', handler)
    return () => ipcRenderer.removeListener('browser-preview-frame', handler)
  },
  onBrowserPreviewTargetList: (cb: (payload: { cdpPort: number; targets: Array<{ targetId: string; title: string; url: string; isActive: boolean }> }) => void) => {
    const handler = (_e: unknown, payload: { cdpPort: number; targets: Array<{ targetId: string; title: string; url: string; isActive: boolean }> }) => cb(payload)
    ipcRenderer.on('browser-preview-target-list', handler)
    return () => ipcRenderer.removeListener('browser-preview-target-list', handler)
  },
  // Guardrail popup window: main renderer drives lifecycle, popup window
  // pulls/listens for state, both sides forward decisions through main.
  guardrailPopupShow:        (payload: unknown) => ipcRenderer.invoke('guardrail-popup-show', payload),
  guardrailPopupClose:       () => ipcRenderer.invoke('guardrail-popup-close'),
  guardrailPopupRequestSync: () => ipcRenderer.invoke('guardrail-popup-request-sync'),
  guardrailPopupDecide:      (payload: { id: string; action: 'approve' | 'session' | 'remember' | 'deny' | 'save-as'; params?: Record<string, unknown>; saveAsName?: string }) =>
    ipcRenderer.invoke('guardrail-popup-decide', payload),
  onOverlaySync: (cb: (snapshot: unknown) => void) => {
    const handler = (_e: unknown, snapshot: unknown) => cb(snapshot)
    ipcRenderer.on('overlay-sync', handler)
    return () => ipcRenderer.removeListener('overlay-sync', handler)
  },
  onOverlayStop: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('overlay-stop', handler)
    return () => ipcRenderer.removeListener('overlay-stop', handler)
  },
  onOverlaySend: (cb: (text: string) => void) => {
    const handler = (_e: unknown, text: string) => cb(text)
    ipcRenderer.on('overlay-send', handler)
    return () => ipcRenderer.removeListener('overlay-send', handler)
  },
  onOverlayStart: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('overlay-start', handler)
    return () => ipcRenderer.removeListener('overlay-start', handler)
  },
  onOverlayResume: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('overlay-resume', handler)
    return () => ipcRenderer.removeListener('overlay-resume', handler)
  },
  onOverlayTogglePlanMode: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('overlay-toggle-plan-mode', handler)
    return () => ipcRenderer.removeListener('overlay-toggle-plan-mode', handler)
  },
  // Popup window subscribes via this; main renderer pushes state on
  // every guardrail change.
  onGuardrailPopupSync: (cb: (state: unknown) => void) => {
    const handler = (_e: unknown, state: unknown) => cb(state)
    ipcRenderer.on('guardrail-popup-sync', handler)
    return () => ipcRenderer.removeListener('guardrail-popup-sync', handler)
  },
  // Main renderer subscribes via this; popup window forwards decisions
  // back through main, and main delivers them to the renderer that owns
  // useGuardrail.decide.
  onGuardrailPopupDecide: (cb: (payload: { id: string; action: 'approve' | 'session' | 'remember' | 'deny' | 'save-as'; params?: Record<string, unknown>; saveAsName?: string }) => void) => {
    const handler = (_e: unknown, payload: { id: string; action: 'approve' | 'session' | 'remember' | 'deny' | 'save-as'; params?: Record<string, unknown>; saveAsName?: string }) => cb(payload)
    ipcRenderer.on('guardrail-popup-decide', handler)
    return () => ipcRenderer.removeListener('guardrail-popup-decide', handler)
  },
}

// ── twixyTestOverlay — Test Progress overlay 윈도우 전용 브릿지 ──────────
// 메인 윈도우가 아니라 test-overlay.html 안에서 호출되는 함수들. 메인 윈도우는
// 위의 twixy.* (pushTestOverlaySnapshot / onTestOverlayStop) 를 쓰고, overlay
// 윈도우는 여기 노출된 함수로 캐시 pull + push 구독 + 액션 forward.
const twixyTestOverlayApi = {
  requestSync: () => ipcRenderer.invoke('test-overlay-request-sync'),
  onSync: (cb: (snap: unknown) => void) => {
    const handler = (_e: unknown, snap: unknown) => cb(snap)
    ipcRenderer.on('test-overlay-sync', handler)
    return () => ipcRenderer.removeListener('test-overlay-sync', handler)
  },
  stop:      () => ipcRenderer.invoke('test-overlay-stop'),
  focusMain: () => ipcRenderer.invoke('test-overlay-focus-main'),
  close:     () => ipcRenderer.invoke('close-test-overlay'),
  sendReviewDecision: (payload: { nodeId: string; action: 'approve' | 'note' | 'skip'; comment?: string }) =>
    ipcRenderer.invoke('test-overlay-review-decision', payload),
}

// ── 창별 표면 ────────────────────────────────────────────────────────────
// 창 5개가 같은 preload.js 를 쓴다. 예전엔 그래서 사이드탭 렌더러도 게이트웨이 토큰을
// 꺼내는 함수를 손에 쥐고 있었다 — 부르면 main 이 발신자를 보고 거부했지만(windowEntry.ts),
// 애초에 쥐여줄 이유가 없다. 보조 창 4개가 쓰는 twixy 이름은 다 합쳐 15개인데 219개를 받고 있었다.
//
// 어느 창인지는 BrowserWindow 가 붙여 준다 (electron/windows.ts 의 additionalArguments).
// 표식이 없으면 main/enterprise/nodal 로 보고 전체 표면을 준다 — 이 세 창은 src/App.tsx 를
// 공유하므로 좁혀도 이득이 작다.
//
// 이름이 틀리면 그 창에서 `undefined is not a function` 으로만 드러나므로,
// `npm run check:preload` 가 (1) 여기 적힌 이름이 twixyApi 에 있는지, (2) 그 창의 import
// 폐쇄가 부르는 이름이 전부 여기 있는지, (3) 안 부르는 이름이 섞여 있지 않은지를 검사한다.
// 타입은 여전히 전 창이 같은 Window['twixy'] 를 본다 — 좁힌 건 런타임 표면이고, 그 간극을
// 메우는 게 저 검사다.
const PER_WINDOW: Record<string, readonly string[]> = {
  sidetab: [
    'planGet', 'onPlanChanged', 'closeSidetab',
    'overlayRequestSync', 'overlayStart', 'overlayResume', 'overlaySetOpacity', 'onOverlaySync',
  ],
  composer: [
    'planGet', 'onPlanChanged',
    'overlayRequestSync', 'overlayStop', 'overlaySend', 'overlayTogglePlanMode', 'onOverlaySync',
  ],
  guardrail: ['guardrailPopupRequestSync', 'guardrailPopupDecide', 'onGuardrailPopupSync'],
  // 이 창의 본체는 아래 twixyTestOverlay 브릿지다. twixy 쪽은 비용 표시 훅
  // (src/lib/useDisplayUsd.tsx) 이 부르는 한 개뿐.
  testOverlay: ['applyDisplayMarkup'],
}

const kindArg = process.argv.find((a) => a.startsWith('--twixy-window='))
const windowKind = kindArg ? kindArg.slice('--twixy-window='.length) : 'main'
const allow = PER_WINDOW[windowKind]

contextBridge.exposeInMainWorld('twixy', allow
  ? Object.fromEntries(allow.map((n) => [n, (twixyApi as Record<string, unknown>)[n]]))
  : twixyApi)

// Test Progress 오버레이 창 전용. 예전에도 이름만 따로였지 전 창이 받았다.
if (windowKind === 'testOverlay') contextBridge.exposeInMainWorld('twixyTestOverlay', twixyTestOverlayApi)