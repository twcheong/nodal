// ─────────────────────────────────────────────────────────────────────────────
// wf-eval.mjs — 헤드리스 워크플로 eval / 하네스 A/B 러너.
//
// Electron GUI/콘솔 없이, 실행 중인 openclaw 게이트웨이(WS 18789)에 직접 붙어
// 워크플로를 변형(v1/v2/v3)별로 돌리고 노드별 비용/토큰/성공을 로깅한다. 실무의
// offline eval harness 방식. GUI·Cursor 콘솔 문제를 완전히 회피.
//
// 용도:
//   - 하네스/모델 변경 후 품질·비용·성공률을 재평가(회귀 검증). LLM-judge 로
//     변형 간 pairwise 품질 점수도 낸다(OpenRouter 키 있을 때).
//   - 전 워크플로가 실제 input 으로 도는지 스모크(INPUT_OVERRIDES 로 현실적 입력 주입).
//   ⚠ 라이브 게이트웨이 + 실제 모델 호출이라 비용이 든다 — CI 상시 실행용 아님,
//     변경 시점 수동/주기 실행용.
//
// 전제: 게이트웨이가 떠 있어야 함 → 다른 터미널에서 `npm run dev`(또는 패키지 앱
// 실행). 그 상태에서 이 스크립트 실행.
//
// 사용:
//   npx tsx scripts/wf-eval.mjs                       # 전 워크플로 × 선택 변형 1회
//   npx tsx scripts/wf-eval.mjs wf_seo_action_plan 3  # 특정 워크플로, 각 변형 3회
//
// 환경변수:
//   AB_VARIANTS=v1,v3         # 비교할 변형(기본 v1,v2,v3). 단일이면 judge 스킵.
//   AB_ORIGIN=file://         # WS Origin(기본 http://localhost:5173). 패키지 조건 재현 시 file://
//   AB_NODE_TIMEOUT_MS=540000 # 노드당 타임아웃(기본 540s = 앱과 동일)
//   AB_JUDGE_MODEL=...        # judge 모델(기본 anthropic/claude-sonnet-4.5)
//
// 결과: 콘솔 표 + scripts/.ab-results/<timestamp>.json 저장.
//
// 프롬프트는 **제품이 실제로 보내는 그것**이다 — src/lib/agents/workflowRunner.ts 의 빌더를
// 그대로 부른다 (그래서 이 스크립트는 tsx 로 돈다). 예전엔 여기 얇은 사본이 있었고 프로덕션만
// 자라서, 이 eval 이 제품이 보내지 않는 프롬프트를 재고 있었다.
//
// ⚠️ 기록된 A/B 결과(scripts/.ab-results/, WORKFLOW_RUNNER_V3_SOUL.md 의 v3 8.3 vs baseline 6.95)와
//    지금 수치는 **비교할 수 없다**. 그 숫자들은 얇은 사본으로 측정된 것이고, 지금은 프롬프트가
//    더 두껍다(토큰↑) + NODE_STATUS 자기보고를 읽어 예전 같으면 성공으로 보이던 run 이
//    실패로 잡힌다. 비교하려면 세 변형을 지금 코드로 다시 돌려야 한다 (실제 모델 비용 발생).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

// 제품이 쓰는 그 빌더·판정기를 그대로 부른다 (tsx 가 .ts 를 해석해준다).
import { buildWorkflowNodePrompt } from '../src/lib/agents/workflowRunner'
import { formatHarnessBlock } from '../src/lib/agents/harness'
import { detectNodeFailure, stripNodeStatus } from '../src/lib/nodeStatus'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const OPENCLAW_JSON = path.join(os.homedir(), '.openclaw', 'openclaw.json')
const WS_URL = 'ws://127.0.0.1:18789'
const NODE_TIMEOUT_MS = Number(process.env.AB_NODE_TIMEOUT_MS || 540000)   // 노드당 9분 (useWorkflowTest 와 동일 근거)

// ── config from openclaw.json ────────────────────────────────────────────────
const oc = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'))
const TOKEN = oc?.gateway?.auth?.token ?? null
const WORKSPACE = oc?.agents?.defaults?.workspace || oc?.workspace
if (!WORKSPACE) { console.error('workspace 경로를 openclaw.json 에서 못 찾음'); process.exit(1) }

