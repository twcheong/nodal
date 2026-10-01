// ─────────────────────────────────────────────────────────────────────────────
// harness/ports — Harness 가 바깥과 닿는 구멍의 타입. 구현은 여기 없다.
//
// 전부 이미 존재하던 모양을 이름만 붙인 것이다. 새 인터페이스를 발명하지 않았다:
//   - TurnSendPort  ← useWorkflowTestSession.sendAndAwaitFinal 에서 workflowId 를 뺀 것,
//                     그리고 runWorkflowNodes 의 MemberSendFn 과 같은 모양.
//   - UsagePort     ← deps.fetchUsageCost / fetchSessionUsage 가 이미 이 모양.
//
// Harness 가 React·window.twixy·PRODUCT 를 import 하지 않는 이유가 여기 있다:
// 이 루프는 언젠가 Electron 밖(서버)에서도 돌아야 하고, 훅은 옮길 수 없다.
// 의존성을 import 하지 않고 주입받으면 그 이식이 가능해진다.
// ─────────────────────────────────────────────────────────────────────────────

/** 한 턴 분량의 응답. 게이트웨이 세션 클라이언트가 이미 이 모양으로 돌려준다. */
export interface TurnSendResult {
  text:      string
  messageId: string | null
  toolCalls: Array<{ name: string; detail?: string }>
}

/**
 * 텍스트를 보내고 assistant final 까지 기다린다. 세션을 어떻게 고르는지는
 * 호출자가 이미 바인딩해서 넘긴다 (Test run 은 workflowId, Orchestration 은 멤버 세션).
 * `displayText` 는 활동 피드에 노출할 짧은 라벨 — 없으면 UI 가 알아서 한다.
 */
export interface TurnSendPort {
  (text: string, opts: { timeoutMs: number; displayText?: string }): Promise<TurnSendResult>
}

/** 게이트웨이의 누적 사용량 원장. null = 아직 세션 미확보. */
export interface UsagePort {
  (): Promise<UsageTotalsRaw | null>
}

export interface UsageTotalsRaw {
  totals: Record<string, number>
  byModel?: unknown[]
}

/** 사용자가 Stop 을 눌렀는지. 루프가 매 단계 확인한다. */
export interface AbortFlag {
  aborted: boolean
}
