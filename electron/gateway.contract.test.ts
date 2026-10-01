// @vitest-environment node
//
// **게이트웨이 프로세스 보관소의 단일 출처**를 소스 모양으로 고정한다.
// windows.contract.test.ts 와 같은 이유로 존재한다 — electron 을 못 띄우니 동작 대신
// 구조를 본다.
//
// 지키려는 것: exit 핸들러의 `openclawProcess === proc` 비교가 **감시의 판정 기준**이다.
// 이 비교가 읽는 변수와 kill 경로가 비우는 변수가 갈라지면,
//   · 갈라진 쪽이 항상 다르면 → 크래시해도 되살아나지 않는다 (채팅이 영영 멈춤)
//   · 갈라진 쪽이 항상 같으면 → 일부러 끈 뒤에도 되살아난다 (종료 후 좀비가 포트를 뭄)
// 둘 다 게이트웨이 자체를 의심하게 만드는 증상이라 원인에 도달하기 어렵다.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const GW   = fs.readFileSync('electron/gateway.ts', 'utf8')
const MAIN = fs.readFileSync('electron/main.ts', 'utf8')

const SUPERVISOR_VARS = [
  'openclawProcess', 'gatewaySupervised', 'gatewayRestartAttempts',
  'gatewayRestartTimer', 'gatewayUptimeTimer', 'appQuitting',
]

describe('게이트웨이 상태 보관소는 gateway.ts 하나뿐이다', () => {
  it('감시 상태 전부가 gateway.ts 에 선언돼 있다', () => {
    for (const v of SUPERVISOR_VARS) {
      expect(GW, v).toContain(`let ${v}`)
    }
  })

  it('main.ts 는 게이트웨이 상태를 선언하지도, 직접 참조하지도 않는다', () => {
    for (const v of SUPERVISOR_VARS) {
      expect(MAIN, `main.ts declares ${v}`).not.toContain(`let ${v}`)
    }
    // 주석의 이름 언급은 허용, 코드 참조는 불가.
    const code = MAIN.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code, 'main.ts 코드가 openclawProcess 를 직접 본다').not.toContain('openclawProcess')
  })
})

describe('감시의 판정 기준이 같은 변수를 읽는다', () => {
  it('exit 핸들러가 모듈 지역 변수를 직접 비교한다 (접근자 경유 금지)', () => {
    // 접근자를 거치면 "두 번째 보관소" 가 끼어들 자리가 생긴다 — 그래서 모양까지 고정한다.
    expect(GW).toMatch(/if \(openclawProcess === proc && gatewaySupervised\) \{/)
    expect(GW).not.toMatch(/getGatewayProcess\(\) === proc/)
  })

  it('의도한 종료 경로들이 그 같은 변수를 비운다', () => {
    for (const fn of ['killGatewayIfRunning', 'stopOpenClaw', 'clearGatewayProcess']) {
      const body = GW.slice(GW.indexOf(`function ${fn}(`))
      expect(body.slice(0, body.indexOf('\n}') + 2), fn).toContain('openclawProcess = null')
    }
  })

  it('접근자도 같은 변수를 돌려준다', () => {
    expect(GW).toMatch(/export function getGatewayProcess\(\): ChildProcess \| null \{ return openclawProcess \}/)
  })
})

describe('배선', () => {
  it('main.ts 가 initGateway 를 부른다 (안 부르면 첫 기동에서 throw)', () => {
    expect(MAIN).toMatch(/^initGateway\(\{/m)
    expect(GW).toMatch(/throw new Error\('gateway\.ts: initGateway/)
  })

  it('keyHandout 은 gateway 의 접근자를 그대로 받는다 (자체 사본 금지)', () => {
    const call = MAIN.slice(MAIN.indexOf('initKeyHandout({'))
    const body = call.slice(0, call.indexOf('\n})') + 3)
    expect(body).toContain('getGatewayProcess,')
    expect(body).toContain('clearGatewayProcess,')
    expect(MAIN).toMatch(/getGatewayProcess, clearGatewayProcess[\s\S]{0,80}from '\.\/gateway'/)
  })
})
