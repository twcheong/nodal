// 이미 받은 모델 가져오기 — 사용자가 고른 폴더(ComfyUI models/, HF 캐시, 예전 다운로드 폴더 등)에서
// 팩 파일을 찾아 엔진 models/ 로 **연결**한다. 다시 받지 않게 하려는 것이라 복사는 최후 수단이다:
//   하드링크(같은 드라이브, 용량 0) → 심볼릭 링크(다른 드라이브, 개발자 모드 필요) → 복사
//
// 찾는 기준은 파일 이름 + 크기(HF 목록의 크기). 폴더 구조는 보지 않는다 — ComfyUI 와 HF 는 같은 파일을
// 다른 경로에 둔다. 단 hf-dir 소스(폴더형 diffusers 컴포넌트)는 폴더 **통째로** 맞아야 한다:
// config.json 처럼 이름이 흔한 파일을 다른 모델 폴더에서 주워 오지 않게.
import fs from 'node:fs'
import path from 'node:path'
import type { RemoteFile } from './setup'

export interface LocalFile { abs: string; size: number }
export type FolderIndex = Map<string, LocalFile[]>

export interface ImportMatch { src: string; dest: string; size: number }
export interface ImportPlan {
  /** 찾은 파일 (dest 는 models/ 기준 posix 상대 경로). 이미 제자리에 있는 파일은 빠진다. */
  links: ImportMatch[]
  /** 이미 models/ 에 맞는 크기로 있는 파일 수. */
  present: number
  /** 못 찾은 필수 파일. 비어 있으면 팩이 완성된다. */
  missing: string[]
}

/** README·라이선스·문서 이미지 — 없어도 모델은 돈다. 받기에서는 받지만 가져오기에서는 요구하지 않는다. */
export function isOptionalFile(dest: string): boolean {
  return /(^|\/)(readme|license|licence|notice)[^/]*$/i.test(dest) || /\.(md|png|jpe?g|gif|webp|mp4)$/i.test(dest) || /(^|\/)\.gitattributes$/.test(dest)
}

const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)'])
const key = (name: string) => name.toLowerCase()

/** 폴더 아래 파일을 이름별로 모은다. 심볼릭 링크 파일(HF 캐시 스냅샷)은 따라가 크기를 재고, 폴더 링크는 따라가지 않는다(순환 방지). */
/** 비동기 — 사용자가 드라이브 루트를 골라도 메인 프로세스(=창)가 멈추지 않게. */
export async function indexFolder(root: string, opts: { maxDepth?: number; maxFiles?: number; signal?: AbortSignal } = {}): Promise<FolderIndex> {
  const maxDepth = opts.maxDepth ?? 10
  const maxFiles = opts.maxFiles ?? 300_000
  const index: FolderIndex = new Map()
  let count = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || count >= maxFiles) return
    if (opts.signal?.aborted) throw new Error('cancelled')
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        // 루트 아래의 숨김 폴더(.git, .cache 의 받다 만 조각)는 건너뛴다. 루트 자체는 사용자가 고른 것이라 본다.
        if (e.name.startsWith('.') || SKIP_DIRS.has(key(e.name))) continue
        await walk(abs, depth + 1)
        continue
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue
      if (e.name.endsWith('.part') || e.name.endsWith('.incomplete')) continue
      let st: fs.Stats
      try { st = await fs.promises.stat(abs) } catch { continue }
      if (!st.isFile()) continue
      const list = index.get(key(e.name)) ?? []
      list.push({ abs, size: st.size })
      index.set(key(e.name), list)
      if (++count >= maxFiles) return
    }
  }
  await walk(root, 0)
  return index
}

/** 경로 끝에서부터 같은 폴더 이름이 몇 개 겹치는가 — 같은 이름·크기 후보가 여럿일 때 고르는 기준. */
function suffixScore(abs: string, dest: string): number {
  const a = abs.split(/[\\/]/).map(key).reverse()
  const d = dest.split('/').map(key).reverse()
  let n = 0
  while (n < a.length && n < d.length && a[n] === d[n]) n++
  return n
}

const sizeOk = (f: { size?: number }, size: number) => f.size === undefined || f.size === size

function fileAt(abs: string): LocalFile | null {
  try { const st = fs.statSync(abs); return st.isFile() ? { abs, size: st.size } : null } catch { return null }
}

/**
 * 팩 파일 목록(expandSources 결과)을 폴더 색인에 맞춘다.
 * modelsDir 에 이미 맞는 크기로 있는 파일은 건너뛴다(present).
 */
