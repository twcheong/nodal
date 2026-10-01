// Compiles every skills/*/*.tskill to its SKILL.md, in place.
//
//   npm run skills:compile
//
// SKILL.md is a build artifact ("DO NOT EDIT" in its header) — the app compiles
// it on launch, but the repo copy goes stale between launches, and prompts that
// were regenerated (gen-prompt-block.ts) must land in the compiled artifact in
// the same commit. This script closes that gap without booting the app.
//
// The `Compiled:` timestamp is the only line allowed to differ without a
// rewrite — otherwise every run would dirty every SKILL.md.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileTSL } from '../../electron/tsl-compiler'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SKILLS = path.join(ROOT, 'skills')

// 비교 전에 줄 끝을 통일하고 타임스탬프 줄을 지운다.
//
// CRLF 주의: 디스크의 SKILL.md 는 체크아웃에 따라 CRLF 인데 compileTSL 결과는 항상 LF 다.
// 줄 끝을 맞추지 않으면 **모든 파일이 매번 달라 보여** 타임스탬프만 바뀐 파일까지 전부
// 다시 쓴다 — 이 파일 머리말이 "그러면 매 실행이 모든 SKILL.md 를 더럽힌다" 고 막으려던
// 바로 그 상황이다. (정규식 쪽도 같은 이유로 위험하다: `.` 는 '\r' 을 안 먹고 `$` 는
// '\r' 앞에서도 걸려서, CRLF 에서는 타임스탬프 대신 앞줄의 '\n' 을 먹는 식으로 어긋난다.)
// 쓰는 내용은 그대로 LF — 비교만 정규화한다.
const stripTimestamp = (md: string) =>
  md.replace(/\r\n/g, '\n').replace(/^\s*Compiled: .*$/m, '')

let failed = false
for (const dir of fs.readdirSync(SKILLS)) {
  const skillDir = path.join(SKILLS, dir)
  if (!fs.statSync(skillDir).isDirectory()) continue
  const src = fs.readdirSync(skillDir).find((f) => f.endsWith('.tskill'))
  if (!src) continue

  const result = compileTSL(fs.readFileSync(path.join(skillDir, src), 'utf8'), src)
  if (!result.ok || !result.markdown) {
    failed = true
    console.error(`${dir}/${src}: compile FAILED`)
    for (const e of result.errors) console.error(`  ${e.message}`)
    continue
  }

  const out = path.join(skillDir, 'SKILL.md')
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  if (stripTimestamp(prev) === stripTimestamp(result.markdown)) {
    console.log(`${dir}: up to date`)
  } else {
    fs.writeFileSync(out, result.markdown, 'utf8')
    console.log(`${dir}: SKILL.md rewritten`)
  }
}

if (failed) process.exit(1)
