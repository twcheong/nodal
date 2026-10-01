// preload 표면 정합성 검사 — `npm run lint` 에 포함, 빌드 불필요.
//
// 다섯 가지가 어긋나면 실패한다:
//   1) 렌더러가 부르는 window.twixy.<name> 이 preload 에 없다  → 오타/삭제된 메서드
//   2) preload 키와 src/global.d.ts 의 선언이 다르다            → 선언 drift
//   3) (1)에는 별칭 경유 호출도 포함한다                        → `const api = window.twixy`
//   4) preload 의 PER_WINDOW 에 twixyApi 에 없는 이름이 있다    → 그 창에서 undefined
//   5) 보조 창의 import 폐쇄가 부르는 이름이 그 창 목록에 없다 / 목록에 안 부르는 이름이 있다
//
// 왜 필요한가: preload 는 200개 넘는 이름을 노출하고, 오타는 컴파일이 아니라 런타임에
// `undefined is not a function` 으로만 드러난다. 그것도 **그 창을 열어야** 드러나므로
// 테스트가 초록인 채로 릴리즈까지 갈 수 있다. 실제로 보조 창 4개는 평소 테스트에서
// 거의 열리지 않는다. 이 검사는 그 실패를 lint 시점으로 끌어온다.
//
// 삭제/개명 슬라이스(Stage 5)의 안전망이기도 하다 — docs/refactor/stage5-preload-plan.md.
//
// 4·5 번이 특히 중요하다: slice 3 이후 보조 창은 twixyApi 전체가 아니라 PER_WINDOW 에
// 적힌 것만 받는다. 타입은 여전히 전 창이 같은 Window['twixy'] 를 보므로 **tsc 가 이
// 간극을 못 본다** — 사이드탭에서 window.twixy.getChannels() 를 써도 컴파일은 통과하고,
// 그 창을 열어야 undefined 로 터진다. 그 실패를 여기서 잡는다.
//
// 한계(의도적): 정규식 기반이라 `twixy[expr]` 같은 완전 동적 접근은 못 본다.
// 그런 접근은 현재 코드베이스에 없고, 생기면 여기 규칙을 깨는 게 아니라 그 코드를 고칠 것.
// ponytail: regex scan, ts-morph 가 필요해지면 그때 바꾼다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SECONDARY_WINDOWS, entryOf, closure } from './module-closure.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
// CRLF 체크아웃에서 줄 끝 \r 이 남으면 `//` 주석 제거용 `$` 앵커가 안 먹는다
// (`.` 가 \r 에 안 붙고 `$` 는 입력 끝에서만 매치). 먼저 털어낸다.
const lines = (s) => s.split('\n').map((l) => l.replace(/\r$/, ''))

// ── preload 가 정의하는 키 ─────────────────────────────────────────────────
// 최상위(들여쓰기 2) + `tools:` 네임스페이스(들여쓰기 4).
// preload 는 객체를 **두 개** 만든다: `twixyApi`(창에 따라 일부만 노출)와
// Test Progress 오버레이 창만 받는 `twixyTestOverlayApi`. 둘을 섞어 세면
// 후자의 6개가 twixy 의 "선언 누락" 으로 오인된다.
function surfaceKeys(objName) {
  const src = lines(rd('electron/preload.ts'))
  const start = src.findIndex((l) => l.startsWith(`const ${objName} = {`))
  if (start < 0) throw new Error(`preload 에 ${objName} 객체가 없다`)
  const flat = new Set()
  const tools = new Set()
  let inTools = false
  for (let i = start + 1; i < src.length; i++) {
    const line = src[i]
    if (/^\}/.test(line)) break                       // 이 객체 리터럴의 끝
    if (/^\s*\/\//.test(line)) continue
    if (/^\s{2}tools\s*:\s*\{/.test(line)) { inTools = true; flat.add('tools'); continue }
    if (inTools && /^\s{2}\}/.test(line)) { inTools = false; continue }
    const m = line.match(inTools ? /^\s{4}([A-Za-z_$][\w$]*)\s*:/ : /^\s{2}([A-Za-z_$][\w$]*)\s*:/)
    if (m) (inTools ? tools : flat).add(m[1])
  }
  return { flat, tools }
}

