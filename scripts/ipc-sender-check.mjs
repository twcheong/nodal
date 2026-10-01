// ─────────────────────────────────────────────────────────────────────────────
// ipc-sender-check.mjs — 패키지 앱에서 main 의 신뢰 경계가 실제로 맞는지 확인한다.
//
// 왜 필요한가: 판정 로직(windowEntry.ts / trustBoundary.ts / fileTypes.ts)은 표 기반 단위
// 테스트로 덮지만, **Electron 이 실제로 주는 값**(senderFrame.url, 진짜 경로, 진짜 설정 파일)과
// 맞물리는지는 패키지 앱에서만 알 수 있다 (vitest 는 main.ts 를 못 띄운다). 그리고 여기서
// 틀리면 구멍보다 나쁘다 — 정상 창이 거부되어 "게이트웨이에 안 붙는다"로 보인다.
//
// 덮는 것:
//   1) 창 표면      — 메인 창은 전체, 보조 창은 자기 것만 (main 전용 메서드가 아예 없다)
//   2) open-file    — 실행형 확장자는 거부되는가 (D3)
//   3) set-project-dir — 다이얼로그로 고르지 않은 경로는 거부되는가 (D1)
//   4) 비밀값 마스킹 — 평문이 안 나오는가 / **안 건드린 저장이 진짜 값을 지키는가** (D5)
//
// 앱을 디버깅 포트와 함께 띄워야 한다:
//   Twixy.exe --remote-debugging-port=9223
//   node scripts/ipc-sender-check.mjs [--port 9223] [--state-dir <dir>] [--read-only]
// 종료 코드 0 = 통과, 1 = 실패.
//
// ── 이 스크립트가 지키는 규칙 ────────────────────────────────────────────────
// · **비밀값을 절대 출력하지 않는다.** 끝 4자까지만 (마스크가 보여 주는 만큼).
// · **바꾼 것은 되돌린다.** 4번은 설정 파일을 먼저 백업하고, 끝나면 백업의 평문으로 다시
//   저장해 파일·openclaw.json·게이트웨이를 원래대로 돌린다. 되돌릴 수 없으면 건너뛰고
//   이유를 찍는다 — 사용자의 살아 있는 토큰이 들어 있는 파일이다.
// · 4번은 save-channels 를 여러 번 부르고, 그때마다 **게이트웨이가 재시작된다**(진행 중인
//   세션이 끊긴다). 읽기만 하려면 --read-only.
// · 2번은 열리는 쪽(allowlist 통과)을 **확인하지 않는다** — 확인하려면 실제로 앱이 떠야 해서다.
//   그쪽은 shared/fileTypes.test.ts 가 덮고, 여기서는 거부되는 쪽만 본다.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt }
const has = (name) => process.argv.includes(`--${name}`)
const PORT = arg('port', '9223')
const READ_ONLY = has('read-only')

/** 마스크 접두사 (shared/secretMask.ts 와 같은 문자). 이 글자가 파일에 있으면 사고다. */
const MASK = '\u2022'
/** 로그에 남겨도 되는 만큼만. 비밀 본문은 절대 찍지 않는다. */
const tail4 = (v) => (typeof v === 'string' && v.length > 4 ? v.slice(-4) : '(short)')

const pages = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
  if (!r) { console.error(`[ipc-check] FAIL — CDP :${PORT} 에 못 붙음. 앱을 --remote-debugging-port=${PORT} 로 띄웠는가?`); process.exit(1) }
  return (await r.json()).filter(t => t.type === 'page')
}

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 50 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  let id = 0
  const pend = new Map()
  ws.on('message', d => { const m = JSON.parse(d.toString()); const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m) } })
  const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  return {
    close: () => ws.close(),
    eval: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      return r.result?.exceptionDetails ? String(r.result.exceptionDetails.text) : r.result?.result?.value
    },
  }
}

