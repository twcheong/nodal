// 보조 창(sidetab / composer / test-overlay / guardrail)의 import 폐쇄(closure) 검사.
// `npm run lint` 에 포함 — 빌드 없이 돈다.
//
// 왜: 이 창들은 로그인 세션을 쓰지 않는다. 그런데 어느 파일 하나가 우연히
// src/lib/supabase.ts 를 (몇 단계 건너) 끌어오면 창마다 GoTrueClient 가 하나씩
// 더 생기고("Multiple GoTrueClient instances") 초기 JS 도 수백 KB 불어난다.
// 실제로 test-overlay 가 그렇게 샜다(commit af4222c).
//
// 기존 방어선이었던 `measure-initial-js.mjs --contains GoTrueClient` 는 vite build
// 이후에만 돈다 — PR 단계에서는 늦다. ESLint no-restricted-imports 는 직접 import
// 만 잡고 전이(transitive) import 는 못 잡는다. 그래서 정적 모듈 그래프를 직접 건다.
//
// 폐쇄 계산은 scripts/module-closure.mjs 가 한다 (check-preload-surface 와 공유).
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, SECONDARY_WINDOWS, entryOf, closure, IMPORT_RE } from './module-closure.mjs'

// 보조 창 entry html — vite.config.ts 의 rollupOptions.input 과 같은 집합
// (main/product entry 는 제외: 그쪽은 Supabase 를 써야 한다).
const ENTRY_HTML = Object.values(SECONDARY_WINDOWS)

// 이 창들이 (전이적으로도) 닿으면 안 되는 모듈.
const FORBIDDEN = ['src/lib/supabase.ts']

const problems = []
for (const html of ENTRY_HTML) {
  const entry = entryOf(html)
  const reached = closure(entry)
  for (const bad of FORBIDDEN) {
    const chain = reached.get(path.join(ROOT, bad))
    if (!chain) continue
    problems.push(
      `${html} → ${bad} 에 도달한다. 이 창은 로그인 세션을 쓰지 않는다 — 해당 모듈을 안 타는 경로로 바꿀 것.\n`
      + chain.map((f, i) => `${'  '.repeat(i + 1)}${path.relative(ROOT, f).replace(/\\/g, '/')}`).join('\n'),
    )
  }
}

// ── Harness 순수성 ──────────────────────────────────────────────────────────
// src/lib/harness/* 는 Electron 밖(서버)에서도 돌아야 한다 — 그게 이 모듈이
// 훅에서 떨어져 나온 이유 전부다. React·PRODUCT·window.twixy 중 하나라도 닿는
// 순간 그 길이 막히는데, 그 사실은 한참 뒤에야 드러난다. 여기서 바로 막는다.
const HARNESS_DIR = path.join(ROOT, 'src', 'lib', 'harness')
const HARNESS_FORBIDDEN_MODULES = ['src/lib/product.ts']
const HARNESS_FORBIDDEN_BARE = ['react', 'react-dom']

if (fs.existsSync(HARNESS_DIR)) {
  for (const f of fs.readdirSync(HARNESS_DIR)) {
    if (!/\.tsx?$/.test(f) || /\.test\./.test(f)) continue
    const entry = path.join(HARNESS_DIR, f)
    const reached = closure(entry)
    const rel = 'src/lib/harness/' + f

    for (const bad of HARNESS_FORBIDDEN_MODULES) {
      const chain = reached.get(path.join(ROOT, bad))
      if (!chain) continue
      problems.push(
        `${rel} → ${bad} 에 도달한다. Harness 는 제품 프로필을 몰라야 한다 — 값을 인자로 받을 것.\n`
        + chain.map((x, i) => `${'  '.repeat(i + 1)}${path.relative(ROOT, x).replace(/\\/g, '/')}`).join('\n'),
      )
    }

    // bare specifier 와 window 전역은 closure 가 못 따라가므로 도달 파일들을 훑는다.
    for (const file of reached.keys()) {
      const text = fs.readFileSync(file, 'utf8')
      const where = path.relative(ROOT, file).replace(/\\/g, '/')
      for (const line of text.split('\n')) {
        const code = line.replace(/\r$/, '').replace(/\/\/.*$/, '')   // CRLF 체크아웃: \r 을 먼저 떼야 주석 제거의 $ 가 맞는다
        if (/^\s*(?:import|export)\s+type\s/.test(code)) continue
        for (const m of code.matchAll(IMPORT_RE)) {
          if (HARNESS_FORBIDDEN_BARE.includes(m[1])) {
            problems.push(`${rel} → ${where} 가 '${m[1]}' 을 import 한다. Harness 는 React 를 몰라야 한다.`)
          }
        }
        if (/\bwindow\.twixy\b/.test(code)) {
          problems.push(`${rel} → ${where} 가 window.twixy 를 쓴다. Harness 는 IPC 를 주입받아야 한다.`)
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('import 경계 위반:\n\n' + problems.join('\n\n') + '\n')
  process.exit(1)
}
console.log(
  `import 경계 OK — 보조 창 ${ENTRY_HTML.length}개가 ${FORBIDDEN.join(', ')} 를 타지 않고,`
  + ' harness/* 는 React·PRODUCT·window.twixy 를 타지 않는다.',
)
