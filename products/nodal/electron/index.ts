// Nodal 의 메인 프로세스 확장. 코어의 electron/product-ipc.ts 가 기동 시 한 번 부른다.
// 여기 등록한 핸들러는 렌더러에서 window.twixy.productInvoke('<name>', payload) 로 부른다.
import fs from 'node:fs'
import path from 'node:path'
import type { ProductMainContext } from '../../../shared/product/types'
import { ENGINE_URL } from '../engineConfig'
import {
  cancelRun, collectAssets, engineRequest, engineStatus, fetchAsset, getRun, listRuns, uploadAsset,
  type EngineHttpRequest,
} from './engine'
import { EngineManager, resolveEnginePaths, type EnginePaths } from './engineManager'
import { packEnv, registerSetup } from './setup'
import { registerStudio } from './studio'
import { systemStats } from './systemStats'

/** 부팅 때 게이트웨이를 이만큼까지 기다려 준다. 넘으면 게이트웨이를 먼저 띄우고, 엔진이
 *  준비되면 게이트웨이를 한 번 다시 띄운다 (세션의 MCP 툴 목록이 세션 시작 때 고정되므로). */
const BOOT_WAIT_MS = 45_000
const RESTART_WAIT_MS = 120_000

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/webm': '.webm', 'video/mp4': '.mp4',
}

