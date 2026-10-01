// Nodal 엔진 프로세스 관리 — 앱이 엔진(Python `nodal serve`)을 띄우고, 살아 있는지 보고, 끈다.
//
// 에이전트는 엔진의 MCP(/mcp)를 툴로 쓴다. openclaw 는 MCP 툴 목록을 **세션이 시작될 때 한 번**
// 읽고 캐시하므로, 엔진이 게이트웨이보다 늦게 뜨면 그 세션에는 nodal__* 툴이 없다. 그래서
// 부팅 때 게이트웨이보다 먼저 띄우고(onBeforeGatewayStart), 늦었으면 준비된 뒤 게이트웨이를
// 한 번 다시 띄운다(restartAgentRuntime).
//
// 실행 방식은 한 가지다: `uv run --project <엔진 소스> --frozen --no-sync nodal serve ...`
//   dev      엔진 소스 = 레포의 products/nodal/engine, 가상환경 = 그 안의 .venv, uv = PATH
//   패키지   엔진 소스 = resources/nodal-engine/src, 가상환경·파이썬·캐시 = 엔진 데이터 폴더,
//            uv = resources/nodal-engine/uv(.exe) — 설치는 setup.ts 가 한다
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ENGINE_PORT, ENGINE_URL, EXCLUDED_BUNDLED_TEMPLATES } from '../engineConfig'
import { engineStatus } from './engine'

export type EngineState =
  | 'idle'            // 아직 시작 전
  | 'not-installed'   // uv 나 가상환경이 없다 — 설치 마법사로
  | 'starting'
  | 'ready'
  | 'external'        // 앱이 띄우지 않은 엔진이 이미 포트에 떠 있다 — 그대로 쓴다
  | 'crashed'
  | 'stopped'

export interface EnginePaths {
  /** uv 실행 파일. dev 는 PATH 의 'uv'. */
  uv: string
  /** 엔진 소스 루트 (pyproject.toml · uv.lock · packages/ · examples/). */
  project: string
  /** 엔진 사용자 데이터: assets/ models/ templates/ extensions/ + 패키지면 env/ python/ cache/. */
  dataDir: string
  /** 패키지 앱이면 가상환경을 dataDir/env 에 둔다 (resources 는 읽기 전용일 수 있다). */
  externalEnv: boolean
}

export interface EngineSnapshot {
  state: EngineState
  url: string
  /** 사람이 읽는 한 줄 — 실패 이유, 설치 안내 등. */
  detail?: string
  dataDir: string
  pid?: number
}

export function resolveEnginePaths(opts: {
  isPackaged: boolean
  resources: string
  userData: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}): EnginePaths {
  // 모델이 수십 GB 라 Windows 에서는 로밍 프로필(%APPDATA%)이 아니라 %LOCALAPPDATA% 에 둔다.
  const localRoot = opts.platform === 'win32' && opts.env.LOCALAPPDATA
    ? path.join(opts.env.LOCALAPPDATA, 'Nodal')
    : opts.userData
  const dataDir = opts.env.NODAL_ENGINE_DATA_DIR || path.join(localRoot, 'engine')
  if (opts.isPackaged) {
    const base = path.join(opts.resources, 'nodal-engine')
    return {
      uv: path.join(base, opts.platform === 'win32' ? 'uv.exe' : 'uv'),
      project: path.join(base, 'src'),
      dataDir,
      externalEnv: true,
    }
  }
  // dev: NODAL_UV > `npm run prepare:nodal-uv` 로 받아 둔 tmp/nodal-uv/uv > PATH 의 uv
  const fetched = path.join(opts.resources, 'tmp', 'nodal-uv', opts.platform === 'win32' ? 'uv.exe' : 'uv')
  return {
    uv: opts.env.NODAL_UV || (fs.existsSync(fetched) ? fetched : 'uv'),
    project: path.join(opts.resources, 'products', 'nodal', 'engine'),
    dataDir,
    externalEnv: false,
  }
}

/** uv 가 쓰는 환경 변수. 패키지 앱은 파이썬·가상환경·캐시를 전부 엔진 데이터 폴더 안에 가둔다. */
export function uvEnv(p: EnginePaths, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // 로더가 HF 에서 config·tokenizer 를 받는다 (manager.py config_repo) — 캐시를 엔진 폴더 안에 가둔다.
    HF_HOME: path.join(p.dataDir, 'hf'),
  }
  if (p.externalEnv) {
    env.UV_PROJECT_ENVIRONMENT = path.join(p.dataDir, 'env')
    env.UV_PYTHON_INSTALL_DIR  = path.join(p.dataDir, 'python')
    env.UV_CACHE_DIR           = path.join(p.dataDir, 'cache')
  }
  return env
}

export function venvDir(p: EnginePaths): string {
  return p.externalEnv ? path.join(p.dataDir, 'env') : path.join(p.project, '.venv')
}

