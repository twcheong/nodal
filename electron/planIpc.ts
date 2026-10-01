// ── 플랜 IPC (main.ts 에서 이동) ────────────────────────────────────────────
//
// All plans live under <projectRoot>/users/[uid]/plans/<planId>/. The LLM round-trip
// for plan generation and step execution happens in the renderer (it already
// owns the gateway WS + chat session). These handlers are pure disk IO for
// plan.json / plan.md / run.md, plus lifecycle transitions.
//
// Stage 4 슬라이스 3-1. 디스크 IO 는 전부 planning.ts 가 하고 여기는 IPC 래퍼다.
// 창은 모른다 — 상태 변화 알림은 broadcast thunk 으로 받는다 (planBroadcast.ts seam).
import { ipcMain } from 'electron'
import * as Planning from './planning'
import type {
  Plan, PlanStatus, PlanPatch, StepEndPayload, StepCompactPayload, CreatePlanInput,
} from './planning'
import { parseExecutionPlan, type ParsedExecutionPlan } from './execution-plan-api'
import type { MRActor } from './mr'

export interface PlanIpcDeps {
  getWorkspace: () => string
  /** 플랜 상태가 바뀌었음을 구독 창들에 알린다 (main 이 창을 안다). */
  broadcastPlanChange: (id: string, kind: string) => void
  /** MR 작성자 식별 — 플랜 author 로 쓰인다. */
  currentActor: () => MRActor
  /** .twixy/config.json — projectId 를 읽는다. */
  loadProjectConfig: () => { projectId: string } | null
}


/**
 * 외부에서 들어온 Execution Plan 을 초안 플랜으로 만든다.
 *
 * IPC(execution-plan-import)와 **Execution Plan HTTP API** 두 곳이 쓴다. API 쪽은 main.ts 의
 * 게이트웨이 기동 코드에 있어 register 안에 가둘 수 없다 — 그래서 deps 를 받는 모듈 함수다.
 */
export function createExecutionPlanDraft(
  deps: PlanIpcDeps,
  parsed: ParsedExecutionPlan,
): { ok: boolean; plan?: Plan; error?: string } {
  try {
    const cfg = deps.loadProjectConfig()
    if (!cfg) return { ok: false, error: 'project_config_missing' }
    const plan = Planning.createPlan(deps.getWorkspace(), {
      ...parsed,
      author:    deps.currentActor(),
      projectId: cfg.projectId,
    })
    deps.broadcastPlanChange(plan.id, 'created')
    return { ok: true, plan }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
/** 플랜 IPC 13개를 등록한다. import 시점 부작용 없음. */
export function registerPlanIpc(deps: PlanIpcDeps): void {
  const { getWorkspace, broadcastPlanChange, currentActor, loadProjectConfig } = deps

  ipcMain.handle('plan-list', (_e, payload?: { status?: PlanStatus }): Plan[] => {
    try { return Planning.listPlans(getWorkspace(), payload) }
    catch (err) { console.warn('[plan] list failed:', err); return [] }
  })

  ipcMain.handle('plan-get', (_e, id: string): Plan | null => {
    return Planning.readPlan(getWorkspace(), id)
  })

  ipcMain.handle('plan-create', (_e, payload: Omit<CreatePlanInput, 'author' | 'projectId'>
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const cfg = loadProjectConfig()
      if (!cfg) return { ok: false, error: 'project_config_missing' }
      const plan = Planning.createPlan(getWorkspace(), {
        ...payload,
        author:    currentActor(),
        projectId: cfg.projectId,
      })
      broadcastPlanChange(plan.id, 'created')
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })


  // ── Execution Plan ingestion (separate from chat planning) ────────────
  // Create a draft plan from a parsed Execution Plan, tagged origin
  // 'execution-plan'. Shared by the UI-import IPC and the inbound HTTP API.
  // Does NOT start the run — the caller decides (UI: human Start; API: auto).
  // createExecutionPlanDraft 는 모듈 스코프에 있다 — IPC 말고 Execution Plan HTTP API 도 쓴다.

  // UI import path: parse → create draft → return plan. The renderer shows the
  // draft PlanCard for human review; it does NOT auto-run (no execution-plan-run
  // event is emitted here).
  ipcMain.handle('execution-plan-import', (_e, raw: unknown
  ): { ok: boolean; plan?: Plan; error?: string } => {
    const parsed = parseExecutionPlan(raw)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    return createExecutionPlanDraft(deps, parsed.value)
  })

  ipcMain.handle('plan-update', (_e, payload: { id: string; patch: PlanPatch }
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.updatePlan(getWorkspace(), payload.id, payload.patch)
      broadcastPlanChange(plan.id, 'updated')
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plan-delete', (_e, id: string): { ok: boolean; error?: string } => {
    try {
      Planning.deletePlan(getWorkspace(), id)
      broadcastPlanChange(id, 'deleted')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plan-begin-run', (_e, payload: { id: string; sessionKey: string }
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.beginRun(getWorkspace(), payload.id, payload.sessionKey)
      broadcastPlanChange(plan.id, 'run-begin')
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plan-step-start', (_e, payload: { id: string; stepId: string }
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.startStep(getWorkspace(), payload.id, payload.stepId)
      broadcastPlanChange(plan.id, 'step-start')
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plan-step-end', (_e, payload: { id: string; stepId: string; result: StepEndPayload }
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.endStep(getWorkspace(), payload.id, payload.stepId, payload.result)
      broadcastPlanChange(plan.id, 'step-end')
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plan-step-compact', (_e, payload: { id: string; stepId: string; compact: StepCompactPayload }
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.saveStepCompact(getWorkspace(), payload.id, payload.stepId, payload.compact)
      broadcastPlanChange(plan.id, 'step-compact')
      return { ok: true, plan }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plan-step-read-raw', (_e, payload: { id: string; stepId: string }): unknown[] => {
    return Planning.readStepRaw(getWorkspace(), payload.id, payload.stepId)
  })

  ipcMain.handle('plan-request-pause', (_e, id: string): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.requestPause(getWorkspace(), id)
      broadcastPlanChange(plan.id, 'pause-requested')
      return { ok: true, plan }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })

  ipcMain.handle('plan-mark-paused', (_e, id: string): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.markPaused(getWorkspace(), id)
      broadcastPlanChange(plan.id, 'paused')
      return { ok: true, plan }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })

  ipcMain.handle('plan-mark-aborted', (_e, id: string): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.markAborted(getWorkspace(), id)
      broadcastPlanChange(plan.id, 'aborted')
      return { ok: true, plan }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })

  ipcMain.handle('plan-finalize', (_e, payload: { id: string; outcome: string }
  ): { ok: boolean; plan?: Plan; error?: string } => {
    try {
      const plan = Planning.finalizePlan(getWorkspace(), payload.id, payload.outcome)
      broadcastPlanChange(plan.id, 'finalized')
      return { ok: true, plan }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })

  ipcMain.handle('plan-read-run', (_e, id: string): string => {
    return Planning.readRunMd(getWorkspace(), id)
  })
}