export function registerMain(ctx: ProductMainContext): void {
  // registerMain 은 app.setName(제품 폴더명) 보다 먼저 불린다 — 여기서 userData 를 바로 읽으면
  // 기본 이름(package.json 의 twixy) 폴더가 잡힌다. 그래서 경로·매니저는 처음 쓸 때 만든다
  // (게이트웨이 직전 훅 / IPC 는 전부 app ready 이후).
  let lazy: { paths: EnginePaths; engine: EngineManager } | null = null
  const get = () => {
    if (!lazy) {
      const paths = resolveEnginePaths({
        isPackaged: ctx.paths.isPackaged,
        resources: ctx.paths.resources,
        userData: ctx.paths.userData,
        platform: process.platform,
        env: process.env,
      })
      const engine = new EngineManager(paths, process.env, () => packEnv(paths))
      engine.onChange((s) => {
        if (s.state === 'ready' && gatewayStartedWithoutEngine) {
          gatewayStartedWithoutEngine = false
          void ctx.restartAgentRuntime().catch((err) => console.error('[nodal] gateway restart failed:', err))
        }
      })
      lazy = { paths, engine }
    }
    return lazy
  }
  // 아래 핸들러들은 호출 시점에 eng() 로 매니저를 얻는다.
  const eng = () => get().engine

  // ── 수명주기 ──────────────────────────────────────────────────────────────
  let gatewayStartedWithoutEngine = false
  ctx.onBeforeGatewayStart(async () => {
    const { paths } = get()
    console.log(`[nodal] engine data: ${paths.dataDir} · uv: ${paths.uv}`)
    await eng().start()
    const ok = await eng().waitReady(BOOT_WAIT_MS)
    if (!ok && eng().snapshot().state === 'starting') gatewayStartedWithoutEngine = true
  })
  ctx.onQuit(() => { if (lazy) lazy.engine.stop() })

  /** 엔진을 재시작하고, 에이전트가 새 툴 목록을 보도록 게이트웨이도 다시 띄운다. */
  async function restartAll(): Promise<boolean> {
    const ok = await eng().restart(RESTART_WAIT_MS)
    if (ok) await ctx.restartAgentRuntime()
    return ok
  }

  ctx.handle('nodal-engine-status', async () => {
    const snap = eng().snapshot()
    // 앱이 띄운 엔진이 아니어도(external) 지금 응답하는지는 따로 본다.
    const live = await engineStatus(ENGINE_URL)
    return { ...snap, running: live.running, nodeCount: live.nodeCount }
  })
  ctx.handle('nodal-engine-logs', () => eng().logs())
  ctx.handle('nodal-engine-start', async () => {
    await eng().start()
    const ok = await eng().waitReady(RESTART_WAIT_MS)
    if (ok) await ctx.restartAgentRuntime()
    return eng().snapshot()
  })
  ctx.handle('nodal-engine-restart', async () => { await restartAll(); return eng().snapshot() })
  ctx.handle('nodal-system-stats', () => systemStats())

  // ── 실행·결과 ─────────────────────────────────────────────────────────────
  ctx.handle('nodal-runs', () => listRuns(ENGINE_URL))

  ctx.handle('nodal-run', async (payload) => {
    const runId = (payload as { runId?: unknown } | null)?.runId
    if (typeof runId !== 'string') throw new Error('runId required')
    const run = await getRun(ENGINE_URL, runId)
    return { run, assets: collectAssets(run) }
  })

  ctx.handle('nodal-cancel-run', async (payload) => {
    const runId = (payload as { runId?: unknown } | null)?.runId
    if (typeof runId !== 'string') throw new Error('runId required')
    await cancelRun(ENGINE_URL, runId)
    return true
  })

  /** 결과 에셋을 워크스페이스 outputs/ 로 저장 — 에이전트·데이터 탭이 파일로 다룰 수 있게. */
  ctx.handle('nodal-save-asset', async (payload) => {
    const { hash, name } = (payload ?? {}) as { hash?: unknown; name?: unknown }
    if (typeof hash !== 'string') throw new Error('hash required')
    const { bytes, mediaType } = await fetchAsset(ENGINE_URL, hash)
    const ext = EXT_BY_TYPE[mediaType.split(';')[0].trim()] ?? ''
    const base = typeof name === 'string' && name.trim()
      ? name.trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
      : `nodal-${hash.slice(0, 12)}`
    const dir = path.join(ctx.getWorkspace(), 'outputs')
    fs.mkdirSync(dir, { recursive: true })
    let file = path.join(dir, base + ext)
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}${ext}`)
    fs.writeFileSync(file, bytes)
    return { relPath: path.relative(ctx.getWorkspace(), file).split(path.sep).join('/') }
  })

  /** 워크스페이스 파일 → 엔진 에셋. 반환된 hash 를 템플릿 이미지 입력에 `asset:<hash>` 로 쓴다. */
  ctx.handle('nodal-upload-workspace-file', async (payload) => {
    const rel = (payload as { relPath?: unknown } | null)?.relPath
    if (typeof rel !== 'string') throw new Error('relPath required')
    const ws = path.resolve(ctx.getWorkspace())
    const abs = path.resolve(ws, rel)
    if (abs !== ws && !abs.startsWith(ws + path.sep)) throw new Error('path outside workspace')
    const data = fs.readFileSync(abs)
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4' }[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    return uploadAsset(ENGINE_URL, { name: path.basename(abs), type, data })
  })

  // ── 노드 에디터 중계 (renderer/nodes) ─────────────────────────────────────
  ctx.handle('nodal-http', (payload) => engineRequest(ENGINE_URL, payload as EngineHttpRequest))

  // ── 템플릿 (에디터에서 만든 그래프 → 에이전트 툴) ─────────────────────────
  ctx.handle('nodal-templates-list', () => {
    const dir = path.join(get().paths.dataDir, 'templates')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.nodal.json')).map((f) => f.replace(/\.nodal\.json$/, ''))
  })
  ctx.handle('nodal-template-read', (payload) => {
    const id = templateId(payload)
    return JSON.parse(fs.readFileSync(path.join(get().paths.dataDir, 'templates', `${id}.nodal.json`), 'utf8')) as unknown
  })
  ctx.handle('nodal-template-save', async (payload) => {
    const id = templateId(payload)
    const doc = (payload as { doc?: unknown }).doc
    if (!doc || typeof doc !== 'object') throw new Error('doc required')
    const dir = path.join(get().paths.dataDir, 'templates')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.nodal.json`), JSON.stringify(doc, null, 2) + '\n')
    // 엔진은 템플릿을 기동 때만 읽는다 → 재시작 → 게이트웨이도 재시작해야 새 툴이 세션에 보인다.
    const ok = await restartAll()
    return { ok, snapshot: eng().snapshot() }
  })

  registerSetup(ctx, eng, () => get().paths)
  registerStudio(ctx)
}

/** 엔진의 템플릿 id 규칙과 같다 (templates.py): ^[a-z][a-z0-9_]{0,47}$ */
function templateId(payload: unknown): string {
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(id)) throw new Error('template id must match ^[a-z][a-z0-9_]{0,47}$')
  return id
}