export function serveArgs(p: EnginePaths, port = ENGINE_PORT): string[] {
  const d = (name: string) => path.join(p.dataDir, name)
  return [
    'run', '--project', p.project, '--frozen', '--no-sync',
    'nodal', 'serve',
    '--host', '127.0.0.1', '--port', String(port),
    // --assets 가 없으면 결과가 메모리에만 남아 재시작하면 사라진다.
    '--assets', d('assets'),
    '--models', d('models'),
    '--templates', d('templates'),
    '--extensions', d('extensions'),
  ]
}

/** 번들 템플릿을 사용자 템플릿 폴더에 심는다. 이미 있는 파일은 건드리지 않는다 (사용자가 고쳤을 수 있다). */
export function seedTemplates(p: EnginePaths): number {
  const src = path.join(p.project, 'examples', 'templates')
  const dst = path.join(p.dataDir, 'templates')
  fs.mkdirSync(dst, { recursive: true })
  if (!fs.existsSync(src)) return 0
  let copied = 0
  for (const name of fs.readdirSync(src)) {
    if (!name.endsWith('.nodal.json') || EXCLUDED_BUNDLED_TEMPLATES.test(name)) continue
    const target = path.join(dst, name)
    if (fs.existsSync(target)) continue
    fs.copyFileSync(path.join(src, name), target)
    copied++
  }
  return copied
}

