// ─────────────────────────────────────────────────────────────────────────────
// e2e-packaged-turn.mjs — 패키지 앱에서 "실제 모델 한 턴"이 도는지 확인한다.
//
// 왜 스모크로 부족한가: smoke-packaged.mjs 는 게이트웨이 기동·핸드셰이크·토큰 보존만 본다.
// 2026-09-20 에 번들 슬림화가 openclaw 의 docs/reference/templates 까지 지워서
// 세션 첫 턴이 통째로 죽는 회귀가 났는데(Missing workspace template: AGENTS.md),
// 스모크는 턴을 돌리지 않아 전부 통과했다. 그 계층(세션 생성 → 키 핸드아웃 → 모델 호출)을
// 실제로 한 번 통과시키는 게 이 스크립트다.
//
// 같이 확인되는 것: Supabase 세션 복원 → twixy.dev 키 핸드아웃 → OpenRouter 호출.
// (로그인 세션이 없으면 키가 없어 모델 호출 단계에서 실패한다 — 그 자체가 신호다.)
//
// 전제: 패키지 앱이 이미 떠 있어야 한다. 비용이 든다(질문 한 줄, 보통 $0.01 미만).
//
// 사용:
//   node scripts/e2e-packaged-turn.mjs
//   node scripts/e2e-packaged-turn.mjs --port 18889 --state-dir ~/.nodal-agent   # Nodal
// 종료 코드 0 = 통과, 1 = 실패.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt }
const PORT = Number(arg('port', 18789))
const STATE_DIR = path.resolve(arg('state-dir', path.join(os.homedir(), '.openclaw')).replace(/^~/, os.homedir()))
const TIMEOUT_MS = Number(arg('timeout', 180_000))
// 패키지 렌더러와 같은 조건. localhost origin 으로는 통과하는 버그가 file:// 에서 안 통과한 이력이 있다.
const ORIGIN = arg('origin', 'file://')

const oc = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'openclaw.json'), 'utf8'))
const TOKEN = oc?.gateway?.auth?.token ?? null

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN })
    const pending = new Map()
    const subs = []
    const rpc = (method, params, timeoutMs = 20_000) => new Promise((res, rej) => {
      const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      pending.set(id, res)
      setTimeout(() => { if (pending.delete(id)) rej(new Error(`RPC timeout: ${method}`)) }, timeoutMs)
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
    ws.on('message', async (data) => {
      let f; try { f = JSON.parse(data.toString()) } catch { return }
      if (f.event === 'connect.challenge') {
        try {
          const auth = await rpc('connect', {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'openclaw-control-ui', displayName: 'E2E Turn Check', version: '0.1.0', platform: process.platform, mode: 'ui' },
            caps: [], auth: TOKEN ? { token: TOKEN } : undefined,
            role: 'operator', scopes: ['operator.admin', 'operator.write', 'operator.read'],
          })
          if (!auth.ok) return reject(new Error('auth rejected: ' + (auth.error?.message ?? '')))
          resolve({ ws, rpc, onEvent: (fn) => subs.push(fn) })
        } catch (e) { reject(e) }
        return
      }
      if (f.id && typeof f.ok === 'boolean') { const cb = pending.get(f.id); if (cb) { pending.delete(f.id); cb(f) } return }
      for (const fn of subs) fn(f)
    })
    ws.on('error', reject)
    ws.on('close', () => { for (const fn of subs) fn({ event: 'ws.closed' }) })
  })
}

function fail(msg) { console.error(`[e2e-turn] FAIL — ${msg}`); process.exit(1) }

const conn = await connect().catch(e => fail(`핸드셰이크: ${e.message}`))
console.log(`[e2e-turn] 핸드셰이크 ok (origin ${ORIGIN}, token ${TOKEN ? '…' + String(TOKEN).slice(-4) : '없음'})`)

const created = await conn.rpc('sessions.create', { agentId: 'workflow-runner' })
if (!created.ok || !created.payload?.key) fail(`sessions.create: ${JSON.stringify(created.error ?? {})}`)
const key = created.payload.key
await conn.rpc('sessions.messages.subscribe', { key })

const answer = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`턴이 ${TIMEOUT_MS}ms 안에 안 끝남`)), TIMEOUT_MS)
  let last = ''
  conn.onEvent((f) => {
    const evtKey = f.payload?.sessionKey ?? f.payload?.key
    if (evtKey && evtKey !== key) return
    if (f.event === 'session.message' && f.payload?.message?.role === 'assistant') {
      const c = f.payload.message.content
      last = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('') : last
    } else if (f.event === 'chat') {
      if (f.payload?.state === 'final') { clearTimeout(t); resolve(last) }
      // errorMessage 는 게이트웨이가 payload 최상단에 넣는다 — 템플릿 누락 같은 원인이 여기 담긴다.
      else if (f.payload?.state === 'error') { clearTimeout(t); reject(new Error(f.payload?.errorMessage ?? f.payload?.error?.message ?? 'chat_error')) }
    } else if (f.event === 'ws.closed') { clearTimeout(t); reject(new Error('소켓이 턴 도중 끊김')) }
  })
  conn.rpc('sessions.send', { key, message: 'Answer in one short line, no tools: what is the capital city of South Korea?' }, TIMEOUT_MS)
    .catch(e => { clearTimeout(t); reject(e) })
})
  .catch(async (e) => { try { await conn.rpc('sessions.delete', { key }) } catch { /* best effort */ } fail(e.message) })

const text = (answer || '').trim()
if (!text) fail('응답이 비어 있다')
console.log(`[e2e-turn] 응답: ${JSON.stringify(text.slice(0, 160))}`)

const today = new Date().toISOString().slice(0, 10)
try {
  const u = await conn.rpc('sessions.usage', { key, startDate: today, endDate: today, limit: 1 })
  const t = u.payload?.totals || {}
  console.log(`[e2e-turn] 비용 usd=${(+t.totalCost || 0).toFixed(5)} in=${(+t.input || 0) + (+t.cacheRead || 0)} out=${+t.output || 0}`)
} catch { /* usage 는 부가 정보 — 없어도 통과 */ }

try { await conn.rpc('sessions.delete', { key }) } catch { /* best effort */ }
conn.ws.close()
console.log('[e2e-turn] PASS — 세션 생성 → 키 핸드아웃 → 모델 호출 → 응답')
process.exit(0)
