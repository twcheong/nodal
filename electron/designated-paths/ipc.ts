import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  loadDesignatedPathsConfig,
  saveDesignatedPathsConfig,
  configsEqual,
  DesignatedPathsConfig,
} from './config'

// In-memory cache to avoid hitting disk on every guard call. Reloaded on
// save and at startup. The OpenClaw subprocess receives a snapshot via env
// at spawn time, so a change to the config requires a gateway restart for
// the LLM-facing guard to see the new values — handled by `onChange`.

let cached: DesignatedPathsConfig | null = null

export function getCachedDesignatedPathsConfig(getMetaDir: () => string): DesignatedPathsConfig {
  if (!cached) cached = loadDesignatedPathsConfig(getMetaDir())
  return cached
}

export function reloadDesignatedPathsConfig(getMetaDir: () => string): DesignatedPathsConfig {
  cached = loadDesignatedPathsConfig(getMetaDir())
  return cached
}

export interface RegisterDesignatedPathsIpcDeps {
  getMainWindow:   () => BrowserWindow | null
  getTwixyMetaDir: () => string
  /** Called after a saved change that requires the OpenClaw subprocess to
   *  pick up the new env. The caller is expected to kill + respawn the
   *  gateway, mirroring `registerGuardrailIpc({ onModeChanged })`. */
  onChange?: () => Promise<void> | void
  /** 발신자 검증 (main.ts 의 senderBlocked 를 주입). true 면 허용된 창에서 온 호출이 아니다. */
  isSenderBlocked?: (e: IpcMainInvokeEvent, channel: string) => boolean
}

export function registerDesignatedPathsIpc(deps: RegisterDesignatedPathsIpcDeps) {
  const { getMainWindow, getTwixyMetaDir, onChange, isSenderBlocked } = deps

  ipcMain.handle('designated-paths-get-config', () =>
    getCachedDesignatedPathsConfig(getTwixyMetaDir),
  )

  ipcMain.handle('designated-paths-set-config', async (e, patch: Partial<DesignatedPathsConfig>) => {
    const current = getCachedDesignatedPathsConfig(getTwixyMetaDir)
    // 에이전트가 쓸 수 있는 폴더 목록을 넓히는 채널 — 설정 화면이 있는 창만.
    if (isSenderBlocked?.(e, 'designated-paths-set-config')) return { ok: false, error: 'forbidden_sender', config: current }
    const next: DesignatedPathsConfig = {
      version: 1,
      roots:          patch.roots          ?? current.roots,
      allowedSubdirs: patch.allowedSubdirs ?? current.allowedSubdirs,
    }
    const changed = !configsEqual(current, next)
    const result = saveDesignatedPathsConfig(getTwixyMetaDir(), next)
    if (result.ok) {
      cached = next
      getMainWindow()?.webContents.send('designated-paths-config-changed', next)
      if (changed && onChange) {
        try { await onChange() }
        catch (err) { console.error('[designated-paths] onChange restart failed:', err) }
      }
    }
    return { ok: result.ok, error: result.error, config: next }
  })
}
