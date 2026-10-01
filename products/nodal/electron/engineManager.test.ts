// @vitest-environment node
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ENGINE_PORT } from '../engineConfig'
import { EngineManager, resolveEnginePaths, seedTemplates, serveArgs, uvEnv, venvDir } from './engineManager'
import { expandSources, packEnv, syncArgs } from './setup'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-engine-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('resolveEnginePaths', () => {
  it('dev: runs the repo subtree with uv from PATH and its own .venv', () => {
    const p = resolveEnginePaths({ isPackaged: false, resources: '/repo', userData: '/ud', platform: 'darwin', env: {} })
    expect(p).toEqual({ uv: 'uv', project: path.join('/repo', 'products', 'nodal', 'engine'), dataDir: path.join('/ud', 'engine'), externalEnv: false })
    expect(venvDir(p)).toBe(path.join('/repo', 'products', 'nodal', 'engine', '.venv'))
  })

  it('packaged Windows: bundled uv.exe, data under LOCALAPPDATA (not roaming), env outside resources', () => {
    const p = resolveEnginePaths({ isPackaged: true, resources: 'C:\\app\\resources', userData: 'C:\\roam\\Nodal', platform: 'win32', env: { LOCALAPPDATA: 'C:\\local' } })
    expect(p.uv).toBe(path.join('C:\\app\\resources', 'nodal-engine', 'uv.exe'))
    expect(p.dataDir).toBe(path.join('C:\\local', 'Nodal', 'engine'))
    expect(p.externalEnv).toBe(true)
    const env = uvEnv(p, {})
    expect(env.UV_PROJECT_ENVIRONMENT).toBe(path.join(p.dataDir, 'env'))
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join(p.dataDir, 'python'))
    expect(env.HF_HOME).toBe(path.join(p.dataDir, 'hf'))
  })
})

describe('serveArgs', () => {
  it('always passes a persistent --assets dir (in-memory assets vanish on restart)', () => {
    const p = resolveEnginePaths({ isPackaged: false, resources: '/repo', userData: '/ud', platform: 'darwin', env: {} })
    const args = serveArgs(p)
    expect(args.slice(0, 7)).toEqual(['run', '--project', p.project, '--frozen', '--no-sync', 'nodal', 'serve'])
    expect(args[args.indexOf('--assets') + 1]).toBe(path.join(p.dataDir, 'assets'))
    expect(args[args.indexOf('--port') + 1]).toBe(String(ENGINE_PORT))
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1')
  })
})

