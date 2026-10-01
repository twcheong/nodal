// Build-time helper: fetch LibreOffice and slim it down for bundling.
//
// Why this exists:
//   The original-design PPTX path (electron/tools/files/pptxRender.ts) needs a
//   real renderer. Detecting a user-installed LibreOffice covers developers,
//   but shipping users should not have to install a second program to see
//   their own deck — so the installer carries one.
//
//   The binary cannot live in git (~1GB unpacked), so it is fetched at build
//   time exactly the way prepare-openclaw-bundle.mjs produces its tree, and
//   electron-builder's extraResources copies the result into the app.
//
// Slimming:
//   A full LibreOffice is ~1.1GB because it is six applications plus help,
//   templates, clip-art galleries and ~100 UI locales. We use exactly one code
//   path — Impress opening a .pptx and writing a PDF — so the rest is dropped.
//   Every removal is listed in PRUNE with the reason; nothing is guessed at.
//
// Idempotent: the download is cached in tmp/, the output tree is rebuilt.
//
// Usage:
//   node scripts/prepare-libreoffice.mjs                 # this platform
//   node scripts/prepare-libreoffice.mjs --arch=x64      # cross-arch on macOS
//   node scripts/prepare-libreoffice.mjs --skip-if-present

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(__dirname, '..')
const tmp = path.join(repo, 'tmp')
const outDir = path.join(tmp, 'libreoffice-bundle')

// Pin the version: a build must be reproducible, and a silent major bump is
// how a working PDF export turns into a broken one between two releases.
const VERSION = '26.8.0'
const BASE = `https://download.documentfoundation.org/libreoffice/stable/${VERSION}`

// A CJK face, shipped alongside.
//
// LibreOffice's own bundled fonts (Liberation, Libertine, DejaVu) carry no
// Korean glyphs, and headless it does not reach the OS font book — measured:
// converting a Korean deck embedded only LinuxLibertine/FrankRuhl and every
// Korean run came out BLANK. The unpruned upstream app behaves identically, so
// this is LibreOffice's headless font resolution, not our slimming. Dropping a
// Korean face into its own fonts dir fixes it (verified by test-loading
// AppleGothic, which then appeared in the PDF).
//
// Noto Sans KR under the SIL Open Font License — redistributable, unlike the
// system faces. Variable weight axis in one ~9MB file.
const FONT_URL = 'https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf'
const FONT_FILE = 'NotoSansKR-variable.ttf'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const platform = argOf('platform', process.platform)
const arch = argOf('arch', process.arch)

/**
 * Paths that go, and why. Keeping this as data rather than a pile of rm calls
 * means the next person can see what was removed without re-deriving it.
 */
//
// NOT on this list, deliberately:
//   presets/  — looks disposable because we pass our own -env:UserInstallation,
//     but the profile is CREATED FROM presets. Removing it makes every run die
//     with "User installation could not be completed" (measured, and the reason
//     this comment exists rather than a second person rediscovering it).
//   fonts/    — the deck's own fonts are rarely installed on the machine; these
//     are what stop every substitution from falling back to a default face.
//   Frameworks/ — the actual code.
const PRUNE = [
  ['help', 'the entire help system'],
  ['readmes', 'per-locale readme files'],
  ['gallery', 'clip-art galleries — never opened by a headless convert'],
  ['template', 'document templates — we open the user\'s file, not a template'],
  ['autocorr', 'autocorrect tables — nothing is typed'],
  ['wordbook', 'user dictionaries'],
  ['wizards', 'Basic wizards — UI only'],
  ['java', 'Java integration — the PDF export path does not use it'],
  ['extensions', 'bundled dictionaries and the nlpsolver — spelling never runs'],
  ['xpdfimport', 'PDF *import* helper — we only ever export'],
]

