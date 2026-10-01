// 창 entry 한 개에서 정적으로 도달하는 파일 집합 — check-window-imports 와
// check-preload-surface 가 같이 쓴다. (같은 폐쇄를 두 번 구현하면 언젠가 한쪽만 고쳐진다.)
//
// 검사 방식은 의도적으로 얕다: 정규식 import 추출 + 확장자 추정.
// ponytail: regex import scan, 번들러 수준 해석이 필요해지면 es-module-lexer 로 교체.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 보조 창 kind → entry html. electron/windowEntry.ts 의 SECONDARY_HTML 과 같은 집합이고,
// vite.config.ts 의 rollupOptions.input 에도 같은 파일들이 들어간다. kind 이름은
// electron/preload.ts 의 PER_WINDOW 키·windows.ts 의 --twixy-window 인자와 같아야 한다.
export const SECONDARY_WINDOWS = {
  sidetab:     'sidetab.html',
  composer:    'composer.html',
  testOverlay: 'test-overlay.html',
  guardrail:   'guardrail.html',
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']
// `from '…'` · `import('…')` · `export … from '…'` · 부작용 전용 `import '…'`
// (마지막 형태를 빠뜨리면 `import '../lib/supabase'` 한 줄이 그대로 새어나간다.)
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

/** entry html 의 `<script type="module" src>` 가 가리키는 파일. */
export function entryOf(html) {
  const src = fs.readFileSync(path.join(ROOT, html), 'utf8').match(/<script[^>]+src="([^"]+)"/)?.[1]
  if (!src) throw new Error(`${html}: <script type="module" src> 를 찾지 못했다`)
  return path.join(ROOT, src.replace(/^\//, ''))
}

function resolveSpec(spec, fromFile) {
  let base
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2))
  else return null                                   // bare specifier = node_modules
  for (const ext of EXTS) {
    const p = base + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

/** entry 에서 도달 가능한 파일 → 거기까지 온 import 경로. */
export function closure(entry) {
  const seen = new Map([[entry, [entry]]])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      // 주석 안의 예시와 타입 전용 import(런타임 코드가 없다)는 건너뛴다.
      const code = line.replace(/\r$/, '').replace(/\/\/.*$/, '')   // CRLF 체크아웃: \r 을 먼저 떼야 주석 제거의 $ 가 맞는다
      if (/^\s*(?:import|export)\s+type\s/.test(code)) continue
      for (const m of code.matchAll(IMPORT_RE)) {
        const next = resolveSpec(m[1].split('?')[0], file)   // '…?raw' 등 쿼리 제거
        if (!next || seen.has(next)) continue
        seen.set(next, [...seen.get(file), next])
        queue.push(next)
      }
    }
  }
  return seen
}

export { IMPORT_RE }
