// ── 다운로드 후처리 (main.ts 에서 이동) ────────────────────────────────────
//
// OpenClaw 가 브라우저 다운로드를 떨구는 임시 폴더를 감시하다가, 파일이 떨어지면
// 내용을 sniff 해 제대로 된 확장자를 붙여 workspace/data/raw/ 로 옮긴다.
// 브라우저가 확장자 없이 내려받은 파일이 그대로 남으면 에이전트가 못 읽는다.
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { getWorkspace, OPENCLAW_DOWNLOADS_DIR } from './paths'
import { PRODUCT } from '../shared/product/current.generated'

export interface DownloadWatcherDeps {
  getMainWindow: () => BrowserWindow | null
}

let deps: DownloadWatcherDeps | null = null

/** main.ts 가 기동 시 1회 호출한다. 안 부르면 첫 이동 알림에서 throw 한다. */
export function initDownloadWatcher(d: DownloadWatcherDeps): void { deps = d }

function need(): DownloadWatcherDeps {
  if (!deps) throw new Error('downloadWatcher.ts: initDownloadWatcher() 가 먼저 불려야 한다')
  return deps
}

// ── Download post-processor — 다운로드 후처리 감시 ───────────────
// OpenClaw 전용 다운로드 폴더를 감시하다가 새 파일이 생기면:
//   1) 파일 앞부분을 sniff 해 실제 포맷(CSV/JSON/PDF/PNG …) 판별
//   2) 확장자를 교정해 workspace/data/raw/ 로 이동
// 덕분에 에이전트가 브라우저로 받은 파일이 곧바로 DataPanel 에서 사용 가능해진다.
/**
 * OpenClaw saves browser downloads at /tmp/openclaw/downloads with arbitrary
 * UUID filenames and no extension (because the Blob+download flow that gives
 * SPAs like X analytics their `.csv` filename is bypassed by automation).
 *
 * This watcher detects new files in that dir, sniffs the first 16 bytes to
 * guess a real extension, then moves them into the Twixy workspace at
 * data/raw/<uuid>.<ext> so they show up in DataPanel as proper exports.
 */
export function startDownloadWatcher() {
  if (!PRODUCT.features.browser) return   // 다운로드는 관리형 Chrome 에서만 생긴다
  try { fs.mkdirSync(OPENCLAW_DOWNLOADS_DIR, { recursive: true }) } catch { /* ignore */ }
  const dest = path.join(getWorkspace(), 'data', 'raw')
  fs.mkdirSync(dest, { recursive: true })

  // Track files we've already processed so the debounced retries don't loop.
  const seen = new Set<string>()

  const process = (name: string) => {
    if (seen.has(name)) return
    const src = path.join(OPENCLAW_DOWNLOADS_DIR, name)
    if (!fs.existsSync(src)) return
    const stat = fs.statSync(src)
    if (stat.isDirectory() || stat.size === 0) return
    // Skip Chromium's in-flight temp files (will fire again when renamed).
    if (name.endsWith('.crdownload') || name.endsWith('.tmp')) return

    // If the file already has a known extension, just move it.
    const existingExt = path.extname(name).toLowerCase()
    let ext = existingExt
    if (!ext) {
      try {
        const fd = fs.openSync(src, 'r')
        const head = Buffer.alloc(16)
        fs.readSync(fd, head, 0, 16, 0)
        fs.closeSync(fd)
        ext = sniffExtension(head, src)
      } catch {
        ext = '.bin'
      }
    }

    seen.add(name)
    const finalName = ext && !existingExt ? `${name}${ext}` : name
    const target = path.join(dest, finalName)
    try {
      fs.renameSync(src, target)
      console.log(`[twixy/downloads] ${name} → data/raw/${finalName}`)
      need().getMainWindow()?.webContents.send('twixy-download', { path: target, name: finalName })
    } catch (err) {
      // Cross-device rename can fail — fall back to copy + unlink.
      try {
        fs.copyFileSync(src, target)
        fs.unlinkSync(src)
        console.log(`[twixy/downloads] ${name} → data/raw/${finalName} (copied)`)
      } catch (copyErr) {
        console.warn(`[twixy/downloads] failed to move ${name}:`, copyErr)
        seen.delete(name)
      }
    }
  }

  try {
    fs.watch(OPENCLAW_DOWNLOADS_DIR, (_event, filename) => {
      if (!filename) return
      // Debounce briefly so the writer is done flushing.
      setTimeout(() => process(filename), 500)
    })
    console.log(`[twixy/downloads] watching ${OPENCLAW_DOWNLOADS_DIR}`)
  } catch (err) {
    console.warn('[twixy/downloads] watcher failed to start:', err)
  }

  // Initial scan in case files were dropped while Twixy was closed.
  for (const name of fs.readdirSync(OPENCLAW_DOWNLOADS_DIR)) process(name)
}

/**
 * Magic-byte sniffer that returns a file extension (with leading dot) or ''.
 * Covers the common shapes that fall out of X analytics, Notion exports,
 * Google Sheets, etc. Falls back to `.csv` for plausible delimited text and
 * `.bin` for everything else.
 */
function sniffExtension(head: Buffer, srcPath: string): string {
  // Binary signatures
  if (head[0] === 0x50 && head[1] === 0x4b) return '.zip'                       // PK\x03\x04 → ZIP (xlsx, docx, pptx live here too but we keep it simple)
  if (head.slice(0, 4).toString() === '%PDF') return '.pdf'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg'
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) return '.png'
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return '.gif'
  if (head.slice(0, 4).toString() === 'RIFF') return '.webp'

  // Text-ish: read a longer sample to differentiate JSON/HTML/CSV.
  let sample = ''
  try {
    const fd = fs.openSync(srcPath, 'r')
    const buf = Buffer.alloc(2048)
    const n = fs.readSync(fd, buf, 0, 2048, 0)
    fs.closeSync(fd)
    sample = buf.slice(0, n).toString('utf8').trim()
  } catch { /* ignore */ }

  if (sample.startsWith('{') || sample.startsWith('[')) return '.json'
  if (/^<\?xml/i.test(sample)) return '.xml'
  if (/^<(!doctype html|html|head|body)/i.test(sample)) return '.html'
  // Heuristic: at least 2 commas in the first line → very likely CSV.
  const firstLine = sample.split('\n', 1)[0] ?? ''
  if ((firstLine.match(/,/g)?.length ?? 0) >= 2) return '.csv'
  if (sample.length > 0) return '.txt'
  return '.bin'
}

