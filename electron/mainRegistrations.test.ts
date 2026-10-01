// @vitest-environment node
//
// main.ts 가 **import 한 register*Ipc 를 전부 호출하는가**.
//
// 슬라이스 14 가 enterpriseIpc · memoryIpc 를 모듈로 빼면서 import 만 남기고 호출을
// 빠뜨렸다. 채널 8개(`twixy-enterprise-*`, `pull-shared`, `memory-*`)가 죽은 채로
// main 에 머지됐는데도 tsc·eslint·채널 인벤토리(정적으로 ipcMain.handle 을 센다)·
// 테스트가 전부 통과했다 — 증상은 렌더러가 invoke 할 때 "No handler registered" 로만
// 나온다. 슬라이스마다 반복될 수 있는 실수라 기계가 지키게 한다.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync('electron/main.ts', 'utf8')

// 호출 여부는 **주석을 뺀** 소스로 센다. 원본으로 세면 `// registerMemoryIpc()` 처럼
// 호출을 주석 처리한 줄도 호출로 잡혀서, 이 테스트가 막으려는 바로 그 변이를 통과시킨다
// (실제로 그렇게 통과하는 것을 변이 테스트로 확인했다). 블록 주석과, 줄 전체가 주석인
// 줄만 걷어 낸다 — 줄 끝 `//` 까지 자르면 'http://…' 같은 문자열이 잘린다.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

/** main.ts 가 import 하는 `register…` 심볼 전부. */
function importedRegistrars(): string[] {
  const names = new Set<string>()
  for (const m of SRC.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.[^']*'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim() ?? ''
      if (/^register[A-Z]/.test(name)) names.add(name)
    }
  }
  return [...names]
}

describe('main.ts 모듈 등록', () => {
  it('import 한 register*() 를 하나도 빠짐없이 호출한다', () => {
    const missing = importedRegistrars().filter(name => {
      // import 줄 자체를 빼고 호출만 센다.
      const calls = CODE.match(new RegExp(`(^|[^\\w.])${name}\\s*\\(`, 'gm')) ?? []
      return calls.length === 0
    })
    expect(missing, `import 됐지만 호출되지 않은 등록 함수: ${missing.join(', ')}`).toEqual([])
  })

  it('검사 대상이 비어 있지 않다 (정규식이 죽으면 조용히 통과한다)', () => {
    expect(importedRegistrars().length).toBeGreaterThan(10)
  })
})
