import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'

export type PdfBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'table'; headers: string[]; rows: (string | number | null)[][] }
  | { type: 'spacer' }

export type WritePdfPayload = {
  title?: string
  blocks: PdfBlock[]
}

const STYLES = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', sans-serif;
       font-size: 13px; line-height: 1.7; color: #1a1a1a;
       max-width: 760px; margin: 40px auto; padding: 0 40px; }
h1,h2,h3 { font-weight: 700; margin: 1.2em 0 0.4em; }
h1 { font-size: 24px; border-bottom: 2px solid #e5e5e5; padding-bottom: 6px; }
h2 { font-size: 18px; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; }
h3 { font-size: 15px; }
ul { margin: 0.4em 0 0.8em 1.2em; padding: 0; }
li { margin: 0.2em 0; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th { background: #f5f5f5; font-weight: 600; padding: 7px 12px; text-align: left; border-bottom: 2px solid #ddd; }
td { padding: 6px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
.spacer { height: 18px; }
`

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderBlocks(blocks: PdfBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'h1': return `<h1>${esc(b.text)}</h1>`
        case 'h2': return `<h2>${esc(b.text)}</h2>`
        case 'h3': return `<h3>${esc(b.text)}</h3>`
        case 'p':  return `<p>${esc(b.text)}</p>`
        case 'spacer': return `<div class="spacer"></div>`
        case 'bullet':
          return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        case 'table': {
          const head = `<tr>${b.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`
          const body = b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
            .join('')
          return `<table>${head}${body}</table>`
        }
      }
    })
    .join('\n')
}

/**
 * Write a PDF report from a structured block list to `safePath`. Uses an
 * offscreen Electron BrowserWindow to render via Chromium so Korean and
 * other non-ASCII glyphs work without bundling fonts.
 */
export async function writePdf(safePath: string, payload: WritePdfPayload): Promise<{ bytes: number }> {
  const titleHtml = payload.title ? `<h1>${esc(payload.title)}</h1>` : ''
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLES}</style></head><body>${titleHtml}${renderBlocks(payload.blocks)}</body></html>`

  fs.mkdirSync(path.dirname(safePath), { recursive: true })

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml))
    const buf = await win.webContents.printToPDF({ printBackground: true })
    fs.writeFileSync(safePath, buf)
    return { bytes: buf.length }
  } finally {
    win.close()
  }
}
