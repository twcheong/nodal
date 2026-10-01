// 제품 경계 검사 — `npm run lint` 에 포함.
//
// 한 레포에서 여러 제품을 빌드하므로, 팀별 작업 범위가 폴더로 갈린다:
//   products/<id>/   그 제품 팀 소유
//   그 밖            공용 코어 (electron/, src/, shared/)
//
// 이 경계가 문서로만 있으면 금방 무너진다. 여기서 네 가지를 기계적으로 막는다:
//   1. 코어가 products/ 를 import 한다        → 코어가 특정 제품에 묶인다
//   2. 코어가 제품 id 로 분기한다              → `if (PRODUCT.id === 'nodal')` 가 쌓인다.
//                                               분기 대신 profile 의 features 값을 읽을 것
//   3. 한 제품이 다른 제품 폴더를 import 한다  → 제품끼리 묶인다
//      (예외: twixy-enterprise 는 twixy 의 상위집합이라 twixy profile 을 확장한다)
//   4. products/nodal/engine(엔진 subtree)이 그 바깥을 import 한다 → 엔진이 앱에 묶인다
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_DIRS = ['electron', 'src', 'shared']
const GENERATED = new Set([
  path.join('shared', 'product', 'current.generated.ts'),
  path.join('shared', 'product', 'current.main.generated.ts'),
])
const ALLOWED_CROSS_PRODUCT = new Set(['twixy-enterprise>twixy'])

// 코어의 **테스트 파일**만 규칙 1·2 에서 제외한다.
//
// 이 규칙이 막으려는 사고는 "출하되는 코어 코드가 특정 제품에 묶이는 것" 이다. 그런데
// 제품별 파생을 검증하는 테스트는 세 제품의 profile 을 다 읽어야 하고, 그건 그 사고의
// 반대편이다 — 제품별로 결과가 갈리는 걸 **잡아 내는** 쪽이다. 실제로 툴 권한 파생
// 테스트가 이 벽에 막혀 실제 프로필 대신 사본 fixture 를 쓰고 있었고, 사본은 프로필이
// 바뀌면 조용히 낡는다(막으려던 것과 같은 종류의 드리프트다).
//
// ⚠ 경계가 느슨해진 게 아니다: 테스트 파일이 **아닌** 모든 경로는 예전과 똑같이 엄격하고,
// 규칙 3(제품끼리 import)은 테스트에도 그대로 적용된다. 번들에 들어가는 코드는 하나도
// 예외가 없다 — vitest 는 이 파일들을 빌드 산출물에 넣지 않는다.
const isTestFile = (file) => /\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(path.basename(file))

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p) }
    else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) yield p
  }
}

// `from '…'` · `import('…')` · `require('…')` · 부작용 전용 `import '…'`.
// 마지막 형태가 빠져 있으면 `import '../../products/nodal/x'` 한 줄이 그대로 통과한다
// (scripts/check-window-imports.mjs 에서 같은 구멍을 먼저 밟았다).
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const problems = []
const report = (file, line, msg) => problems.push(`${path.relative(ROOT, file)}:${line}  ${msg}`)

function eachLine(file, fn) {
  // CRLF 주의: split('\n') 만 하면 각 줄 끝에 '\r' 이 남는다. 그러면 아래 주석 제거
  // 정규식의 `$` (JS 는 줄 끝이 아니라 **문자열 끝**에만 붙는다) 가 '\r' 앞에서 안 걸려
  // 주석이 통째로 코드로 스캔된다 — 같은 커밋이 main 체크아웃(CRLF)에서는 실패하고
  // 워크트리(LF)에서는 통과하는 유령 버그가 된다. scripts/check-window-imports.mjs 가
  // 먼저 밟은 것과 같은 구멍이라 여기서도 줄 끝을 먼저 털어 낸다.
  //
  // 원인은 같아도 증상의 **방향은 반대**라, 마주쳤을 때의 반응도 달라야 한다:
  //   · 이 스크립트 — 주석이 코드로 읽혀 **과다 보고**한다 (규칙을 설명하려고 주석에
  //     `PRODUCT.id ===` 나 products/ 경로를 적는 순간 위반으로 잡힌다).
  //   · check-window-imports.mjs — 반대로 **눈이 멀어** 위반이 조용히 통과했다.
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, i) => {
    const code = text.replace(/\/\/.*$/, '')   // 주석 안의 예시는 검사하지 않는다
    fn(code, i + 1)
  })
}