// ── 전 워크플로 테스트용 실제 input 주입 (inp.id 기준) ──
const INPUT_OVERRIDES = {
  site_url: "https://example.com",
  store_url: "https://shop.example.com",
  max_pages: "12",
  domain: "example.com",
  seed_keyword: "강남 PT",
  market: "한국",
  business_name: "무브 헬스장",
  location: "서울 강남구 역삼동",
  category: "피트니스/PT 스튜디오",
  city: "서울 강남",
  keywords: "강남 PT, 강남 헬스장, 역삼 피트니스",
  competitors: "에이블짐, 스포애니, 커브스",
  client_name: "카페 무브",
  industry: "F&B / 스페셜티 카페",
  platforms: "Instagram, 네이버 블로그",
  brand_voice: "친근하고 감성적, 20-30대 타깃",
  page_urls: "https://example.com/product/1",
  fixes: JSON.stringify([{url:"https://example.com/product/1",title:"신상 러닝화 | 무브샵",meta:"가볍고 반응 좋은 러닝화"}]),
  audit_findings: JSON.stringify([
    {area:"Metadata",issue:"12페이지 meta description 누락",severity:"high"},
    {area:"Performance",issue:"모바일 LCP 4.8초",severity:"critical"},
    {area:"Crawlability",issue:"robots.txt가 /products/* 차단",severity:"critical"},
    {area:"Schema",issue:"제품 페이지 Product 스키마 없음",severity:"high"},
    {area:"Content",issue:"블로그 8편 thin content",severity:"medium"}
  ]),
};

// ── harness SOULs (변형별) ────────────────────────────────────────────────────
const readSoul = (f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf8').trim() } catch { return null } }
const SOULS = {
  v2: readSoul('WORKFLOW_RUNNER_V2_SOUL.md'),   // tool economy
  v3: readSoul('WORKFLOW_RUNNER_V3_SOUL.md'),   // reasoning & thoroughness
}
const harnessBlock = (soul) => soul ? formatHarnessBlock(soul) : ''

// ── args ─────────────────────────────────────────────────────────────────────
const argWf = process.argv[2] || null            // 특정 워크플로 id (없으면 비-browser 전체)
const runsPer = Number(process.argv[3] || 1)
// 변형: soul=null(v1, 하네스 없음) / SOULS.v2 / SOULS.v3. 새 하네스 추가 = 항목 하나.
// AB_VARIANTS 환경변수(csv)로 부분 선택 가능 (예: AB_VARIANTS=v1,v3).
const ALL_VARIANTS = [
  { label: 'v1', soul: null },
  { label: 'v2', soul: SOULS.v2 },
  { label: 'v3', soul: SOULS.v3 },
]
const pick = (process.env.AB_VARIANTS || 'v1,v2,v3').split(',').map(s => s.trim())
const VARIANTS = ALL_VARIANTS.filter(v => pick.includes(v.label) && (v.label === 'v1' || v.soul))

// ── 워크플로 로드 (browser 안 쓰는 것만 기본 대상) ─────────────────────────────
function loadWorkflows() {
  const dir = path.join(WORKSPACE, 'workflows')
  const out = []
  for (const id of fs.readdirSync(dir)) {
    const wfPath = path.join(dir, id, 'workflow.json')
    if (!fs.existsSync(wfPath)) continue
    let wf; try { wf = JSON.parse(fs.readFileSync(wfPath, 'utf8')) } catch { continue }
    if (wf?.version !== 1) continue
    const usesChrome = (wf.nodes || []).some(n => n.tool === 'chrome')
    out.push({ ...wf, _usesChrome: usesChrome })
  }
  return out
}

// 노드 프롬프트 — 제품과 같은 빌더. 변종(v1/v2/v3)은 하네스 블록만 갈아끼운다.
// promptStyle 'workflow-test': 사용자가 실제로 돌리는 Test run 경로와 같은 문구를 잰다.
function buildNodePrompt(wf, node, inputs, isFirst, soul) {
  return buildWorkflowNodePrompt({
    workflow: wf, node, inputs, isFirst,
    run: { promptStyle: 'workflow-test', harnessPreamble: harnessBlock(soul) },
  })
}

// ── WS 클라이언트 (useWorkflowTestSession 프로토콜 이식) ────────────────────────
function connectGateway() {
  return new Promise((resolve, reject) => {
    // 게이트웨이 controlUi.allowedOrigins 에 있는 origin 을 보내야 통과.
    const ws = new WebSocket(WS_URL, { origin: process.env.AB_ORIGIN || 'http://localhost:5173' })
    const pending = new Map()
    let subs = []   // (frame)=>void
    const rpc = (method, params, timeoutMs = 15000) => new Promise((res, rej) => {
      const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      pending.set(id, res)
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`RPC timeout: ${method}`)) } }, timeoutMs)
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
    ws.on('message', async (data) => {
      let f; try { f = JSON.parse(data.toString()) } catch { return }
      if (f.event === 'connect.challenge') {
        try {
          const auth = await rpc('connect', {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'openclaw-control-ui', displayName: 'AB Eval', version: '0.1.0', platform: process.platform, mode: 'ui' },
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

// 한 세션에서 텍스트 보내고 chat.final 까지 대기.
function sendAndAwait(conn, key, text, onEvent) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('turn_timeout')) }, NODE_TIMEOUT_MS)
    let lastText = ''
    const handler = (f) => {
      const evtKey = f.payload?.sessionKey ?? f.payload?.key
      if (evtKey && evtKey !== key) return
      if (f.event === 'session.message' && f.payload?.message?.role === 'assistant') {
        const c = f.payload.message.content
        lastText = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('') : lastText
      } else if (f.event === 'chat') {
        if (f.payload?.state === 'final') { cleanup(); resolve(lastText) }
        else if (f.payload?.state === 'error') { cleanup(); reject(new Error(f.payload?.error?.message ?? 'chat_error')) }
      } else if (f.event === 'ws.closed') { cleanup(); reject(new Error('ws_closed')) }
    }
    const off = onEvent(handler)
    function cleanup() { clearTimeout(t); const i = off; void i }
    conn.rpc('sessions.send', { key, message: text }, NODE_TIMEOUT_MS).catch(e => { cleanup(); reject(e) })
  })
}

