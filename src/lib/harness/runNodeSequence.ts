// ─────────────────────────────────────────────────────────────────────────────
// harness/runNodeSequence — 워크플로의 노드들을 순서대로 모는 루프.
//
// Test run(useWorkflowTest)과 Orchestration(runWorkflowNodes)이 각자 한 벌씩
// 갖고 있던 시퀀싱 셸을 합친 것이다. 앞서 runNodeTurn(턴 한 개)과 usage(비용
// delta)를 합쳤고, 남아 있던 게 이 바깥 루프였다.
//
// 두 경로의 실제 차이는 전부 **주입되는 정책**으로 내려갔다:
//   - review 노드     onReview (Test run = 사람이 누를 때까지 대기 / Orchestration = 자동)
//   - 타임아웃 재시도  turnPolicy 가 주는 slicePortions (Test run 만)
//   - 프롬프트 조립    buildPrompt (첨부파일·scratch dir 은 Test run 만, preamble 은 Orchestration 만)
//   - 에러 문구        mapError (Test run 만 friendlyRunError 로 번역)
//   - 기록 상세        recordPrompt / recordToolCalls (Test run 만)
//   - 진단 로그        logLabel (Test run 만)
// 루프가 정책을 고르지 않는다 — 호출자가 준 것을 그대로 쓴다.
//
// 상태를 어디에 쓰는지는 이 파일의 관심사가 아니다. onNode 로 메트릭만 내보내고,
// 그걸 React state 에 쓰든 콜백으로 모으든 호출자가 정한다. 그래서 순수 TS 로
// 남을 수 있고, 언젠가 Electron 밖에서도 이 루프가 돈다.
//
// 인자를 전부 이름 있는 필드로 받는 이유: 위치 인자였다면 순서가 바뀌어도
// 타입이 같으면 컴파일이 통과한다. 이 루프의 호출부는 단위 테스트가 얇은
// 자리라(훅 쪽) tsc 가 대신 잡아주게 둔다.
// ─────────────────────────────────────────────────────────────────────────────
import { runNodeTurn, type TurnPolicy } from './runNodeTurn'
import { settledUsage, usageDelta, type UsageTotals } from './usage'
import type { AbortFlag, TurnSendPort } from './ports'
import type { NodeRunMetrics } from '../../hooks/useWorkflowTest'

export interface RunTotals {
  cost: number; ms: number; tokensIn: number; tokensOut: number
}

export interface NodeSequenceResult {
  status:        'done' | 'failed' | 'aborted'
  finalOutput:   string
  totals:        RunTotals
  outputs:       Record<string, string>   // nodeId → 상태 줄을 뺀 출력 본문
  /** 실패한 노드. 중단(aborted)에는 붙지 않는다 — 기존 결과 모양 유지. */
  failedNodeId?: string
  /** 루프가 일찍 멈춘 지점. 실패든 중단이든 붙는다 (호출자의 뒷정리용). */
  stoppedAtNodeId?: string
  /** 왜 실패했나 — 호출자가 뒷정리 문구를 고를 때 쓴다. */
  failureKind?: 'self-report' | 'error'
  reason?:       string
}

/**
 * review 노드를 어떻게 처리했는지. 루프는 이 결과를 그대로 보고하고 다음 노드로 간다.
 *
 * totalsDelta 를 metrics 와 따로 두는 건 지금 동작을 그대로 보존하기 위해서다:
 * Test run 의 skip 은 노드에 durationMs 를 기록하면서도 run 합계에는 더하지 않고,
 * approve 는 더한다. 하나로 합치면 둘 중 하나의 숫자가 바뀐다.
 */
export interface ReviewOutcome {
  metrics: NodeRunMetrics
  /** run 합계에 더할 양. 생략 = 아무것도 더하지 않음. */
  totalsDelta?: { cost?: number; ms?: number; tokensIn?: number; tokensOut?: number }
  /** 사람이 중단을 선택한 경우. 루프가 즉시 aborted 로 끝낸다. */
  stop?: { reason: string }
}

export interface RunNodeSequenceArgs {
  workflow: TwixyWorkflow
  /** 재개 시작 지점. 기본 0. */
  startIndex?: number
  abort: AbortFlag

  /** 이 노드에 보낼 지시문. 에이전트 좌석 호출은 호출자가 한다(ctx 가 경로마다 다르므로). */
  buildPrompt: (args: { node: TwixyWorkflowNode; index: number; isFirst: boolean }) => Promise<string> | string

  turn: { send: TurnSendPort; cancel?: () => Promise<void> }
  /** 노드마다의 턴 정책 — 타임아웃, (있으면) 축소 재시도 사다리, 활동 피드 라벨. */
  turnPolicy: (args: { node: TwixyWorkflowNode; index: number }) => TurnPolicy

  /** 누적 사용량 원장 읽기. 노드 전후 스냅샷의 차이가 그 노드의 비용이 된다. */
  getUsage: () => Promise<UsageTotals>

  /** review 노드를 만났을 때. 사람을 기다리든 자동으로 처리하든 호출자 몫. */
  onReview: (args: { node: TwixyWorkflowNode; index: number }) => Promise<ReviewOutcome>

  /** 노드 상태가 바뀔 때마다. running → (done | failed | aborted). */
  onNode: (args: { nodeId: string; metrics: NodeRunMetrics; totals: RunTotals }) => void

  /** 던져진 에러 문구를 사람이 읽을 문장으로. 없으면 원문 그대로. */
  mapError?: (raw: string) => string
  /** 보낸 지시문을 메트릭에 남길 때의 길이 상한. 없으면 기록하지 않는다. */
  recordPrompt?: number
  /** 툴 호출 목록을 메트릭에 남길지. */
  recordToolCalls?: boolean
  /** 진단 로그 접두사. 없으면 아무것도 찍지 않는다. */
  logLabel?: string
}

