import path from 'node:path'
import { isInside } from '../../trustBoundary'

/**
 * Resolve `relPath` against the user's workspace and refuse anything that
 * escapes (absolute paths, `../` traversal, symlink/junction tricks). Mirrors
 * the guard used by the legacy `write-file` IPC handler.
 *
 * Returns the resolved absolute path on success, or `null` if the path
 * would escape the workspace.
 */
export function resolveInsideWorkspace(workspace: string, relPath: string): string | null {
  if (!relPath || typeof relPath !== 'string') return null
  if (path.isAbsolute(relPath) || relPath.startsWith('~')) return null
  const safe = path.resolve(workspace, relPath)
  // 워크스페이스 루트 자체('.')는 예전부터 통과였다 — 호출부가 파일 여부를 따로 본다.
  if (!isInside(workspace, safe, { allowRoot: true })) return null
  return safe
}