async function sessionUsage(conn, key) {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const r = await conn.rpc('sessions.usage', { key, startDate: today, endDate: today, limit: 1 })
    const t = r.payload?.totals || {}
    return { usd: +t.totalCost || 0, tin: (+t.input || 0) + (+t.cacheRead || 0), tout: +t.output || 0 }
  } catch { return { usd: 0, tin: 0, tout: 0 } }
}

// ── 한 워크플로를 한 변형으로 실행 ─────────────────────────────────────────────
async function runOnce(conn, wf, variant) {
  const inputs = {}
  for (const inp of wf.inputs || []) inputs[inp.id] = INPUT_OVERRIDES[inp.id] ?? String(inp.observed ?? '')
  const res = await conn.rpc('sessions.create', { agentId: 'workflow-runner' })
  if (!res.ok || !res.payload?.key) throw new Error('sessions.create 실패')
  const key = res.payload.key
  await conn.rpc('sessions.messages.subscribe', { key })
  const onEvent = (fn) => { conn.onEvent(fn); return fn }

  const before = await sessionUsage(conn, key)
  const t0 = Date.now()
  let status = 'done', failReason = null
  const realNodes = (wf.nodes || []).filter(n => n.type !== 'review')  // review 노드는 auto-approve 취급, 전송 생략
  let isFirst = true
  const nodeOutputs = []   // 품질 채점(judge)용 아티팩트 캡처
  for (const node of realNodes) {
    const prompt = buildNodePrompt(wf, node, inputs, isFirst, variant.soul)
    isFirst = false
    try {
      const out = await sendAndAwait(conn, key, prompt, onEvent)
      // NODE_STATUS 자기보고를 **제품과 같은 판정기로** 읽는다. 이게 없으면 러너가
      // "못 했다" 고 산문으로 말해도 eval 은 성공으로 세고, 성공률·품질 점수가 부풀려진다.
      const failure = detectNodeFailure(out || '')
      if (failure) { status = 'failed'; failReason = failure; break }
      nodeOutputs.push({ node: node.title, text: stripNodeStatus(out || '').slice(0, 4000) })
    } catch (e) {
      status = 'failed'; failReason = e.message
      break
    }
  }
  const ms = Date.now() - t0
  // 비용 델타 — ledger 반영에 ~2s 지연이 있어 잠깐 대기 후 재조회.
  await new Promise(r => setTimeout(r, 2500))
  const after = await sessionUsage(conn, key)
  try { await conn.rpc('sessions.reset', { key, reason: 'ab-eval' }) } catch { /* noop */ }
  return {
    workflowId: wf.id, workflowTitle: wf.title, variant: variant.label,
    status, ms,
    costUsd: Math.max(0, after.usd - before.usd),
    tokensIn: Math.max(0, after.tin - before.tin),
    tokensOut: Math.max(0, after.tout - before.tout),
    nodes: realNodes.length,
    failReason,
    output: nodeOutputs.map(o => `## ${o.node}\n${o.text}`).join('\n\n'),
  }
}

