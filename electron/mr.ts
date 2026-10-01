// Merge Request — Phase 2 local-only implementation.
//
// Disk layout (inside the project root):
//   .twixy/mr/<mr_id>/meta.json        # the full MR record
//   .twixy/mr/<mr_id>/blobs/<sha>      # new content for add/modify ops (Buffer)
//
// Blobs are content-addressed (sha256 of the raw bytes) so the same content
// uploaded by two MRs dedupes within a single MR and is trivial to verify.
//
// All paths inside `changes[].path` are stored RELATIVE TO THE PROJECT ROOT and
// must start with `shared/`. Writes to user/ go straight to disk and never
// become MRs; only the shared surface is governed by review.
//
// Phase 2 is local-only (solo / shared-folder via Dropbox). The server sync
// layer (Phase 3) will reuse this data model byte-for-byte and just forward
// meta.json + blobs over HTTP.

import * as fs     from 'node:fs'
import * as path   from 'node:path'
import * as crypto from 'node:crypto'
import { safeSegment } from './trustBoundary'

// ── Types ──────────────────────────────────────────────────────────────────
export type MRStatus =
  | 'open'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'rejected'

export type MRChange =
  | { op: 'add';    path: string; blobSha: string }
  | { op: 'modify'; path: string; blobSha: string; prevSha: string }
  | { op: 'delete'; path: string;                  prevSha: string }

export type MRActor = { uid: string; email?: string }

export type MRReviewer = {
  uid:      string
  email?:   string
  decision: 'approve' | 'reject' | null
  at:       string | null
  comment?: string
}

export type MRComment = {
  id:     string
  author: MRActor
  body:   string
  at:     string
}

export type MergeRequest = {
  id:                string
  projectId:         string
  title:             string
  description?:      string
  author:            MRActor
  baseSnapshot:      string       // empty in Phase 2 (snapshots are Phase 3)
  status:            MRStatus
  changes:           MRChange[]
  reviewers:         MRReviewer[]
  requiredApprovals: number
  comments:          MRComment[]
  createdAt:         string
  updatedAt:         string
  mergedAt?:         string
}

// Input to `createMR`: the caller hasn't computed blob shas yet, so content is
// delivered raw. Accepts Buffer, Uint8Array, ArrayBuffer, or utf8 string so the
// IPC layer can forward binary files from the renderer without a round-trip
// through base64.
export type MRContentInput = Buffer | Uint8Array | ArrayBuffer | string
export type MRChangeInput =
  | { op: 'add';    path: string; content: MRContentInput }
  | { op: 'modify'; path: string; content: MRContentInput }
  | { op: 'delete'; path: string }

export type CreateMRInput = {
  title:             string
  description?:      string
  author:            MRActor
  reviewers?:        { uid: string; email?: string }[]
  requiredApprovals?: number
  changes:           MRChangeInput[]
}

