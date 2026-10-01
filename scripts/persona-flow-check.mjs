// persona-flow-check.mjs — Release 1 유저 스토리가 의존하는 백엔드 capability 를
// anon 키(앱과 동일 경로)로 실제 probe 해 구현/미구현을 ground truth 로 판정.
//   node scripts/persona-flow-check.mjs
// 존재하는 테이블+RLS → HTTP 200 (rows 0 이어도 OK). 없는 테이블 → 404(PGRST205).
// 이건 "백엔드가 있나"만 봄. UI/로직 유무는 코드 감사(Task 3)로 보완.

const URL = 'https://mooltalmugrwzkvvawip.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vb2x0YWxtdWdyd3prdnZhd2lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMTI0NDYsImV4cCI6MjA4ODU4ODQ0Nn0.QC_DQtuRXfYpLxvlghDqHfgn57sobFpjU_6c4IK57YE'

// story → 그 스토리가 실제로 쓰는 테이블. present=있어야 정상, absent=없을 것으로 예상(미구현 신호).
const PROBES = [
  { story: 'US-R1-01 팀원 초대/관리',   table: 'organization_members', expect: 'present', note: '멤버 데이터층. 초대 UI 는 앱에 없음(웹 위임)' },
  { story: 'US-R1-01 초대 토큰',        table: 'org_setup_tokens',     expect: 'present', note: '초대/셋업 토큰 백엔드' },
  { story: 'US-R1-02 워크플로 공유',     table: 'shared_workflows',     expect: 'present', note: '팀 라이브러리 공유본' },
  { story: 'US-R1-03 폴더 구성',        table: 'workflow_folders',     expect: 'absent',  note: '폴더/하위폴더 = 테이블 없음' },
  { story: 'US-R1-04 실시간 편집 잠금',  table: 'workflow_locks',       expect: 'absent',  note: '편집 잠금 = 테이블 없음(프리젠스만)' },
  { story: 'US-R1-05 활동 피드',        table: 'org_activity',         expect: 'present', note: '활동 로그(비실시간, join 미기록)' },
  { story: 'US-R1-06 복제/포크 버전',    table: 'shared_workflow_versions', expect: 'present', note: '재공유 스냅샷 버전' },
  { story: 'US-R1-07~09 런 대시보드',    table: 'org_workflow_runs',    expect: 'present', note: '팀 런 상태/성과(30초 폴링)' },
  { story: 'US-R1-10 이메일/슬랙 알림',  table: 'notification_prefs',   expect: 'absent',  note: '알림 채널 설정 = 테이블 없음(OS 알림만)' },
  { story: 'US-R1-12 역할별 저장 뷰',    table: 'dashboard_views',      expect: 'absent',  note: '저장 뷰 서버측 = 없음(localStorage 만)' },
  { story: '1:1 DM',                    table: 'org_direct_messages',  expect: 'present', note: '팀 DM' },
  { story: '업데이트 알림',              table: 'app_release',          expect: 'present', note: '방금 추가' },
  { story: 'US-R1-01 초대(신규 백엔드)', table: 'org_invites',          expect: 'present', note: 'org_invites.sql 적용 후 present' },
  { story: 'US-R1-04 실시간 공동편집',   table: 'live_workflows',       expect: 'present', note: 'live_workflows.sql 적용 후 present' },
]

// 초대 RPC 존재 확인. PostgREST 는 body 의 인자 이름으로 함수를 찾으므로 올바른 인자를
// 보내야 함(빈 {} 는 zero-arg 버전을 찾아 false 404). 미인증이라 함수는 권한/로직 에러로
// 실패(=존재), 없으면 404(PGRST202).
const DUMMY = '00000000-0000-0000-0000-000000000000'
const RPCS = [
  { fn: 'create_org_invite',  args: { p_org_id: DUMMY, p_email: null, p_role: 'member' } },
  { fn: 'accept_org_invite',  args: { p_code: 'nonexistent' } },
  { fn: 'list_org_invites',   args: { p_org_id: DUMMY } },
  { fn: 'revoke_org_invite',  args: { p_id: DUMMY } },
  { fn: 'remove_org_member',  args: { p_org_id: DUMMY, p_member_user_id: DUMMY } },
]

async function probe(table) {
  const res = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  })
  return { status: res.status, ok: res.ok }
}

const rows = []
let mismatch = 0
for (const p of PROBES) {
  const { status } = await probe(p.table)
  const exists = status === 200
  const asExpected = (p.expect === 'present') === exists
  if (!asExpected) mismatch++
  rows.push({
    story: p.story,
    table: p.table,
    backend: exists ? 'EXISTS' : 'MISSING',
    expect: p.expect,
    verdict: asExpected ? (exists ? 'OK' : '미구현(예상대로)') : '⚠️예상밖',
    http: status,
    note: p.note,
  })
}

console.log('\n=== 페르소나 플로우 백엔드 probe (anon 키, 앱과 동일 경로) ===\n')
for (const r of rows) {
  console.log(`[${r.backend.padEnd(7)}] ${r.story}`)
  console.log(`          table=${r.table}  http=${r.http}  → ${r.verdict}`)
  console.log(`          ${r.note}`)
}
const present = rows.filter(r => r.backend === 'EXISTS').length
console.log(`\n요약: 백엔드 존재 ${present}/${rows.length} · 예상밖 ${mismatch}`)

console.log('\n=== 초대 RPC 존재 확인 ===')
for (const { fn, args } of RPCS) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  // 404 = 함수 없음. 그 외(권한/로직 에러) = 함수 존재.
  const exists = res.status !== 404
  console.log(`  ${fn}: http=${res.status} → ${exists ? 'EXISTS' : 'MISSING'}`)
}
// 보안: anon(비멤버)은 live_workflows 에 write 못 해야 함(RLS). 뚫리면 심각.
console.log('\n=== 라이브 문서 write 보안 (RLS) ===')
{
  const res = await fetch(`${URL}/rest/v1/live_workflows`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: DUMMY, workflow_json: {} }),
  })
  const blocked = res.status === 401 || res.status === 403
  console.log(`  anon insert: http=${res.status} → ${blocked ? 'BLOCKED (정상)' : '⚠️ 뚫림'}`)
}

console.log('\n주의: 이건 백엔드 존재/보안만. 실시간 동기화 로직은 2-user 실행 검증 필요.')
