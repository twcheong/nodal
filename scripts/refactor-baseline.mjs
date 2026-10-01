// ─────────────────────────────────────────────────────────────────────────────
// refactor-baseline.mjs — 리팩토링 기준선 inventory (재실행 가능).
//
// 기술 부채 실행 가이드 v2 의 P0 / C inventory. 코드 이동 전후에 다시 돌려서
// docs/refactor/baseline/inventory.json 을 diff 하면 "IPC 채널·preload API 가
// 이동 전후 1:1 대응하는가" 를 기계적으로 확인할 수 있다.
//
// 집계 정의 (숫자를 비교할 때 이 정의를 같이 볼 것):
//   - IPC 등록: TS AST 에서 `ipcMain.handle|on|once(<첫 인자>)` 호출. 주석/문자열 안의
//     텍스트는 세지 않는다. 첫 인자가 문자열 리터럴이 아니면 channel = "<dynamic>".
//     제품 모드(APP_MODE)별 실제 런타임 등록 여부는 이 정적 목록으로 알 수 없다.
//   - preload API: `contextBridge.exposeInMainWorld(name, {...})` 객체 리터럴을 재귀로
//     걸어 함수 값인 프로퍼티만 센다 (platform 같은 값 프로퍼티는 values 로 분리).
//   - 렌더러 참조: src/**/*.{ts,tsx} 에서 `twixy.<method>` / `twixy.tools.<method>`
//     텍스트 매치 수. 동적 접근(twixy[key])·다른 entry 는 못 잡으므로 0 은 "삭제 가능"
//     이 아니라 "검증 후보" 다.
//
// 사용: node scripts/refactor-baseline.mjs
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'docs', 'refactor', 'baseline')
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, exts, out)
    else if (exts.some(x => e.name.endsWith(x))) out.push(p)
  }
  return out
}
const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
const loc = (file) => fs.readFileSync(file, 'utf8').split('\n').length - 1
const sh = (cmd) => { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return null } }

// `a.b(...)` 형태의 호출인지 — obj/prop 이름 매칭.
function isCall(node, obj, props) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === obj
    && props.includes(node.expression.name.text)
}
const literal = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) ? n.text : '<dynamic>'

// ── 1. ipcMain 등록 ──────────────────────────────────────────────────────────
const ipcMain = []
for (const file of walk(path.join(ROOT, 'electron'), ['.ts'])) {
  const sf = parse(file)
  ;(function visit(n) {
    if (isCall(n, 'ipcMain', ['handle', 'on', 'once'])) {
      ipcMain.push({ channel: literal(n.arguments[0]), kind: n.expression.name.text, file: rel(file), line: lineOf(sf, n) })
    }
    ts.forEachChild(n, visit)
  })(sf)
}

// ── 2. preload 노출 API ──────────────────────────────────────────────────────
const preloadFile = path.join(ROOT, 'electron', 'preload.ts')
const psf = parse(preloadFile)
const preloadApi = []      // { global, path, line, channels[] }
const preloadValues = []   // 함수가 아닌 값 프로퍼티
function channelsIn(node) {
  const out = []
  ;(function v(n) {
    if (isCall(n, 'ipcRenderer', ['invoke', 'send', 'sendSync', 'on', 'once', 'removeListener', 'removeAllListeners'])) {
      out.push(`${n.expression.name.text}:${literal(n.arguments[0])}`)
    }
    ts.forEachChild(n, v)
  })(node)
  return [...new Set(out)]
}
function walkObject(globalName, obj, prefix) {
  for (const prop of obj.properties) {
    const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : '<computed>'
    const full = prefix ? `${prefix}.${name}` : name
    if (ts.isMethodDeclaration(prop)) {
      preloadApi.push({ global: globalName, path: full, line: lineOf(psf, prop), channels: channelsIn(prop) })
    } else if (ts.isPropertyAssignment(prop)) {
      const init = prop.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        preloadApi.push({ global: globalName, path: full, line: lineOf(psf, prop), channels: channelsIn(init) })
      } else if (ts.isObjectLiteralExpression(init)) {
        walkObject(globalName, init, full)
      } else {
        preloadValues.push({ global: globalName, path: full, line: lineOf(psf, prop) })
      }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      preloadValues.push({ global: globalName, path: full, line: lineOf(psf, prop), shorthand: true })
    }
  }
}
// Stage 5 slice 3 이후 preload 는 객체를 exposeInMainWorld 에 바로 넘기지 않는다 —
// 먼저 `const twixyApi = { … }` 로 만들고, 창에 따라 그중 일부만 노출한다.
// 그래서 여기서 세는 건 "어느 창이 받는 표면" 이 아니라 **preload 가 정의하는 전체**다
// (= 메인 창이 받는 것). 창별로 누가 무엇을 받는지는 scripts/check-preload-surface.mjs.
;(function visit(n) {
  if (isCall(n, 'contextBridge', ['exposeInMainWorld']) && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
    walkObject(literal(n.arguments[0]), n.arguments[1], '')
  }
  // `const <global>Api = { … }` — 위 인라인 형태와 같은 것으로 센다.
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /Api$/.test(n.name.text)
      && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
    walkObject(n.name.text.replace(/Api$/, ''), n.initializer, '')
  }
  ts.forEachChild(n, visit)
})(psf)

