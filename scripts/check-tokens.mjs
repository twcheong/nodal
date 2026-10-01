#!/usr/bin/env node
/**
 * tokens.css ↔ tokens.ts 동기화 검사.
 *
 * 1. tokens.css의 :root 선언(--x: ...)과 tokens.ts rawValues의 키가 양방향 일치하는지
 *    (legacy alias는 의도적으로 TS에 미러링하지 않으므로 제외)
 * 2. tokens.ts의 t 객체가 참조하는 var(--x)가 전부 tokens.css에 정의돼 있는지
 *
 * 불일치 시 exit 1. npm run check:tokens / lint에 체이닝됨.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/design/tokens.css'), 'utf8')
const ts = readFileSync(join(root, 'src/design/tokens.ts'), 'utf8')

// 신규 코드 사용 금지 alias — TS 미러 제외 대상
const LEGACY = new Set(['--text', '--radius', '--bg', '--green', '--red', '--yellow'])

const cssVars = new Set(
  [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]).filter((v) => !LEGACY.has(v)),
)

const rawSection = ts.slice(ts.indexOf('rawValues'))
const tsRawKeys = new Set([...rawSection.matchAll(/'(--[a-z0-9-]+)':/gi)].map((m) => m[1]))

const tSection = ts.slice(0, ts.indexOf('rawValues'))
const tRefs = new Set([...tSection.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]))

let failed = false
const report = (label, items) => {
  if (items.length === 0) return
  failed = true
  console.error(`✗ ${label}:\n    ${items.join('\n    ')}`)
}

report(
  'tokens.css에만 있고 tokens.ts rawValues에 없는 토큰',
  [...cssVars].filter((v) => !tsRawKeys.has(v)),
)
report(
  'tokens.ts rawValues에만 있고 tokens.css에 없는 토큰',
  [...tsRawKeys].filter((v) => !cssVars.has(v)),
)
report(
  'tokens.ts t 객체가 참조하지만 tokens.css에 정의되지 않은 변수',
  [...tRefs].filter((v) => !cssVars.has(v)),
)

if (failed) {
  console.error('\ntokens.css와 tokens.ts가 어긋났습니다. 두 파일을 함께 수정하세요.')
  process.exit(1)
}
console.log(`✓ tokens in sync (${cssVars.size} tokens)`)
