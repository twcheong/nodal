// ── Merge Request · Admin 통계 IPC (main.ts 에서 이동) ──────────────────────
//
// 프로젝트 안의 `.twixy/mr/` 를 다루는 IPC 12개. 팀 협업(Phase 2, 로컬 전용)에서
// 변경을 MR 로 제안·리뷰·병합하는 경로 전부와, 그 위에 얹힌 admin 통계 2개.
//
// **가변 상태를 갖지 않는다.** 단일 출처는 디스크의 `.twixy/mr/` 이고, 액터 신원은
// main.ts 의 `currentActor` 를 주입받는다 (세션과 프로젝트 설정 양쪽을 읽는 다리라
// 어느 모듈에도 넣을 수 없다 — 슬라이스 8a 참조).
import { app, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as MR from './mr'
import type { MRActor, MergeRequest, MRStatus, MRChangeInput } from './mr'
import { getWorkspace, getSharedDir, getTwixyMetaDir, getProjectRoot, loadProjectConfig, saveProjectConfig, loadCollabMode } from './paths'
import { isInside } from './trustBoundary'
import { regenerateSkillsIndex } from './skills'

export interface MrIpcDeps {
  getMainWindow: () => BrowserWindow | null
  currentActor: () => MRActor
  safeCopyFile: (src: string, dst: string) => { ok: boolean; downgraded: boolean; err?: unknown }
  looksBinary: (buf: Buffer) => boolean
  decodeTextFile: (buf: Buffer) => string
}

/** MR·admin 통계 IPC 12개를 등록한다. import 시점 부작용 없음. */
export function registerMrIpc(deps: MrIpcDeps): void {
  const { getMainWindow, currentActor, safeCopyFile, looksBinary, decodeTextFile } = deps

  // ── Admin panel: storage + MR stats for the current project ──────
  // Walks user/, shared/, .twixy/ recursively with a file-count ceiling so
  // very large projects (100GB+) don't hang the UI. Sizes are in bytes;
  // callers format them for display. All paths returned are absolute so
  // the "Reveal in Finder" buttons can open them directly.
  ipcMain.handle('admin-stats', () => {
    const root      = getProjectRoot()
    const userDir   = getWorkspace()
    const sharedDir = getSharedDir()
    const metaDir   = getTwixyMetaDir()
    const mrDir     = path.join(metaDir, 'mr')

    const CAP = 200_000
    function walk(p: string): { size: number; files: number; capped: boolean } {
      if (!fs.existsSync(p)) return { size: 0, files: 0, capped: false }
      let size = 0, files = 0, capped = false
      const stack = [p]
      while (stack.length) {
        if (files >= CAP) { capped = true; break }
        const cur = stack.pop()!
        let ents: fs.Dirent[]
        try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
        for (const e of ents) {
          const full = path.join(cur, e.name)
          if (e.isDirectory()) { stack.push(full); continue }
          try { size += fs.statSync(full).size; files++ } catch { /* skipped */ }
        }
      }
      return { size, files, capped }
    }

    let mrOpen = 0, mrMerged = 0, mrOther = 0
    try {
      for (const m of MR.listMRs(metaDir)) {
        if (m.status === 'merged')          mrMerged++
        else if (m.status === 'rejected')   mrOther++
        else                                mrOpen++
      }
    } catch { /* .twixy/mr/ missing is fine */ }

    let blobCount = 0, blobSize = 0
    if (fs.existsSync(mrDir)) {
      try {
        for (const mrid of fs.readdirSync(mrDir)) {
          const blobsDir = path.join(mrDir, mrid, 'blobs')
          if (!fs.existsSync(blobsDir)) continue
          for (const b of fs.readdirSync(blobsDir)) {
            blobCount++
            try { blobSize += fs.statSync(path.join(blobsDir, b)).size } catch {}
          }
        }
      } catch { /* ignore */ }
    }

    return {
      paths: { projectRoot: root, user: userDir, shared: sharedDir, meta: metaDir },
      storage: {
        user:   walk(userDir),
        shared: walk(sharedDir),
        meta:   walk(metaDir),
        blobs:  { count: blobCount, size: blobSize },
      },
      mrs:   { open: mrOpen, merged: mrMerged, other: mrOther },
      actor: currentActor(),
    }
  })

  // Relaxed reveal — lets the admin panel open shared/ and .twixy/
  // (normal reveal-in-finder only allows paths inside user/).
  ipcMain.handle('admin-reveal', (_e, absPath: string): boolean => {
    try {
      const resolved = path.resolve(absPath)
      if (!isInside(getProjectRoot(), resolved, { allowRoot: true })) return false
      if (!fs.existsSync(resolved)) return false
      shell.showItemInFolder(resolved)
      return true
    } catch { return false }
  })

  // ── Merge Request (Phase 2: local-only) ───────────────────────────
  // All handlers operate on `.twixy/mr/` inside the current project. Paths in
  // payloads are project-relative and must start with `shared/` (enforced by
  // the mr.ts module). Identity is resolved via currentActor().
  ipcMain.handle('mr-current-actor', () => currentActor())

  ipcMain.handle('mr-list', (_e, payload?: { status?: MRStatus }): MergeRequest[] => {
    try {
      return MR.listMRs(getTwixyMetaDir(), payload)
    } catch (err) {
      console.warn('[mr] list failed:', err)
      return []
    }
  })

  ipcMain.handle('mr-get', (_e, id: string): MergeRequest | null => {
    return MR.readMR(getTwixyMetaDir(), id)
  })

  ipcMain.handle('mr-create', (_e, payload: {
    title:             string
    description?:      string
    reviewers?:        { uid: string; email?: string }[]
    requiredApprovals?: number
    changes:           MRChangeInput[]
  }): { ok: boolean; mr?: MergeRequest; error?: string } => {
    try {
      const cfg = loadProjectConfig()
      if (!cfg) return { ok: false, error: 'project_config_missing' }
      const mr = MR.createMR(getProjectRoot(), getTwixyMetaDir(), cfg.projectId, {
        title:             payload.title,
        description:       payload.description,
        author:            currentActor(),
        reviewers:         payload.reviewers         ?? cfg.reviewers,
        requiredApprovals: payload.requiredApprovals ?? cfg.requiredApprovals ?? 1,
        changes:           payload.changes,
      })
      getMainWindow()?.webContents.send('mr-changed', { id: mr.id, kind: 'created' })
      return { ok: true, mr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('mr-review', (_e, payload: {
    id: string; decision: 'approve' | 'reject'; comment?: string
  }): { ok: boolean; mr?: MergeRequest; error?: string } => {
    try {
      const mr = MR.reviewMR(
        getTwixyMetaDir(), payload.id, currentActor(), payload.decision, payload.comment,
      )
      getMainWindow()?.webContents.send('mr-changed', { id: mr.id, kind: 'reviewed' })
      return { ok: true, mr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('mr-comment', (_e, payload: { id: string; body: string }
  ): { ok: boolean; mr?: MergeRequest; error?: string } => {
    try {
      const mr = MR.addComment(getTwixyMetaDir(), payload.id, currentActor(), payload.body)
      getMainWindow()?.webContents.send('mr-changed', { id: mr.id, kind: 'commented' })
      return { ok: true, mr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('mr-cancel', (_e, id: string
  ): { ok: boolean; mr?: MergeRequest; error?: string } => {
    try {
      const mr = MR.cancelMR(getTwixyMetaDir(), id)
      getMainWindow()?.webContents.send('mr-changed', { id: mr.id, kind: 'cancelled' })
      return { ok: true, mr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('mr-merge', (_e, id: string
  ): { ok: boolean; mr?: MergeRequest; error?: string } => {
    try {
      const mr = MR.readMR(getTwixyMetaDir(), id)
      if (!mr) return { ok: false, error: 'MR not found' }

      // Solo-mode self-merge: author == owner. For shared-folder and (later)
      // server modes we require normal approval, unless the merger is the owner.
      const cfg          = loadProjectConfig()
      const actor        = currentActor()
      const isOwner      = !!cfg?.ownerUid && cfg.ownerUid === actor.uid
      const isSoloOwner  = !cfg?.ownerUid && loadCollabMode() === 'solo'
      const allowSelfMerge = isOwner || isSoloOwner

      const merged = MR.mergeMR(
        getProjectRoot(), getTwixyMetaDir(), getSharedDir(), getWorkspace(), id,
        (src, dst) => { safeCopyFile(src, dst) },
        { allowSelfMerge, actor },
      )
      // After a successful merge, any shared/skills/<name>/ path means that skill
      // is now team-shared — remove the .twixy-custom marker in user/skills/<name>/
      // so it stops showing the "CUSTOM" badge in the Skills panel.
      const promotedSkills = new Set<string>()
      for (const c of merged.changes) {
        const m = /^shared\/skills\/([^/]+)\//.exec(c.path)
        if (m) promotedSkills.add(m[1])
      }
      for (const name of promotedSkills) {
        const marker = path.join(getWorkspace(), 'skills', name, '.twixy-custom')
        try { fs.unlinkSync(marker) } catch { /* already gone or never existed */ }
      }
      // Regenerate the skills index in case a shared skill changed.
      if (merged.changes.some(c => c.path.startsWith('shared/skills/'))) {
        regenerateSkillsIndex()
        getMainWindow()?.webContents.send('skills-changed')
      }
      getMainWindow()?.webContents.send('mr-changed', { id: merged.id, kind: 'merged' })
      return { ok: true, mr: merged }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Map a file path to an inline-displayable MIME type. Returns null for formats
  // we can't preview (so the UI falls back to "binary (N B)").
  function imageMimeFor(p: string | undefined): string | null {
    if (!p) return null
    const e = p.toLowerCase().split('.').pop() ?? ''
    if (e === 'png')  return 'image/png'
    if (e === 'jpg' || e === 'jpeg') return 'image/jpeg'
    if (e === 'gif')  return 'image/gif'
    if (e === 'webp') return 'image/webp'
    if (e === 'svg')  return 'image/svg+xml'
    if (e === 'avif') return 'image/avif'
    return null
  }

  // Returns blob content for UI diff viewers. Text files come back as a utf8
  // string; binary image files also return a base64 data URL for inline preview.
  ipcMain.handle('mr-read-blob', (_e, payload: { id: string; sha: string; path?: string }
  ): { ok: boolean; text?: string; binary?: boolean; size?: number; dataUrl?: string; error?: string } => {
    const buf = MR.readBlob(getTwixyMetaDir(), payload.id, payload.sha)
    if (!buf) return { ok: false, error: 'blob not found' }
    if (looksBinary(buf)) {
      const mime    = imageMimeFor(payload.path)
      const dataUrl = mime ? `data:${mime};base64,${buf.toString('base64')}` : undefined
      return { ok: true, binary: true, size: buf.length, dataUrl }
    }
    return { ok: true, text: decodeTextFile(buf), size: buf.length }
  })

  // Returns the current content of a file at a given project-relative path
  // (expected to be `shared/...`). Same shape as mr-read-blob.
  ipcMain.handle('mr-read-shared', (_e, relPath: string
  ): { ok: boolean; text?: string; binary?: boolean; size?: number; dataUrl?: string; error?: string } => {
    const buf = MR.readSharedFile(getProjectRoot(), relPath)
    if (!buf) return { ok: false, error: 'file not found' }
    if (looksBinary(buf)) {
      const mime    = imageMimeFor(relPath)
      const dataUrl = mime ? `data:${mime};base64,${buf.toString('base64')}` : undefined
      return { ok: true, binary: true, size: buf.length, dataUrl }
    }
    return { ok: true, text: decodeTextFile(buf), size: buf.length }
  })

}