// ── 3. 렌더러 참조 수 (삭제 "후보" 식별용) ─────────────────────────────────────
const srcFiles = walk(path.join(ROOT, 'src'), ['.ts', '.tsx']).filter(f => !f.endsWith('.d.ts'))
const srcText = srcFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n')
for (const api of preloadApi) {
  const leaf = api.path.split('.').pop()
  const owner = api.global === 'twixy' ? 'twixy' : api.global
  const pat = api.path.includes('.')
    ? new RegExp(`${owner}\\??\\.${api.path.split('.').slice(0, -1).join('\\??\\.')}\\??\\.${leaf}\\b`, 'g')
    : new RegExp(`${owner}\\??\\.${leaf}\\b`, 'g')
  api.rendererRefs = (srcText.match(pat) || []).length
}

// ── 4. 교차 검증: preload ↔ main 채널 대응 ────────────────────────────────────
const mainChannels = new Set(ipcMain.map(r => r.channel))
const preloadInvoked = new Set(
  preloadApi.flatMap(a => a.channels).filter(c => /^(invoke|send|sendSync):/.test(c)).map(c => c.split(':').slice(1).join(':')),
)
const preloadWithoutMain = [...preloadInvoked].filter(c => c !== '<dynamic>' && !mainChannels.has(c)).sort()
const mainWithoutPreload = [...mainChannels].filter(c => c !== '<dynamic>' && !preloadInvoked.has(c)).sort()
const dupChannels = Object.entries(ipcMain.reduce((m, r) => ((m[r.channel] = (m[r.channel] || 0) + 1), m), {}))
  .filter(([c, n]) => n > 1 && c !== '<dynamic>').map(([c, n]) => ({ channel: c, registrations: n }))

