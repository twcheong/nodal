// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { indexFolder, isOptionalFile, linkInto, planImport } from './modelImport'
import type { RemoteFile } from './setup'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-import-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

let n = 0
/** 새 작업 폴더 하나 — 파일은 { 상대경로: 바이트 수 }. */
function tree(files: Record<string, number>): string {
  const root = path.join(tmp, `t${n++}`)
  for (const [rel, size] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, Buffer.alloc(size, 1))
  }
  return root
}
const file = (dest: string, size?: number): RemoteFile => ({ url: `https://x/${dest}`, dest, size })
const dirFile = (root: string, rel: string, size?: number): RemoteFile => ({ ...file(`${root}/${rel}`, size), group: { root, rel } })

describe('planImport', () => {
  it('finds single files in a ComfyUI layout by name + size', async () => {
    const src = tree({ 'diffusion_models/z_image_bf16.safetensors': 30, 'text_encoders/qwen_3_4b.safetensors': 20, 'vae/ae.safetensors': 10 })
    const models = tree({})
    const files = [file('diffusion_models/z_image_bf16.safetensors', 30), file('text_encoders/qwen_3_4b.safetensors', 20), file('vae/ae.safetensors', 10)]
    const plan = planImport(files, await indexFolder(src), models)
    expect(plan.missing).toEqual([])
    expect(plan.links.map((l) => l.dest).sort()).toEqual(files.map((f) => f.dest).sort())
  })

  it('rejects a same-named file with the wrong size', async () => {
    const src = tree({ 'vae/ae.safetensors': 11 })
    const plan = planImport([file('vae/ae.safetensors', 10)], await indexFolder(src), tree({}))
    expect(plan.links).toEqual([])
    expect(plan.missing).toEqual(['vae/ae.safetensors'])
  })

  it('prefers the candidate whose path tail matches dest', async () => {
    const src = tree({ 'loras/ae.safetensors': 10, 'vae/ae.safetensors': 10 })
    const plan = planImport([file('vae/ae.safetensors', 10)], await indexFolder(src), tree({}))
    expect(plan.links[0].src).toBe(path.join(src, 'vae', 'ae.safetensors'))
  })

  it('accepts a sizeless (url) file by name', async () => {
    const src = tree({ 'upscale/RealESRGAN_x4plus.pth': 5 })
    const plan = planImport([file('upscale/RealESRGAN_x4plus.pth')], await indexFolder(src), tree({}))
    expect(plan.links).toHaveLength(1)
  })

  it('matches a folder source as a whole — not a stray config.json from another model', async () => {
    const src = tree({
      'other/transformer/config.json': 7,          // 같은 이름·크기지만 가중치가 없는 폴더
      'FLUX/transformer/config.json': 7,
      'FLUX/transformer/diffusion_pytorch_model.safetensors': 40,
    })
    const files = [dirFile('diffusion_models/FLUX-transformer', 'config.json', 7), dirFile('diffusion_models/FLUX-transformer', 'diffusion_pytorch_model.safetensors', 40)]
    const plan = planImport(files, await indexFolder(src), tree({}))
    expect(plan.missing).toEqual([])
    expect(plan.links.map((l) => l.src).sort()).toEqual([
      path.join(src, 'FLUX', 'transformer', 'config.json'),
      path.join(src, 'FLUX', 'transformer', 'diffusion_pytorch_model.safetensors'),
    ].sort())
  })

  it('reports a folder source missing when a required file is absent, but tolerates a missing README', async () => {
    const src = tree({ 'H3/modular_model_index.json': 3, 'H3/transformer/w.safetensors': 50 })
    const files = [dirFile('h3/H3', 'modular_model_index.json', 3), dirFile('h3/H3', 'transformer/w.safetensors', 50), dirFile('h3/H3', 'README.md', 2)]
    expect(planImport(files, await indexFolder(src), tree({})).missing).toEqual([])
    const partial = [...files, dirFile('h3/H3', 'vae/v.safetensors', 9)]
    expect(planImport(partial, await indexFolder(src), tree({})).missing.sort()).toEqual(['h3/H3/modular_model_index.json', 'h3/H3/transformer/w.safetensors', 'h3/H3/vae/v.safetensors'])
  })

  it('counts files already in models/ as present', async () => {
    const models = tree({ 'vae/ae.safetensors': 10 })
    const plan = planImport([file('vae/ae.safetensors', 10)], await indexFolder(tree({})), models)
    expect(plan).toEqual({ links: [], present: 1, missing: [] })
  })

  it('skips hidden folders and partial downloads', async () => {
    const src = tree({ '.cache/vae/ae.safetensors': 10, 'vae/ae.safetensors.part': 10 })
    const plan = planImport([file('vae/ae.safetensors', 10)], await indexFolder(src), tree({}))
    expect(plan.links).toEqual([])
  })
})

describe('isOptionalFile', () => {
  it('treats docs as optional and weights/configs as required', () => {
    expect(isOptionalFile('h3/x/README.md')).toBe(true)
    expect(isOptionalFile('h3/x/.gitattributes')).toBe(true)
    expect(isOptionalFile('h3/x/assets/demo.png')).toBe(true)
    expect(isOptionalFile('h3/x/vae/config.json')).toBe(false)
    expect(isOptionalFile('h3/x/transformer/model.safetensors')).toBe(false)
  })
})

describe('linkInto', () => {
  it('hardlinks on the same volume (no copy) and is idempotent', async () => {
    const src = tree({ 'a.bin': 64 })
    const dst = path.join(tree({}), 'models', 'vae', 'a.bin')
    const signal = new AbortController().signal
    let copied = 0
    expect(await linkInto(path.join(src, 'a.bin'), dst, signal, (b) => { copied += b })).toBe('hardlink')
    expect(copied).toBe(0)
    expect(fs.statSync(dst).ino).toBe(fs.statSync(path.join(src, 'a.bin')).ino)
    expect(await linkInto(path.join(src, 'a.bin'), dst, signal, () => {})).toBe('same')
  })

  it('replaces a stale file and a leftover .part', async () => {
    const src = tree({ 'a.bin': 64 })
    const dir = tree({ 'a.bin': 3, 'a.bin.part': 5 })
    await linkInto(path.join(src, 'a.bin'), path.join(dir, 'a.bin'), new AbortController().signal, () => {})
    expect(fs.statSync(path.join(dir, 'a.bin')).size).toBe(64)
    expect(fs.existsSync(path.join(dir, 'a.bin.part'))).toBe(false)
  })
})
