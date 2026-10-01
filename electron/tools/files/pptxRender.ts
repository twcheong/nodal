// True render of a foreign .pptx — the real thing, not the wireframe.
//
// pptxSketch.ts approximates a deck from its XML because we cannot draw
// PowerPoint. This module takes the other route: if the machine already has a
// renderer, use it. LibreOffice converts .pptx → PDF faithfully and runs on
// macOS, Windows and Linux, which is why Anthropic's pptx skill leans on it.
//
// The installer CARRIES one (scripts/prepare-libreoffice.mjs slims a release to
// ~560MB and electron-builder drops it in Contents/Resources/libreoffice), so a
// shipping user needs to install nothing. A LibreOffice the user installed
// themselves is used too — that covers `npm run dev`, where no bundle exists.
// If neither is present the sketch still renders, so the feature degrades
// rather than disappears.
//
// No new dependencies: LibreOffice writes a PDF, an offscreen BrowserWindow
// (the same trick pdf.ts already uses to PRINT a PDF) renders each page with
// the pdfjs-dist we already ship, and composeSheet lays them out exactly as it
// does for our own decks — so the model sees one consistent format either way.
//
// Cost, honestly: soffice cold-starts in seconds and a deck takes a few more,
// against ~0.5s for the sketch. That is why this is opt-in per call, not the
// default for every read.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import sharp from 'sharp'
import { composeSheet } from './pptxPreview'

/** Our own copy: shipped in Resources, or built into tmp/ during development. */
function bundledPath(): string {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'libreoffice')
    : path.join(app.getAppPath(), 'tmp', 'libreoffice-bundle')
  return process.platform === 'win32'
    ? path.join(root, 'program', 'soffice.exe')
    : path.join(root, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')
}

/** Where LibreOffice lives, most-preferred first, plus an escape hatch. */
function candidatePaths(): string[] {
  const env = process.env.TWIXY_SOFFICE_PATH?.trim()
  if (env) return [env]
  // Ours first: a known version we tested against, rather than whatever the
  // machine happens to have.
  const mine = bundledPath()
  if (process.platform === 'darwin') {
    return [
      mine,
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      path.join(os.homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
    ]
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [
      mine,
      path.join(pf, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(pf86, 'LibreOffice', 'program', 'soffice.exe'),
    ]
  }
  return [mine, '/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice']
}

let cached: string | null | undefined

/** The soffice binary, or null when this machine has none. Cached per run. */
export function findSoffice(): string | null {
  if (cached !== undefined) return cached
  cached = candidatePaths().find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) ?? null
  return cached
}

const run = (cmd: string, args: string[], timeoutMs: number, env?: Record<string, string>) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ...env } }, (err) => (err ? reject(err) : resolve()))
  })

/** Font directories worth scanning, per platform. Missing ones are harmless. */
function systemFontDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [
      '/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts',
      path.join(home, 'Library/Fonts'),
      // Office ships the faces modern decks default to (Aptos, Calibri…) inside
      // its own bundle, where they are not "installed" system-wide.
      '/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts',
      '/Applications/Microsoft Word.app/Contents/Resources/DFonts',
    ]
  }
  if (process.platform === 'win32') {
    const win = process.env.SystemRoot ?? 'C:\\Windows'
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [path.join(win, 'Fonts'), path.join(local, 'Microsoft', 'Windows', 'Fonts')]
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local/share/fonts')]
}

/**
 * Make LibreOffice see the machine's fonts.
 *
 * Headless on macOS it reads ONLY its own bundled faces — measured twice: a
 * Korean deck came back with every Korean run blank, and a deck set in a font
 * installed in ~/Library/Fonts still rendered in Liberation. That is why the
 * first true renders looked misaligned against PowerPoint: Aptos (this deck
 * uses it 77 times) has no metric-compatible substitute, so every line wrapped
 * differently.
 *
 * FONTCONFIG_FILE is the lever that works — <dir> entries inside the bundle's
 * own fc_local.conf are ignored, the env var is not. With it the same deck
 * embeds Aptos, Malgun Gothic and Hiragino: the fonts the deck actually asks
 * for. Our bundled dir stays first so the shipped CJK fallback still applies
 * on a machine with no Korean font at all.
 */
function writeFontConfig(workDir: string, soffice: string): string {
  const bundled = path.resolve(path.dirname(soffice), '..', 'Resources', 'fonts', 'truetype')
  const dirs = [bundled, ...systemFontDirs()].filter((d) => { try { return fs.statSync(d).isDirectory() } catch { return false } })
  // The cache is expensive to build (seconds across a few hundred faces) and
  // identical between runs, so it lives outside the per-call scratch dir.
  const cache = path.join(app.getPath('userData'), 'fontconfig-cache')
  fs.mkdirSync(cache, { recursive: true })
  const conf = path.join(workDir, 'fonts.conf')
  fs.writeFileSync(conf,
    '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n' +
    dirs.map((d) => `  <dir>${d.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</dir>`).join('\n') +
    `\n  <cachedir>${cache}</cachedir>\n</fontconfig>\n`)
  return conf
}

