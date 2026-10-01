// Build-time helper: produce a self-contained openclaw bundle that includes
// every transitive runtime dependency.
//
// Why this exists:
//   electron-builder's `extraResources` only copies what we point at; npm
//   hoists most of openclaw's deps (tslog, etc.) to the repo-root
//   node_modules/, so a naive `from: node_modules/openclaw` rule shipped an
//   *incomplete* tree to the dmg — first launch on a clean machine crashed
//   with `Cannot find package 'tslog'` because that dep was missing.
//
//   Also: openclaw runs as a child of a *plain* /usr/local/bin/node, NOT
//   inside Electron. That child Node has no asar awareness — every dep must
//   sit on the real filesystem, not inside app.asar.
//
// Strategy:
//   1. Create tmp/openclaw-bundle/ with a minimal package.json whose only
//      dep is `openclaw` pinned to the same version as the host repo.
//   2. Run `npm install --omit=dev` inside it. npm produces a complete
//      production tree, all hoisted into the bundle's own node_modules/.
//   3. electron-builder's extraResources copies that node_modules/ to
//      /Contents/Resources/node_modules/ in the packaged app.
//
// Idempotent: blows away and re-creates tmp/openclaw-bundle/ on every run.

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')
const BUNDLE    = path.join(ROOT, 'tmp', 'openclaw-bundle')
const NM        = path.join(BUNDLE, 'node_modules')

const hostPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const openclawVersion = hostPkg.dependencies?.openclaw
if (!openclawVersion) {
  console.error('[prepare-openclaw-bundle] openclaw missing from root package.json dependencies')
  process.exit(1)
}

console.log(`[prepare-openclaw-bundle] openclaw@${openclawVersion} → ${BUNDLE}`)

fs.rmSync(BUNDLE, { recursive: true, force: true })
fs.mkdirSync(BUNDLE, { recursive: true })

fs.writeFileSync(
  path.join(BUNDLE, 'package.json'),
  JSON.stringify({
    name:    'twixy-openclaw-bundle',
    version: '0.0.0',
    private: true,
    dependencies: { openclaw: openclawVersion },
  }, null, 2) + '\n',
)

console.log('[prepare-openclaw-bundle] installing production tree…')
execSync('npm install --omit=dev --no-package-lock --no-audit --no-fund', {
  cwd:    BUNDLE,
  stdio:  'inherit',
})

// Sanity check: tslog should now be present.
const tslog = path.join(NM, 'tslog')
if (!fs.existsSync(tslog)) {
  console.error('[prepare-openclaw-bundle] tslog NOT found after install — bundle is incomplete')
  process.exit(1)
}

// The npm install above produces a *vanilla* openclaw — the Twixy agent tools
// (tool_write_pptx, bridge tools, …) live in patches/openclaw+*.patch and must
// be re-applied here, or the packaged app ships an openclaw without them.
// patch-package refuses to run without a lockfile, so apply the diff directly.
console.log('[prepare-openclaw-bundle] applying patches/openclaw+*.patch…')
const patchFiles = fs.readdirSync(path.join(ROOT, 'patches')).filter(f => f.startsWith('openclaw+') && f.endsWith('.patch'))
if (patchFiles.length === 0) {
  console.error('[prepare-openclaw-bundle] no openclaw patch found in patches/ — refusing to ship a vanilla bundle')
  process.exit(1)
}
// Cross-platform patch apply. The old `patch -p1 < file` via shell:'/bin/bash'
// only works on macOS/Linux — Windows has neither /bin/bash nor a `patch`
// binary, so `npm run dist:win` crashed with `spawnSync /bin/bash ENOENT`.
// git ships on every dev machine and applies patch-package's git-format diffs.
// BUNDLE sits inside the parent repo, so a bare `git apply` would resolve the
// patch's `node_modules/openclaw/...` paths against the PARENT repo root and
// patch the wrong tree. Give BUNDLE its own throwaway git repo so paths resolve
// relative to BUNDLE, then remove it. BUNDLE is freshly installed (rm+reinstall
// above), so a clean apply is expected — fail loudly rather than ship a
// half-patched openclaw.
execSync('git init -q', { cwd: BUNDLE, stdio: 'inherit' })
try {
  for (const f of patchFiles) {
    // The patch must be LF to match openclaw's LF dist files. On Windows with
    // core.autocrlf=true the checked-out .patch is CRLF, so its context lines
    // no longer match the LF source → `git apply` reports "patch does not
    // apply". Normalize to LF in a temp copy before applying. (.gitattributes
    // also pins patches/*.patch to -text, but normalizing here makes the build
    // robust regardless of a dev's git config.)
    const lf = path.join(BUNDLE, `.apply-${f}`)
    fs.writeFileSync(lf, fs.readFileSync(path.join(ROOT, 'patches', f), 'utf8').replace(/\r\n/g, '\n'))
    execSync(`git apply -p1 --whitespace=nowarn ${JSON.stringify(lf)}`, {
      cwd:   BUNDLE,
      stdio: 'inherit',
    })
    fs.rmSync(lf, { force: true })
  }
} finally {
  fs.rmSync(path.join(BUNDLE, '.git'), { recursive: true, force: true })
}

const topLevel = fs.readdirSync(NM).filter(n => !n.startsWith('.')).length
console.log(`[prepare-openclaw-bundle] OK — ${topLevel} top-level packages at ${NM}`)
