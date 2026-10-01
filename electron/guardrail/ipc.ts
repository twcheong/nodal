import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { loadGuardrailConfig, saveGuardrailConfig, GuardrailConfig } from './config'

let cached: GuardrailConfig | null = null

export function getCachedGuardrailConfig(): GuardrailConfig {
  if (!cached) cached = loadGuardrailConfig()
  return cached
}

export function reloadGuardrailConfig(): GuardrailConfig {
  cached = loadGuardrailConfig()
  return cached
}

export function registerGuardrailIpc(
  getMainWindow: () => BrowserWindow | null,
  onModeChanged?: () => Promise<void> | void,
  /** 발신자 검증 (main.ts 의 senderBlocked 를 주입). 이 모듈은 main 을 import 하지 않는다.
   *  true 면 그 호출은 허용된 창에서 온 게 아니다. */
  isSenderBlocked?: (e: IpcMainInvokeEvent, channel: string) => boolean,
) {
  ipcMain.handle('guardrail-get-config', () => getCachedGuardrailConfig())

  ipcMain.handle('guardrail-set-config', async (e, patch: Partial<GuardrailConfig>) => {
    const current = getCachedGuardrailConfig()
    // 가드레일 자체를 끄거나(mode) allowlist 를 넓히는 채널 — 설정 화면이 있는 창만.
    if (isSenderBlocked?.(e, 'guardrail-set-config')) return { ok: false, error: 'forbidden_sender', config: current }
    const next: GuardrailConfig = {
      mode: patch.mode ?? current.mode,
      allowlist: {
        write: patch.allowlist?.write ?? current.allowlist.write,
        edit:  patch.allowlist?.edit  ?? current.allowlist.edit,
        bash:  patch.allowlist?.bash  ?? current.allowlist.bash,
      },
    }
    const modeChanged = next.mode !== current.mode
    const result = saveGuardrailConfig(next)
    if (result.ok) {
      cached = next
      getMainWindow()?.webContents.send('guardrail-config-changed', next)
      // Mode is captured into the gateway subprocess env at spawn (see
      // patches/openclaw+2026.4.2.patch — `process.env.TWIXY_GUARDRAIL_MODE`),
      // so a live mode switch only takes effect after the gateway is
      // respawned. Tradeoff: in-flight agent sessions are interrupted.
      // We restart only on mode changes — allowlist-only edits skip the
      // restart to preserve session continuity, even though they also won't
      // take effect mid-session (acceptable: users typically add allowlist
      // entries from inside an approval modal that's already blocking).
      if (modeChanged && onModeChanged) {
        try { await onModeChanged() } catch (err) { console.error('[guardrail] mode-change restart failed:', err) }
      }
    }
    return { ok: result.ok, error: result.error, config: next }
  })

  ipcMain.handle('guardrail-remove-allowlist-entry', (_e, payload: { tool: 'write' | 'edit' | 'bash'; entry: string }) => {
    const current = getCachedGuardrailConfig()
    const next: GuardrailConfig = {
      mode: current.mode,
      allowlist: {
        write: current.allowlist.write,
        edit:  current.allowlist.edit,
        bash:  current.allowlist.bash,
        [payload.tool]: current.allowlist[payload.tool].filter(e => e !== payload.entry),
      } as GuardrailConfig['allowlist'],
    }
    const result = saveGuardrailConfig(next)
    if (result.ok) {
      cached = next
      getMainWindow()?.webContents.send('guardrail-config-changed', next)
    }
    return { ok: result.ok, error: result.error, config: next }
  })
}
