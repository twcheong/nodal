// logic-tests.mjs — 앱 켜기 전 로직 검증. 3부:
//   A. 순수 알고리즘(소스 로직 미러) — semver/업데이트판정/태그
//   B. 소스 드리프트 가드 — 실제 소스 파일의 상수/구현이 기대와 일치하는지
//   C. 실배포 백엔드 로직 — Supabase 에 실호출(초대 가드·RLS 보안·업데이트판정)
//   node scripts/logic-tests.mjs
import { readFileSync } from 'node:fs'

const URL = 'https://mooltalmugrwzkvvawip.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vb2x0YWxtdWdyd3prdnZhd2lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMTI0NDYsImV4cCI6MjA4ODU4ODQ0Nn0.QC_DQtuRXfYpLxvlghDqHfgn57sobFpjU_6c4IK57YE'
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }

let pass = 0, fail = 0
const ok  = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`) } else { fail++; console.log(`  ❌ ${m}`) } }
const eq  = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`)

// ── A. 순수 알고리즘 (src 로직 미러) ────────────────────────────────────────
console.log('\n[A] 순수 알고리즘')

// appRelease.compareSemver
const cmp = (a, b) => { const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1 } return 0 }
eq(cmp('0.1.0', '0.2.0'), -1, 'semver 0.1.0<0.2.0')
eq(cmp('0.2.0', '0.1.9'), 1, 'semver 0.2.0>0.1.9')
eq(cmp('0.10.0', '0.9.0'), 1, 'semver 0.10.0>0.9.0 (두자리)')
eq(cmp('0.1', '0.1.0'), 0, 'semver 길이차 동일')

// appRelease.checkForUpdate 판정
const decide = (cur, rel) => { if (!rel?.latest_version) return null; if (cmp(cur, rel.latest_version) >= 0) return null; return { forced: !!rel.min_supported && cmp(cur, rel.min_supported) < 0 } }
eq(decide('0.1.0', { latest_version: '0.1.0' }), null, '업데이트: 현재=최신 → 배너없음')
ok(decide('0.0.5', { latest_version: '0.1.0' }) !== null, '업데이트: 구버전 → 배너뜸')
eq(decide('0.0.5', { latest_version: '0.1.0', min_supported: '0.1.0' })?.forced, true, '업데이트: min_supported 미만 → 강제')
eq(decide('0.0.9', { latest_version: '0.1.0', min_supported: '0.0.5' })?.forced, false, '업데이트: min_supported 이상 → 비강제')

// tags: normalize(cap5/dedup/lowercase) + toggle + AND필터
const MAX = 5
const norm = (tags) => { const out = []; for (const raw of tags) { const t = String(raw ?? '').trim().toLowerCase().slice(0, 24); if (t && !out.includes(t)) out.push(t); if (out.length >= MAX) break } return out }
const toggle = (cur, t) => cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]
const matchAND = (rowTags, active) => active.every(t => rowTags.includes(t))
eq(norm(['a', 'b', 'c', 'd', 'e', 'f']), ['a', 'b', 'c', 'd', 'e'], 'tags cap 5')
eq(norm(['SEO', ' seo ', 'Seo']), ['seo'], 'tags dedup+lowercase+trim')
eq(toggle(['seo'], 'content'), ['seo', 'content'], 'tag toggle 추가')
eq(toggle(['seo', 'content'], 'seo'), ['content'], 'tag toggle 제거')
ok(matchAND(['seo', 'clientA'], ['seo', 'clientA']) === true, 'AND필터: 둘 다 가짐 통과')
ok(matchAND(['seo'], ['seo', 'clientA']) === false, 'AND필터: 하나 없음 탈락')

