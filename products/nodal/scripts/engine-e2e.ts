// 실제 엔진 E2E — 앱의 엔진 매니저로 엔진을 띄워 MCP 경로 전체를 확인한다 (LLM·로그인 없이).
//
//   npm run prepare:nodal-uv && tmp/nodal-uv/uv sync --project products/nodal/engine --frozen --group diffusion --group upscale --no-group dev
//   npx tsx products/nodal/scripts/engine-e2e.ts <빈 임시 폴더>
//
// 확인하는 것: 기동·ready → MCP 툴 목록 → thumbnail 실행·결과 에셋 → REST 중계 →
// 에디터 그래프를 템플릿으로 저장 → 재시작 → 새 툴이 생기고 실행된다 → 종료 시 포트 해제.
// 8188 포트가 비어 있어야 한다 (앱이 떠 있으면 먼저 끌 것).
import fs from 'node:fs'
import path from 'node:path'
import { EngineManager, resolveEnginePaths } from '../electron/engineManager'
import { packEnv } from '../electron/setup'
import { engineRequest, fetchAsset } from '../electron/engine'
import { graphToTemplate } from '../renderer/nodes/templateConvert'
import { ENGINE_MCP_URL, ENGINE_URL } from '../engineConfig'

const SCRATCH = process.argv[2]
if (!SCRATCH) { console.error('usage: npx tsx products/nodal/scripts/engine-e2e.ts <빈 임시 폴더>'); process.exit(1) }
const ROOT = path.resolve(__dirname, '../../..')
const paths = resolveEnginePaths({ isPackaged: false, resources: ROOT, userData: SCRATCH, platform: process.platform, env: { ...process.env, NODAL_ENGINE_DATA_DIR: path.join(SCRATCH, 'engine') } })
console.log('uv:', paths.uv, '\ndata:', paths.dataDir)
const m = new EngineManager(paths, process.env, () => packEnv(paths))

let sid: string | null = null
let rid = 0
async function mcp(method: string, params: unknown = {}, notify = false) {
  const res = await fetch(ENGINE_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rid, method, params }),
  })
  sid = res.headers.get('mcp-session-id') ?? sid
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
const tool = async (name: string, args: unknown) => {
  const r = await mcp('tools/call', { name, arguments: args })
  const c = r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? '{}')
  if (r.result?.isError) throw new Error(`${name}: ${JSON.stringify(c)}`)
  return c
}
async function waitRun(runId: string) {
  for (let i = 0; i < 120; i++) {
    const r = await tool('get_run', { run_id: runId })
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) return r
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error('timeout')
}
async function session() { sid = null; await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }); await mcp('notifications/initialized', {}, true) }

;(async () => {
  const t0 = Date.now()
  await m.start()
  console.log('state after start:', m.snapshot().state)
  console.log('ready:', await m.waitReady(120_000), `${((Date.now() - t0) / 1000).toFixed(1)}s`, m.snapshot().state)

  await session()
  const tools = (await mcp('tools/list')).result.tools.map((t: { name: string }) => t.name)
  console.log('MCP tools:', tools.length, tools.join(', '))
  const cat = await tool('list_templates', {})
  console.log('templates loaded:', cat.loaded.length, 'rejected:', cat.rejected.map((r: { path: string; reason: string }) => `${path.basename(r.path)}: ${r.reason}`))

  const sample = path.join(paths.project, 'examples', 'sample.png')
  const sub = await tool('run_template_thumbnail', { source: sample, size: 128 })
  console.log('submitted:', sub)
  const done = await waitRun(sub.run_id)
  console.log('thumbnail run:', done.status, JSON.stringify(done.results))
  const hash = Object.values(done.results as Record<string, { asset?: { hash: string } }>)[0]?.asset?.hash
  if (hash) { const a = await fetchAsset(ENGINE_URL, hash); console.log('asset bytes:', a.bytes.length, a.mediaType) }
  const runs = await engineRequest(ENGINE_URL, { method: 'GET', path: '/api/runs' })
  console.log('REST proxy /api/runs:', runs.status, (runs.body as { history: unknown[] }).history.length, 'in history')

  // 에디터 그래프 → 템플릿 → 새 툴
  const graph = {
    nodal_version: '1' as const,
    nodes: {
      src: { type: 'image.Load', inputs: { path: sample } },
      fit: { type: 'image.Resize', inputs: { image: { $link: ['src', 'image'] as [string, string] }, width: 96, height: 64, method: 'lanczos' } },
      save: { type: 'image.Save', inputs: { image: { $link: ['fit', 'image'] as [string, string] }, embed_workflow: true } },
    },
    outputs: ['save'],
  }
  const tpl = graphToTemplate(graph, { id: 'e2e_banner', doc: '이미지를 가로 배너 크기로 줄인다 (E2E).', params: [{ kind: 'image', nodeId: 'src', name: 'image' }, { kind: 'literal', nodeId: 'fit', input: 'width', name: 'width' }], returns: [{ nodeId: 'save', socket: 'asset', name: 'image' }] })
  fs.writeFileSync(path.join(paths.dataDir, 'templates', 'e2e_banner.nodal.json'), JSON.stringify(tpl, null, 2))
  console.log('restart ok:', await m.restart(120_000))
  await session()
  const cat2 = await tool('list_templates', {})
  const mine = cat2.loaded.find((t: { id: string }) => t.id === 'e2e_banner')
  console.log('saved template loaded:', !!mine, mine ? JSON.stringify(mine.input_schema) : JSON.stringify(cat2.rejected))
  const sub2 = await tool('run_template_e2e_banner', { image: sample, width: 200 })
  const done2 = await waitRun(sub2.run_id)
  console.log('saved-template run:', done2.status, JSON.stringify(done2.results), done2.error ?? '')

  m.stop()
  await new Promise((r) => setTimeout(r, 800))
  console.log('final state:', m.snapshot().state, '| port free:', !(await fetch(`${ENGINE_URL}/api/nodes`).then(() => true, () => false)))
  process.exit(0)
})().catch((e) => { console.error('E2E FAILED:', e); console.error(m.logs().slice(-30).join('\n')); m.stop(); process.exit(1) })