// ── 5. LOC · 기타 지표 ────────────────────────────────────────────────────────
const HOOKS = ['useOpenClaw', 'useCopilotChat', 'useWorkflowTestSession', 'useOrchestrationGateway', 'useWorkflowClaw', 'useDashboardClaw', 'useOrchestrationClaw']
const locOf = (p) => { const f = path.join(ROOT, p); return fs.existsSync(f) ? loc(f) : null }
const metrics = {
  loc: {
    'electron/main.ts': locOf('electron/main.ts'),
    'electron/preload.ts': locOf('electron/preload.ts'),
    'electron/planning.ts': locOf('electron/planning.ts'),
    'src/global.d.ts': locOf('src/global.d.ts'),
    gatewayHooks: Object.fromEntries(HOOKS.map(h => [h, locOf(`src/hooks/${h}.ts`)])),
  },
  mainTs: (() => {
    const t = fs.readFileSync(path.join(ROOT, 'electron', 'main.ts'), 'utf8')
    const count = (re) => (t.match(re) || []).length
    return {
      writeFileSync: count(/fs\.writeFileSync\s*\(/g),
      configPathReads: count(/fs\.readFileSync\(CONFIG_PATH/g),
      configPathWrites: count(/fs\.writeFileSync\(CONFIG_PATH/g),
      startsWithWorkspaceChecks: count(/\.startsWith\(\s*(getWorkspace\(\)|root)\s*\)/g),
    }
  })(),
  rawSoulImports: (srcText.match(/^import .*\?raw['"]/gm) || []).length,
  patchBytes: fs.existsSync(path.join(ROOT, 'patches', 'openclaw+2026.4.2.patch')) ? fs.statSync(path.join(ROOT, 'patches', 'openclaw+2026.4.2.patch')).size : null,
  htmlEntries: fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort(),
}
const gatewayHooksTotal = Object.values(metrics.loc.gatewayHooks).reduce((s, n) => s + (n || 0), 0)

// dist 가 있으면 JS 청크 크기도 (없으면 생략 — 빌드 조건이 다르면 비교 금지).
const distAssets = path.join(ROOT, 'dist', 'assets')
const distJs = fs.existsSync(distAssets)
  ? fs.readdirSync(distAssets).filter(f => f.endsWith('.js')).map(f => ({ file: f, bytes: fs.statSync(path.join(distAssets, f)).size })).sort((a, b) => b.bytes - a.bytes)
  : null

const env = {
  generatedAt: new Date().toISOString(),
  commit: sh('git rev-parse HEAD'),
  branch: sh('git rev-parse --abbrev-ref HEAD'),
  dirty: (sh('git status --porcelain --untracked-files=no') || '') !== '',
  os: `${process.platform} ${process.arch}`,
  node: process.version,
  npm: sh('npm --version'),
}

const inventory = {
  env, metrics: { ...metrics, gatewayHooksTotal },
  ipcMain: ipcMain.sort((a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file)),
  preloadApi: preloadApi.sort((a, b) => (a.global + a.path).localeCompare(b.global + b.path)),
  preloadValues,
  crossCheck: { preloadWithoutMain, mainWithoutPreload, dupChannels },
  distJs,
}
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')

// ── 사람이 읽는 요약 ──────────────────────────────────────────────────────────
const byFile = ipcMain.reduce((m, r) => ((m[r.file] = (m[r.file] || 0) + 1), m), {})
const byGlobal = preloadApi.reduce((m, a) => ((m[a.global] = (m[a.global] || 0) + 1), m), {})
const unref = preloadApi.filter(a => a.rendererRefs === 0)
const md = `# 리팩토링 기준선 inventory

> 자동 생성: \`node scripts/refactor-baseline.mjs\`. 손으로 고치지 말 것. 집계 정의는 스크립트 머리말 참고.

- commit \`${env.commit}\` (${env.branch}${env.dirty ? ', **작업트리 변경 있음**' : ''}) · ${env.os} · node ${env.node} · npm ${env.npm}
- 생성: ${env.generatedAt}

## LOC
| 파일 | 줄 |
|---|---|
${Object.entries(metrics.loc).filter(([k]) => k !== 'gatewayHooks').map(([k, v]) => `| ${k} | ${v} |`).join('\n')}
${Object.entries(metrics.loc.gatewayHooks).map(([k, v]) => `| src/hooks/${k}.ts | ${v} |`).join('\n')}
| **게이트웨이 훅 7개 합계** | **${gatewayHooksTotal}** |

## IPC 등록 (ipcMain.handle|on|once) — 총 ${ipcMain.length}
| 파일 | 등록 수 |
|---|---|
${Object.entries(byFile).sort((a, b) => b[1] - a[1]).map(([f, n]) => `| ${f} | ${n} |`).join('\n')}

- 중복 등록 채널: ${dupChannels.length ? dupChannels.map(d => `\`${d.channel}\`×${d.registrations}`).join(', ') : '없음'}

## preload 노출 API — 함수 ${preloadApi.length}개 (값 프로퍼티 ${preloadValues.length}개 별도)
${Object.entries(byGlobal).map(([g, n]) => `- \`window.${g}\`: ${n}`).join('\n')}

## 교차 검증
- preload 가 호출하는데 main 등록이 없는 채널 (${preloadWithoutMain.length}): ${preloadWithoutMain.map(c => `\`${c}\``).join(', ') || '없음'}
- main 에 등록됐는데 preload invoke/send 가 없는 채널 (${mainWithoutPreload.length}): ${mainWithoutPreload.map(c => `\`${c}\``).join(', ') || '없음'}
  - (main→renderer 단방향 이벤트, 다른 창 전용 채널일 수 있음 — 삭제 근거 아님)

## 렌더러 텍스트 참조 0 — 삭제 "검증 후보" (${unref.length})
동적 접근·별도 entry·테스트·지원 계약을 확인하기 전에는 dead code 로 단정하지 않는다 (가이드 C2).

${unref.map(a => `- \`${a.global}.${a.path}\` (preload.ts:${a.line})${a.channels.length ? ' → ' + a.channels.join(', ') : ''}`).join('\n') || '- 없음'}

## main.ts 지표
- fs.writeFileSync: ${metrics.mainTs.writeFileSync}
- CONFIG_PATH 직접 읽기/쓰기: ${metrics.mainTs.configPathReads} / ${metrics.mainTs.configPathWrites}
- \`startsWith(getWorkspace()|root)\` 경로 검사 (P1 대상): ${metrics.mainTs.startsWithWorkspaceChecks}

## 기타
- SOUL \`?raw\` import: ${metrics.rawSoulImports}
- openclaw 패치: ${metrics.patchBytes} bytes
- HTML entry (${metrics.htmlEntries.length}): ${metrics.htmlEntries.join(', ')}
${distJs ? `
## dist JS 청크 (상위 8, raw bytes — 빌드 조건이 같을 때만 비교)
| 파일 | bytes |
|---|---|
${distJs.slice(0, 8).map(d => `| ${d.file} | ${d.bytes} |`).join('\n')}
` : '\n_dist 없음 — 청크 크기 미기록._\n'}`
fs.writeFileSync(path.join(OUT_DIR, 'inventory.md'), md)

console.log(`[baseline] ipcMain ${ipcMain.length} · preload fn ${preloadApi.length} (+값 ${preloadValues.length}) · 미참조 후보 ${unref.length}`)
console.log(`[baseline] preload→main 누락 ${preloadWithoutMain.length} · main 전용 ${mainWithoutPreload.length} · 중복 채널 ${dupChannels.length}`)
console.log(`[baseline] → ${rel(path.join(OUT_DIR, 'inventory.md'))}, inventory.json`)
