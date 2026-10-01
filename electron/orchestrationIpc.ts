// ── 오케스트레이션(L4) IPC (main.ts 에서 이동) ──────────────────────────────
//
// workflow* 의 미러 구조. 디스크 IO 는 planning.ts 가 하고 여기는 IPC 래퍼다.
// (Stage 4 슬라이스 3-3)
import { ipcMain } from 'electron'
import * as Planning from './planning'
import type { Orchestration, CreateOrchestrationInput, OrchestrationPatch } from './planning'
import type { MRActor } from './mr'

export interface OrchestrationIpcDeps {
  getWorkspace: () => string
  currentActor: () => MRActor
}

/** 오케스트레이션 IPC 12개를 등록한다. import 시점 부작용 없음. */
export function registerOrchestrationIpc(deps: OrchestrationIpcDeps): void {
  const { getWorkspace, currentActor } = deps

  // ── Orchestrations (L4) — workflow* 미러 ───────────────────────────────────
  ipcMain.handle('orchestration-list', (): Orchestration[] => {
    try { return Planning.listOrchestrations(getWorkspace()) }
    catch (err) { console.warn('[orchestration] list failed:', err); return [] }
  })
  ipcMain.handle('orchestration-get', (_e, id: string): Orchestration | null => {
    return Planning.readOrchestration(getWorkspace(), id)
  })
  ipcMain.handle('orchestration-create', (_e, payload: Omit<CreateOrchestrationInput, 'author'>
  ): { ok: boolean; orchestration?: Orchestration; error?: string } => {
    try {
      const orchestration = Planning.createOrchestration(getWorkspace(), { ...payload, author: currentActor() })
      return { ok: true, orchestration }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-update', (_e, payload: { id: string; patch: OrchestrationPatch }
  ): { ok: boolean; orchestration?: Orchestration; error?: string } => {
    try {
      const orchestration = Planning.updateOrchestration(getWorkspace(), payload.id, payload.patch)
      return { ok: true, orchestration }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-delete', (_e, id: string): { ok: boolean; error?: string } => {
    try { Planning.deleteOrchestration(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-restore', (_e, snapshot: Orchestration
  ): { ok: boolean; orchestration?: Orchestration; error?: string } => {
    try {
      const orchestration = Planning.restoreOrchestration(getWorkspace(), snapshot)
      return { ok: true, orchestration }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-chat-load', (_e, id: string) => {
    try { return { ok: true, lines: Planning.readOrchBuilderChat(getWorkspace(), id) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-chat-append', (_e, payload: { id: string; line: Planning.BuilderChatLine }) => {
    try { Planning.appendOrchBuilderChat(getWorkspace(), payload.id, payload.line); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-chat-clear', (_e, id: string) => {
    try { Planning.clearOrchBuilderChat(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-run-load', (_e, id: string) => {
    try { return { ok: true, state: Planning.readOrchLastRun(getWorkspace(), id) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-run-save', (_e, payload: { id: string; state: unknown }) => {
    try { Planning.writeOrchLastRun(getWorkspace(), payload.id, payload.state); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('orchestration-run-clear', (_e, id: string) => {
    try { Planning.clearOrchLastRun(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
}