// ── global.d.ts 의 선언 키 (TwixyAPI + Window.twixy 확장) ───────────────────
function declaredKeys() {
  const src = lines(rd('src/global.d.ts'))
  const out = new Set()
  // 관심 블록: `interface TwixyAPI {` 와 `twixy: TwixyAPI & {`
  const blocks = []
  for (let i = 0; i < src.length; i++) {
    if (/^interface TwixyAPI\s*\{/.test(src[i]) || /^\s*twixy:\s*TwixyAPI\s*&\s*\{/.test(src[i])) {
      blocks.push({ start: i, baseIndent: src[i].match(/^\s*/)[0].length })
    }
  }
  for (const b of blocks) {
    let depth = 0
    let paren = 0
    for (let i = b.start; i < src.length; i++) {
      const line = src[i]
      const code = line.replace(/\/\/.*$/, '')
      const opens = (code.match(/\{/g) ?? []).length
      const closes = (code.match(/\}/g) ?? []).length
      // 블록 최상위 깊이(1)에서의 키만 센다 — 중첩 객체 타입 안쪽은 제외.
      // paren === 0 조건이 없으면 여러 줄 함수 시그니처의 인자(`cb: (…) => void`)가
      // 선언 키로 잡힌다.
      if (depth === 1 && paren === 0) {
        const m = code.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/)
        if (m) out.add(m[1])
      }
      paren += (code.match(/\(/g) ?? []).length - (code.match(/\)/g) ?? []).length
      depth += opens - closes
      if (i > b.start && depth <= 0) break
    }
  }
  return out
}

// ── 렌더러가 부르는 이름 ────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith('global.d.ts')) out.push(p)
  }
  return out
}

// `window.twixy.x` · `twixy?.x` · `twixy.tools.x`, 그리고 별칭 `const api = window.twixy` 뒤의 `api.x`.
function calledNames() {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'products'))]
  const flat = new Map()   // name → [file…]
  const tools = new Map()
  const add = (map, name, file) => { (map.get(name) ?? map.set(name, []).get(name)).push(file) }

  for (const file of files) {
    // 주석 줄은 뺀다 — `// window.twixy.workflow* 를 감싸는 훅` 같은 설명이 호출로 잡힌다.
    // 문자열 안의 `https://` 를 건드리지 않도록 "줄 전체가 주석" 인 경우만 제거한다.
    const text = lines(fs.readFileSync(file, 'utf8'))
      .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
      .join('\n')
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')

    // `window.` 접두를 필수로 둔다. 안 그러면 'twixy.runnerHarness'(localStorage 키),
    // 'twixy.overwrite'(guardrail 플러그인 id) 같은 **문자열 리터럴**이 호출로 잡힌다.
    // 실제 호출은 전역 `twixy` 식별자가 없으므로 항상 window 를 거친다.
    for (const m of text.matchAll(/window\.twixy(?:\?)?\.tools(?:\?)?\.(\w+)/g)) add(tools, m[1], rel)
    for (const m of text.matchAll(/window\.twixy(?:\?)?\.(\w+)/g)) {
      if (m[1] !== 'tools') add(flat, m[1], rel)
    }
    // 별칭: `const api = window.twixy` → 이 파일 안의 `api.<name>` 도 twixy 호출이다.
    // 이게 없으면 LiveBrowserPreview 의 browserPreview* 9개가 "아무도 안 씀" 으로 보인다.
    for (const a of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*window\.twixy\b/g)) {
      const alias = a[1]
      for (const m of text.matchAll(new RegExp(`\\b${alias}(?:\\?)?\\.(\\w+)`, 'g'))) {
        if (m[1] !== 'tools') add(flat, m[1], rel)
      }
      for (const m of text.matchAll(new RegExp(`\\b${alias}(?:\\?)?\\.tools(?:\\?)?\\.(\\w+)`, 'g'))) add(tools, m[1], rel)
    }
  }
  return { flat, tools }
}

// ── 검사 ────────────────────────────────────────────────────────────────────
const exposed = surfaceKeys('twixyApi')
const overlay = surfaceKeys('twixyTestOverlayApi')
const declared = declaredKeys()
const called = calledNames()
const problems = []
const rel = (fs2) => [...new Set(fs2)].slice(0, 3).join(', ') + (new Set(fs2).size > 3 ? ` 외 ${new Set(fs2).size - 3}곳` : '')

// 1·3) 렌더러가 부르는데 preload 에 없다
for (const [name, files] of called.flat) {
  if (!exposed.flat.has(name)) {
    problems.push(`window.twixy.${name} 을 부르는데 preload 에 그런 키가 없다 — ${rel(files)}`)
  }
}
for (const [name, files] of called.tools) {
  if (!exposed.tools.has(name)) {
    problems.push(`window.twixy.tools.${name} 을 부르는데 preload 의 tools 에 없다 — ${rel(files)}`)
  }
}

// 2) 선언 drift — preload 키와 global.d.ts 가 서로를 덮는지
for (const name of exposed.flat) {
  if (name === 'tools') continue
  if (!declared.has(name)) problems.push(`preload 이 ${name} 을 노출하는데 src/global.d.ts 선언에 없다 — 타입이 못 따라간다`)
}
for (const name of declared) {
  if (name === 'tools') continue
  if (!exposed.flat.has(name)) problems.push(`src/global.d.ts 가 ${name} 을 선언하는데 preload 이 노출하지 않는다 — 부르면 런타임 undefined`)
}

