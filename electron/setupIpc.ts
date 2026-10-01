// ── Setup 화면 (main.ts 에서 이동) ──────────────────────────────────────────
//
// 첫 실행 경로: Node 22 가 없는 사용자를 위한 portable Node 다운로드·검증·배치와,
// SetupScreen 이 쓰는 IPC 7개(기동 오류 조회 · 로그 열기 · Node 확인/설치 · 기동 재시도).
//
// **`startupErrorMsg` 의 유일한 저장소가 여기다.** 게이트웨이 기동이 실패한 이유를
// 담아 두고 `get-startup-error` 로 렌더러에 넘긴다. gateway.ts(감시가 포기할 때)와
// main.ts(app.whenReady 의 첫 기동)는 아래 접근자로 같은 버퍼에 쓴다 — 버퍼가 둘이
// 되면 복구 화면이 옛 메시지를 보여주거나, 기동에 성공했는데도 오류 화면에 갇힌다.
import { app, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execSync, spawn } from 'node:child_process'
import { PRODUCT } from '../shared/product/current.generated'
import { killGatewayIfRunning, startOpenClaw } from './gateway'
import { startSkillsWatcher } from './skills'
import { getWorkspace } from './paths'

export interface SetupIpcDeps {
  getMainWindow: () => BrowserWindow | null
  /** 게이트웨이 stdout/stderr 롤링 버퍼 — 로깅 묶음(main.ts) 소유. */
  getOpenClawLog: () => string
  /** Twixy 가 관리하는 portable Node 경로. findNode22 가 같은 값을 쓴다. */
  twixyNodePath: string
  openclawLogPath: string
  ensureWorkspace: () => Promise<void> | void
  findNode22: () => string
  patchChromeProfileDisplayName: () => void
}

// ── 기동 실패 메시지 버퍼 (이 모듈이 유일한 저장소) ─────────────────────────
// 기동 실패 메시지 버퍼. 렌더러가 마운트되기 전에 'openclaw-error' 가 발사될 수 있어
// 이벤트가 유실되면 UI 가 'connecting' 에 영원히 갇힌다.
// 렌더러는 첫 렌더에 get-startup-error IPC 로 이 버퍼를 조회해 복구 화면을 띄운다.
let startupErrorMsg: string | null = null

export function getStartupErrorMsg(): string | null { return startupErrorMsg }
export function setStartupErrorMsg(v: string | null): void { startupErrorMsg = v }