// ── LLM-as-judge (pairwise) — Claude via OpenRouter로 v1 vs v2 품질 채점 ────────
// 교차검증: 피평가 모델(MiniMax)과 다른 회사(Anthropic) judge. 절대점수 대신
// pairwise + per-dimension 점수. 정답 없는 open-ended 태스크의 실무 방식.
const JUDGE_MODEL = process.env.AB_JUDGE_MODEL || 'anthropic/claude-sonnet-4.5'
const OR_KEY = oc?.models?.providers?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY

async function judgeMulti(wf, task, outputs) {
  // outputs: [{label, text}]. 순서/라벨 편향 방지 위해 익명 슬롯(1,2,3..)으로 제시.
  const rubric = [
    'completeness: 태스크가 요구한 걸 빠짐없이 다뤘는가 (모든 입력 항목/finding 반영)',
    'correctness: 사실·수치·논리가 맞는가 (모순/환각 없음)',
    'reasoning: 판단의 근거가 드러나는가 (예: impact vs effort 트레이드오프)',
    'actionability: 결과가 구체적이고 실행 가능한가',
  ]
  const slots = outputs.map((o, i) => ({ slot: String(i + 1), label: o.label, text: o.text }))
  const sys = `You are a strict evaluator of AI workflow outputs. Multiple candidate outputs for the SAME task are given, labeled by number. Score EACH on every dimension 1-10, then rank them best→worst. Output ONLY compact JSON: {"scores":{"1":{"completeness":n,"correctness":n,"reasoning":n,"actionability":n},"2":{...},...},"ranking":["1","2",...],"why":"one sentence on the top vs bottom"}. Be discriminating — do not give everything 8s or ties. An output that skips input items or gives verdicts without reasons must score low on completeness/reasoning even if short and clean.`
  const user = `Task ("${wf.title}"): ${task}\n\nDimensions:\n- ${rubric.join('\n- ')}\n\n` +
    slots.map(s => `=== OUTPUT ${s.slot} ===\n${(s.text || '(empty)').slice(0, 6000)}`).join('\n\n')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JUDGE_MODEL, temperature: 0, max_tokens: 700, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  })
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const txt = (await res.json())?.choices?.[0]?.message?.content || ''
  const m = txt.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('judge non-JSON: ' + txt.slice(0, 150))
  const parsed = JSON.parse(m[0])
  // 슬롯 번호 → 변형 label 매핑해서 반환.
  const byLabel = {}; const rankLabels = []
  for (const s of slots) byLabel[s.label] = parsed.scores?.[s.slot] || null
  for (const sl of (parsed.ranking || [])) { const found = slots.find(s => s.slot === String(sl)); if (found) rankLabels.push(found.label) }
  return { scores: byLabel, ranking: rankLabels, why: parsed.why || '' }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const all = loadWorkflows()
  const targets = argWf
    ? all.filter(w => w.id === argWf)
    : all   // 전체(브라우저 포함) — 사용자 요청
  if (!targets.length) { console.error('대상 워크플로 없음. (browser 워크플로는 id 명시 필요)'); process.exit(1) }

  console.log(`[ab-eval] 게이트웨이 연결...`)
  const conn = await connectGateway()
  console.log(`[ab-eval] 연결됨. 대상 ${targets.length}개 × 변형 ${VARIANTS.length} × ${runsPer}회`)

  const results = []
  let idx = 0
  const total = targets.length * VARIANTS.length * runsPer
  const taskDescOf = (wf) => (wf.inputs || []).map(i => `${i.label}: ${String(i.observed ?? '').slice(0, 500)}`).join(' | ') || wf.description || wf.title
  for (const wf of targets) {
    for (let run = 0; run < runsPer; run++) {
      const pair = {}   // variant.label → result (같은 run = 같은 입력 → judge 대상)
      for (const v of VARIANTS) {
        idx++
        process.stdout.write(`[ab-eval ${idx}/${total}] ${wf.title} · ${v.label} ... `)
        try {
          const r = await runOnce(conn, wf, v)
          results.push(r); pair[v.label] = r
          console.log(`${r.status} · $${r.costUsd.toFixed(4)} · ${(r.ms / 1000).toFixed(0)}s · out ${r.tokensOut}`)
        } catch (e) {
          const er = { workflowId: wf.id, workflowTitle: wf.title, variant: v.label, status: 'error', ms: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, failReason: e.message, output: '' }
          results.push(er); pair[v.label] = er
          console.log(`ERROR ${e.message}`)
        }
      }
      // 품질 채점 (multi-way): 이 run 의 모든 변형 산출물을 Claude judge 로 랭킹.
      const judgeable = VARIANTS.map(v => pair[v.label]).filter(r => r && r.status === 'done' && r.output)
      if (OR_KEY && judgeable.length >= 2) {
        try {
          const j = await judgeMulti(wf, taskDescOf(wf), judgeable.map(r => ({ label: r.variant, text: r.output })))
          for (const r of judgeable) {
            r._quality = j.scores[r.variant] || null
            r._rank = j.ranking.indexOf(r.variant) + 1   // 1=best
          }
          const avg = s => s ? +((s.completeness + s.correctness + s.reasoning + s.actionability) / 4).toFixed(1) : '?'
          console.log(`   ⚖ judge rank ${j.ranking.join('>')} | ${judgeable.map(r => `${r.variant}=${avg(r._quality)}`).join(' ')} — ${j.why}`)
        } catch (e) { console.log(`   ⚖ judge 실패: ${e.message}`) }
      }
    }
  }
  conn.ws.close()

  // 집계
  const qAvg = s => s ? (s.completeness + s.correctness + s.reasoning + s.actionability) / 4 : null
  const summary = {}
  for (const v of VARIANTS) {
    const rs = results.filter(r => r.variant === v.label); const n = rs.length || 1
    const q = rs.map(r => qAvg(r._quality)).filter(x => x != null)
    const ranks = rs.map(r => r._rank).filter(x => x)
    summary[v.label] = {
      runs: rs.length,
      successRate: +(rs.filter(r => r.status === 'done').length / n).toFixed(2),
      avgCostUsd: +(rs.reduce((a, r) => a + r.costUsd, 0) / n).toFixed(4),
      avgSec: +(rs.reduce((a, r) => a + r.ms, 0) / n / 1000).toFixed(0),
      avgTokensOut: Math.round(rs.reduce((a, r) => a + r.tokensOut, 0) / n),
      avgQuality: q.length ? +(q.reduce((a, x) => a + x, 0) / q.length).toFixed(2) : null,  // judge 1~10
      firsts: rs.filter(r => r._rank === 1).length,          // judge 랭킹 1위 횟수
      avgRank: ranks.length ? +(ranks.reduce((a, x) => a + x, 0) / ranks.length).toFixed(2) : null,
    }
  }
  console.log('\n===== 상세 =====')
  console.table(results.map(r => ({ wf: r.workflowTitle, variant: r.variant, status: r.status, cost: r.costUsd, sec: Math.round(r.ms / 1000), out: r.tokensOut })))
  console.log('===== 변형별 요약 =====')
  console.table(summary)

  const outDir = path.join(__dirname, '.ab-results')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ at: stamp, targets: targets.map(t => t.id), runsPer, results, summary }, null, 2))
  console.log(`\n결과 저장: ${outFile}`)
  process.exit(0)
}

main().catch(e => { console.error('[ab-eval] 실패:', e); process.exit(1) })
