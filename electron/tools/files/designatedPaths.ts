import path from 'node:path'
import { resolveInsideWorkspace } from './safePath'
import { DEFAULT_CONFIG, type DesignatedPathsConfig } from '../../designated-paths/config'

// ── Designated-directory write guard ──────────────────────────────
//
// LLM-controlled file writes (PDF / XLSX / PPTX via the Twixy bridge IPC)
// must land inside one of the configured buckets. `resolveInsideWorkspace()`
// only enforces "stay under <workspace>/" — any subpath is allowed.
//
// The bucket list is user-editable via SettingsPanel; the source of truth
// lives at <projectRoot>/.twixy/designated-paths.json. To avoid coupling
// every tool-handler to electron/ipc, callers provide a `getConfig` thunk
// that returns the current cache snapshot. In tests we fall back to
// DEFAULT_CONFIG so the function stays pure.
//
// The OpenClaw subprocess gets its own copy of the config via env vars
// (`TWIXY_DESIGNATED_ROOTS`, `TWIXY_ALLOWED_SUBDIRS`) — see
// `patches/openclaw+*.patch`. Both sides must agree on the policy, hence
// the shared `DesignatedPathsConfig` type.

// Lazy resolver. main.ts installs the real cache thunk during startup;
// before that (or in tests), DEFAULT_CONFIG is used as a safe fallback.
let configResolver: () => DesignatedPathsConfig = () => DEFAULT_CONFIG

/** Wire the runtime config resolver (called once during Electron startup). */
export function setDesignatedPathsConfigResolver(fn: () => DesignatedPathsConfig): void {
  configResolver = fn
}

function getConfig(): DesignatedPathsConfig {
  try { return configResolver() }
  catch { return DEFAULT_CONFIG }
}

/**
 * Resolve `relPath` against the workspace and additionally enforce that
 * it lands inside one of the designated buckets at the documented depth.
 *
 * Returns the resolved absolute path on success, or `null` on rejection.
 */
export function resolveInsideDesignated(workspace: string, relPath: string): string | null {
  const safe = resolveInsideWorkspace(workspace, relPath)
  if (!safe) return null

  const rel = path.relative(workspace, safe).split(path.sep).join('/')
  if (!rel || rel.startsWith('..')) return null

  const cfg = getConfig()
  const segments = rel.split('/')
  for (const root of cfg.roots) {
    const rootSegs = root.split('/')
    if (segments.length <= rootSegs.length) continue
    if (rootSegs.some((s, i) => segments[i] !== s)) continue

    const tail = segments.slice(rootSegs.length)
    if (tail.length === 1) return safe
    if (tail.length === 2) {
      const subdir = tail[0]
      const whitelist = cfg.allowedSubdirs[root] ?? []
      if (whitelist.includes(subdir)) return safe
      return null
    }
    return null
  }
  return null
}

/** Human-readable error for LLM retries. Lists the current allowed roots
 *  so the model can self-correct on its next tool call. */
export function designatedError(): string {
  const roots = getConfig().roots
  return 'path not in a designated directory; allowed roots: ' + roots.join(', ')
}