describe('seedTemplates', () => {
  it('copies bundled templates once, skips experimental h3_compare_*, never overwrites user edits', () => {
    const project = path.join(tmp, 'proj')
    fs.mkdirSync(path.join(project, 'examples', 'templates'), { recursive: true })
    for (const n of ['thumbnail', 'h3_compare_anchor', 'zimage_i2i']) fs.writeFileSync(path.join(project, 'examples', 'templates', `${n}.nodal.json`), `{"id":"${n}"}`)
    const p = { uv: 'uv', project, dataDir: path.join(tmp, 'data'), externalEnv: false }
    fs.mkdirSync(path.join(p.dataDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(p.dataDir, 'templates', 'thumbnail.nodal.json'), '{"edited":true}')
    expect(seedTemplates(p)).toBe(1)
    expect(fs.readdirSync(path.join(p.dataDir, 'templates')).sort()).toEqual(['thumbnail.nodal.json', 'zimage_i2i.nodal.json'])
    expect(fs.readFileSync(path.join(p.dataDir, 'templates', 'thumbnail.nodal.json'), 'utf8')).toBe('{"edited":true}')
  })
})

describe('setup helpers', () => {
  it('syncArgs: CUDA installs h3; CPU/MPS installs the diffusion group; never the dev group', () => {
    const p = { uv: 'uv', project: '/e', dataDir: '/d', externalEnv: true }
    expect(syncArgs(p, true)).toEqual(['sync', '--project', '/e', '--frozen', '--extra', 'cuda', '--group', 'h3', '--group', 'upscale', '--no-group', 'dev'])
    expect(syncArgs(p, false)).toContain('diffusion')
    expect(syncArgs(p, false)).not.toContain('cuda')
  })

  it('packEnv: only installed packs contribute env, as absolute model paths', () => {
    const p = { uv: 'uv', project: '/e', dataDir: path.join(tmp, 'packs'), externalEnv: true }
    expect(packEnv(p)).toEqual({})
    fs.mkdirSync(path.join(p.dataDir, 'models', '.packs'), { recursive: true })
    fs.writeFileSync(path.join(p.dataDir, 'models', '.packs', 'upscale.json'), '{}')
    expect(packEnv(p)).toEqual({ NODAL_UPSCALE_MODEL: path.join(p.dataDir, 'models', 'upscale', 'RealESRGAN_x4plus.pth') })
  })

  it('expandSources: hf-dir lists recursively, applies exclude, keeps sha256 for verification', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('https://huggingface.co/api/models/o/r/tree/main?recursive=true')
      return new Response(JSON.stringify([
        { type: 'directory', path: 'transformer' },
        { type: 'file', path: 'transformer/a.safetensors', size: 10, lfs: { oid: 'abc' } },
        { type: 'file', path: 'transformer_ref/b.safetensors', size: 20 },
        { type: 'file', path: '.gitattributes', size: 1 },
      ]))
    }) as typeof fetch
    try {
      const files = await expandSources([{ kind: 'hf-dir', repo: 'o/r', path: '', dest: 'h3/X', exclude: ['transformer_ref/'] }])
      expect(files).toEqual([{ url: 'https://huggingface.co/o/r/resolve/main/transformer/a.safetensors', dest: 'h3/X/transformer/a.safetensors', size: 10, sha256: 'abc', group: { root: 'h3/X', rel: 'transformer/a.safetensors' } }])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// 실제 프로세스로 기동 → ready → 종료. uv 자리에 가짜 스크립트를 두고, 그 스크립트가 엔진처럼
// /api/nodes 에 답하는 서버를 띄운다. 엔진 포트(8188)가 이미 쓰이고 있으면 건너뛴다.
const portFree = () => new Promise<boolean>((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
  s.listen(ENGINE_PORT, '127.0.0.1')
})

describe.skipIf(process.platform === 'win32')('EngineManager lifecycle (fake uv)', () => {
  it('starts, becomes ready, stops the whole process group, and reports not-installed without a venv', async (ctx) => {
    if (!(await portFree())) ctx.skip()
    const project = path.join(tmp, 'life')
    fs.mkdirSync(path.join(project, '.venv'), { recursive: true })
    const fakeUv = path.join(tmp, 'fake-uv.sh')
    fs.writeFileSync(fakeUv, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "uv 0.0.0"; exit 0; fi
exec "${process.execPath}" -e "require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({nodes:[1,2,3]}))}).listen(${ENGINE_PORT},'127.0.0.1')"
`, { mode: 0o755 })
    const p = { uv: fakeUv, project, dataDir: path.join(tmp, 'life-data'), externalEnv: false }
    const m = new EngineManager(p, { ...process.env, NODAL_ENGINE_EXTERNAL: '' }, () => ({ NODAL_TEST: '1' }))
    await m.start()
    expect(m.snapshot().state).toBe('starting')
    expect(await m.waitReady(10_000)).toBe(true)
    expect(m.snapshot().state).toBe('ready')
    expect(fs.existsSync(path.join(p.dataDir, 'engine.log'))).toBe(true)

    m.stop()
    await new Promise((r) => setTimeout(r, 500))
    expect(m.snapshot().state).toBe('stopped')

    fs.rmSync(path.join(project, '.venv'), { recursive: true })
    const m2 = new EngineManager(p, process.env)
    await m2.start()
    expect(m2.snapshot().state).toBe('not-installed')
  }, 20_000)
})
