import fs from 'fs'
import path from 'path'
import { PRODUCT } from '../../shared/product/current.generated'

// ── Designated workspace directories — user-editable config ──────────
//
// Defines the workspace-relative roots that LLM file-writes are allowed
// to target, plus per-root channel-folder whitelists. Read at startup by
// (a) the Electron-side `resolveInsideDesignated()` guard and (b) the
// OpenClaw subprocess via env vars (`TWIXY_DESIGNATED_ROOTS`,
// `TWIXY_ALLOWED_SUBDIRS`) — see patches/openclaw+*.patch.
//
// Lives at <projectRoot>/.twixy/designated-paths.json. The file is only
// created when the user edits the defaults via SettingsPanel; the in-code
// DEFAULT_CONFIG is the source of truth for fresh setups.
//
// ── KNOWN LIMITATIONS ───────────────────────────────────────────────
// The guard fires inside OpenClaw's `runBeforeToolCallHook` for tools
// that name a target path in their parameters: `write`, `edit`,
// `notebookedit`, and Twixy's bridge tools `tool_write_pdf` /
// `tool_write_xlsx` / `tool_write_pptx`. Those are the file-write
// surfaces the LLM normally reaches for.
//
// It does NOT cover paths that arrive via shell strings. An LLM that
// calls the `bash` / `exec` tool with something like
//   `echo "data" > data/exports/foo.csv`
//   `mkdir -p out && cp src dst`
//   `python -c "open('data/exports/x', 'w').write(...)"`
// will bypass the bucket check entirely — OpenClaw's existing guardrail
// classifier still flags destructive/network shell commands for user
// approval, but it does not parse path arguments out of arbitrary
// shell text. Robust shell-side enforcement would require either
// shell-command parsing (fragile across pipes, heredocs, subshells) or
// a real filesystem sandbox; both are out of scope for this guard.
//
// Practical mitigation today:
//   - Keep `TWIXY_GUARDRAIL_MODE` at "standard" or "strict" if you also
//     want shell commands to require approval (separate path from this
//     guard — see electron/guardrail/).
//   - If a workflow legitimately needs to write somewhere outside the
//     listed roots, add the root via SettingsPanel rather than routing
//     around it through `bash`.

export interface DesignatedPathsConfig {
  version: 1
  /** Workspace-relative root directories that may be written to. */
  roots: string[]
  /** Per-root sub-folder whitelist. Files at `<root>/<subdir>/<filename>`
   *  are allowed iff `<subdir>` is in the corresponding list. Roots with
   *  no entry here (or an empty array) only accept direct children. */
  allowedSubdirs: Record<string, string[]>
}

// 기본값은 제품마다 다르다 (마케팅 데이터 폴더 vs 영상 입출력 폴더) — products/<id>/profile.ts.
export const DEFAULT_CONFIG: DesignatedPathsConfig = {
  version: 1,
  roots: [...PRODUCT.designatedPaths.roots],
  allowedSubdirs: Object.fromEntries(
    Object.entries(PRODUCT.designatedPaths.allowedSubdirs).map(([root, subs]) => [root, [...subs]]),
  ),
}

const FILENAME = 'designated-paths.json'

function configPath(metaDir: string): string {
  return path.join(metaDir, FILENAME)
}

function normalizeRel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!s) return null
  // No traversal, no absolute, no tilde — these would never be designated anyway.
  if (s.startsWith('..') || s.includes('/../') || s.startsWith('~')) return null
  return s
}

function normalizeSubdirName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.includes('/') || s.includes('\\') || s === '.' || s === '..') return null
  return s
}

function normalize(raw: unknown): DesignatedPathsConfig {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const rootsRaw = Array.isArray(obj.roots) ? obj.roots : []
  const roots = Array.from(new Set(rootsRaw.map(normalizeRel).filter((s): s is string => !!s)))
  const allowedSubdirs: Record<string, string[]> = {}
  const sdRaw = (obj.allowedSubdirs && typeof obj.allowedSubdirs === 'object')
    ? obj.allowedSubdirs as Record<string, unknown>
    : {}
  for (const root of roots) {
    const arr = Array.isArray(sdRaw[root]) ? sdRaw[root] as unknown[] : []
    allowedSubdirs[root] = Array.from(new Set(
      arr.map(normalizeSubdirName).filter((s): s is string => !!s)
    ))
  }
  return { version: 1, roots, allowedSubdirs }
}

export function loadDesignatedPathsConfig(metaDir: string): DesignatedPathsConfig {
  try {
    const raw = fs.readFileSync(configPath(metaDir), 'utf8')
    const parsed = JSON.parse(raw)
    const cfg = normalize(parsed)
    // Empty roots almost certainly means a corrupted / hand-edited file — fall
    // back to defaults rather than silently disabling all file writes.
    if (cfg.roots.length === 0) return structuredClone(DEFAULT_CONFIG)
    return cfg
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveDesignatedPathsConfig(
  metaDir: string,
  cfg: DesignatedPathsConfig,
): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(metaDir, { recursive: true })
    const next = normalize(cfg)
    fs.writeFileSync(configPath(metaDir), JSON.stringify(next, null, 2), 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** Env vars consumed by the OpenClaw subprocess (see patches/openclaw+*.patch). */
export function serializeForEnv(cfg: DesignatedPathsConfig): Record<string, string> {
  return {
    TWIXY_DESIGNATED_ROOTS:   JSON.stringify(cfg.roots),
    TWIXY_ALLOWED_SUBDIRS:    JSON.stringify(cfg.allowedSubdirs),
  }
}

export function configsEqual(a: DesignatedPathsConfig, b: DesignatedPathsConfig): boolean {
  if (a.roots.length !== b.roots.length) return false
  for (let i = 0; i < a.roots.length; i++) if (a.roots[i] !== b.roots[i]) return false
  const ak = Object.keys(a.allowedSubdirs).sort()
  const bk = Object.keys(b.allowedSubdirs).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    const av = a.allowedSubdirs[ak[i]] ?? []
    const bv = b.allowedSubdirs[bk[i]] ?? []
    if (av.length !== bv.length) return false
    for (let j = 0; j < av.length; j++) if (av[j] !== bv[j]) return false
  }
  return true
}
