// ─────────────────────────────────────────────────────────────────────────────
// smoke-packaged.mjs — 패키지 빌드 스모크 (리팩토링 단계 게이트용).
//
// 왜: 2026-09 의 회귀 4건(1008 control-ui 거절, gateway.auth.token 유실→재시작 루프,
// prepare 단계 실패, 설치 누락)이 전부 *패키지 빌드에서만* 났다. dev(localhost:5173)
// 는 secure context + isDev 분기라 같은 버그를 숨긴다. 그래서 게이트는 패키지로 확인한다.
//
// 확인하는 것:
//   1) 패키지 exe 가 떠서 게이트웨이(127.0.0.1:<port>)가 listen 한다
//   2) 패키지 렌더러와 같은 조건(Origin: file://, 토큰만, device identity 없음)의
//      control-ui 핸드셰이크가 통과한다  ← 1008 회귀 검출
//   3) 기동 중 설정 재작성이 gateway.auth.token 을 바꾸지 않는다 ← 토큰 유실 회귀 검출
//      (이전 실행에서 만들어진 토큰이 있을 때만 판정. 첫 실행이면 skip 으로 표시)
//   4) 일정 시간 뒤에도 프로세스가 살아 있다 (즉시 크래시 아님)
//
// 확인 못 하는 것: 로그인/재로그인, 워크플로 산출(수동 체크리스트).
// 모델 한 턴이 실제로 도는지는 이 스크립트 다음에 scripts/e2e-packaged-turn.mjs 로 본다 —
// 스모크만으로는 세션 턴이 통째로 죽는 회귀(2026-09-20 워크스페이스 템플릿 누락)를 못 잡았다.
//
// 사용:
//   node scripts/smoke-packaged.mjs                                  # release/win-unpacked/Twixy.exe
//   node scripts/smoke-packaged.mjs --exe <path> --state-dir <dir> --port 18789
// 종료 코드 0 = 통과, 1 = 실패.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt }
const EXE = path.resolve(arg('exe', path.join(ROOT, 'release', 'win-unpacked', 'Twixy.exe')))
const STATE_DIR = path.resolve(arg('state-dir', path.join(os.homedir(), '.openclaw')))
const PORT = Number(arg('port', 18789))
const LISTEN_TIMEOUT_MS = 120_000   // 첫 실행은 Node 런타임 설치까지 있어 느릴 수 있다
const ALIVE_AFTER_MS = 8_000

