// 스튜디오 탭(영상 제작 워크플로 1번: 기준 이미지 → 스토리보드 → 샷 이미지 → 영상 → 편집)의 메인 쪽.
//
// 프로젝트는 워크스페이스의 projects/<id>/ 에 산다 — project.json(단계·승인·샷·테이크)과 승인까지 간
// 이미지·영상 파일. 워크스페이스에 두는 이유: 사용자가 파일을 직접 열고 백업·공유하고, 채팅 에이전트도
// 읽을 수 있다. "승인된 기준 자료를 보관한다" 는 워크플로 원칙과도 맞는다.
//
// 메인은 project.json 의 모양을 해석하지 않는다(렌더러가 소유) — id·경로만 지킨다. 생성은 에이전트와 같은
// 엔진 MCP 템플릿으로(mcpClient), 이어 붙이기는 REST 그래프(diffusion.ConcatVideo)로 돌린다.
import fs from 'node:fs'
import path from 'node:path'
import type { ProductMainContext } from '../../../shared/product/types'
import { ENGINE_URL } from '../engineConfig'
import { engineRequest, fetchAsset, uploadAsset } from './engine'
import { callEngineTool } from './mcpClient'

export interface StudioAsset { hash: string; path: string; mediaType: string }
export interface StudioProjectSummary { id: string; name: string; updatedAt: number; stage: number }

