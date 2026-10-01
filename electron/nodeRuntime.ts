// ── Node 런타임 — portable Node 경로 · 시스템 Node 22+ 탐색 (main.ts 에서 이동) ──
//
// 게이트웨이(openclaw)는 Node 22 이상에서만 돈다. 어디서 찾는지는 순수 계산이고
// 앱 상태를 하나도 안 만진다 — main 에 있을 이유가 없었다(결합도 0).
//
// 설치(다운로드·압축 해제)는 setupIpc.ts 가 하고, 여기는 **경로와 탐색만** 안다.
// 두 쪽이 같은 `TWIXY_NODE_PATH` 를 봐야 해서 그 상수도 같이 옮겼다.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT } from '../shared/product/current.generated'

// 사용자에게 Node 22가 없을 때 Twixy가 관리하는 portable Node를 설치하는 경로.
// 관리자 권한 불필요. 플랫폼별 표준 위치:
//   Windows: %LOCALAPPDATA%\Twixy\node\node.exe
//   macOS:   ~/Library/Application Support/Twixy/node/bin/node
export const TWIXY_NODE_DIR  = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), PRODUCT.appDataDirName, 'node')
  : path.join(os.homedir(), 'Library', 'Application Support', PRODUCT.appDataDirName, 'node')
export const TWIXY_NODE_PATH = process.platform === 'win32'
  ? path.join(TWIXY_NODE_DIR, 'node.exe')
  : path.join(TWIXY_NODE_DIR, 'bin', 'node')

// ── Find Node >= 22 — Node 런타임 탐색 ────────────────────────────
// OpenClaw 는 Node 22 이상이 필수. 사용자의 시스템에서 가능한 모든 위치를 훑어
// 첫 번째 사용 가능한 v22+ 바이너리 경로를 반환한다.
// 검사 순서: 앱 관리 portable → nvm / nvm-windows → homebrew → volta → fnm →
//             winget/chocolatey 기본 설치 경로 → PATH 의 'node' fallback.
export function findNode22(): string {
  const candidates: string[] = []

  // Check our own Twixy-managed portable Node first (Windows + macOS)
  candidates.push(TWIXY_NODE_PATH)

  // 1. nvm
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  const nvmVersions = path.join(nvmDir, 'versions', 'node')
  if (fs.existsSync(nvmVersions)) {
    const dirs = fs.readdirSync(nvmVersions)
      .filter(v => parseInt(v.replace('v', '')) >= 22)
      .sort((a, b) => {
        const av = a.replace('v', '').split('.').map(Number)
        const bv = b.replace('v', '').split('.').map(Number)
        return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2]
      })
    for (const v of dirs) {
      candidates.push(path.join(nvmVersions, v, 'bin', 'node'))
    }
  }

  // 2. homebrew (macOS)
  if (process.platform !== 'win32') {
    const brewPaths = [
      '/opt/homebrew/opt/node@22/bin/node',
      '/usr/local/opt/node@22/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ]
    candidates.push(...brewPaths)
  }

  // 3. volta
  const voltaBin = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Volta', 'bin', 'node.exe')
    : path.join(os.homedir(), '.volta', 'bin', 'node')
  candidates.push(voltaBin)

  // 4. Windows — nvm-windows, direct installs, fnm, scoop
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || ''
    const localAppData = process.env.LOCALAPPDATA || ''
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

    // nvm-windows
    const nvmWindowsDir = process.env.NVM_HOME || path.join(appData, 'nvm')
    if (fs.existsSync(nvmWindowsDir)) {
      const dirs = fs.readdirSync(nvmWindowsDir)
        .filter(v => parseInt(v.replace('v', '')) >= 22)
        .sort((a, b) => {
          const av = a.replace('v', '').split('.').map(Number)
          const bv = b.replace('v', '').split('.').map(Number)
          return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2]
        })
      for (const v of dirs) {
        candidates.push(path.join(nvmWindowsDir, v, 'node.exe'))
      }
    }

    // fnm (Fast Node Manager)
    const fnmDir = process.env.FNM_DIR || path.join(localAppData, 'fnm')
    if (fs.existsSync(fnmDir)) {
      const fnmVersions = path.join(fnmDir, 'node-versions')
      if (fs.existsSync(fnmVersions)) {
        const dirs = fs.readdirSync(fnmVersions)
          .filter(v => parseInt(v.replace('v', '')) >= 22)
        for (const v of dirs) {
          candidates.push(path.join(fnmVersions, v, 'installation', 'node.exe'))
        }
      }
    }

    // Direct installs (chocolatey, winget, official installer)
    candidates.push(
      path.join(programFiles, 'nodejs', 'node.exe'),
      path.join(programFilesX86, 'nodejs', 'node.exe'),
      path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
    )
  }

  // Return first candidate that exists and is v22+
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    try {
      const version = execSync(`"${c}" --version`, { timeout: 3000 }).toString().trim()
      const major = parseInt(version.replace('v', '').split('.')[0])
      if (major >= 22) {
        console.log(`[twixy] Using Node ${version} at ${c}`)
        return c
      }
    } catch { /* skip */ }
  }

  console.warn('[twixy] Node 22+ not found, falling back to system node')
  return 'node'
}