// 4) 두 번째 브릿지(twixyTestOverlay)도 같은 방식으로 — 오타는 여기서도 런타임에만 난다.
{
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'products'))]
  for (const file of files) {
    const text = lines(fs.readFileSync(file, 'utf8')).filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const m of text.matchAll(/window\.twixyTestOverlay(?:\?)?\.(\w+)/g)) {
      if (!overlay.flat.has(m[1])) {
        problems.push(`window.twixyTestOverlay.${m[1]} 을 부르는데 preload 에 없다 — ${path.relative(ROOT, file).replace(/\\/g, '/')}`)
      }
    }
  }
}

// ── 5) 창별 표면 — PER_WINDOW 가 그 창의 import 폐쇄와 정확히 맞물리는가 ────
// preload 의 PER_WINDOW 리터럴을 그대로 읽는다. 여기 적힌 이름만 그 창의
// window.twixy 에 들어가므로, 이 목록이 곧 계약이다.
function perWindowLists() {
  const src = lines(rd('electron/preload.ts')).filter((l) => !/^\s*\/\//.test(l)).join('\n')
  const block = src.slice(src.indexOf('const PER_WINDOW'))
  const out = {}
  for (const m of block.slice(0, block.indexOf('\n}')).matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  return out
}

/** 그 창의 entry 에서 정적으로 도달하는 파일들이 부르는 이름. */
function calledInWindow(html) {
  const flat = new Set()
  const overlayNames = new Set()
  for (const file of closure(entryOf(html)).keys()) {
    const text = lines(fs.readFileSync(file, 'utf8')).filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n')
    const add = (set, re, group = 1) => { for (const m of text.matchAll(re)) set.add(m[group]) }
    add(flat, /window\.twixy(?:\?)?\.(\w+)/g)
    add(overlayNames, /window\.twixyTestOverlay(?:\?)?\.(\w+)/g)
    // 별칭: `const bridge = window.twixyTestOverlay` / `const api = window.twixy`
    for (const a of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*window\.(twixyTestOverlay|twixy)\b/g)) {
      const set = a[2] === 'twixy' ? flat : overlayNames
      for (const m of text.matchAll(new RegExp(`\\b${a[1]}(?:\\?)?\\.(\\w+)`, 'g'))) set.add(m[1])
    }
  }
  flat.delete('tools')
  return { flat, overlayNames }
}

const perWindow = perWindowLists()
for (const [kind, html] of Object.entries(SECONDARY_WINDOWS)) {
  const list = perWindow[kind]
  if (!list) { problems.push(`preload 의 PER_WINDOW 에 ${kind} 창이 없다 — 그 창이 전체 표면을 받는다`); continue }
  for (const name of list) {
    if (!exposed.flat.has(name)) problems.push(`PER_WINDOW.${kind} 의 ${name} 이 twixyApi 에 없다 — 그 창에서 undefined`)
  }
  const { flat, overlayNames } = calledInWindow(html)
  for (const name of flat) {
    if (!list.includes(name)) problems.push(`${html} 이 window.twixy.${name} 을 부르는데 PER_WINDOW.${kind} 에 없다 — 그 창에서 undefined`)
  }
  for (const name of list) {
    if (!flat.has(name)) problems.push(`PER_WINDOW.${kind} 의 ${name} 을 그 창은 부르지 않는다 — 표면은 부르는 것만 담는다`)
  }
  // twixyTestOverlay 브릿지는 testOverlay 창에만 간다.
  if (kind !== 'testOverlay' && overlayNames.size > 0) {
    problems.push(`${html} 이 window.twixyTestOverlay 를 쓴다 — 그 브릿지는 test-overlay 창에만 노출된다`)
  }
}

if (problems.length > 0) {
  console.error(`preload 표면 불일치 ${problems.length}건:\n` + problems.map((p) => '  ' + p).join('\n') + '\n')
  process.exit(1)
}
console.log(
  `preload 표면 OK — twixyApi ${exposed.flat.size - 1}(+tools ${exposed.tools.size}) · 선언 ${declared.size}`
  + ` · twixyTestOverlay ${overlay.flat.size} · 렌더러 호출 ${called.flat.size}(+tools ${called.tools.size}) 전부 일치.`,
)
console.log(
  '  창별 표면 — ' + Object.entries(SECONDARY_WINDOWS)
    .map(([kind]) => `${kind} ${perWindow[kind].length}`)
    .join(' · ') + ` · main/enterprise/nodal ${exposed.flat.size - 1}(전체).`,
)
