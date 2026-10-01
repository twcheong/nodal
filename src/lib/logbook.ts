// ─────────────────────────────────────────────────────────────────────────────
// logbook.ts — plan 실행 L6/L7/L8 작업 마커의 렌더러 측 진입점.
//
// 계층 정의서 7.3 도구 매핑:
//   L6 = PlanStep (Twixy 가 작업을 쪼갠 단계)            — usePlans.ts 가 발사
//   L7 = 그 단계의 실제 실행(exec)                        — usePlans.ts 가 발사
//   L8 = 실행 중 호출한 개별 도구 (web_search, read, …)   — useOpenClaw.ts 가 발사
//
// task_id 규칙:
//   L6 = plan:step:<planId>:<stepId>
//   L7 = plan:step:exec:<planId>:<stepId>
//   L8 = 게이트웨이 도구 callId 그대로
// (planId/stepId 생성기는 electron/planning.ts generateId / `s${i+1}` —
//  콜론이 들어갈 수 없는 형식이지만, 방어적으로 sanitize 한다.)
//
// L8 게이트: usePlans 가 L7 구간 동안만 beginL8Window/endL8Window 로 창을 열고,
// useOpenClaw 의 session.tool 핸들러는 창이 열려 있을 때만 L8 마커를 발사한다.
// 이렇게 해야 일반 채팅·플래너·컴팩션 턴의 도구 호출이 L6/L7 부모 없이
// logbook 스택에 고아 마커로 쌓이지 않고, 엄격 중첩(L6→L7→L8)이 유지된다.
//
// 모든 발사는 fire-and-forget — window.twixy.logbookContext 는 void 를 반환하고
// 실패는 main 프로세스에서 조용히 무시된다. plan 실행에 영향 없음.
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeIdPart(s: string): string {
  return s.replace(/:/g, '_')
}

export function l6TaskId(planId: string, stepId: string): string {
  return `plan:step:${sanitizeIdPart(planId)}:${sanitizeIdPart(stepId)}`
}

export function l7TaskId(planId: string, stepId: string): string {
  return `plan:step:exec:${sanitizeIdPart(planId)}:${sanitizeIdPart(stepId)}`
}

// 마커 1건 송신. preload 가 노출 안 된 구버전 빌드 / 비-Electron 환경에서도
// 절대 throw 하지 않는다.
export function logbookMark(marker: TwixyLogbookMarker): void {
  try {
    window.twixy?.logbookContext?.(marker)
  } catch { /* never disturb the caller */ }
}

// ── L8 창 (활성 L7 구간) ─────────────────────────────────────────
// usePlans 가 step 실행(L7 start~end) 동안 열어두는 창. useOpenClaw 는
// 창이 열려 있을 때 도착하는 도구 start 이벤트만 L8 로 발사한다.
let activeL7: { taskId: string; planId: string } | null = null
// 이 창에서 start 를 발사한 callId 집합 — end 는 start 를 보낸 건에 대해서만
// 발사한다 (창 밖에서 시작된 도구의 end 가 고아 pop 을 만들지 않도록).
const startedL8 = new Set<string>()

export function beginL8Window(l7Id: string, planId: string): void {
  activeL7 = { taskId: l7Id, planId }
  startedL8.clear()
}

export function endL8Window(): void {
  // 잔존 L8 start (end 이벤트가 유실/지연된 도구)는 logbook 서버가 L7 end 를
  // 받을 때 스택에서 함께 pop 하므로 여기서 개별 end 를 쏠 필요 없다.
  activeL7 = null
  startedL8.clear()
}

export function logbookToolStart(callId: string, toolName: string): void {
  if (!activeL7 || !callId || startedL8.has(callId)) return
  startedL8.add(callId)
  logbookMark({
    event:     'start',
    task_id:   callId,
    level:     'L8',
    title:     toolName,
    actor:     'AI',
    parent_id: activeL7.taskId,
    plan_id:   activeL7.planId,
  })
}

export function logbookToolEnd(callId: string): void {
  if (!callId || !startedL8.has(callId)) return
  startedL8.delete(callId)
  logbookMark({ event: 'end', task_id: callId, level: 'L8', actor: 'AI' })
}