// 1·2 — 코어
for (const dir of CORE_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    if (GENERATED.has(path.relative(ROOT, file))) continue
    if (isTestFile(file)) continue   // 위 주석 참고 — 테스트만, 규칙 1·2 만
    eachLine(file, (code, line) => {
      for (const m of code.matchAll(IMPORT_RE)) {
        const resolved = m[1].startsWith('.') ? path.resolve(path.dirname(file), m[1]) : null
        if (resolved && path.relative(ROOT, resolved).split(path.sep)[0] === 'products') {
          report(file, line, `코어가 products/ 를 import 한다 (${m[1]}) — shared/product/current.generated 를 통해서만 읽을 것`)
        }
      }
      if (/PRODUCT\.id\s*[!=]==?/.test(code) || /[!=]==?\s*PRODUCT\.id/.test(code)) {
        report(file, line, '제품 id 로 분기한다 — profile 의 features 에 값을 추가하고 그걸 읽을 것')
      }
      if (/process\.env\.APP_MODE/.test(code)) {
        report(file, line, 'APP_MODE 를 런타임에 읽는다 — 패키징된 앱에는 이 env 가 없다. PRODUCT 를 쓸 것')
      }
    })
  }
}

// 3 — 제품끼리
const productsDir = path.join(ROOT, 'products')
for (const id of fs.readdirSync(productsDir)) {
  const dir = path.join(productsDir, id)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const file of walk(dir)) {
    eachLine(file, (code, line) => {
      for (const m of code.matchAll(IMPORT_RE)) {
        if (!m[1].startsWith('.')) continue
        const rel = path.relative(productsDir, path.resolve(path.dirname(file), m[1]))
        if (rel.startsWith('..')) continue
        const other = rel.split(path.sep)[0]
        if (other !== id && !ALLOWED_CROSS_PRODUCT.has(`${id}>${other}`)) {
          report(file, line, `products/${id} 가 products/${other} 를 import 한다 — 공유할 코드는 코어로 올릴 것`)
        }
      }
    })
  }
}

// 4 — 엔진 subtree 는 닫혀 있어야 한다
// products/nodal/engine 은 twcheong/nodal 을 git subtree 로 들인 것이다. 이 안의 코드가
// 바깥(앱 코어·Nodal 앱 코드)을 import 하기 시작하면 엔진을 따로 테스트·빌드할 수 없고
// `git subtree pull` 도 충돌한다. 앱 → 엔진 방향만 허용한다.
const ENGINE_DIR = path.join(productsDir, 'nodal', 'engine')
if (fs.existsSync(ENGINE_DIR)) {
  for (const file of walk(ENGINE_DIR)) {
    eachLine(file, (code, line) => {
      for (const m of code.matchAll(IMPORT_RE)) {
        if (!m[1].startsWith('.')) continue
        if (path.relative(ENGINE_DIR, path.resolve(path.dirname(file), m[1])).startsWith('..')) {
          report(file, line, `엔진 subtree 가 바깥을 import 한다 (${m[1]}) — 엔진은 앱을 몰라야 한다`)
        }
      }
    })
  }
}

if (problems.length) {
  console.error(`[check-product-boundary] ${problems.length}건\n` + problems.map((p) => '  ' + p).join('\n'))
  process.exit(1)
}
console.log('[check-product-boundary] ok')
