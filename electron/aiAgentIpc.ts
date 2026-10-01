// ── AI 에이전트(Specialist) IPC (main.ts 에서 이동) ──────────────────────────
//
// orchestration* 의 미러 구조. 디스크 IO 는 planning.ts 가 하고 여기는 IPC 래퍼다.
// (Stage 4 슬라이스 3-4)
import { ipcMain } from 'electron'
import * as Planning from './planning'
import type { AiAgentRec, CreateAiAgentInput, AiAgentPatch } from './planning'
import type { MRActor } from './mr'

export interface AiAgentIpcDeps {
  getWorkspace: () => string
  currentActor: () => MRActor
}

/** AI 에이전트 IPC 9개를 등록한다. import 시점 부작용 없음. */
export function registerAiAgentIpc(deps: AiAgentIpcDeps): void {
  const { getWorkspace, currentActor } = deps

  // ── AI Agents (Specialist 단위) — orchestration* 미러 ───────────────────────
  ipcMain.handle('aiagent-list', (): AiAgentRec[] => {
    try { return Planning.listAiAgents(getWorkspace()) }
    catch (err) { console.warn('[aiagent] list failed:', err); return [] }
  })
  ipcMain.handle('aiagent-get', (_e, id: string): AiAgentRec | null => {
    return Planning.readAiAgent(getWorkspace(), id)
  })
  ipcMain.handle('aiagent-create', (_e, payload: Omit<CreateAiAgentInput, 'author'>
  ): { ok: boolean; agent?: AiAgentRec; error?: string } => {
    try { return { ok: true, agent: Planning.createAiAgent(getWorkspace(), { ...payload, author: currentActor() }) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('aiagent-update', (_e, payload: { id: string; patch: AiAgentPatch }
  ): { ok: boolean; agent?: AiAgentRec; error?: string } => {
    try { return { ok: true, agent: Planning.updateAiAgent(getWorkspace(), payload.id, payload.patch) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('aiagent-delete', (_e, id: string): { ok: boolean; error?: string } => {
    try { Planning.deleteAiAgent(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('aiagent-restore', (_e, snapshot: AiAgentRec
  ): { ok: boolean; agent?: AiAgentRec; error?: string } => {
    try { return { ok: true, agent: Planning.restoreAiAgent(getWorkspace(), snapshot) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('aiagent-run-load', (_e, id: string) => {
    try { return { ok: true, state: Planning.readAiAgentLastRun(getWorkspace(), id) } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('aiagent-run-save', (_e, payload: { id: string; state: unknown }) => {
    try { Planning.writeAiAgentLastRun(getWorkspace(), payload.id, payload.state); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('aiagent-run-clear', (_e, id: string) => {
    try { Planning.clearAiAgentLastRun(getWorkspace(), id); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })

}
