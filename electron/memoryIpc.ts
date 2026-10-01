// ── 장기 기억(Memory) 보기·편집 IPC (main.ts 에서 이동) ────────────────────
//
// 에이전트가 세션 사이에 들고 가는 메모리 파일(workspace/memory/)을 렌더러가
// 읽고 쓰는 경로. 단일 출처는 디스크이고 이 모듈은 상태를 갖지 않는다.
import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspace } from './paths'
import { isInside } from './trustBoundary'

/** 메모리 IPC 4개를 등록한다. import 시점 부작용 없음. */
export function registerMemoryIpc(): void {

  // ── 장기 기억(Memory) 보기·편집 IPC ──────────────────────────────
  // MEMORY.md 읽기/쓰기 + memory/*.md 일일 노트 목록/읽기. 모두 현재 사용자
  // 워크스페이스(getWorkspace) 안으로 한정 — SettingsPanel 의 Memory 섹션 전용.
  ipcMain.handle('memory-read', (): { ok: boolean; content: string; error?: string } => {
    try {
      const p = path.join(getWorkspace(), 'MEMORY.md')
      const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
      return { ok: true, content }
    } catch (err) {
      return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('memory-write', (_e, payload: { content: string }): { ok: boolean; error?: string } => {
    try {
      const p = path.join(getWorkspace(), 'MEMORY.md')
      fs.writeFileSync(p, String(payload?.content ?? ''), 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('memory-list-notes', (): {
    ok: boolean; notes: { name: string; mtime: number }[]; error?: string
  } => {
    try {
      const dir = path.join(getWorkspace(), 'memory')
      if (!fs.existsSync(dir)) return { ok: true, notes: [] }
      const notes = fs.readdirSync(dir)
        .filter(n => n.toLowerCase().endsWith('.md'))
        .map(name => {
          let mtime = 0
          try { mtime = fs.statSync(path.join(dir, name)).mtimeMs } catch { /* skip */ }
          return { name, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
      return { ok: true, notes }
    } catch (err) {
      return { ok: false, notes: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('memory-read-note', (_e, payload: { name: string }): {
    ok: boolean; content: string; error?: string
  } => {
    try {
      const name = String(payload?.name ?? '')
      // 경로 traversal 방어: 슬래시/역슬래시/상위참조 금지, .md 확장자만 허용.
      if (!name || /[\\/]/.test(name) || name.includes('..') || !name.toLowerCase().endsWith('.md')) {
        return { ok: false, content: '', error: 'invalid_note_name' }
      }
      const dir = path.join(getWorkspace(), 'memory')
      const p = path.join(dir, name)
      // 정규화 후에도 memory 디렉토리 밖이면 거부 (이중 방어).
      if (!isInside(dir, p)) {
        return { ok: false, content: '', error: 'invalid_note_name' }
      }
      const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
      return { ok: true, content }
    } catch (err) {
      return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
    }
  })

}
