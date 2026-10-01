// 첫 실행 설치 — 엔진 파이썬 런타임(uv sync)과 모델 팩 다운로드.
//
// 한 번에 작업 하나만 돈다(설치 중 다운로드를 또 누르는 사고 방지). 렌더러(renderer/setup)는
// nodal-setup-status 를 폴링해 진행률을 그린다 — 이벤트 푸시 채널을 코어에 새로 뚫지 않으려고.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ProductMainContext } from '../../../shared/product/types'
import type { EngineManager, EnginePaths } from './engineManager'
import { uvAvailable, uvEnv, venvDir } from './engineManager'
import { indexFolder, linkInto, planImport, type ImportPlan } from './modelImport'
import { MODEL_PACKS, getPack, type ModelPack, type PackSource } from './modelPacks'

export interface GpuInfo { name: string; vramMB: number }

export interface SetupJob {
  kind: 'runtime' | 'pack' | 'import'
  id: string
  phase: 'preparing' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled'
  bytesDone: number
  bytesTotal: number
  fileIndex: number
  fileCount: number
  currentFile?: string
  error?: string
  log: string[]
  /** kind 'import' — 팩별 결과. */
  imported?: ImportResult[]
}

export interface ImportResult {
  packId: string
  label: string
  /** 연결(또는 복사)한 파일 수 · 이미 있던 파일 수. */
  linked: number
  present: number
  copied: number
  /** 못 찾은 필수 파일 — 비어 있으면 설치 완료로 표시했다. */
  missing: string[]
  installed: boolean
}

export interface RemoteFile {
  url: string; dest: string; size?: number; sha256?: string
  /** hf-dir 소스에서 온 파일: 폴더(dest) 와 그 안의 상대 경로. 가져오기가 폴더 단위로 맞출 때 쓴다. */
  group?: { root: string; rel: string }
}

export function detectNvidiaGpu(): GpuInfo | null {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (r.status !== 0 || !r.stdout) return null
    const [name, mem] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim())
    return { name, vramMB: Number(mem) || 0 }
  } catch {
    return null
  }
}

/** 이 PC 에 맞는 uv sync 옵션. CUDA 는 NVIDIA 가 있는 Windows/Linux 에서만. */
export function syncArgs(p: EnginePaths, cuda: boolean): string[] {
  return [
    'sync', '--project', p.project, '--frozen',
    ...(cuda ? ['--extra', 'cuda', '--group', 'h3'] : ['--group', 'diffusion']),
    '--group', 'upscale',
    // dev 그룹(ruff·pytest·mypy)은 사용자 PC 에 필요 없다.
    '--no-group', 'dev',
  ]
}

const markerPath = (p: EnginePaths, packId: string) => path.join(p.dataDir, 'models', '.packs', `${packId}.json`)

export function packInstalled(p: EnginePaths, packId: string): boolean {
  return fs.existsSync(markerPath(p, packId))
}

function writeMarker(p: EnginePaths, packId: string, files: string[], extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(markerPath(p, packId)), { recursive: true })
  fs.writeFileSync(markerPath(p, packId), JSON.stringify({ id: packId, at: new Date().toISOString(), files, ...extra }, null, 2))
}

/** 설치된 팩이 엔진에 넘기라고 한 환경 변수 (models/ 기준 상대 → 절대). */
export function packEnv(p: EnginePaths): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pack of MODEL_PACKS) {
    if (!pack.env || !packInstalled(p, pack.id)) continue
    for (const [k, rel] of Object.entries(pack.env)) env[k] = path.join(p.dataDir, 'models', rel)
  }
  return env
}

async function listHfDir(repo: string, dir: string): Promise<Array<{ path: string; size: number; sha256?: string }>> {
  const suffix = dir ? `/${dir.split('/').map(encodeURIComponent).join('/')}` : ''
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main${suffix}?recursive=true`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HF 목록 조회 실패 ${repo}/${dir} (${res.status})`)
  const items = await res.json() as Array<{ type: string; path: string; size?: number; lfs?: { oid?: string } }>
  return items.filter((x) => x.type === 'file').map((x) => ({ path: x.path, size: x.size ?? 0, sha256: x.lfs?.oid }))
}