const PROJECTS_DIR = 'projects'
const PROJECT_FILE = 'project.json'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const SUBDIRS = new Set(['references', 'storyboard', 'shots', 'takes', 'export'])
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/webm': '.webm', 'video/mp4': '.mp4' }
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** 사람이 붙인 이름 → 폴더 id. 한글은 남기지 않고(경로 호환) 비면 시각으로. */
export function projectIdFor(name: string, now = Date.now()): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${slug || 'project'}-${now.toString(36)}`
}

/** 파일 이름에 쓸 수 있게. */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'asset'
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('잘못된 프로젝트 id')
  return id
}

export function registerStudio(ctx: ProductMainContext): void {
  const root = () => path.join(ctx.getWorkspace(), PROJECTS_DIR)
  const dirOf = (id: string) => path.join(root(), checkId(id))
  const rel = (abs: string) => path.relative(ctx.getWorkspace(), abs).split(path.sep).join('/')

  const read = (id: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dirOf(id), PROJECT_FILE), 'utf8')) as Record<string, unknown>

  const write = (id: string, project: Record<string, unknown>) => {
    const dir = dirOf(id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, PROJECT_FILE)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2))
    fs.renameSync(tmp, file)   // 쓰다 죽어도 반쪽 파일이 남지 않게
  }

  /** 엔진 에셋 → 프로젝트 폴더 파일. 같은 해시면 다시 쓰지 않는다. */
  const keep = async (id: string, hash: string, subdir: string, name: string): Promise<StudioAsset> => {
    if (!SUBDIRS.has(subdir)) throw new Error('잘못된 폴더')
    const { bytes, mediaType } = await fetchAsset(ENGINE_URL, hash)
    const type = mediaType.split(';')[0].trim()
    const dir = path.join(dirOf(id), subdir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safeName(name)}-${hash.slice(0, 8)}${EXT[type] ?? ''}`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes)
    return { hash, path: rel(file), mediaType: type }
  }

  ctx.handle('studio-list', (): StudioProjectSummary[] => {
    if (!fs.existsSync(root())) return []
    const out: StudioProjectSummary[] = []
    for (const id of fs.readdirSync(root())) {
      if (!ID_RE.test(id)) continue
      try {
        const p = read(id)
        out.push({ id, name: String(p.name ?? id), updatedAt: Number(p.updatedAt ?? 0), stage: Number(p.stage ?? 1) })
      } catch { /* project.json 이 없거나 깨진 폴더는 건너뛴다 */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  })

  ctx.handle('studio-create', (payload) => {
    const { project } = (payload ?? {}) as { project?: Record<string, unknown> }
    if (!project || typeof project.name !== 'string' || !project.name.trim()) throw new Error('프로젝트 이름이 필요합니다')
    const id = projectIdFor(project.name)
    const now = Date.now()
    const created = { ...project, id, createdAt: now, updatedAt: now }
    write(id, created)
    return created
  })

  ctx.handle('studio-load', (payload) => read(checkId((payload as { id?: unknown } | null)?.id)))

  ctx.handle('studio-save', (payload) => {
    const { project } = (payload ?? {}) as { project?: Record<string, unknown> }
    const id = checkId(project?.id)
    const saved = { ...project, updatedAt: Date.now() }
    write(id, saved)
    return { updatedAt: saved.updatedAt }
  })

  ctx.handle('studio-reveal', async (payload) => {
    const { shell } = await import('electron')
    const dir = dirOf(checkId((payload as { id?: unknown } | null)?.id))
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return true
  })

  /** 템플릿 하나를 엔진 MCP 로 돌린다 → run_id. 검증 실패는 사람이 읽을 메시지로. */
  ctx.handle('studio-run', async (payload) => {
    const { template, args } = (payload ?? {}) as { template?: unknown; args?: unknown }
    if (typeof template !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(template)) throw new Error('잘못된 템플릿')
    const res = await callEngineTool(`run_template_${template}`, (args ?? {}) as Record<string, unknown>)
    if (res.isError) {
      const issues = (res.data.issues as Array<{ message?: string; location?: string }> | undefined) ?? []
      const detail = issues.map((i) => i.message ?? i.location).filter(Boolean).slice(0, 3).join(' · ')
      throw new Error(`${String(res.data.message ?? '실행 요청 실패')}${detail ? ` — ${detail}` : ''}`)
    }
    const runId = res.data.run_id
    if (typeof runId !== 'string') throw new Error('엔진이 run_id 를 주지 않았습니다')
    return { runId }
  })

  /** 고른 테이크들을 이어 붙이는 실행 → run_id (렌더러가 다른 작업처럼 기다린다). */
  ctx.handle('studio-concat', async (payload) => {
    const hashes = (payload as { hashes?: unknown } | null)?.hashes
    if (!Array.isArray(hashes) || hashes.length === 0 || !hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{8,}$/.test(h))) {
      throw new Error('이을 테이크가 없습니다')
    }
    const graph = {
      nodal_version: '1',
      nodes: { concat: { type: 'diffusion.ConcatVideo', inputs: { sources: hashes.map((h) => `asset:${h}`).join('\n') } } },
      outputs: ['concat'],
    }
    const res = await engineRequest(ENGINE_URL, { method: 'POST', path: '/api/runs', json: JSON.stringify({ graph, use_cache: true }) })
    const body = res.body as { run_id?: string; error?: { message?: string } }
    if (res.status >= 400 || !body.run_id) throw new Error(body.error?.message ?? `이어 붙이기 요청 실패 (${res.status})`)
    return { runId: body.run_id }
  })

  ctx.handle('studio-keep', async (payload) => {
    const { id, hash, subdir, name } = (payload ?? {}) as { id?: unknown; hash?: unknown; subdir?: unknown; name?: unknown }
    if (typeof hash !== 'string' || typeof subdir !== 'string') throw new Error('hash·subdir 가 필요합니다')
    return keep(checkId(id), hash, subdir, typeof name === 'string' ? name : 'asset')
  })

  /** 사용자가 가진 사진을 기준 이미지로 — 파일 선택 → 엔진 에셋으로 올리고 프로젝트 폴더에 복사. */
  ctx.handle('studio-import', async (payload) => {
    const { id, subdir } = (payload ?? {}) as { id?: unknown; subdir?: unknown }
    const projectId = checkId(id)
    if (typeof subdir !== 'string' || !SUBDIRS.has(subdir)) throw new Error('잘못된 폴더')
    const { dialog, BrowserWindow } = await import('electron')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = { title: '기준 이미지 고르기', properties: ['openFile' as const, 'multiSelections' as const], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled) return []
    const out: StudioAsset[] = []
    for (const file of picked.filePaths) {
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()]
      if (!type) continue
      const data = fs.readFileSync(file)
      const ref = await uploadAsset(ENGINE_URL, { name: path.basename(file), type, data: new Uint8Array(data) })
      out.push(await keep(projectId, ref.hash, subdir, path.parse(file).name))
    }
    return out
  })
}
