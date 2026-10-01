// 생성된 SOUL 상수가 .md 원본과 어긋나지 않는지 지킨다.
//
// 왜 테스트로 두는가: 생성물이 조용히 낡는 게 이 저장소에서 **이미 두 번** 난 사고다
// (skills/SKILL.md 8개, 그리고 deck 프롬프트 블록). 검사를 npm 스크립트에만 걸면
// 그 체인이 안 돌 때 조용히 지나간다 — 실제로 `npm run lint` 는 Windows 에서 중간 단계에
// 막혀 eslint 까지 못 가던 시기가 있었고, 그동안 뒤쪽 검사는 전부 안 돌았다.
// vitest 는 모두가 매번 돌리므로 여기 두면 빠뜨릴 수가 없다.
// (npm 스크립트 쪽 검사 `npm run check:souls` 도 lint 체인에 함께 걸어 둔다.)

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  WORKFLOW_SOUL_MD, ORCHESTRATION_SOUL_MD, CONTENT_SOUL_MD, WORKFLOW_RUNNER_V3_SOUL_MD,
} from './generated/soulText'

const ROOT = path.resolve(__dirname, '../../..')

const SOULS: Array<[string, string]> = [
  ['WORKFLOW_SOUL.md',           WORKFLOW_SOUL_MD],
  ['ORCHESTRATION_SOUL.md',      ORCHESTRATION_SOUL_MD],
  ['CONTENT_SOUL.md',            CONTENT_SOUL_MD],
  ['WORKFLOW_RUNNER_V3_SOUL.md', WORKFLOW_RUNNER_V3_SOUL_MD],
]

describe('생성된 SOUL 상수 ↔ .md 원본', () => {
  it.each(SOULS)('%s 가 최신이다 (어긋나면: npm run gen:souls)', (mdFile, constant) => {
    // 생성기와 같은 정규화 — 줄끝만 맞추고 나머지 바이트는 그대로 비교한다.
    const onDisk = fs.readFileSync(path.join(ROOT, mdFile), 'utf8').replace(/\r\n/g, '\n')
    expect(constant).toBe(onDisk)
  })

  it('줄끝은 LF 로 고정 — 체크아웃(autocrlf)에 따라 프롬프트가 달라지지 않는다', () => {
    // 이 저장소는 .gitattributes 가 없고 core.autocrlf=true 라 Windows 에서 .md 가 CRLF 로
    // 떨어진다. 예전엔 `?raw` 가 디스크 그대로를 돌려줘서 Windows 빌드와 macOS 빌드가
    // 서로 다른 바이트를 모델에 보냈다. 상수로 구우면서 LF 로 고정했다.
    for (const [mdFile, constant] of SOULS) {
      expect(constant, `${mdFile} 상수에 CR 이 남아 있다`).not.toContain('\r')
    }
  })

  it('비어 있지 않다 — 생성기가 빈 파일을 구워도 통과하지 않도록', () => {
    for (const [mdFile, constant] of SOULS) {
      expect(constant.trim().length, mdFile).toBeGreaterThan(200)
    }
  })
})