export function planImport(files: RemoteFile[], index: FolderIndex, modelsDir: string): ImportPlan {
  const plan: ImportPlan = { links: [], present: 0, missing: [] }
  const destAbs = (dest: string) => path.join(modelsDir, ...dest.split('/'))
  const todo = files.filter((f) => {
    const have = fileAt(destAbs(f.dest))
    // 크기를 모르는 파일(url 소스)은 있으면 맞다고 본다 — 받기(downloadFile)의 건너뛰기 규칙과 같다.
    if (have && sizeOk(f, have.size)) { plan.present++; return false }
    return true
  })

  // ① 폴더형 소스 — 가장 큰 파일로 후보 폴더를 잡고, 나머지 파일이 그 폴더의 같은 상대 경로에 다 있어야 한다.
  const groups = new Map<string, RemoteFile[]>()
  for (const f of todo) if (f.group) groups.set(f.group.root, [...(groups.get(f.group.root) ?? []), f])
  for (const group of groups.values()) {
    const required = group.filter((f) => !isOptionalFile(f.dest))
    const anchor = [...(required.length ? required : group)].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
    const anchorRel = anchor.group!.rel.split('/')
    let root: string | null = null
    for (const c of index.get(key(anchorRel[anchorRel.length - 1])) ?? []) {
      if (!sizeOk(anchor, c.size)) continue
      const parts = c.abs.split(/[\\/]/)
      if (parts.length <= anchorRel.length) continue
      const tail = parts.slice(parts.length - anchorRel.length).map(key)
      if (tail.join('/') !== anchorRel.map(key).join('/')) continue
      const r = parts.slice(0, parts.length - anchorRel.length).join(path.sep)
      if (required.every((f) => { const h = fileAt(path.join(r, ...f.group!.rel.split('/'))); return !!h && sizeOk(f, h.size) })) { root = r; break }
    }
    for (const f of group) {
      const h = root ? fileAt(path.join(root, ...f.group!.rel.split('/'))) : null
      if (h && sizeOk(f, h.size)) plan.links.push({ src: h.abs, dest: f.dest, size: h.size })
      else if (!isOptionalFile(f.dest)) plan.missing.push(f.dest)
    }
  }

  // ② 낱개 파일 — 이름 + 크기. 후보가 여럿이면 경로 끝이 dest 와 더 많이 겹치는 쪽.
  for (const f of todo) {
    if (f.group) continue
    const name = f.dest.slice(f.dest.lastIndexOf('/') + 1)
    const cands = (index.get(key(name)) ?? []).filter((c) => sizeOk(f, c.size))
    if (!cands.length) { if (!isOptionalFile(f.dest)) plan.missing.push(f.dest); continue }
    const best = cands.sort((a, b) => suffixScore(b.abs, f.dest) - suffixScore(a.abs, f.dest))[0]
    plan.links.push({ src: best.abs, dest: f.dest, size: best.size })
  }
  return plan
}

export type LinkMethod = 'hardlink' | 'symlink' | 'copy' | 'same'

/** src 를 dst 에 연결한다. 하드링크 → 심볼릭 링크 → 복사(onBytes 로 진행률). */
export async function linkInto(src: string, dst: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<LinkMethod> {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (fs.existsSync(dst)) {
    const a = fs.statSync(src), b = fs.statSync(dst)
    if (a.ino === b.ino && a.dev === b.dev) return 'same'
    fs.rmSync(dst, { force: true })   // 크기가 안 맞는 헌 파일 (planImport 가 맞는 건 이미 걸렀다)
  }
  fs.rmSync(dst + '.part', { force: true })   // 받다 만 조각 — 이제 필요 없다
  try { fs.linkSync(src, dst); return 'hardlink' } catch { /* 다른 드라이브 · 링크 미지원 파일시스템 */ }
  try { fs.symlinkSync(src, dst, 'file'); return 'symlink' } catch { /* Windows: 개발자 모드가 아니면 권한 없음 */ }
  const part = dst + '.part'
  try {
    const out = fs.createWriteStream(part)
    let writeErr: Error | null = null
    out.on('error', (err) => { writeErr = err })   // 디스크 가득 참 등 — 이벤트로만 온다
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 8 << 20 })) {
      if (signal.aborted) throw new Error('cancelled')
      if (writeErr) throw writeErr
      if (!out.write(chunk)) await new Promise<void>((r) => { out.once('drain', () => r()); out.once('error', () => r()) })
      onBytes((chunk as Buffer).length)
    }
    if (writeErr) throw writeErr
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())))
    fs.renameSync(part, dst)
  } catch (err) {
    fs.rmSync(part, { force: true })
    throw err
  }
  return 'copy'
}