// ── Low-level helpers ──────────────────────────────────────────────────────
function mrDir(metaDir: string, id: string): string {
  return path.join(metaDir, 'mr', safeSegment(id))
}
function metaPath(metaDir: string, id: string): string {
  return path.join(mrDir(metaDir, id), 'meta.json')
}
function blobPath(metaDir: string, id: string, sha: string): string {
  return path.join(mrDir(metaDir, id), 'blobs', safeSegment(sha))
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function generateId(prefix: string): string {
  const bytes = crypto.randomBytes(12).toString('hex')
  return `${prefix}_${Date.now().toString(36)}${bytes}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function toBuffer(content: MRContentInput): Buffer {
  if (Buffer.isBuffer(content))       return content
  if (content instanceof Uint8Array)  return Buffer.from(content)
  if (content instanceof ArrayBuffer) return Buffer.from(new Uint8Array(content))
  return Buffer.from(content, 'utf8')
}

// Validate that a change path is relative, contained in shared/, and doesn't
// escape via ..  — we never want MRs to rewrite .twixy/ or user/.
function assertSharedPath(relPath: string): void {
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'))
  if (norm.startsWith('/') || norm.includes('..') || norm === '' || norm === '.') {
    throw new Error(`invalid path: ${relPath}`)
  }
  if (!norm.startsWith('shared/')) {
    throw new Error(`MR paths must be under shared/: ${relPath}`)
  }
}

// ── Meta I/O ───────────────────────────────────────────────────────────────
export function readMR(metaDir: string, id: string): MergeRequest | null {
  try {
    const raw = fs.readFileSync(metaPath(metaDir, id), 'utf8')
    const mr  = JSON.parse(raw) as MergeRequest
    return mr
  } catch {
    return null
  }
}

function writeMR(metaDir: string, mr: MergeRequest): void {
  fs.mkdirSync(mrDir(metaDir, mr.id), { recursive: true })
  fs.writeFileSync(metaPath(metaDir, mr.id), JSON.stringify(mr, null, 2), 'utf8')
}

export function listMRs(metaDir: string, opts?: { status?: MRStatus }): MergeRequest[] {
  const root = path.join(metaDir, 'mr')
  let entries: string[] = []
  try { entries = fs.readdirSync(root) } catch { return [] }
  const out: MergeRequest[] = []
  for (const id of entries) {
    const mr = readMR(metaDir, id)
    if (!mr) continue
    if (opts?.status && mr.status !== opts.status) continue
    out.push(mr)
  }
  // Newest first — useful for UI lists.
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

export function readBlob(metaDir: string, id: string, sha: string): Buffer | null {
  try { return fs.readFileSync(blobPath(metaDir, id, sha)) } catch { return null }
}

// ── Create ─────────────────────────────────────────────────────────────────
// `projectRoot` is needed so we can compute prevSha for modify/delete ops by
// hashing whatever currently lives at shared/<path>.
export function createMR(
  projectRoot: string,
  metaDir:     string,
  projectId:   string,
  input:       CreateMRInput,
): MergeRequest {
  if (!input.title.trim()) throw new Error('title required')
  if (!input.changes.length) throw new Error('at least one change required')

  const id = generateId('mr')
  // Pre-create the blob dir so stores below don't race on mkdir.
  fs.mkdirSync(path.join(mrDir(metaDir, id), 'blobs'), { recursive: true })

  const changes: MRChange[] = []
  for (const c of input.changes) {
    assertSharedPath(c.path)
    const absolute = path.join(projectRoot, c.path)

    if (c.op === 'add') {
      if (fs.existsSync(absolute)) {
        throw new Error(`add conflict: ${c.path} already exists in shared/`)
      }
      const buf = toBuffer(c.content)
      const sha = sha256(buf)
      fs.writeFileSync(blobPath(metaDir, id, sha), buf)
      changes.push({ op: 'add', path: c.path, blobSha: sha })
    } else if (c.op === 'modify') {
      if (!fs.existsSync(absolute)) {
        throw new Error(`modify target missing: ${c.path}`)
      }
      const prevBuf = fs.readFileSync(absolute)
      const prevSha = sha256(prevBuf)
      const newBuf  = toBuffer(c.content)
      const blobSha = sha256(newBuf)
      // No-op detection: skip modify-with-identical-content changes.
      if (blobSha === prevSha) continue
      fs.writeFileSync(blobPath(metaDir, id, blobSha), newBuf)
      changes.push({ op: 'modify', path: c.path, blobSha, prevSha })
    } else {
      if (!fs.existsSync(absolute)) {
        throw new Error(`delete target missing: ${c.path}`)
      }
      const prevBuf = fs.readFileSync(absolute)
      const prevSha = sha256(prevBuf)
      changes.push({ op: 'delete', path: c.path, prevSha })
    }
  }

  if (!changes.length) {
    // We wrote blob dir but no meaningful changes — clean up and error.
    fs.rmSync(mrDir(metaDir, id), { recursive: true, force: true })
    throw new Error('no effective changes (all modifications were no-ops)')
  }

  const now = nowIso()
  const mr: MergeRequest = {
    id,
    projectId,
    title:             input.title.trim(),
    description:       input.description?.trim() || undefined,
    author:            input.author,
    baseSnapshot:      '',
    status:            'open',
    changes,
    reviewers: (input.reviewers ?? []).map(r => ({
      uid: r.uid, email: r.email, decision: null, at: null,
    })),
    requiredApprovals: input.requiredApprovals ?? 1,
    comments:          [],
    createdAt:         now,
    updatedAt:         now,
  }
  writeMR(metaDir, mr)
  return mr
}

// ── Review ─────────────────────────────────────────────────────────────────
export function reviewMR(
  metaDir: string,
  id:      string,
  reviewer: MRActor,
  decision: 'approve' | 'reject',
  comment?: string,
): MergeRequest {
  const mr = readMR(metaDir, id)
  if (!mr) throw new Error(`MR not found: ${id}`)
  if (mr.status === 'merged' || mr.status === 'rejected') {
    throw new Error(`MR is ${mr.status}, cannot review`)
  }

  // Upsert reviewer decision. Owner self-review is allowed.
  let found = false
  for (const r of mr.reviewers) {
    if (r.uid === reviewer.uid) {
      r.decision = decision
      r.at       = nowIso()
      if (comment !== undefined) r.comment = comment
      found = true
      break
    }
  }
  if (!found) {
    mr.reviewers.push({
      uid: reviewer.uid, email: reviewer.email,
      decision, at: nowIso(), comment,
    })
  }

  if (decision === 'reject') {
    mr.status = 'changes_requested'
  } else {
    const approvals = mr.reviewers.filter(r => r.decision === 'approve').length
    mr.status = approvals >= mr.requiredApprovals ? 'approved' : 'open'
  }
  mr.updatedAt = nowIso()
  writeMR(metaDir, mr)
  return mr
}

// ── Comment ────────────────────────────────────────────────────────────────
export function addComment(
  metaDir: string,
  id:      string,
  author:  MRActor,
  body:    string,
): MergeRequest {
  const mr = readMR(metaDir, id)
  if (!mr) throw new Error(`MR not found: ${id}`)
  const trimmed = body.trim()
  if (!trimmed) throw new Error('comment body required')
  mr.comments.push({
    id:     generateId('c'),
    author,
    body:   trimmed,
    at:     nowIso(),
  })
  mr.updatedAt = nowIso()
  writeMR(metaDir, mr)
  return mr
}

// ── Cancel ─────────────────────────────────────────────────────────────────
export function cancelMR(metaDir: string, id: string): MergeRequest {
  const mr = readMR(metaDir, id)
  if (!mr) throw new Error(`MR not found: ${id}`)
  if (mr.status === 'merged') throw new Error('already merged')
  mr.status    = 'rejected'
  mr.updatedAt = nowIso()
  writeMR(metaDir, mr)
  return mr
}

// ── Merge ──────────────────────────────────────────────────────────────────
// Applies an approved MR's changes to shared/, then mirrors the changes into
// user/ using the caller-provided `cloneInto` (so we can reuse the COW helper
// from main.ts without creating a dependency loop).
//
// Contract on cloneInto(src, dst): create parent dirs, clone src → dst. No-op
// semantics on identical content are fine; it's mostly about making sure the
// personal workspace is up-to-date after a merge.
export function mergeMR(
  projectRoot: string,
  metaDir:     string,
  sharedDir:   string,
  userDir:     string,
  id:          string,
  cloneInto:   (src: string, dst: string) => void,
  opts?:       { allowSelfMerge?: boolean; actor?: MRActor },
): MergeRequest {
  const mr = readMR(metaDir, id)
  if (!mr) throw new Error(`MR not found: ${id}`)
  if (mr.status === 'merged')   throw new Error('already merged')
  if (mr.status === 'rejected') throw new Error('MR was rejected')
  if (mr.status !== 'approved' && !opts?.allowSelfMerge) {
    throw new Error(`MR is ${mr.status} — needs approval before merge`)
  }

  // 경로를 **병합 시점에 다시** 검증한다. createMR 이 이미 봤지만, 여기서 읽는 mr.changes 는
  // 디스크의 meta.json 에서 온 값이고 shared-folder 모드에서 그 파일은 팀원 누구나 쓸 수 있다.
  // 검증 없이 쓰면 남이 고친 `path: '../../x'` 가 병합하는 사람의 PC 에 쓰인다.
  // 하나라도 걸리면 아무것도 건드리기 전에 통째로 거부.
  for (const c of mr.changes) assertSharedPath(c.path)

  // Snapshot verification: for each modify/delete, the current content on
  // disk must still match prevSha. Otherwise someone else mutated the shared
  // surface since this MR was opened → rebase required.
  for (const c of mr.changes) {
    if (c.op === 'add') continue
    const absolute = path.join(projectRoot, c.path)
    if (!fs.existsSync(absolute)) {
      if (c.op === 'delete') continue  // already gone; treat as no-op
      throw new Error(`rebase required: ${c.path} no longer exists`)
    }
    const currentSha = sha256(fs.readFileSync(absolute))
    if (currentSha !== c.prevSha) {
      throw new Error(`rebase required: ${c.path} changed since MR was opened`)
    }
  }

  // Apply changes: shared/ is the source of truth, user/ is then re-synced.
  for (const c of mr.changes) {
    const absoluteShared = path.join(projectRoot, c.path)                // shared/foo
    const userRel        = c.path.replace(/^shared\//, '')
    const absoluteUser   = path.join(userDir, userRel)

    if (c.op === 'delete') {
      try { fs.unlinkSync(absoluteShared) } catch { /* already gone */ }
      try { fs.unlinkSync(absoluteUser)   } catch { /* user may have customized or removed */ }
      continue
    }

    const blob = readBlob(metaDir, id, c.blobSha)
    if (!blob) throw new Error(`missing blob ${c.blobSha} for ${c.path}`)
    fs.mkdirSync(path.dirname(absoluteShared), { recursive: true })
    fs.writeFileSync(absoluteShared, blob)

    fs.mkdirSync(path.dirname(absoluteUser), { recursive: true })
    try { fs.unlinkSync(absoluteUser) } catch { /* ok */ }
    cloneInto(absoluteShared, absoluteUser)
  }

  mr.status    = 'merged'
  mr.mergedAt  = nowIso()
  mr.updatedAt = mr.mergedAt
  if (opts?.actor) {
    // Record self-merge actor for audit even in solo mode.
    mr.comments.push({
      id:     generateId('c'),
      author: opts.actor,
      body:   opts.allowSelfMerge ? 'self-merged' : 'merged',
      at:     mr.mergedAt!,
    })
  }
  writeMR(metaDir, mr)
  return mr
}

// Ensures sharedDir and userDir exist — useful as a guard before mergeMR.
export function assertMergeDirsExist(sharedDir: string, userDir: string): void {
  if (!fs.existsSync(sharedDir)) throw new Error(`shared dir missing: ${sharedDir}`)
  if (!fs.existsSync(userDir))   throw new Error(`user dir missing: ${userDir}`)
}

// Helper for the "read me the current shared content" case — used by UI to
// show before/after diffs. Returns null if file is absent or binary.
export function readSharedFile(projectRoot: string, relPath: string): Buffer | null {
  try {
    assertSharedPath(relPath)
    const abs = path.join(projectRoot, relPath)
    return fs.readFileSync(abs)
  } catch {
    return null
  }
}
