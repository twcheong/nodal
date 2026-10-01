// @vitest-environment node
//
// 게이트웨이 재기동 경로의 **실패 계약**을 고정한다.
//
// 왜 소스를 읽는 이상한 테스트인가: 이 계약은 main.ts 안의 핸들러에 있고, main.ts 는
// import 시점에 electron 을 잡고 IPC 를 등록하고 프로세스를 띄워서 vitest 에 올릴 수 없다.
// 그래서 동작 대신 **소스 모양**을 본다. 정상적인 단위 테스트가 아니라는 걸 알고 쓰는
// 임시 가드다 — Stage 4 슬라이스 8 에서 게이트웨이가 모듈로 빠지면 이 파일은 진짜
// 동작 테스트로 대체하고 지운다. (슬라이스 7 에서 gateway.ts 로 빠졌지만, 아직
// electron 없이 기동을 못 돌려서 소스 검사를 유지한다.)
//
// 고정하려는 것: startOpenClaw() 가 실패했을 때 어떤 핸들러는 { ok:false, error } 를
// **반환**하고 어떤 경로는 **throw** 한다. 둘을 한 헬퍼로 합치면 반환하던 쪽이 조용히
// throw 로 바뀌는데, 렌더러가 그 반환값을 읽지 않아서 증상이 안 보인다. 그래서 "합치지
// 않았다" 를 기계가 지키게 한다.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

// 계약이 여러 파일에 걸쳐 있으므로(기동·정리는 gateway, 모드/채널 핸들러는 accountIpc,
// retry-openclaw 는 setupIpc, 나머지는 main) 전부 이어 붙여 본다 — "openclawProcess 를 비우는 곳은 4군데" 같은
// 전수 검사가 파일 경계로 갈라지면 의미를 잃는다. 파일이 더 쪼개지면 여기에 추가할 것.
const SRC = `${fs.readFileSync('electron/main.ts', 'utf8')}
${fs.readFileSync('electron/gateway.ts', 'utf8')}
${fs.readFileSync('electron/accountIpc.ts', 'utf8')}
${fs.readFileSync('electron/setupIpc.ts', 'utf8')}
${fs.readFileSync('electron/integrationsIpc.ts', 'utf8')}`   // 슬라이스 15: respawnGateway 가 여기로 갔다

/** `ipcMain.handle('<channel>'` 부터 다음 등록 직전까지 = 그 핸들러의 본문. */
function handlerBody(channel: string): string {
  const start = SRC.indexOf(`ipcMain.handle('${channel}'`)
  expect(start, `handler not found: ${channel}`).toBeGreaterThan(-1)
  const next = SRC.indexOf('ipcMain.handle(', start + 1)
  return SRC.slice(start, next === -1 ? SRC.length : next)
}

/** 이름 있는 함수의 본문 (중괄호 깊이로 끝을 찾는다). */
function functionBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  expect(start, `function not found: ${name}`).toBeGreaterThan(-1)
  const open = SRC.indexOf('{', start)
  let depth = 0
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

/** `needle` 이 어떤 try 블록 **안**에 있는가. 핸들러에 try 가 여러 개일 수 있어서
 *  (save-channels 는 ensureWorkspace 용 try 가 따로 있다) "catch 가 있다" 로는 부족하다 —
 *  그 느슨한 검사는 실제로 mutation 을 놓쳤다. 중괄호 깊이로 범위를 실제로 계산한다. */
function isInsideTry(body: string, needle: string): boolean {
  const at = body.indexOf(needle)
  if (at < 0) return false
  for (let i = 0; i < body.length; i++) {
    if (!body.startsWith('try', i)) continue
    const open = body.indexOf('{', i)
    if (open < 0) break
    let depth = 0
    for (let j = open; j < body.length; j++) {
      if (body[j] === '{') depth++
      else if (body[j] === '}' && --depth === 0) {
        if (at > open && at < j) return true
        i = open
        break
      }
    }
  }
  return false
}

describe('실패를 { ok:false, error } 로 반환하는 경로', () => {
  // 이 셋은 렌더러가 저장 버튼을 눌렀을 때의 경로다. 게이트웨이가 못 뜨면 "저장 실패" 로
  // 돌려줘야지 예외로 터지면 안 된다.
  for (const channel of ['save-channels', 'set-twixy-mode', 'retry-openclaw']) {
    it(`${channel} — startOpenClaw 를 try/catch 로 감싸고 error 를 반환한다`, () => {
      const body = handlerBody(channel)
      expect(body, channel).toContain('await startOpenClaw()')
      expect(body, channel).toContain('catch')
      expect(body, channel).toMatch(/return \{ ok: false, error/)
      // 핸들러에 try 가 여러 개일 수 있으므로 '감쌌는지' 를 실제로 계산한다.
      expect(isInsideTry(body, 'await startOpenClaw()'), channel).toBe(true)
    })
  }
})

describe('실패를 그대로 throw 하는 경로', () => {
  it('respawnGateway — catch 가 없다 (호출부가 처리한다)', () => {
    const body = functionBody('respawnGateway')
    expect(body).toContain('await startOpenClaw()')
    expect(body).not.toContain('catch')
  })
})

describe('상태 정리는 한 곳으로 모였다', () => {
  it('killGatewayIfRunning 이 재기동 경로 7곳에서 쓰인다', () => {
    const calls = SRC.split('killGatewayIfRunning()').length - 1
    // 선언 1 + 호출 7. 7번째는 제품 확장의 restartAgentRuntime (main.ts initProductIpc 의 restartGateway)
    // — respawnGateway 와 같이 **throw** 계약이다 (호출부인 products/<id>/electron 이 처리한다).
    expect(calls).toBe(8)
  })

  it('openclawProcess 를 직접 비우는 곳은 4군데뿐', () => {
    // killGatewayIfRunning · clearGatewayProcess(접근자) · exit 핸들러 · stopOpenClaw.
    // (키 재발급은 슬라이스 7 부터 clearGatewayProcess() 를 거친다 — 직접 대입이 아니다.)
    // 늘어났다면 또 복붙된 것이다 — 헬퍼를 쓰거나, 모양이 다른 이유를 남길 것.
    expect(SRC.split('openclawProcess = null').length - 1).toBe(4)
  })

  it('killGatewayIfRunning 은 재기동을 하지 않는다 (상태 정리까지만)', () => {
    const body = functionBody('killGatewayIfRunning')
    expect(body).toContain('openclawProcess.kill()')
    expect(body).toContain('openclawProcess = null')
    expect(body).not.toContain('startOpenClaw')   // 합치는 순간 실패 계약이 뭉개진다
  })
})
