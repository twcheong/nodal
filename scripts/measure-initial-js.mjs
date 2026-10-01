// ─────────────────────────────────────────────────────────────────────────────
// measure-initial-js.mjs — 진입 html 이 "처음에" 가져오는 JS 총량.
//
// 왜: dist/assets 의 파일별 크기만 보면 lazy 분리의 효과를 알 수 없다. 청크 하나가
// 줄어도 그 코드가 다른 정적 청크로 옮겨갔을 뿐이면 초기 로드는 그대로다. 그래서
// html 의 <script type=module> 에서 출발해 **정적 import 만** 따라간 폐포를 잰다
// (`import("…")` 동적 import 는 첫 방문 때 받으므로 제외).
//
// 사용: node_modules/.bin/vite build  →  node scripts/measure-initial-js.mjs [index.html …]
//       인자 없으면 dist/ 최상위의 모든 html (nodal 은 products/nodal/index.html 을 인자로). --json 이면 기계가 읽을 출력.
//       --contains <문자열>: 각 entry 의 폐포에서 그 문자열이 든 파일을 표시. 예) --contains GoTrueClient
//         = "이 창이 Supabase auth 클라이언트를 만드는가" (supabase.ts 는 import 되는 순간 createClient 를 실행한다).
//         보조 창(sidetab/composer/guardrail/test-overlay)에서는 (none) 이어야 한다.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const ci = args.indexOf('--contains')
const needle = ci >= 0 ? args[ci + 1] : null
const htmls = args.filter((a, i) => !a.startsWith('--') && (ci < 0 || i !== ci + 1))
const entries = htmls.length ? htmls : fs.readdirSync(DIST).filter(f => f.endsWith('.html'))

// Rollup 은 정적 import 를 `import{a}from"./x.js"` / `import"./x.js"` 로 낸다. `import(` 는
// 괄호 때문에 이 패턴에 안 걸린다. 문자열 속 우연한 매치는 "파일이 실제로 있는가" 로 거른다.
const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[^"'()]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g

function closure(html) {
  const text = fs.readFileSync(path.join(DIST, html), 'utf8')
  const roots = [...text.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(m => m[1])
  const seen = new Map() // abs → bytes
  // src 는 html 기준 상대 경로다 — nodal 은 dist/products/nodal/index.html 이라 '../../assets/…' 로 나온다.
  const queue = roots.map(r => path.resolve(path.dirname(path.join(DIST, html)), r))
  while (queue.length) {
    const abs = queue.pop()
    if (seen.has(abs) || !fs.existsSync(abs)) continue
    const buf = fs.readFileSync(abs)
    seen.set(abs, buf)
    for (const m of buf.toString('utf8').matchAll(STATIC_IMPORT)) queue.push(path.resolve(path.dirname(abs), m[1]))
  }
  const files = [...seen].map(([abs, buf]) => ({ file: path.basename(abs), bytes: buf.length, gzip: zlib.gzipSync(buf).length, ...(needle ? { contains: buf.includes(needle) } : {}) }))
    .sort((a, b) => b.bytes - a.bytes)
  return { html, files, bytes: files.reduce((s, f) => s + f.bytes, 0), gzip: files.reduce((s, f) => s + f.gzip, 0) }
}

const all = fs.readdirSync(path.join(DIST, 'assets')).filter(f => f.endsWith('.js'))
  .map(f => ({ file: f, bytes: fs.statSync(path.join(DIST, 'assets', f)).size })).sort((a, b) => b.bytes - a.bytes)
const result = { chunks: all, entries: entries.map(closure) }

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`dist/assets JS — ${all.length} files, ${all.reduce((s, f) => s + f.bytes, 0)} bytes`)
  for (const f of all) console.log(`  ${String(f.bytes).padStart(9)}  ${f.file}`)
  for (const e of result.entries) {
    console.log(`\n${e.html} — initial (static closure): ${e.bytes} bytes raw / ${e.gzip} gzip, ${e.files.length} files`)
    for (const f of e.files) console.log(`  ${String(f.bytes).padStart(9)}  ${f.file}`)
    if (needle) console.log(`  contains "${needle}": ${e.files.filter(f => f.contains).map(f => f.file).join(', ') || '(none)'}`)
  }
}