const results = []
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`) }
const skip = (name, why) => { console.log(`  [SKIP] ${name} — ${why}`) }

/** 렌더러에서 IPC 를 부르고 결과를 JSON 으로 받는다.
 *  `await` 를 빼면 Promise 를 stringify 해서 항상 '{}' 가 돌아온다 — 조용히 전부 통과하는 함정. */
const call = (page, expr) => page.eval(`(async()=>JSON.stringify(await (${expr})))()`).then(s => {
  try { return JSON.parse(s) } catch { return s }
})

// ── 제품별 상태 폴더 찾기 ────────────────────────────────────────────────────
// 패키지 앱이 어느 제품인지 스크립트는 모른다. 알려진 조합을 훑어 채널 파일이 있는 쪽을 쓴다.
// products/<id>/profile.ts 의 stateDirName · stateFilePrefix 와 같아야 한다.
const KNOWN_STATE = [
  { dir: '.openclaw',    prefix: 'twixy' },   // twixy · twixy-enterprise
  { dir: '.nodal-agent', prefix: 'nodal' },   // nodal
]
function findState() {
  const override = arg('state-dir', null)
  const candidates = override
    ? KNOWN_STATE.map(s => ({ ...s, abs: override }))
    : KNOWN_STATE.map(s => ({ ...s, abs: path.join(os.homedir(), s.dir) }))
  for (const c of candidates) {
    const channels = path.join(c.abs, `${c.prefix}-channels.json`)
    if (fs.existsSync(channels)) return { ...c, channels, openclaw: path.join(c.abs, 'openclaw.json') }
  }
  return null
}

console.log(`[ipc-check] CDP :${PORT}${READ_ONLY ? ' · read-only' : ''}`)

const mainTarget = (await pages()).find(p => /index\.html/.test(p.url))
if (!mainTarget) { console.error('[ipc-check] FAIL — 메인 창 타깃을 못 찾음'); process.exit(1) }
const main = await attach(mainTarget)

// ── 1) 창 표면 — 메인은 전체, 보조 창은 자기 것만 ───────────────────────────
console.log('\n[1] 발신자 검증')
const token = await main.eval(`(async()=>{const t=await window.twixy.getGatewayToken(); return t?'ok':String(t)})()`)
record('메인 창 get-gateway-token', token === 'ok', token === 'ok' ? '토큰 받음' : `${token} — 정상 창이 거부됨`)

const session = await main.eval(`(async()=>{const s=await window.twixy.authGetSession(); return s?'ok':String(s)})()`)
// 로그아웃 상태면 정상적으로 null 이다 — 거부와 구분이 안 되므로 그때는 판정하지 않는다.
record('메인 창 auth-get-session', true, session === 'ok' ? '세션 받음' : `${session} (로그아웃 상태면 정상 — 판정 제외)`)

await main.eval(`window.twixy.openTestOverlay()`)
await new Promise(r => setTimeout(r, 4000))
const overlayTarget = (await pages()).find(p => /test-overlay\.html/.test(p.url))
if (!overlayTarget) {
  record('보조 창 차단', false, 'test-overlay 창이 안 떠서 확인 못 함')
} else {
  const o = await attach(overlayTarget)
  // Stage 5 slice 3 이후: 보조 창은 preload 표면부터 좁다 (electron/preload.ts 의 PER_WINDOW).
  // 예전엔 여기서 '불러 보고 null/forbidden_sender 가 오는가' 를 봤다 — 이제 **함수 자체가 없다**.
  // 더 강한 보장이라 검사도 그쪽으로 옮겼다: 부를 수 없으면 main 의 거부에 기대지 않아도 된다.
  // (핸들러의 발신자 검증은 심층 방어로 남아 있다. 표 기반 판정은 electron/windowEntry.test.ts,
  //  어느 창이 어느 채널을 받는지는 electron/windows.contract.test.ts 가 덮는다. 진짜 창에서
  //  거부 경로를 불러 보는 건 이제 불가능하다 — 그 함수가 창에 없다는 게 이 검사의 결론이다.)
  const MAIN_ONLY = ['getGatewayToken', 'authGetSession', 'overlaySend', 'getChannels', 'openTestOverlay']
  const absent = await o.eval(`JSON.stringify(${JSON.stringify(MAIN_ONLY)}.filter(n => typeof window.twixy[n] !== 'undefined'))`)
  const leaked = JSON.parse(absent)
  record('보조 창 main 전용 메서드 부재', leaked.length === 0,
    leaked.length === 0 ? `${MAIN_ONLY.length}개 전부 undefined` : `표면에 남아 있다: ${leaked.join(', ')}`)
  // 좁히다가 그 창이 정작 쓰는 것까지 없애면 창이 조용히 망가진다 — 양쪽을 같이 본다.
  const own = await o.eval(`JSON.stringify([typeof window.twixy.applyDisplayMarkup, typeof (window.twixyTestOverlay||{}).requestSync, Object.keys(window.twixy).length])`)
  const [markup, reqSync, surfaceSize] = JSON.parse(own)
  record('보조 창 자기 표면 유지', markup === 'function' && reqSync === 'function',
    `applyDisplayMarkup=${markup} · twixyTestOverlay.requestSync=${reqSync} · window.twixy 키 ${surfaceSize}개`)
  o.close()
  await main.eval(`window.twixy.closeTestOverlay()`)
}

// ── 2) open-file — 실행형 확장자 거부 (D3) ───────────────────────────────────
// 워크스페이스 안에 실행형 파일을 만들어 두고(에이전트가 할 수 있는 일), 열기를 요청한다.
// **열리는 쪽은 확인하지 않는다** — 통과시키면 실제로 앱이 뜬다. 그쪽은 단위 테스트 담당.
console.log('\n[2] open-file 확장자 allowlist (D3)')
if (READ_ONLY) {
  skip('open-file 거부', '--read-only (워크스페이스에 임시 파일을 만들어야 한다)')
} else {
  const stamp = Date.now().toString(36)
  for (const ext of ['bat', 'lnk']) {
    const rel = `data/tmp/ipc-check-${stamp}.${ext}`
    const wrote = await call(main, `window.twixy.writeFile(${JSON.stringify(rel)}, 'ipc-sender-check scratch')`)
    if (!wrote?.ok) { skip(`open-file .${ext} 거부`, `임시 파일을 못 만듦: ${JSON.stringify(wrote)}`); continue }
    const opened = await call(main, `window.twixy.openFile(${JSON.stringify(rel)})`)
    const err = String(opened?.error ?? '')
    // 'file not found' 가 아니라 **확장자** 때문에 거부됐는지까지 본다 (검사 순서 확인).
    const blocked = opened?.ok === false && /can't be opened/i.test(err)
    record(`open-file .${ext} 거부`, blocked, blocked ? `거부 + 사유 노출: "${err.slice(0, 60)}…"` : `기대와 다름: ${JSON.stringify(opened)}`)
    const del = await call(main, `window.twixy.deleteFile(${JSON.stringify(rel)})`)
    if (!del?.ok) console.log(`  [warn] 임시 파일 정리 실패 — 직접 지울 것: ${rel}`)
  }
  skip('open-file 허용 확장자', '통과시키면 실제로 앱이 뜬다 — shared/fileTypes.test.ts 가 덮는다')
}

// ── 3) set-project-dir — 다이얼로그로 고른 경로만 (D1) ───────────────────────
console.log('\n[3] set-project-dir 출처 검사 (D1)')
const platform = await main.eval(`window.twixy.platform`)
const bogus = platform === 'win32' ? 'C:\\twixy-ipc-check-never-picked' : '/tmp/twixy-ipc-check-never-picked'
const rejected = await call(main, `window.twixy.setProjectDir(${JSON.stringify(bogus)})`)
record('고르지 않은 경로 거부', rejected?.ok === false && rejected?.error === 'not_user_picked', JSON.stringify(rejected))

const curDir = await main.eval(`(async()=>await window.twixy.getProjectDir())()`)
if (READ_ONLY) {
  skip('현재 폴더 no-op 수락', '--read-only (게이트웨이가 재시작된다)')
} else if (!curDir) {
  skip('현재 폴더 no-op 수락', '프로젝트 폴더가 아직 설정되지 않음(기본 워크스페이스) — 되돌릴 기준이 없다')
} else {
  const noop = await call(main, `window.twixy.setProjectDir(${JSON.stringify(curDir)})`)
  const after = await main.eval(`(async()=>await window.twixy.getProjectDir())()`)
  record('현재 폴더 no-op 수락', noop?.ok === true && after === curDir, noop?.ok ? '수락 + 경로 그대로' : JSON.stringify(noop))
}

// ── 4) 비밀값 마스킹 (D5) ────────────────────────────────────────────────────
// 여기가 이 스크립트에서 유일하게 **조용한 데이터 손실**이 가능한 자리다. 그래서:
//   먼저 파일을 백업 → 읽기 검증 → "안 건드린 저장" → 진짜 값이 그대로인지 파일로 확인
//   → 어긋나면 백업의 평문으로 즉시 되돌리고 나머지 단계는 하지 않는다.
console.log('\n[4] 비밀값 마스킹 (D5)')
const state = findState()
const SECRETS = [
  ['telegram', 'botToken'], ['discord', 'token'],
  ['slack', 'botToken'], ['slack', 'appToken'], ['bluebubbles', 'password'],
]
const secretsOf = (cfg) => SECRETS
  .map(([ch, field]) => [`${ch}.${field}`, cfg?.[ch]?.[field]])
  .filter(([, v]) => typeof v === 'string' && v.length > 0)

if (!state) {
  skip('채널 마스킹', `상태 폴더를 못 찾음 (--state-dir 로 지정 가능). 찾아본 곳: ${KNOWN_STATE.map(s => s.dir).join(', ')}`)
} else {
  const backupRaw = fs.readFileSync(state.channels, 'utf8')
  const backup = JSON.parse(backupRaw)
  const storedSecrets = secretsOf(backup)

  // 4-1. 읽기 — 평문이 렌더러로 나오면 안 된다.
  const fromIpc = await call(main, `window.twixy.getChannels()`)
  const ipcSecrets = secretsOf(fromIpc)
  if (storedSecrets.length === 0) {
    skip('채널 마스킹', '저장된 채널 비밀값이 없다 — 확인할 대상이 없음')
  } else {
    const allMasked = ipcSecrets.length > 0 && ipcSecrets.every(([, v]) => v.startsWith(MASK))
    const leaked = ipcSecrets.filter(([k, v]) => storedSecrets.some(([sk, sv]) => sk === k && sv === v))
    record('get-channels 는 마스크만 준다', allMasked && leaked.length === 0,
      allMasked && leaked.length === 0
        ? `${ipcSecrets.length}개 필드 마스킹 (끝 4자: ${ipcSecrets.map(([k, v]) => `${k}=${tail4(v)}`).join(', ')})`
        : `평문 노출 의심: ${leaked.map(([k]) => k).join(', ') || '(마스크 아님)'}`)

    // 4-2. **안 건드린 저장** — 조용한 손실이 나는 자리.
    if (READ_ONLY) {
      skip('안 건드린 저장이 진짜 값을 지킨다', '--read-only (저장 시 게이트웨이가 재시작된다)')
    } else {
      console.log('  … save-channels 호출 — 게이트웨이가 재시작된다')
      const saved = await call(main, `window.twixy.saveChannels(${JSON.stringify(fromIpc)})`)
      const afterRaw = fs.readFileSync(state.channels, 'utf8')
      const after = JSON.parse(afterRaw)
      const afterSecrets = secretsOf(after)
      const preserved = storedSecrets.every(([k, v]) => afterSecrets.some(([ak, av]) => ak === k && av === v))
      const maskOnDisk = afterRaw.includes(MASK)
      const ok = saved?.ok !== false && preserved && !maskOnDisk
      record('안 건드린 저장이 진짜 값을 지킨다', ok,
        ok ? `${storedSecrets.length}개 필드 그대로 (끝 4자 일치), 파일에 마스크 없음`
           : `${maskOnDisk ? '파일에 마스크가 저장됐다' : '값이 바뀌었다'} — 백업으로 되돌린다`)

      if (!ok) {
        // 평문으로 다시 저장하면 파일·openclaw.json·게이트웨이가 한 번에 복구된다
        // (mergeSecret 은 마스크가 아닌 값을 그대로 통과시키므로 구현이 깨져 있어도 동작한다).
        await call(main, `window.twixy.saveChannels(${JSON.stringify(backup)})`)
        const healed = secretsOf(JSON.parse(fs.readFileSync(state.channels, 'utf8')))
        console.log(`  [restore] 백업으로 복구 ${healed.length === storedSecrets.length ? '성공' : '실패 — 원본: ' + state.channels}`)
        console.log('  [restore] 이후 단계는 건너뛴다 (같은 경로를 또 건드리지 않는다)')
      } else {
        // openclaw.json 에도 마스크가 새지 않았는지 (게이트웨이가 읽는 파일).
        if (fs.existsSync(state.openclaw)) {
          const gw = fs.readFileSync(state.openclaw, 'utf8')
          const gwHasChannels = /"channels"\s*:/.test(gw)
          if (gwHasChannels) record('openclaw.json 에 마스크가 없다', !gw.includes(MASK), gw.includes(MASK) ? '게이트웨이 설정에 마스크가 들어갔다' : '진짜 값 유지')
          else skip('openclaw.json 채널 블록', '활성화된 채널이 없어 블록이 생성되지 않음')
        }

        // 4-3. clear / 교체 — **사용자의 진짜 토큰은 건드리지 않는다.**
        // 설정되지 않은 채널 슬롯 하나를 임시로 빌려 쓰고, 끝나면 키째 지운다.
        // enabled:false 라 buildChannelsBlock 이 openclaw.json 에 내보내지 않는다(가짜 서버 접속 없음).
        const freeSlot = ['bluebubbles', 'discord', 'telegram'].find(k => !backup[k])
        if (!freeSlot) {
          skip('clear / 교체', '빈 채널 슬롯이 없다 — 진짜 토큰을 지웠다 되돌리는 시험은 하지 않는다')
        } else {
          const field = freeSlot === 'discord' ? 'token' : freeSlot === 'telegram' ? 'botToken' : 'password'
          const send = async (value) => {
            const next = { ...fromIpc }
            next[freeSlot] = value === null ? undefined : { enabled: false, [field]: value }
            if (value === null) delete next[freeSlot]
            await call(main, `window.twixy.saveChannels(${JSON.stringify(next)})`)
            return JSON.parse(fs.readFileSync(state.channels, 'utf8'))
          }
          console.log(`  … 빈 슬롯 '${freeSlot}' 을 빌려 쓴다 (enabled:false, 끝나면 제거) — 저장 3회 = 재시작 3회`)
          const A = 'ipc-check-value-AAAA', B = 'ipc-check-value-BBBB'

          const setA = await send(A)
          record('새 값 저장', setA?.[freeSlot]?.[field] === A, `${freeSlot}.${field} = …${tail4(A)}`)

          const setB = await send(B)
          record('기존 값 교체', setB?.[freeSlot]?.[field] === B, `…${tail4(A)} → …${tail4(B)}`)

          const cleared = await send('')
          const goneValue = cleared?.[freeSlot]?.[field]
          record('clear 하면 값이 사라진다', !goneValue, goneValue ? '값이 남아 있다' : '빈 값으로 저장됨')

          const restored = await send(null)
          const slotGone = !restored?.[freeSlot]
          const realsOk = storedSecrets.every(([k, v]) => secretsOf(restored).some(([ak, av]) => ak === k && av === v))
          record('빌린 슬롯 원상복구', slotGone && realsOk,
            slotGone ? (realsOk ? '슬롯 제거 + 진짜 토큰 그대로' : '슬롯은 제거됐으나 진짜 토큰이 바뀌었다')
                     : `슬롯이 남아 있다 — 직접 확인: ${state.channels}`)
          if (!realsOk) {
            await call(main, `window.twixy.saveChannels(${JSON.stringify(backup)})`)
            console.log(`  [restore] 백업으로 복구 시도 — 원본: ${state.channels}`)
          }
        }
      }
    }
  }

  // 4-4. BYOK 키 — 읽기 마스킹 + 안 건드린 저장 (게이트웨이 재시작 없음)
  const profiles = await call(main, `window.twixy.getAuthProfiles()`)
  const keyIds = profiles && typeof profiles === 'object'
    ? Object.keys(profiles).filter(id => typeof profiles[id]?.key === 'string' && profiles[id].key.length > 0)
    : []
  if (keyIds.length === 0) {
    skip('BYOK 키 마스킹', '저장된 API 키가 없다 (twixy 모드면 정상)')
  } else {
    const allMasked = keyIds.every(id => profiles[id].key.startsWith(MASK))
    record('get-auth-profiles 는 마스크만 준다', allMasked,
      allMasked ? `${keyIds.length}개 키 마스킹 (${keyIds.map(id => `${id}=${tail4(profiles[id].key)}`).join(', ')})` : '평문이 나왔다')

    const model = await main.eval(`(async()=>await window.twixy.getAgentModel())()`)
    if (READ_ONLY) skip('BYOK 안 건드린 저장', '--read-only')
    else if (!model) skip('BYOK 안 건드린 저장', '현재 모델을 못 읽어 같은 값으로 저장할 수 없다')
    else {
      const keysPayload = {
        anthropic: profiles['anthropic:default']?.key ?? '',
        openai:    profiles['openai:default']?.key ?? '',
      }
      await call(main, `window.twixy.saveApiKeys({ keys: ${JSON.stringify(keysPayload)}, model: ${JSON.stringify(model)} })`)
      const reread = await call(main, `window.twixy.getAuthProfiles()`)
      const same = keyIds.every(id => reread?.[id]?.key === profiles[id].key)
      record('BYOK 안 건드린 저장이 키를 지킨다', same,
        same ? `끝 4자 그대로 (${keyIds.map(id => tail4(profiles[id].key)).join(', ')})` : '키가 바뀌었다 — auth-profiles.json 확인 필요')
    }
  }
}

main.close()

const failed = results.filter(r => !r.ok).length
console.log(`\n[ipc-check] ${failed ? 'FAIL' : 'PASS'} — ${results.length - failed} pass / ${failed} fail`)
process.exit(failed ? 1 : 0)
