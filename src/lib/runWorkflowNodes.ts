// ─────────────────────────────────────────────────────────────────────────────
// runWorkflowNodes — 한 Workflow(L5)의 노드들을 주어진 게이트웨이 세션에서 순차
// 실행하는 순수 async 러너. useWorkflowTest 의 노드 루프와 동일한 정책(노드별
// 비용/시간 delta, 실패 시 중단)을 따르되, React state 와 분리되어 Orchestration
// 러너가 멤버(=Workflow)를 실행하는 단위로 재사용한다.
//
// 노드를 실제로 "모는" 부분(보내기·타임아웃·자기보고 판정)과 비용 delta 계산은
// src/lib/harness/ 와 공유한다 — 예전엔 useWorkflowTest 에 같은 코드가 한 벌 더
// 있었고 usage 헬퍼는 주석이 스스로 "동일 로직" 이라고 적고 있었다.
//
// useWorkflowTest 와 남는 차이:
//   - 사람이 없으므로 review 노드는 자동 처리(reviewMode: auto-approve | auto-skip).
//   - 상태는 onNode 콜백으로만 보고. 호출자(패턴 전략)가 모아서 표시/저장.
//   - preamble 로 상류 멤버 출력을 첫 노드 앞에 주입(pipeline 체이닝).
//   - 타임아웃 축소 재시도(slicePortions)를 쓰지 않는다 — 켜면 워크플로 하나가
//     최악 4배 오래 걸리고 비용도 그만큼 는다. 별도 결정 사항.
// ─────────────────────────────────────────────────────────────────────────────

import type { NodeRunStatus, NodeRunMetrics } from '../hooks/useWorkflowTest'
import { runnerHarnessPreamble } from './runnerHarness'
import { workflowRunnerAgent } from './agents/workflowRunner'
import { runNodeSequence } from './harness/runNodeSequence'
import { extractTotals } from './harness/usage'

// 노드 1개의 실행 상한. useWorkflowTest 와 같은 값·같은 근거.
const NODE_TIMEOUT_MS = 540_000

export interface MemberSendFn {
  (text: string, opts?: { timeoutMs?: number }):
    Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
}

export interface RunWorkflowDeps {
  send:           MemberSendFn
  fetchUsageCost: () => Promise<{ totals: Record<string, number>; byModel: unknown[] } | null>
  abort:          { aborted: boolean }
  onNode?:        (nodeId: string, metrics: NodeRunMetrics) => void
  reviewMode?:    'auto-approve' | 'auto-skip'   // 기본 auto-approve
  preamble?:      string                          // 첫 노드 앞에 주입할 상류 컨텍스트
}

export interface RunWorkflowResult {
  status:       'done' | 'failed' | 'aborted'
  finalOutput:  string
  totals:       { cost: number; ms: number; tokensIn: number; tokensOut: number }
  outputs:      Record<string, string>   // nodeId → 출력 본문
  failedNodeId?: string
  reason?:      string
}

export async function runWorkflowNodes(
  workflow: TwixyWorkflow,
  inputs:   Record<string, string>,
  deps:     RunWorkflowDeps,
): Promise<RunWorkflowResult> {
  const reviewMode = deps.reviewMode ?? 'auto-approve'

  const r = await runNodeSequence({
    workflow,
    abort: deps.abort,

    buildPrompt: ({ node, isFirst }) => workflowRunnerAgent.buildBody({
      workflow, node, inputs, isFirst,
      run: {
        promptStyle:     'orchestration',
        harnessPreamble: runnerHarnessPreamble(),
        preamble:        deps.preamble,
      },
    }) as string,

    turn: { send: deps.send },
    // slicePortions 를 주지 않는다 → 타임아웃은 곧바로 실패 (헤더 참고).
    turnPolicy: () => ({ timeoutMs: NODE_TIMEOUT_MS }),

    getUsage: async () => extractTotals((await deps.fetchUsageCost())?.totals),

    // 사람이 없다. auto-approve 는 통과로, auto-skip 은 건너뜀으로 기록만 하고
    // run 합계에는 아무것도 더하지 않는다(시간도 비용도 실제로 안 썼으므로).
    onReview: async ({ node }) => ({
      metrics: {
        status:     reviewMode === 'auto-skip' ? 'skipped' : 'done',
        startedAt:  Date.now(),
        endedAt:    Date.now(),
        durationMs: 0,
        costUsd:    0,
        reason: reviewMode === 'auto-skip'
          ? 'Review skipped (orchestration)'
          : 'Auto-approved (orchestration)',
      } satisfies NodeRunMetrics & { status: NodeRunStatus },
    }),

    onNode: ({ nodeId, metrics }) => { deps.onNode?.(nodeId, metrics) },
  })

  return {
    status:       r.status,
    finalOutput:  r.finalOutput,
    totals:       r.totals,
    outputs:      r.outputs,
    failedNodeId: r.failedNodeId,
    reason:       r.reason,
  }
}