// live: 에코 필터(내가 쓴 원격변경 무시) + join 중복방지
const isEcho = (row, me) => row.updated_by === me
ok(isEcho({ updated_by: 'u1' }, 'u1') === true, 'live 에코: 내 변경 무시')
ok(isEcho({ updated_by: 'u2' }, 'u1') === false, 'live 에코: 남 변경 수신')
const pickLocal = (list, liveId) => list.find(w => w.liveId === liveId)?.id ?? null
eq(pickLocal([{ id: 'w1', liveId: 'L1' }], 'L1'), 'w1', 'live join: 기존 사본 재사용(중복방지)')
eq(pickLocal([{ id: 'w1', liveId: 'L9' }], 'L1'), null, 'live join: 없으면 새로 생성')

// ── B. 소스 드리프트 가드 ───────────────────────────────────────────────────
console.log('\n[B] 소스 드리프트 가드')
const read = (p) => readFileSync(p, 'utf8')
ok(/MAX_TAGS\s*=\s*5/.test(read('src/lib/sharedWorkflows.ts')), 'sharedWorkflows MAX_TAGS=5')
ok(/out\.length\s*>=\s*5/.test(read('electron/planning.ts')), 'electron 로컬태그 cap=5 (팀과 일치)')
ok(/export function compareSemver/.test(read('src/lib/appRelease.ts')), 'appRelease.compareSemver 존재')
ok(/updated_by === userId/.test(read('src/hooks/useLiveWorkflow.ts')), 'useLiveWorkflow 에코 필터 존재')
ok(/liveId/.test(read('electron/planning.ts')), 'electron 이 liveId 영속')

// ── C. 실배포 백엔드 로직 (Supabase 실호출) ─────────────────────────────────
console.log('\n[C] 실배포 백엔드 로직')
const rpc = async (fn, args) => { const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); let b = {}; try { b = await r.json() } catch {} return { status: r.status, body: b } }
const DUMMY = '00000000-0000-0000-0000-000000000000'

// 업데이트: 라이브 app_release 읽고 판정
const relRes = await fetch(`${URL}/rest/v1/app_release?select=latest_version,min_supported&limit=1`, { headers: H })
const rel = (await relRes.json())[0]
ok(relRes.status === 200 && !!rel?.latest_version, `app_release 읽기(anon) → latest=${rel?.latest_version}`)
ok(decide('0.0.1', rel) !== null, '실데이터로 구버전 → 배너뜸')
ok(decide('9.9.9', rel) === null, '실데이터로 최신버전 → 배너없음')

// 초대 가드: anon(비admin) 은 발급 못 함
const ci = await rpc('create_org_invite', { p_org_id: DUMMY, p_email: null, p_role: 'member' })
ok(ci.status !== 404 && /not_admin/.test(JSON.stringify(ci.body)), `create_org_invite 가드: 비admin 차단 (${ci.body?.message ?? ci.status})`)
// 초대 수락 가드: 없는 코드 거부
const ai = await rpc('accept_org_invite', { p_code: 'definitely-not-a-real-code' })
ok(ai.status !== 404 && /invalid_or_used_code/.test(JSON.stringify(ai.body)), `accept_org_invite 가드: 잘못된 코드 거부 (${ai.body?.message ?? ai.status})`)

// RLS 보안: anon 은 live_workflows 에 write 못 함, read 는 200(빈 결과)
const li = await fetch(`${URL}/rest/v1/live_workflows`, { method: 'POST', headers: H, body: JSON.stringify({ org_id: DUMMY, workflow_json: {} }) })
ok(li.status === 401 || li.status === 403, `live_workflows anon write 차단 (${li.status})`)
const lr = await fetch(`${URL}/rest/v1/live_workflows?select=id&limit=1`, { headers: H })
ok(lr.status === 200, `live_workflows anon read 허용(RLS 빈결과) (${lr.status})`)
// org_invites 도 anon write 차단
const oi = await fetch(`${URL}/rest/v1/org_invites`, { method: 'POST', headers: H, body: JSON.stringify({ org_id: DUMMY }) })
ok(oi.status === 401 || oi.status === 403, `org_invites anon write 차단 (${oi.status})`)

console.log(`\n결과: ${pass} PASS · ${fail} FAIL`)
process.exit(fail ? 1 : 0)