/** uv 를 실행할 수 있는가. PATH 탐색까지 해야 하므로 --version 을 실제로 돌려 본다. */
export function uvAvailable(uv: string): boolean {
  try {
    return spawnSync(uv, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0
  } catch {
    return false
  }
}

const MAX_LOG_LINES = 400
const MAX_CRASH_RESTARTS = 3
const CRASH_WINDOW_MS = 10 * 60_000
const CRASH_RESTART_DELAY_MS = 3000

export class EngineManager {
  #state: EngineState = 'idle'
  #detail: string | undefined
  #child: ChildProcess | null = null
  #logs: string[] = []
  #logFile: fs.WriteStream | null = null
  #readyWaiters: Array<(ok: boolean) => void> = []
  #stopping = false
  /** 최근 자동 재시작 시각들 — 계속 죽으면 멈추려고. */
  #crashes: number[] = []
  readonly #listeners = new Set<(s: EngineSnapshot) => void>()

  constructor(
    readonly paths: EnginePaths,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** 기동 때마다 다시 읽는 추가 환경 변수 — 설치된 모델 팩의 NODAL_H3_MODEL 등 (setup.ts packEnv). */
    private readonly extraEnv: () => Record<string, string> = () => ({}),
  ) {}

  snapshot(): EngineSnapshot {
    return { state: this.#state, url: ENGINE_URL, detail: this.#detail, dataDir: this.paths.dataDir, pid: this.#child?.pid }
  }

  logs(): string[] {
    return [...this.#logs]
  }

  onChange(fn: (s: EngineSnapshot) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  isInstalled(): boolean {
    return uvAvailable(this.paths.uv) && fs.existsSync(venvDir(this.paths))
  }

  /** 띄운다. 이미 떠 있거나 뜨는 중이면 아무것도 안 한다. 결과는 waitReady 로 기다린다. */
  async start(): Promise<void> {
    if (this.#child || this.#state === 'starting' || this.#state === 'ready' || this.#state === 'external') return
    this.#stopping = false

    // 누가 이미 엔진을 띄워 두었다 (개발자가 터미널에서, 또는 이전 앱 인스턴스의 잔재).
    // 같은 포트에 두 번째를 띄우면 바인드 실패로 죽기만 하므로 그대로 붙는다.
    if ((await engineStatus(ENGINE_URL)).running) {
      this.#set('external', '이미 실행 중인 엔진에 연결했습니다')
      return
    }
    if (this.env.NODAL_ENGINE_EXTERNAL === '1') {
      this.#set('stopped', 'NODAL_ENGINE_EXTERNAL=1 — 엔진을 직접 띄워 주세요')
      return
    }
    if (!uvAvailable(this.paths.uv)) {
      this.#set('not-installed', this.paths.externalEnv ? '엔진 런타임(uv)이 없습니다 — 앱을 다시 설치해 주세요' : 'uv 가 없습니다 — npm run prepare:nodal-uv (또는 brew install uv)')
      return
    }
    if (!fs.existsSync(venvDir(this.paths))) {
      this.#set('not-installed', '엔진이 아직 설치되지 않았습니다')
      return
    }

    for (const dir of ['assets', 'models', 'templates', 'extensions']) {
      fs.mkdirSync(path.join(this.paths.dataDir, dir), { recursive: true })
    }
    try { seedTemplates(this.paths) } catch (err) { this.#log(`[nodal] 템플릿 복사 실패: ${String(err)}`) }

    this.#logs = []
    this.#logFile?.end()
    // 직전 실행의 로그를 engine.prev.log 로 남긴다 — 엔진이 죽고 다시 뜨면 죽은 이유가 거기 있다
    // (전에는 새 실행이 덮어써서 크래시 원인을 볼 수 없었다).
    const logPath = path.join(this.paths.dataDir, 'engine.log')
    try { if (fs.existsSync(logPath)) fs.renameSync(logPath, path.join(this.paths.dataDir, 'engine.prev.log')) } catch { /* 열려 있으면 그냥 덮어쓴다 */ }
    this.#logFile = fs.createWriteStream(logPath, { flags: 'w' })
    const args = serveArgs(this.paths)
    this.#log(`$ ${this.paths.uv} ${args.join(' ')}`)
    this.#set('starting')

    const child = spawn(this.paths.uv, args, {
      cwd: this.paths.project,
      env: { ...uvEnv(this.paths, this.env), ...this.extraEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: 새 프로세스 그룹 — uv 아래의 python 까지 한 번에 죽이려고 (-pid).
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.#child = child
    const onData = (buf: Buffer) => { for (const line of buf.toString('utf8').split(/\r?\n/)) if (line) this.#log(line) }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      this.#log(`[nodal] 실행 실패: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      this.#child = null
      this.#log(`[nodal] 엔진 종료 (code=${code ?? '-'} signal=${signal ?? '-'})`)
      if (this.#stopping) this.#set('stopped')
      else {
        this.#set('crashed', `엔진이 종료됐습니다 (code ${code ?? signal}) — 로그를 확인하세요`)
        this.#scheduleCrashRestart()
      }
      this.#flushWaiters(false)
    })
    void this.#pollReady(child)
  }

  /** 준비될 때까지 기다린다. 제한 시간 안에 못 뜨면 false (프로세스는 계속 뜨는 중일 수 있다). */
  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.#state === 'ready' || this.#state === 'external') return Promise.resolve(true)
    if (this.#state !== 'starting') return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== done)
        resolve(false)
      }, timeoutMs)
      const done = (ok: boolean) => { clearTimeout(timer); resolve(ok) }
      this.#readyWaiters.push(done)
    })
  }

  /** 동기 — before-quit 에서도 부른다. */
  stop(): void {
    this.#stopping = true
    const child = this.#child
    if (!child?.pid) {
      if (this.#state === 'external') this.#set('idle')
      return
    }
    try {
      if (process.platform === 'win32') {
        // uv → python 자식까지 트리째. child.kill() 은 uv 만 죽이고 python 이 포트를 쥔 채 남는다.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch {
      try { child.kill() } catch { /* 이미 죽었다 */ }
    }
  }

  async restart(timeoutMs: number): Promise<boolean> {
    const child = this.#child
    this.stop()
    if (child) await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) })
    if (this.#state === 'external') this.#set('idle')
    this.#state = 'idle'
    await this.start()
    return this.waitReady(timeoutMs)
  }

  /**
   * 뜬 뒤에 죽었으면(작업 중 네이티브 크래시 등) 알아서 다시 띄운다 — 전에는 사용자가 엔진 탭에서
   * 재시작할 때까지 모든 생성이 막혀 있었다. 계속 죽는 상태(설치가 깨짐 등)에서 무한히 돌지 않게
   * 10분에 3번까지만. 죽은 이유는 engine.prev.log 에 남는다.
   */
  #scheduleCrashRestart(): void {
    const now = Date.now()
    this.#crashes = this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    if (this.#crashes.length >= MAX_CRASH_RESTARTS) {
      this.#set('crashed', `엔진이 ${MAX_CRASH_RESTARTS}번 연달아 종료돼 자동 재시작을 멈췄습니다 — engine.prev.log 를 확인하세요`)
      return
    }
    this.#crashes.push(now)
    setTimeout(() => {
      if (this.#state !== 'crashed' || this.#child) return   // 그새 사용자가 재시작했다
      this.#state = 'idle'
      void this.start()
    }, CRASH_RESTART_DELAY_MS)
  }

  async #pollReady(child: ChildProcess): Promise<void> {
    // 콜드 스타트: 파이썬 기동 + 노드 팩 import. torch 가 있으면 수십 초 걸린다.
    while (this.#child === child && this.#state === 'starting') {
      if ((await engineStatus(ENGINE_URL)).running) {
        if (this.#child !== child) return
        this.#set('ready')
        this.#flushWaiters(true)
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  #flushWaiters(ok: boolean): void {
    const waiters = this.#readyWaiters
    this.#readyWaiters = []
    for (const w of waiters) w(ok)
  }

  #set(state: EngineState, detail?: string): void {
    this.#state = state
    this.#detail = detail
    console.log(`[nodal] engine ${state}${detail ? ` — ${detail}` : ''}`)
    const snap = this.snapshot()
    for (const fn of this.#listeners) fn(snap)
  }

  #log(line: string): void {
    this.#logs.push(line)
    if (this.#logs.length > MAX_LOG_LINES) this.#logs.splice(0, this.#logs.length - MAX_LOG_LINES)
    this.#logFile?.write(line + '\n')
  }
}