/** Setup 헬퍼 + IPC 7개를 등록한다. import 시점 부작용 없음. */
export function registerSetupIpc(deps: SetupIpcDeps): void {
  const { getMainWindow, getOpenClawLog, ensureWorkspace, findNode22, patchChromeProfileDisplayName } = deps
  const TWIXY_NODE_PATH   = deps.twixyNodePath
  const OPENCLAW_LOG_PATH = deps.openclawLogPath

  // ── Setup helpers — 첫 실행 / Node 설치 헬퍼 ─────────────────────
  // Twixy 가 관리하는 portable Node 22 를 다운로드/검증/배치한다.
  // SetupScreen 의 "Install Node" 버튼이 install-node22 IPC 로 호출.

  /**
   * Download `url` to `destPath`, reporting progress as (downloaded, total).
   * Follows redirects (HTTP 301/302) automatically.
   */
  function downloadFile(
    url: string,
    destPath: string,
    onProgress: (downloaded: number, total: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (href: string) => {
        https.get(href, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            res.resume()
            return follow(res.headers.location!)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return reject(new Error(`HTTP ${res.statusCode} from ${href}`))
          }
          const total = parseInt(res.headers['content-length'] ?? '0', 10)
          let downloaded = 0
          const out = fs.createWriteStream(destPath)
          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length
            onProgress(downloaded, total)
          })
          res.pipe(out)
          out.on('finish', () => { out.close(); resolve() })
          out.on('error', reject)
          res.on('error', reject)
        }).on('error', reject)
      }
      follow(url)
    })
  }

  /**
   * Download Node.js 22 portable archive and place a `node` binary at
   * TWIXY_NODE_PATH. Sends 'node-install-progress' IPC events: { phase, pct }
   *
   * Supports Windows (zip from nodejs.org → Expand-Archive) and macOS
   * (tar.gz → /usr/bin/tar). Both flows share the same phases:
   *   downloading → extracting → installing → done.
   */
  async function installNode22(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const arch    = process.arch === 'arm64' ? 'arm64' : 'x64'
    const version = '22.14.0'

    let archiveName: string
    let nodeBinRelPath: string[]   // path inside the extracted archive to the node binary
    if (process.platform === 'win32') {
      archiveName    = `node-v${version}-win-${arch}.zip`
      nodeBinRelPath = [`node-v${version}-win-${arch}`, 'node.exe']
    } else if (process.platform === 'darwin') {
      archiveName    = `node-v${version}-darwin-${arch}.tar.gz`
      nodeBinRelPath = [`node-v${version}-darwin-${arch}`, 'bin', 'node']
    } else {
      return { ok: false, error: `Unsupported platform: ${process.platform}` }
    }

    const url         = `https://nodejs.org/dist/v${version}/${archiveName}`
    const tmpDir      = path.join(os.tmpdir(), 'twixy-node-install')
    const archivePath = path.join(tmpDir, archiveName)
    const extractDir  = path.join(tmpDir, 'extracted')

    const send = (phase: string, pct: number) =>
      getMainWindow()?.webContents.send('node-install-progress', { phase, pct })

    try {
      // Start clean — leftover from a prior failed run would mask the new download.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* first run */ }
      fs.mkdirSync(tmpDir,                            { recursive: true })
      fs.mkdirSync(extractDir,                        { recursive: true })
      fs.mkdirSync(path.dirname(TWIXY_NODE_PATH),     { recursive: true })

      // ── 1. Download ───────────────────────────────────────────────
      send('downloading', 0)
      await downloadFile(url, archivePath, (dl, total) => {
        send('downloading', total > 0 ? Math.round(dl / total * 100) : 0)
      })

      // ── 2. Extract ────────────────────────────────────────────────
      send('extracting', 0)
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          const ps = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractDir}" -Force`,
          ], { stdio: 'pipe' })
          ps.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell exit ${code}`)))
          ps.on('error', reject)
        })
      } else {
        // macOS — /usr/bin/tar handles .tar.gz natively.
        await new Promise<void>((resolve, reject) => {
          const tar = spawn('/usr/bin/tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'pipe' })
          tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)))
          tar.on('error', reject)
        })
      }

      // ── 3. Copy node binary ───────────────────────────────────────
      send('installing', 90)
      const nodeSrc = path.join(extractDir, ...nodeBinRelPath)
      fs.copyFileSync(nodeSrc, TWIXY_NODE_PATH)
      if (process.platform !== 'win32') {
        // copyFileSync preserves source mode on most platforms, but be explicit —
        // a non-executable bin/node would fail silently with EACCES at spawn time.
        fs.chmodSync(TWIXY_NODE_PATH, 0o755)
      }

      // ── 4. Verify ─────────────────────────────────────────────────
      const ver = execSync(`"${TWIXY_NODE_PATH}" --version`, { timeout: 5000 }).toString().trim()

      // ── 5. Cleanup ────────────────────────────────────────────────
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }

      send('done', 100)
      return { ok: true, version: ver }
    } catch (err) {
      console.error('[twixy/setup] install-node22 failed:', err)
      return { ok: false, error: String(err) }
    }
  }

  // ── Setup IPC — SetupScreen 용 IPC 핸들러들 ──────────────────────
  // 기동 실패 시 복구 UI 에서 호출: 로그 확인, Node 22 체크/설치, OpenClaw 재시도.

  // Renderer can query the startup error on mount to avoid the race condition
  // where 'openclaw-error' fires before the React listener is registered.
  ipcMain.handle('get-startup-error', () => startupErrorMsg)

  // Expose openclaw log to the renderer for in-app debugging.
  ipcMain.handle('get-openclaw-log', () => getOpenClawLog() || '(no log yet)')
  ipcMain.handle('open-log-file', () => shell.openPath(OPENCLAW_LOG_PATH))

  // 렌더러가 남기는 진단 한 줄 — 같은 로그 파일로 모은다.
  //
  // 왜 필요한가(2026-09-16): "검증이 엄청 오래 걸린다" 를 재려고 타이머를 넣었는데
  // console.log 라 렌더러 DevTools 에만 남았다. 사용자도 못 꺼내고 나도 못 읽어서,
  // 결국 시간 비교를 하지 못했다. 측정값은 **꺼낼 수 있는 곳**에 있어야 측정이다.
  ipcMain.handle('log-ui', (_e, line: string) => {
    try {
      if (typeof line !== 'string' || !line.trim()) return false
      const stamp = new Date().toISOString()
      const text = `[ui] ${stamp} ${line.slice(0, 500)}\n`
      fs.mkdirSync(path.dirname(OPENCLAW_LOG_PATH), { recursive: true })
      // 로그가 무한정 자라지 않게 — 2MB 넘으면 뒤쪽 절반만 남기고 자른다.
      try {
        const st = fs.statSync(OPENCLAW_LOG_PATH)
        if (st.size > 2_000_000) {
          const buf = fs.readFileSync(OPENCLAW_LOG_PATH)
          fs.writeFileSync(OPENCLAW_LOG_PATH, buf.subarray(Math.floor(buf.length / 2)))
        }
      } catch { /* 파일이 없으면 그냥 새로 쓴다 */ }
      fs.appendFileSync(OPENCLAW_LOG_PATH, text)
      console.log(`[ui] ${line}`)
      return true
    } catch { return false }
  })

  // 워크플로 노드가 만든 산출물을 시스템 기본 앱으로 연다 (write 노드의 "Open"
  // 버튼). 보안: 절대경로는 그대로, 상대경로는 워크스페이스 기준 resolve, 결과
  // 가 workspace 밖이면 거부. 실존 + 파일(디렉토리 X) 만 허용.
  ipcMain.handle('check-node22', () => {
    const node = findNode22()
    if (node === 'node') return { found: false }
    try {
      const ver   = execSync(`"${node}" --version`, { timeout: 3000 }).toString().trim()
      const major = parseInt(ver.replace('v', '').split('.')[0], 10)
      return { found: major >= 22, version: ver, path: node }
    } catch {
      return { found: false }
    }
  })

  // Download and install Node.js 22 portable.
  // Progress events ('node-install-progress') are sent to the renderer window.
  ipcMain.handle('install-node22', () => installNode22())

  // Forward progress events from the main process to the renderer.
  ipcMain.on('node-install-progress', (_e, payload) => {
    getMainWindow()?.webContents.send('node-install-progress', payload)
  })

  // Retry starting the OpenClaw gateway after prerequisites are satisfied.
  ipcMain.handle('retry-openclaw', async () => {
    startupErrorMsg = null
    try {
      await ensureWorkspace()
      await startOpenClaw()
      getMainWindow()?.webContents.send('openclaw-ready')
      patchChromeProfileDisplayName()
      startSkillsWatcher(getWorkspace())
      return { ok: true }
    } catch (err) {
      startupErrorMsg = String(err)
      getMainWindow()?.webContents.send('openclaw-error', startupErrorMsg)
      return { ok: false, error: startupErrorMsg }
    }
  })

}