const log = (...m) => console.log('[libreoffice]', ...m)
const sizeOf = (p) => {
  try { return Number(execFileSync('du', ['-sk', p]).toString().trim().split(/\s+/)[0]) * 1024 } catch { return 0 }
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)}MB`

function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 50_000_000) {
    log(`cached: ${path.basename(dest)} (${mb(fs.statSync(dest).size)})`)
    return
  }
  log(`downloading ${url}`)
  // curl over a Node fetch: it resumes, shows progress on a TTY, and follows
  // the mirror redirects the Document Foundation hands out.
  execFileSync('curl', ['-fL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' })
}

/** macOS: mount the dmg, copy LibreOffice.app out, unmount even on failure. */
function extractMac(dmg, into) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-mnt-'))
  execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-quiet', '-mountpoint', mountPoint])
  try {
    const app = path.join(mountPoint, 'LibreOffice.app')
    if (!fs.existsSync(app)) throw new Error(`LibreOffice.app not found in ${dmg}`)
    fs.mkdirSync(into, { recursive: true })
    // ditto preserves the resource forks and symlinks a Mac app bundle needs;
    // cp -R mangles some of them and the copy will not launch.
    execFileSync('ditto', [app, path.join(into, 'LibreOffice.app')])
  } finally {
    try { execFileSync('hdiutil', ['detach', mountPoint, '-quiet']) } catch { /* already gone */ }
    try { fs.rmSync(mountPoint, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Windows: administrative install unpacks the MSI without touching the registry. */
function extractWin(msi, into) {
  if (process.platform !== 'win32') {
    throw new Error(
      'A Windows LibreOffice bundle must be prepared on Windows — msiexec is required to unpack the MSI.\n' +
      'Run `node scripts/prepare-libreoffice.mjs` on the Windows build machine before `npm run dist:win`.',
    )
  }
  fs.mkdirSync(into, { recursive: true })
  execFileSync('msiexec', ['/a', msi, '/qn', `TARGETDIR=${into}`], { stdio: 'inherit' })
}

/** Drop everything the convert path does not read. */
function prune(root) {
  const before = sizeOf(root)
  for (const [rel, why] of PRUNE) {
    const p = path.join(root, rel)
    if (!fs.existsSync(p)) continue
    const freed = sizeOf(p)
    fs.rmSync(p, { recursive: true, force: true })
    log(`  − ${rel.padEnd(22)} ${mb(freed).padStart(6)}  (${why})`)
  }
  // Icon themes: ~40MB of SVG/PNG toolbar art for a UI that never renders.
  // soffice.cfg (the menu/toolbar definitions) stays — startup reads it.
  const config = path.join(root, 'config')
  if (fs.existsSync(config)) {
    let freed = 0
    for (const f of fs.readdirSync(config)) {
      if (!/^images_.*\.zip$/.test(f)) continue
      const p = path.join(config, f)
      freed += sizeOf(p)
      fs.rmSync(p, { force: true })
    }
    if (freed) log(`  − config/images_*.zip     ${mb(freed).padStart(6)}  (icon themes — no UI is drawn)`)
  }
  const after = sizeOf(root)
  log(`slimmed ${mb(before)} → ${mb(after)}`)
  return after
}

/** Put the CJK face where LibreOffice looks for its own fonts. */
function addCjkFont(fontsDir) {
  const cache = path.join(tmp, FONT_FILE)
  if (!fs.existsSync(cache) || fs.statSync(cache).size < 1_000_000) {
    log('downloading Noto Sans KR (OFL)')
    execFileSync('curl', ['-fL', '--retry', '3', '-o', cache, FONT_URL], { stdio: 'inherit' })
  }
  fs.mkdirSync(fontsDir, { recursive: true })
  fs.copyFileSync(cache, path.join(fontsDir, FONT_FILE))
  log(`  + ${FONT_FILE.padEnd(22)} ${mb(fs.statSync(cache).size).padStart(6)}  (Korean glyphs — LibreOffice ships none)`)
}

function main() {
  if (args.includes('--skip-if-present') && fs.existsSync(outDir)) {
    log(`already present at ${path.relative(repo, outDir)} — skipping`)
    return
  }
  fs.mkdirSync(tmp, { recursive: true })
  fs.rmSync(outDir, { recursive: true, force: true })

  if (platform === 'darwin') {
    const slug = arch === 'arm64' ? 'aarch64' : 'x86-64'
    const dir = arch === 'arm64' ? 'aarch64' : 'x86_64'
    const name = `LibreOffice_${VERSION}_MacOS_${slug}.dmg`
    const dmg = path.join(tmp, name)
    download(`${BASE}/mac/${dir}/${name}`, dmg)
    log('extracting…')
    extractMac(dmg, outDir)
    const root = path.join(outDir, 'LibreOffice.app', 'Contents', 'Resources')
    prune(root)
    addCjkFont(path.join(root, 'fonts', 'truetype'))
    const soffice = path.join(outDir, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')
    if (!fs.existsSync(soffice)) throw new Error('soffice missing after extract')
    log(`ready: ${path.relative(repo, soffice)} (${mb(sizeOf(outDir))})`)
  } else if (platform === 'win32') {
    const name = `LibreOffice_${VERSION}_Win_x86-64.msi`
    const msi = path.join(tmp, name)
    download(`${BASE}/win/x86_64/${name}`, msi)
    log('extracting…')
    extractWin(msi, outDir)
    // The administrative install nests the payload under a program dir.
    const found = fs.existsSync(path.join(outDir, 'program', 'soffice.exe'))
      ? outDir
      : fs.readdirSync(outDir).map((d) => path.join(outDir, d)).find((d) => fs.existsSync(path.join(d, 'program', 'soffice.exe')))
    if (!found) throw new Error('soffice.exe missing after extract')
    if (found !== outDir) {
      for (const entry of fs.readdirSync(found)) fs.renameSync(path.join(found, entry), path.join(outDir, entry))
      fs.rmSync(found, { recursive: true, force: true })
    }
    prune(path.join(outDir, 'share'))
    addCjkFont(path.join(outDir, 'share', 'fonts', 'truetype'))
    log(`ready: ${path.relative(repo, path.join(outDir, 'program', 'soffice.exe'))} (${mb(sizeOf(outDir))})`)
  } else {
    throw new Error(`no LibreOffice bundle recipe for ${platform} — the app falls back to a user-installed one`)
  }
}

main()