const hfUrl = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`

/** 팩의 소스를 실제 파일 목록으로 푼다 (크기·해시 포함). */
export async function expandSources(sources: PackSource[]): Promise<RemoteFile[]> {
  const out: RemoteFile[] = []
  for (const s of sources) {
    if (s.kind === 'url') { out.push({ url: s.url, dest: s.dest }); continue }
    if (s.kind === 'hf-file') {
      const dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : ''
      const meta = (await listHfDir(s.repo, dir)).find((f) => f.path === s.path)
      out.push({ url: hfUrl(s.repo, s.path), dest: s.dest, size: meta?.size, sha256: meta?.sha256 })
      continue
    }
    const prefix = s.path ? s.path.replace(/\/$/, '') + '/' : ''
    for (const f of await listHfDir(s.repo, s.path)) {
      const rel = f.path.slice(prefix.length)
      if (rel.startsWith('.git') || (s.exclude ?? []).some((e) => rel.startsWith(e))) continue
      out.push({ url: hfUrl(s.repo, f.path), dest: path.posix.join(s.dest, rel), size: f.size, sha256: f.sha256, group: { root: s.dest, rel } })
    }
  }
  return out
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) {
    if (signal.aborted) throw new Error('cancelled')
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 이어받기 — dest.part 가 있으면 Range 로 이어 붙인다. 끝나면 해시 확인 후 dest 로 이름 바꾼다. */
async function downloadFile(f: RemoteFile, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  if (fs.existsSync(dest) && (f.size === undefined || fs.statSync(dest).size === f.size)) { onBytes(f.size ?? fs.statSync(dest).size); return }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = dest + '.part'
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (f.size !== undefined && have > f.size) { fs.rmSync(part); have = 0 }
  if (have) onBytes(have)
  if (f.size === undefined || have < f.size) {
    const res = await fetch(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' })
    if (!(res.status === 200 || res.status === 206) || !res.body) throw new Error(`다운로드 실패 ${f.url} (${res.status})`)
    if (res.status === 200 && have) { onBytes(-have); have = 0 }   // 서버가 Range 를 무시 — 처음부터
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' })
    try {
      for await (const chunk of Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
        onBytes((chunk as Buffer).length)
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
  }
  if (f.sha256) {
    const got = await sha256File(part, signal)
    if (got !== f.sha256) { fs.rmSync(part, { force: true }); throw new Error(`해시 불일치: ${path.basename(dest)} — 다시 받아 주세요`) }
  }
  fs.renameSync(part, dest)
}

/** engine·paths 는 getter — app ready 뒤(첫 호출 때) 에야 정해진다 (index.ts 참고). */
export function registerSetup(ctx: ProductMainContext, getEngine: () => EngineManager, getPaths: () => EnginePaths): void {
  let job: SetupJob | null = null
  let abort: AbortController | null = null
  let child: ChildProcess | null = null
  const gpu = detectNvidiaGpu()
  const cuda = gpu !== null && process.platform !== 'darwin'

  const log = (line: string) => {
    if (!job) return
    job.log.push(line)
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200)
  }
  const busy = () => !!job && (job.phase === 'preparing' || job.phase === 'running' || job.phase === 'verifying')

  // 렌더러가 1초마다 폴링한다 — uv --version 프로세스를 매번 띄우지 않게 잠깐 캐시한다.
  let uvCache = { at: 0, ok: false }
  const uvOk = () => {
    if (Date.now() - uvCache.at > 10_000) uvCache = { at: Date.now(), ok: uvAvailable(getPaths().uv) }
    return uvCache.ok
  }

  ctx.handle('nodal-setup-status', () => ({
    platform: process.platform,
    uv: uvOk(),
    runtimeInstalled: fs.existsSync(venvDir(getPaths())),
    gpu,
    cuda,
    dataDir: getPaths().dataDir,
    packs: MODEL_PACKS.map((p) => ({
      id: p.id, label: p.label, description: p.description, approxGB: p.approxGB, license: p.license,
      templates: p.templates, requires: p.requires ?? [], cudaOnly: !!p.cudaOnly,
      installed: packInstalled(getPaths(), p.id),
      available: !p.cudaOnly || cuda,
    })),
    job,
    engine: getEngine().snapshot(),
  }))

  ctx.handle('nodal-setup-install-runtime', () => {
    if (busy()) throw new Error('다른 설치 작업이 진행 중입니다')
    if (!uvAvailable(getPaths().uv)) throw new Error(getPaths().externalEnv ? '동봉된 uv 를 찾을 수 없습니다 — 앱을 다시 설치해 주세요' : 'uv 가 없습니다 — npm run prepare:nodal-uv (또는 brew install uv)')
    fs.mkdirSync(getPaths().dataDir, { recursive: true })
    job = { kind: 'runtime', id: cuda ? 'cuda' : 'cpu', phase: 'running', bytesDone: 0, bytesTotal: 0, fileIndex: 0, fileCount: 0, log: [] }
    const args = syncArgs(getPaths(), cuda)
    log(`$ uv ${args.join(' ')}`)
    const c = spawn(getPaths().uv, args, { cwd: getPaths().project, env: uvEnv(getPaths(), process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child = c
    const onData = (b: Buffer) => { for (const l of b.toString('utf8').split(/\r?\n/)) if (l.trim()) log(l) }
    c.stdout?.on('data', onData)
    c.stderr?.on('data', onData)
    c.on('error', (err) => { if (job) { job.phase = 'failed'; job.error = err.message } })
    c.on('exit', (code) => {
      child = null
      if (!job || job.phase === 'cancelled') return
      if (code === 0) {
        job.phase = 'done'
        // 설치가 끝났으면 바로 띄운다 — 모델이 없어도 무모델 템플릿(썸네일·제품 카드)은 돈다.
        void (async () => {
          await getEngine().start()
          if (await getEngine().waitReady(120_000)) await ctx.restartAgentRuntime()
        })().catch((err) => log(`엔진 시작 실패: ${String(err)}`))
      } else {
        job.phase = 'failed'
        job.error = `uv sync 실패 (code ${code}) — 로그를 확인하세요`
      }
    })
    return job
  })

  ctx.handle('nodal-setup-download-pack', (payload) => {
    if (busy()) throw new Error('다른 설치 작업이 진행 중입니다')
    const pack = getPack(String((payload as { id?: unknown } | null)?.id ?? ''))
    if (!pack) throw new Error('unknown pack')
    if (pack.cudaOnly && !cuda) throw new Error('이 팩은 NVIDIA GPU 가 있는 Windows PC 에서만 쓸 수 있습니다')
    const missing = (pack.requires ?? []).filter((r) => !packInstalled(getPaths(), r))
    if (missing.length) throw new Error(`먼저 필요한 팩: ${missing.join(', ')}`)
    job = { kind: 'pack', id: pack.id, phase: 'preparing', bytesDone: 0, bytesTotal: 0, fileIndex: 0, fileCount: 0, log: [] }
    abort = new AbortController()
    void runPack(pack, job, abort.signal)
    return job
  })

  /** 이미 받은 모델 가져오기. payload.folder 가 없으면 폴더 선택 창을 띄운다 (취소하면 null). */
  ctx.handle('nodal-setup-import-folder', async (payload) => {
    if (busy()) throw new Error('다른 설치 작업이 진행 중입니다')
    let folder = (payload as { folder?: unknown } | null)?.folder
    if (typeof folder !== 'string' || !folder) {
      const { dialog, BrowserWindow } = await import('electron')
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts = { title: '이미 받은 모델이 있는 폴더 (예: ComfyUI 의 models 폴더)', properties: ['openDirectory' as const] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      folder = r.filePaths[0]
    }
    if (busy()) throw new Error('다른 설치 작업이 진행 중입니다')
    if (!fs.existsSync(folder as string)) throw new Error(`폴더가 없습니다: ${folder}`)
    job = { kind: 'import', id: path.basename(folder as string), phase: 'preparing', bytesDone: 0, bytesTotal: 0, fileIndex: 0, fileCount: 0, log: [], imported: [] }
    abort = new AbortController()
    void runImport(folder as string, job, abort.signal)
    return job
  })

  ctx.handle('nodal-setup-cancel', () => {
    if (!job || !busy()) return job
    job.phase = 'cancelled'
    abort?.abort()
    child?.kill()
    return job
  })

  async function runImport(folder: string, j: SetupJob, signal: AbortSignal): Promise<void> {
    const modelsDir = path.join(getPaths().dataDir, 'models')
    try {
      log(`${folder} 살펴보는 중…`)
      const index = await indexFolder(folder, { signal })
      log(`파일 ${[...index.values()].reduce((n, l) => n + l.length, 0)}개를 찾았습니다. 팩과 맞춰 봅니다 (파일 목록 확인에 인터넷 연결이 필요합니다)`)
      const plans: Array<{ pack: ModelPack; plan: ImportPlan; files: string[] }> = []
      for (const pack of MODEL_PACKS) {
        if (signal.aborted) throw new Error('cancelled')
        if (packInstalled(getPaths(), pack.id) || (pack.cudaOnly && !cuda)) continue
        const files = await expandSources(pack.sources)
        plans.push({ pack, plan: planImport(files, index, modelsDir), files: files.map((f) => f.dest) })
      }
      const links = plans.flatMap((p) => p.plan.links)
      j.fileCount = links.length
      j.bytesTotal = links.reduce((n, l) => n + l.size, 0)
      j.phase = 'running'
      let newlyInstalled = 0
      for (const { pack, plan, files } of plans) {
        const res: ImportResult = { packId: pack.id, label: pack.label, linked: 0, present: plan.present, copied: 0, missing: plan.missing, installed: false }
        for (const l of plan.links) {
          if (signal.aborted) throw new Error('cancelled')
          j.fileIndex++
          j.currentFile = l.dest
          const before = j.bytesDone
          const how = await linkInto(l.src, path.join(modelsDir, ...l.dest.split('/')), signal, (n) => { j.bytesDone += n })
          j.bytesDone = before + l.size
          res.linked++
          if (how === 'copy') res.copied++
        }
        // 아무것도 못 찾은 팩은 결과에서 뺀다 — 이 폴더와 상관없는 팩이다.
        if (res.linked === 0 && res.present === 0) continue
        if (!plan.missing.length) {
          writeMarker(getPaths(), pack.id, files, { importedFrom: folder })
          res.installed = true
          newlyInstalled++
        }
        j.imported!.push(res)
        log(`${pack.label}: ${res.installed ? '설치 완료' : `${plan.missing.length}개 파일이 없습니다 — 받기를 누르면 나머지만 받습니다`} (연결 ${res.linked - res.copied}, 복사 ${res.copied}, 이미 있음 ${res.present})`)
      }
      j.phase = 'done'
      if (!j.imported!.length) { log('이 폴더에서 팩 파일을 찾지 못했습니다'); return }
      // 런타임 설치 전이면 엔진을 띄울 수 없다 — 파일만 연결해 두고, 런타임 설치가 끝나면 엔진이 뜬다.
      if (newlyInstalled && fs.existsSync(venvDir(getPaths()))) {
        log('완료 — 엔진을 다시 시작합니다')
        if ((await getEngine().restart(120_000))) await ctx.restartAgentRuntime()
      }
    } catch (err) {
      if (j.phase === 'cancelled' || signal.aborted) { j.phase = 'cancelled'; log('취소됨'); return }
      j.phase = 'failed'
      j.error = err instanceof Error ? err.message : String(err)
      log(j.error)
    }
  }

  async function runPack(pack: ModelPack, j: SetupJob, signal: AbortSignal): Promise<void> {
    const modelsDir = path.join(getPaths().dataDir, 'models')
    try {
      const files = await expandSources(pack.sources)
      j.fileCount = files.length
      j.bytesTotal = files.reduce((n, f) => n + (f.size ?? 0), 0)
      j.phase = 'running'
      log(`${pack.label}: 파일 ${files.length}개, ${(j.bytesTotal / 1e9).toFixed(1)} GB`)
      for (const [i, f] of files.entries()) {
        if (signal.aborted) throw new Error('cancelled')
        j.fileIndex = i + 1
        j.currentFile = f.dest
        await downloadFile(f, path.join(modelsDir, ...f.dest.split('/')), signal, (n) => { j.bytesDone += n })
      }
      writeMarker(getPaths(), pack.id, files.map((f) => f.dest))
      j.phase = 'done'
      log('완료 — 엔진을 다시 시작합니다')
      // 팩이 환경 변수(NODAL_H3_MODEL 등)를 더했거나 새 모델이 생겼다 → 엔진·게이트웨이 재시작.
      if ((await getEngine().restart(120_000))) await ctx.restartAgentRuntime()
    } catch (err) {
      if (j.phase === 'cancelled' || signal.aborted) { j.phase = 'cancelled'; log('취소됨 — 다시 누르면 이어받습니다'); return }
      j.phase = 'failed'
      j.error = err instanceof Error ? err.message : String(err)
      log(j.error)
    }
  }
}
