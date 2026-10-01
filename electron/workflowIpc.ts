// ── 워크플로 IPC (main.ts 에서 이동) ────────────────────────────────────────
//
// 워크플로 CRUD · 빌더 대화 · 마지막 테스트 실행 · 실행 이력/상세. 디스크 IO 는
// planning.ts 가 하고 여기는 IPC 래퍼다. (Stage 4 슬라이스 3-2)
//
// 목록 캐시(wfListCache)는 이 모듈 안에 있다 — 쓰는 곳도 읽는 곳도 전부 여기뿐이라
// 바깥으로 낼 이유가 없다. register 는 기동 시 한 번만 불리므로 클로저로 유지된다.
import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as Planning from './planning'
import type { Workflow, CreateWorkflowInput, WorkflowPatch } from './planning'
import type { MRActor } from './mr'
import { isInside } from './trustBoundary'

export interface WorkflowIpcDeps {
  getWorkspace: () => string
  currentActor: () => MRActor
}

/** 워크플로 IPC 17개를 등록한다. import 시점 부작용 없음. */
export function registerWorkflowIpc(deps: WorkflowIpcDeps): void {
  const { getWorkspace, currentActor } = deps

  // ── Workflows (Marketing IDE) ───────────────────────────────────────────
  // Read-only viewer + CRUD against users/<uid>/workflows. Execution is not
  // wired up yet — these handlers only manage the JSON authority.
  // 시작 시 App / WorkflowView / OrchestrationView 가 각자 useWorkflows 로
  // workflow-list 를 거의 동시에 3번 호출한다. 매번 모든 워크플로 JSON(노드
  // 포함)을 전부 재파싱하는 건 낭비 — 짧은 TTL 캐시로 그 startup 버스트를 디스크
  // 1회로 합친다. mutation(create/update/delete/restore)에서 즉시 무효화하고,
  // 그 밖의 쓰기 경로(예: 팀 공유 복사)는 사용자 액션이라 800ms TTL 이 이미
  // 지난 뒤 refresh 되므로 자연히 fresh 읽기가 된다 (startup 밖 staleness 없음).
  let wfListCache: { ws: string; at: number; data: Workflow[] } | null = null
  const WF_LIST_TTL_MS = 800
  function bustWfListCache() { wfListCache = null }

  ipcMain.handle('workflow-list', (): Workflow[] => {
    try {
      const ws = getWorkspace()
      const c = wfListCache
      if (c && c.ws === ws && Date.now() - c.at < WF_LIST_TTL_MS) return c.data
      const data = Planning.listWorkflows(ws)
      wfListCache = { ws, at: Date.now(), data }
      return data
    } catch (err) { console.warn('[workflow] list failed:', err); return [] }
  })

  ipcMain.handle('workflow-get', (_e, id: string): Workflow | null => {
    return Planning.readWorkflow(getWorkspace(), id)
  })

  ipcMain.handle('workflow-create', (_e, payload: Omit<CreateWorkflowInput, 'author'>
  ): { ok: boolean; workflow?: Workflow; error?: string } => {
    try {
      const workflow = Planning.createWorkflow(getWorkspace(), {
        ...payload,
        author: currentActor(),
      })
      bustWfListCache()
      return { ok: true, workflow }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('workflow-update', (_e, payload: { id: string; patch: WorkflowPatch }
  ): { ok: boolean; workflow?: Workflow; error?: string } => {
    try {
      const workflow = Planning.updateWorkflow(getWorkspace(), payload.id, payload.patch)
      bustWfListCache()
      return { ok: true, workflow }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('workflow-delete', (_e, id: string): { ok: boolean; error?: string } => {
    try {
      Planning.deleteWorkflow(getWorkspace(), id)
      bustWfListCache()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // 풀 overwrite 복원 — Undo 가 직전 스냅샷을 그대로 복원할 때 사용. patch
  // merge 의 제한(필드 추가/삭제) 회피.
  ipcMain.handle('workflow-restore', (_e, snapshot: Workflow
  ): { ok: boolean; workflow?: Workflow; error?: string } => {
    try {
      const workflow = Planning.restoreWorkflow(getWorkspace(), snapshot)
      bustWfListCache()
      return { ok: true, workflow }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Workflow builder chat persistence ─────────────────────────────────
  // Each workflow has its own builder-chat.jsonl next to workflow.json.
  // Renderer (useWorkflowClaw) loads on workflow switch, appends per message,
  // clears on user reset. Survives app restart + follows the workflow file.
  ipcMain.handle('workflow-chat-load', (_e, id: string) => {
    try { return { ok: true, lines: Planning.readBuilderChat(getWorkspace(), id) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('workflow-chat-append', (_e, payload: { id: string; line: Planning.BuilderChatLine }) => {
    try { Planning.appendBuilderChat(getWorkspace(), payload.id, payload.line); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('workflow-chat-clear', (_e, id: string) => {
    try { Planning.clearBuilderChat(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })


  // ── Last test run persistence (per workflow) ─────────────────────────
  // Canvas restores per-node statuses / cost / duration after app restart.
  // Saved at run-end (or any significant state transition). renderer parses.
  ipcMain.handle('workflow-test-run-load', (_e, id: string) => {
    try { return { ok: true, state: Planning.readLastTestRun(getWorkspace(), id) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('workflow-test-run-save', (_e, payload: { id: string; state: unknown }) => {
    try { Planning.writeLastTestRun(getWorkspace(), payload.id, payload.state); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('workflow-test-run-clear', (_e, id: string) => {
    try { Planning.clearLastTestRun(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  // 탭(대화)별 raw scratch 폴더 삭제 — 탭을 닫을 때 그 탭의 러너가 수집/중간
  // 저장한 원본을 정리한다. 경로는 반드시 data/raw/ 아래로 제한(산출물이 있는
  // data/reports 는 절대 안 건드림). relDir 은 'data/raw/tab-xxxx' 형태.
  ipcMain.handle('workflow-raw-scratch-clear', (_e, relDir: string) => {
    try {
      if (typeof relDir !== 'string' || !relDir.trim()) return { ok: false, error: 'no dir' }
      const norm = relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      // data/raw/<something> 정확히 한 단계 아래만 허용 — traversal·상위 삭제 차단.
      if (!/^data\/raw\/[A-Za-z0-9_.-]+$/.test(norm)) return { ok: false, error: 'dir not under data/raw/' }
      const abs = path.join(getWorkspace(), norm)
      const jailed = path.resolve(getWorkspace(), 'data', 'raw')
      if (!isInside(jailed, abs)) return { ok: false, error: 'outside data/raw' }
      fs.rmSync(abs, { recursive: true, force: true })
      return { ok: true }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })
  // run 히스토리 (runs.jsonl, append-only) — Runs 대시보드의 필터/통계 데이터.
  ipcMain.handle('workflow-run-history-append', (_e, payload: { id: string; entry: Planning.RunHistoryEntry }) => {
    try { Planning.appendRunHistory(getWorkspace(), payload.id, payload.entry); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('workflow-run-history-list', (_e, limit?: number): Planning.RunHistoryEntry[] => {
    try { return Planning.listRunHistory(getWorkspace(), limit) }
    catch { return [] }
  })
  // run 상세 로그 (runs/<startedAt>.json) — 실행 로그 뷰어 데이터.
  ipcMain.handle('workflow-run-detail-save', (_e, payload: { id: string; detail: Planning.RunDetail }) => {
    try { Planning.writeRunDetail(getWorkspace(), payload.id, payload.detail); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('workflow-run-detail-load', (_e, payload: { id: string; startedAt: number }): Planning.RunDetail | null => {
    try { return Planning.readRunDetail(getWorkspace(), payload.id, payload.startedAt) }
    catch { return null }
  })

}
