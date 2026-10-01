// @vitest-environment node
//
// **창 목록의 단일 출처**를 소스 모양으로 고정한다.
//
// 왜 이런 테스트가 필요한가: IPC 발신자 검증(senderBlocked)은 "이 창이 이 채널을 불러도
// 되는가" 를 창 조회로 판단한다. 창을 만드는 코드와 조회하는 코드가 **서로 다른 보관소**를
// 보게 되는 순간, 정상 창이 거부되고 증상은 "게이트웨이에 안 붙는다" 로만 나타난다 —
// 거부 로그를 찾아보기 전까지는 게이트웨이를 의심하게 되는 실패다.
//
// 런타임으로 확인하려면 패키지 앱이 필요한데(scripts/ipc-sender-check.mjs) 이번 회차에는
// 그 점검을 돌리지 않는다. 그래서 그 자리를 소스 검사로 메운다. 정식 단위 테스트가
// 아니라는 걸 알고 쓰는 가드다 — electron 을 못 띄우니 동작 대신 구조를 본다.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const WINDOWS = fs.readFileSync('electron/windows.ts', 'utf8')
const MAIN = fs.readFileSync('electron/main.ts', 'utf8')
const OVERLAY = fs.readFileSync('electron/overlayIpc.ts', 'utf8')

/** windowEntry.ts 의 WindowKind 와 같아야 한다. */
const KINDS = ['main', 'sidetab', 'composer', 'testOverlay', 'guardrail'] as const
const SECONDARY_VARS = ['overlayWindow', 'composerWindow', 'testOverlayWindow', 'guardrailWindow']

describe('창 보관소는 windows.ts 하나뿐이다', () => {
  it('보조 창 4개의 선언이 windows.ts 에 있다', () => {
    for (const v of SECONDARY_VARS) {
      expect(WINDOWS, v).toMatch(new RegExp(`let ${v}\\s*:`))
    }
  })

  it('main.ts 와 overlayIpc.ts 는 보조 창을 선언하지 않는다', () => {
    for (const v of SECONDARY_VARS) {
      expect(MAIN, `main.ts declares ${v}`).not.toMatch(new RegExp(`let ${v}\\s*:`))
      expect(OVERLAY, `overlayIpc.ts declares ${v}`).not.toMatch(new RegExp(`let ${v}\\s*:`))
    }
  })

  it('메인 창만 main.ts 소유 — thunk 으로만 나간다', () => {
    expect(MAIN).toMatch(/let mainWindow\s*:/)
    expect(MAIN).toMatch(/function getMainWindow\(\)/)
    // 창 모듈은 메인 창 변수를 직접 못 본다 (import 도 불가능하지만 명시해 둔다)
    expect(WINDOWS).not.toMatch(/let mainWindow\s*:/)
  })
})

describe('getWindow 가 유일한 조회 지점이다', () => {
  const body = WINDOWS.slice(WINDOWS.indexOf('export function getWindow'))
    .slice(0, WINDOWS.slice(WINDOWS.indexOf('export function getWindow')).indexOf('\n}') + 2)

  it('WindowKind 5종을 전부 다룬다', () => {
    for (const k of KINDS) expect(body, k).toContain(`case '${k}'`)
  })

  it('보조 창은 보관소 변수를 그대로 돌려주고, main 만 thunk 으로 위임한다', () => {
    expect(body).toMatch(/case 'main':\s*return need\(\)\.getMainWindow\(\)/)
    expect(body).toMatch(/case 'sidetab':\s*return overlayWindow/)
    expect(body).toMatch(/case 'composer':\s*return composerWindow/)
    expect(body).toMatch(/case 'testOverlay':\s*return testOverlayWindow/)
    expect(body).toMatch(/case 'guardrail':\s*return guardrailWindow/)
  })

  it('senderBlocked 는 자체 창 목록을 갖지 않고 getWindow 를 쓴다', () => {
    // main.ts 의 windowOf 는 getWindow 그 자체여야 한다 (별도 switch 가 있으면 두 출처가 된다).
    expect(MAIN).toMatch(/const windowOf = getWindow/)
    const sb = MAIN.slice(MAIN.indexOf('function senderBlocked'))
      .slice(0, MAIN.slice(MAIN.indexOf('function senderBlocked')).indexOf('\n}') + 2)
    expect(sb).toContain('windowOf(kind)')
    for (const v of SECONDARY_VARS) expect(sb, v).not.toContain(v)
  })
})

describe('창 모듈의 초기화 계약', () => {
  it('main.ts 가 initWindows 를 부른다 (안 부르면 창 생성이 throw 한다)', () => {
    expect(MAIN).toMatch(/initWindows\(\{/)
  })

  it('deps 없이 쓰면 조용히 넘어가지 않고 throw 한다', () => {
    expect(WINDOWS).toMatch(/throw new Error\('windows\.ts: initWindows/)
  })
})

describe('창마다 자기 preload 표면을 고르게 표식을 준다', () => {
  // preload 는 한 벌뿐이고, 어느 창인지는 `--twixy-window=<kind>` 로만 안다
  // (electron/preload.ts 의 PER_WINDOW). 창 생성 코드를 복사하다 표식을 빠뜨리거나
  // 남의 kind 를 그대로 두면 그 창은 **전체 표면을 받거나 남의 표면을 받는다** —
  // 증상은 그 창을 열어야 나오는 undefined 이므로 여기서 소스로 고정한다.
  const CREATORS: [string, string][] = [
    ['createOverlayWindow',     'sidetab'],
    ['createComposerWindow',    'composer'],
    ['createTestOverlayWindow', 'testOverlay'],
    ['createGuardrailWindow',   'guardrail'],
  ]

  for (const [fn, kind] of CREATORS) {
    it(`${fn} 는 --twixy-window=${kind} 를 넘긴다`, () => {
      const body = WINDOWS.slice(WINDOWS.indexOf(`export function ${fn}`))
      const upToLoad = body.slice(0, body.indexOf('loadWindowEntry'))
      expect(upToLoad).toContain(`additionalArguments: ['--twixy-window=${kind}']`)
      // 로더와 표식이 같은 kind 를 써야 한다 — 어긋나면 표면과 진입 페이지가 다른 창이 된다.
      expect(body.slice(body.indexOf('loadWindowEntry'), body.indexOf('loadWindowEntry') + 80))
        .toContain(`'${kind}'`)
    })
  }

  it('메인 창은 표식이 없다 — 전체 표면을 받는 유일한 창', () => {
    const body = MAIN.slice(MAIN.indexOf('mainWindow = new BrowserWindow'))
      .slice(0, 900)
    expect(body).not.toContain('--twixy-window')
  })
})
