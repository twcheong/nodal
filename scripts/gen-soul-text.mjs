// SOUL 마크다운 4개를 평범한 .ts 상수로 굽는다.
//
//   node scripts/gen-soul-text.mjs           # 생성(쓰기)
//   node scripts/gen-soul-text.mjs --check    # 최신인지 검사만 (CI/lint 용)
//
// WHY: 지금까지 SOUL 은 `import soul from '../../X_SOUL.md?raw'` 로 읽었다. `?raw` 는 Vite
// 전용 specifier 라 그 모듈을 **평범한 node 가 import 할 수 없다**. 그래서 scripts/wf-eval.mjs
// 는 프로덕션 프롬프트를 가져오지 못하고 자기 사본을 들고 있었고, 그 사본은 낡았다 —
// v3 하네스를 기본 ON 으로 만든 A/B 숫자가 제품이 실제로 보내는 프롬프트가 아닌 걸 쟀다는 뜻이다.
// 상수로 구워두면 에이전트 좌석이 순수 TS 로 남고 평범한 node 에서도 import 된다.
//
// 줄 단위 배열로 굽는 이유: 33KB 짜리 한 줄은 diff 에서 읽을 수가 없다. 줄 배열이면
// 생성 파일의 diff 가 .md 의 diff 와 같은 모양이 된다 (커밋하는 이유가 "리뷰 가능한 diff" 이므로).
//
// 줄바꿈은 **LF 로 정규화**한다. 이 저장소는 .gitattributes 가 없고 core.autocrlf=true 라
// Windows 체크아웃에서 .md 가 CRLF 가 된다 — `?raw` 는 디스크 그대로를 돌려주므로 지금까지
// Windows 빌드와 macOS 빌드가 **서로 다른 프롬프트**를 보내고 있었다. 생성 파일이 플랫폼마다
// 달라지면 커밋된 산출물로서 성립하지 않는다. LF 로 고정하면 어디서 굽든 같은 바이트가 나온다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = 'src/lib/agents/generated/soulText.ts'

/** 마크다운 원본 → 내보낼 상수 이름. 추가하려면 여기 한 줄. */
const SOULS = [
  { md: 'WORKFLOW_SOUL.md',            constName: 'WORKFLOW_SOUL_MD' },
  { md: 'ORCHESTRATION_SOUL.md',       constName: 'ORCHESTRATION_SOUL_MD' },
  { md: 'CONTENT_SOUL.md',             constName: 'CONTENT_SOUL_MD' },
  { md: 'WORKFLOW_RUNNER_V3_SOUL.md',  constName: 'WORKFLOW_RUNNER_V3_SOUL_MD' },
]

/** 디스크에서 읽어 줄바꿈만 정규화한다. 그 밖의 바이트는 건드리지 않는다. */
export function readSoul(mdFile) {
  return fs.readFileSync(path.join(ROOT, mdFile), 'utf8').replace(/\r\n/g, '\n')
}

function emitConst({ md, constName }) {
  const lines = readSoul(md).split('\n')
  const body = lines.map(l => `  ${JSON.stringify(l)},`).join('\n')
  return `/** ${md} 원문. 편집은 그 .md 에서. */\nexport const ${constName} = [\n${body}\n].join('\\n')\n`
}

function render() {
  return [
    '// ⚠️ AUTO-GENERATED — 직접 편집하지 말 것.',
    '//',
    `// 생성: node scripts/gen-soul-text.mjs   (npm run gen:souls)`,
    '// 원본: 저장소 루트의 *_SOUL.md — 내용을 고치려면 그쪽을 고치고 다시 구울 것.',
    '//',
    '// 커밋하는 파일이다. 이유: 평범한 체크아웃에서 빌드 단계 없이 import 되어야',
    '// scripts/wf-eval.mjs 같은 순수 node 소비자가 **제품이 실제로 쓰는** 텍스트를 쓸 수 있다.',
    '// 낡은 채로 지나가지 않도록 soulText.test.ts 가 .md 원본과 대조한다 (npm test 에서 돈다).',
    '//',
    '// 줄바꿈은 LF 로 정규화돼 있다 — 체크아웃 줄끝(autocrlf)과 무관하게 같은 바이트가 나오도록.',
    '',
    ...SOULS.map(emitConst),
  ].join('\n')
}

const target = path.join(ROOT, OUT)
const next = render()
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null

if (process.argv.includes('--check')) {
  if (current === next) {
    console.log(`souls OK — ${SOULS.length} constants match their .md sources`)
    process.exit(0)
  }
  console.error(
    `✗ ${OUT} 가 .md 원본과 어긋난다.\n`
    + `  고치려면: npm run gen:souls\n`
    + (current === null ? '  (생성 파일이 아예 없다)' : '  (SOUL 을 고치고 다시 굽지 않은 것으로 보인다)'),
  )
  process.exit(1)
}

fs.mkdirSync(path.dirname(target), { recursive: true })
if (current === next) {
  console.log(`souls unchanged — ${SOULS.length} constants`)
} else {
  fs.writeFileSync(target, next, 'utf8')
  console.log(`souls written → ${OUT} (${SOULS.length} constants)`)
}
