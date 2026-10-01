// ─────────────────────────────────────────────────────────────────────────────
// nodeStatus — 노드 자기보고 프로토콜(NODE_STATUS)의 단일 정본.
//
// 게이트웨이는 어시스턴트가 final 메시지를 내기만 하면 turn 을 성공으로 친다.
// 그래서 러너가 "파일을 못 찾음 / 막힘" 이라고 산문으로 항복해도 노드는 그냥
// done 이 된다. 매 노드 끝에 상태 줄 하나를 요구하고 그걸 읽는 것이 실제 실패를
// 잡는 유일한 수단이다 (review 노드가 없는 플랜에선 특히).
//
// 이 파일이 생긴 이유: 같은 프로토콜을 요구하는 프롬프트 빌더가 두 벌 있고
// (Test run = useWorkflowTest.ts, Orchestration = runWorkflowNodes.ts) 한쪽만
// 고쳐서 두 경로가 "성공" 의 정의부터 달라져 있었다. 문구와 파서를 여기 한 곳에
// 두면 그 종류의 표류가 구조적으로 불가능해진다.
//
// React 를 끌어오지 않는 순수 모듈이다 — hooks 와 lib 양쪽에서 import 한다
// (lib → hooks 방향 import 를 피하려고 훅이 아니라 여기 둔다).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 프롬프트 말미에 붙는 상태 줄 요구 문구. 앞의 빈 줄은 호출자가 넣는다:
 *   if (node.type !== 'review') parts.push('', ...NODE_STATUS_LINES)
 *
 * review 노드에는 붙이지 않는다 — 판정하는 주체가 사람이라 러너의 자기보고가
 * 의미 없고, 사람에게 보여줄 출력에 프로토콜 찌꺼기만 남는다.
 */
export const NODE_STATUS_LINES: readonly string[] = [
  'When you finish THIS node, end your reply with a status line on its own last line — EXACTLY one of:',
  '  NODE_STATUS: OK   — you actually achieved the goal above (file written, data extracted, action done).',
  '  NODE_STATUS: FAILED — <one short reason>   — you could NOT (a required file/page was missing, you were blocked, or tools kept erroring).',
  'Report FAILED honestly instead of pretending success — a false OK makes the next step build on missing/wrong data. Do not mark OK just because you produced a message.',
  'There are NO other statuses — no PARTIAL, no WARNING. Completed part of the scope? That is FAILED, with the exact resume point (last item/page/cursor) in the reason so the run can continue from there.',
]

/**
 * 러너의 마지막 응답에서 자기보고 실패를 읽는다.
 *   OK        → null (성공)
 *   상태 줄 없음 → null (성공) — 약한 모델이 줄을 빠뜨렸다고 실제 성공을 실패로
 *                 뒤집지 않기 위한 의도적 선택이다.
 *   FAILED    → 사유 문자열
 *   그 외 상태  → 실패 취급 + 사유 보존
 *
 * 마지막 규칙이 있는 이유: 프로토콜은 OK|FAILED 둘뿐인데 실행기가 상태를 지어내는
 * 일이 실제로 있었다 — "NODE_STATUS: PARTIAL — stopped at page 262" 로 418쪽 중
 * 262쪽만 쓰고도 노드가 done 처리돼 뒤 노드가 불완전한 데이터 위에서 돌 뻔했다.
 * 사유는 그대로 보존한다 (PARTIAL 의 재개 지점 같은 정보가 Resume 에 쓸모 있다).
 */
export function detectNodeFailure(text: string): string | null {
  const m = text.match(/NODE_STATUS:\s*([A-Z_]+)\b[ \t]*[—:–-]*[ \t]*([^\n]*)/i)
  if (!m) return null
  const status = m[1].toUpperCase()
  if (status === 'OK') return null
  const reason = (m[2] ?? '').trim()
  if (status === 'FAILED') return reason || 'The step reported it could not complete.'
  return `The step reported a non-OK status (${status})${reason ? `: ${reason}` : ''} — treated as incomplete so later steps do not build on partial data.`
}

/** 저장/표시용 output 에서 상태 줄 제거 — recap·리뷰 뷰에 프로토콜 찌꺼기가 새지 않게. */
export function stripNodeStatus(text: string): string {
  return text.replace(/\n?[ \t]*NODE_STATUS:\s*[A-Z_]+\b[^\n]*/gi, '').trimEnd()
}