/**
 * .pptx → PDF via LibreOffice, into a scratch dir we own.
 *
 * `-env:UserInstallation` points at a private profile: without it a soffice
 * the USER already has open owns the single default profile and our headless
 * call exits immediately having done nothing.
 */
async function toPdf(soffice: string, srcAbs: string, workDir: string): Promise<string> {
  const profile = path.join(workDir, 'profile')
  await run(soffice, [
    `-env:UserInstallation=file://${profile.split(path.sep).join('/')}`,
    '--headless', '--norestore', '--invisible',
    '--convert-to', 'pdf:impress_pdf_Export',
    '--outdir', workDir,
    srcAbs,
  ], 120_000, { FONTCONFIG_FILE: writeFontConfig(workDir, soffice) })
  const pdf = path.join(workDir, path.basename(srcAbs).replace(/\.[^.]+$/, '') + '.pdf')
  if (!fs.existsSync(pdf)) throw new Error('LibreOffice produced no PDF')
  return pdf
}

/**
 * PDF → one PNG data URL per page, rendered by pdfjs inside an offscreen
 * window. Electron gives us a real <canvas>, so no native canvas module is
 * needed — the reason this costs zero new dependencies.
 */
async function renderPdfPages(pdfAbs: string, widthPx: number): Promise<string[]> {
  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'))
  // The LEGACY build, not the default one: Electron's Chromium is older than
  // pdfjs 5.x targets and the modern bundle dies on `Uint8Array.toHex`
  // (measured). extractText.ts already uses legacy for the same reason.
  const buildDir = path.join(pdfjsDir, 'legacy', 'build')
  // The page lives INSIDE that directory so `import('./pdf.min.mjs')` is a
  // same-origin relative import. Loading a data: URL instead gives the page an
  // opaque origin and the import is refused — measured, and the reason this is
  // a temp file rather than an inline document.
  const pageFile = path.join(buildDir, `__twixy_render_${process.pid}_${Date.now()}.html`)
  fs.writeFileSync(pageFile, '<!doctype html><meta charset="utf-8"><body></body>')
  // Bytes go in as base64 rather than being fetched: a file:// fetch would
  // need webSecurity off, and this way the window keeps Electron's defaults.
  const b64 = fs.readFileSync(pdfAbs).toString('base64')
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: false, contextIsolation: false } })
  try {
    await win.loadFile(pageFile)
    return await win.webContents.executeJavaScript(`(async () => {
      const pdfjs = await import('./pdf.min.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'
      const bin = atob(${JSON.stringify(b64)})
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise
      const out = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: ${widthPx} / base.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
        out.push(canvas.toDataURL('image/png'))
      }
      return out
    })()`, true) as string[]
  } finally {
    win.destroy()
    try { fs.unlinkSync(pageFile) } catch { /* best effort */ }
  }
}

export type RenderResult = { png: Buffer; pages: Buffer[]; slideCount: number; via: 'libreoffice' }

/**
 * Faithful contact sheet, or null when no renderer is installed.
 *
 * Never throws for "not available" — the caller falls back to the sketch. It
 * DOES throw when a renderer exists but failed, so the failure is visible
 * rather than silently downgraded.
 */
export async function renderDeckTrue(safePath: string, pageW = 1000): Promise<RenderResult | null> {
  const soffice = findSoffice()
  if (!soffice) return null
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twixy-pptx-'))
  try {
    const pdf = await toPdf(soffice, safePath, workDir)
    // Rendered once at page resolution: the sheet is these images scaled down,
    // so a deck is never rasterised twice.
    const pages = await renderPdfPages(pdf, pageW)
    if (pages.length === 0) throw new Error('PDF had no pages')
    // Page ratio from the first rendered image, so 4:3 decks compose correctly.
    const bitmaps = pages.map((d) => Buffer.from(d.split(',')[1], 'base64'))
    const dims = await sharp(bitmaps[0]).metadata()
    const png = await composeSheet({
      count: bitmaps.length,
      pageW: dims.width ?? 4, pageH: dims.height ?? 3,
      cell: () => '',                       // unused — we hand over real bitmaps
      bitmap: (i) => bitmaps[i],
    })
    return { png, pages: bitmaps, slideCount: pages.length, via: 'libreoffice' }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}