const nowMs = () => Date.now()

export async function runNodeSequence(args: RunNodeSequenceArgs): Promise<NodeSequenceResult> {
  const { workflow, abort, buildPrompt, turn, turnPolicy, getUsage, onReview, onNode } = args
  const startIndex = args.startIndex ?? 0

  const outputs: Record<string, string> = {}
  let finalOutput = ''
  let cost = 0, ms = 0, tokensIn = 0, tokensOut = 0
  const totals = (): RunTotals => ({ cost, ms, tokensIn, tokensOut })
  const report = (nodeId: string, metrics: NodeRunMetrics) =>
    onNode({ nodeId, metrics, totals: totals() })

  if (!workflow || workflow.nodes.length === 0) {
    return { status: 'done', finalOutput: '', totals: totals(), outputs }
  }

  // 시작 시점 원장 스냅샷 — 첫 노드의 delta 기준.
  let prevUsage: UsageTotals = {}
  try { prevUsage = await getUsage() } catch { /* 0 baseline */ }

  for (let i = startIndex; i < workflow.nodes.length; i++) {
    const node = workflow.nodes[i]

    if (abort.aborted) {
      report(node.id, { status: 'aborted', reason: 'Stopped by user' })
      return { status: 'aborted', finalOutput, totals: totals(), outputs, stoppedAtNodeId: node.id, reason: 'Stopped by user' }
    }

    if (node.type === 'review') {
      const outcome = await onReview({ node, index: i })
      cost      += outcome.totalsDelta?.cost      ?? 0
      ms        += outcome.totalsDelta?.ms        ?? 0
      tokensIn  += outcome.totalsDelta?.tokensIn  ?? 0
      tokensOut += outcome.totalsDelta?.tokensOut ?? 0
      // 리뷰가 실제로 모델을 썼다면(사람 노트를 세션에 보내는 경우) 원장 기준선을
      // 다시 잡는다 — 안 그러면 그 비용이 다음 노드의 delta 에 얹혀 두 번 계산된다.
      const td = outcome.totalsDelta
      if (td && ((td.cost ?? 0) > 0 || (td.tokensIn ?? 0) > 0 || (td.tokensOut ?? 0) > 0)) {
        try { prevUsage = await getUsage() } catch { /* 기준선 유지 */ }
      }
      report(node.id, outcome.metrics)
      if (outcome.stop) {
        return { status: 'aborted', finalOutput, totals: totals(), outputs, stoppedAtNodeId: node.id, reason: outcome.stop.reason }
      }
      continue
    }

    const startedAt = nowMs()
    report(node.id, { status: 'running', startedAt })

    // 실패 경로에서도 보낸 지시문을 남길 수 있게 try 밖에 둔다.
    let promptForLog: string | undefined
    try {
      const prompt = await buildPrompt({ node, index: i, isFirst: i === startIndex })
      if (args.recordPrompt !== undefined) promptForLog = prompt.slice(0, args.recordPrompt)

      const result = await runNodeTurn(
        { send: turn.send, cancel: turn.cancel, abort },
        prompt,
        turnPolicy({ node, index: i }),
      )
      const endedAt = nowMs()

      let d = { costUsd: 0, tokensIn: 0, tokensOut: 0 }
      try {
        const cur = await settledUsage(getUsage, prevUsage)
        d = usageDelta(prevUsage, cur)
        prevUsage = cur
      } catch { /* delta stays 0 */ }

      cost += d.costUsd; ms += endedAt - startedAt
      tokensIn += d.tokensIn; tokensOut += d.tokensOut

      // 부분 출력이라도 보존한다 — 실패해도 호출자가 쓸 수 있게 판정보다 먼저 담는다.
      outputs[node.id] = result.text
      if (result.text) finalOutput = result.text

      const common: NodeRunMetrics = {
        status:     'done',
        startedAt, endedAt,
        durationMs: endedAt - startedAt,
        costUsd:    d.costUsd,
        tokensIn:   d.tokensIn,
        tokensOut:  d.tokensOut,
        output:     result.text,
        ...(promptForLog !== undefined ? { prompt: promptForLog } : {}),
        ...(args.recordToolCalls ? { toolCalls: result.toolCalls } : {}),
      }

      if (result.failure) {
        if (args.logLabel) console.warn(`[${args.logLabel}] node "${node.title}" self-reported failure:`, result.failure)
        report(node.id, { ...common, status: 'failed', reason: result.failure })
        return {
          status: 'failed', finalOutput, totals: totals(), outputs,
          failedNodeId: node.id, stoppedAtNodeId: node.id, failureKind: 'self-report', reason: result.failure,
        }
      }

      report(node.id, { ...common, autoSlice: result.autoSlice })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const stoppedByUser = abort.aborted || raw === 'cancelled'
      const reason = stoppedByUser ? 'Stopped by user' : (args.mapError?.(raw) ?? raw)
      if (!stoppedByUser && args.logLabel) console.error(`[${args.logLabel}] node "${node.title}" failed:`, err)
      report(node.id, {
        status:    stoppedByUser ? 'aborted' : 'failed',
        startedAt, endedAt: nowMs(),
        reason,
        ...(promptForLog ? { prompt: promptForLog } : {}),
      })
      return {
        status: stoppedByUser ? 'aborted' : 'failed',
        finalOutput, totals: totals(), outputs,
        // throw 경로는 중단이어도 failedNodeId 를 채운다 — 기존 동작 그대로.
        failedNodeId: node.id, stoppedAtNodeId: node.id, failureKind: 'error', reason,
      }
    }
  }

  return { status: 'done', finalOutput, totals: totals(), outputs }
}