const results = []
const record = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`  [${status}] ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const readToken = () => {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'openclaw.json'), 'utf8'))?.gateway?.auth?.token ?? null } catch { return null }
}
const portOpen = () => new Promise(res => {
  const s = net.connect({ host: '127.0.0.1', port: PORT })
  s.once('connect', () => { s.destroy(); res(true) })
  s.once('error', () => res(false))
  s.setTimeout(1500, () => { s.destroy(); res(false) })
})
function killTree(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    else process.kill(-pid, 'SIGTERM')
  } catch { /* already gone */ }
}

// 패키지 렌더러와 같은 조건의 control-ui 핸드셰이크.
function handshake(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'file://' })
    const done = (ok, detail) => { try { ws.close() } catch { /* noop */ } resolve({ ok, detail }) }
    const timer = setTimeout(() => done(false, 'handshake timeout 20s'), 20_000)
    let connectId = null
    ws.on('message', (data) => {
      let f; try { f = JSON.parse(data.toString()) } catch { return }
      if (f.event === 'connect.challenge') {
        connectId = `smoke-${Date.now()}`
        ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-control-ui', displayName: 'Packaged Smoke', version: '0.0.0', platform: process.platform, mode: 'ui' },
          caps: [], auth: token ? { token } : undefined,
          role: 'operator', scopes: ['operator.admin', 'operator.write', 'operator.read'],
        } }))
      } else if (connectId && f.id === connectId) {
        clearTimeout(timer)
        done(f.ok === true, f.ok ? 'connect ok' : `rejected: ${f.error?.message ?? JSON.stringify(f.error)}`)
      }
    })
    ws.on('close', (code, reason) => { clearTimeout(timer); done(false, `closed ${code} ${String(reason)}`) })
    ws.on('error', (e) => { clearTimeout(timer); done(false, `ws error: ${e.message}`) })
  })
}

async function main() {
  console.log(`[smoke] exe=${EXE}\n[smoke] state-dir=${STATE_DIR} port=${PORT}`)
  if (!fs.existsSync(EXE)) { record('exe 존재', 'FAIL', '먼저 npm run dist:win (또는 --exe 지정)'); return finish() }
  if (await portOpen()) { record('사전조건: 포트 비어있음', 'FAIL', `:${PORT} 이미 사용 중 — 실행 중인 앱/게이트웨이를 끄고 다시`); return finish() }

  const tokenBefore = readToken()
  const child = spawn(EXE, [], { detached: process.platform !== 'win32', stdio: 'ignore' })
  let exited = null
  child.on('exit', (code) => { exited = code })

  try {
    // 1) listen
    const t0 = Date.now()
    let listening = false
    while (Date.now() - t0 < LISTEN_TIMEOUT_MS && exited === null) {
      if (await portOpen()) { listening = true; break }
      await sleep(2000)
    }
    if (!listening) { record('게이트웨이 listen', 'FAIL', exited !== null ? `앱이 종료됨(exit ${exited})` : `${LISTEN_TIMEOUT_MS / 1000}s 내 미기동`); return }
    record('게이트웨이 listen', 'PASS', `${Math.round((Date.now() - t0) / 1000)}s`)

    // 게이트웨이가 토큰을 (재)생성했다면 디스크에 쓸 시간을 준다.
    await sleep(3000)
    const tokenAfter = readToken()

    // 2) file:// 핸드셰이크
    // 포트가 열렸다고 핸드셰이크가 바로 되지는 않는다 — 기동 직후 첫 시도가 challenge 를 못 받고
    // 타임아웃하는 걸 실제로 봤다(같은 빌드로 다시 돌리면 통과). 게이트를 거짓 실패로 멈추지 않게
    // 창을 두고 재시도하되, 시도 횟수와 총 시간을 결과에 남겨 "느려짐"이 묻히지 않게 한다.
    let hs = null
    const hsT0 = Date.now()
    for (let attempt = 1; attempt <= 3; attempt++) {
      hs = await handshake(tokenAfter)
      if (hs.ok) { if (attempt > 1) hs.detail += ` (${attempt}번째 시도, ${Math.round((Date.now() - hsT0) / 1000)}s)`; break }
      if (attempt < 3) await sleep(5000)
    }
    record('control-ui 핸드셰이크 (Origin file://, 토큰만)', hs.ok ? 'PASS' : 'FAIL',
      hs.ok ? hs.detail : `3회 시도 실패 — 마지막: ${hs.detail}`)

    // 3) 토큰 보존
    if (!tokenBefore) record('gateway.auth.token 보존', 'SKIP', '이전 토큰 없음(첫 실행) — 한 번 더 돌리면 판정됨')
    else record('gateway.auth.token 보존', tokenBefore === tokenAfter ? 'PASS' : 'FAIL',
      tokenBefore === tokenAfter ? '기동 전후 동일' : '기동 중 토큰이 바뀜 = 설정 재작성이 토큰을 떨궜을 가능성')

    // 4) 생존
    await sleep(ALIVE_AFTER_MS)
    record('프로세스 생존', exited === null ? 'PASS' : 'FAIL', exited === null ? `${ALIVE_AFTER_MS / 1000}s 후 alive` : `exit ${exited}`)
  } finally {
    if (child.pid) killTree(child.pid)
  }
}

function finish() {
  const failed = results.filter(r => r.status === 'FAIL').length
  console.log(`[smoke] ${failed === 0 ? 'PASS' : 'FAIL'} — ${results.filter(r => r.status === 'PASS').length} pass / ${failed} fail / ${results.filter(r => r.status === 'SKIP').length} skip`)
  process.exit(failed === 0 ? 0 : 1)
}

main().then(finish).catch((e) => { console.error('[smoke] 예외:', e); process.exit(1) })
