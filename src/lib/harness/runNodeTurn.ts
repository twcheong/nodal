// ─────────────────────────────────────────────────────────────────────────────
// harness/runNodeTurn — 노드 한 개를 실제로 "모는" 부분.
//
// 보낸다 → final 을 기다린다 → (선택) 타임아웃이면 범위를 줄여 다시 던진다
// → 러너의 자기보고로 성공/실패를 판정한다 → 표시용 본문을 돌려준다.
//
// Test run(useWorkflowTest)과 Orchestration(runWorkflowNodes)이 각자 갖고 있던
// 것을 한 곳으로 합쳤다. 두 경로의 차이는 **정책 하나**로만 남는다:
//   - Test run       : slicePortions 를 넘긴다 → 타임아웃 시 축소 재시도
//   - Orchestration  : 안 넘긴다 → 타임아웃이면 그대로 실패
// 재시도를 Orchestration 에도 켜는 건 비용·소요시간이 몇 배로 뛰는 변경이라
// 별도 결정 사항이다 (사용자가 정한 건 "성공의 정의" 였지 타임아웃 전략이 아니다).
//
// 순수 TS — React·window.twixy·PRODUCT 없음. 의존성은 전부 인자로 받는다.
// ─────────────────────────────────────────────────────────────────────────────
import { detectNodeFailure, stripNodeStatus } from '../nodeStatus'
import type { AbortFlag, TurnSendPort } from './ports'

export interface TurnPolicy {
  /** 한 번의 시도에 허용하는 시간. 노드마다 리셋된다(누적 아님). */
  timeoutMs: number
  /**
   * 타임아웃 시 "이만큼만 해라" 로 줄여가며 재시도할 단계. 생략 = 재시도 없음.
   * 개수가 아니라 비율로 지시하는 이유: 아이템 수 N 을 아는 건 실행기뿐이다.
   */
  slicePortions?: readonly string[]
  /** 타임아웃난 turn 을 죽이고 나서 지연 이벤트가 빠질 때까지 기다리는 시간. */
  drainMs?: number
  /** 축소 재시도에 들어가기 직전 한 번. 진단 로그용 — 정책에 영향 없음. */
  onSliceRetry?: (attempt: number, nextPortion: string) => void
  /** 활동 피드에 보일 짧은 라벨. attempt 0 = 최초 시도. */
  label?: (attempt: number, portion: string | null) => string | undefined
}

export interface TurnDeps {
  send:    TurnSendPort
  /** 타임아웃난 turn 을 게이트웨이에서 중단시킨다. 없으면 재시도도 불가능하다(아래 주석). */
  cancel?: () => Promise<void>
  abort:   AbortFlag
}

export interface NodeTurnResult {
  /** 러너 원문 (상태 줄 포함). 로그·디버그용. */
  rawText:   string
  /** 상태 줄을 제거한 본문 — 저장·표시·하류 체이닝은 전부 이걸 쓴다. */
  text:      string
  /** 자기보고 실패 사유. null 이면 성공. */
  failure:   string | null
  toolCalls: Array<{ name: string; detail?: string }>
  /** 축소 재시도가 실제로 개입했을 때만 채워진다. */
  autoSlice?: { attempts: number; portion: string }
}

/**
 * 타임아웃 시 프롬프트 뒤에 붙는 지시문. 두 경로가 같은 문구를 쓰도록 여기 둔다
 * (지금은 Test run 만 쓰지만, 문구가 갈리는 걸 구조적으로 막는 게 목적이다).
 */
export function sliceNoteFor(portion: string, timeoutMs: number): string {
  return [
    '',
    `RUNTIME BUDGET EXCEEDED — a previous attempt at this exact node ran past the ${Math.round(timeoutMs / 60_000)}-minute limit and was cancelled, losing its work.`,
    `Retry it as a BOUNDED SLICE: do ${portion} of the scope, write what you complete to the output file, and stop there.`,
    'End your reply by stating exactly where you stopped (last item, page, or cursor) so the remainder can continue from that point.',
    'Do NOT attempt the full scope again — a second timeout loses this work too.',
  ].join('\n')
}

export async function runNodeTurn(
  deps: TurnDeps,
  prompt: string,
  policy: TurnPolicy,
): Promise<NodeTurnResult> {
  const portions = policy.slicePortions ?? []
  const drainMs = policy.drainMs ?? 1_500

  let result: Awaited<ReturnType<TurnSendPort>> | null = null
  let autoSlice: NodeTurnResult['autoSlice']

  for (let attempt = 0; ; attempt++) {
    const portion = attempt === 0 ? null : portions[attempt - 1]
    const note = portion === null ? '' : sliceNoteFor(portion, policy.timeoutMs)
    try {
      result = await deps.send(prompt + note, {
        timeoutMs: policy.timeoutMs,
        displayText: policy.label?.(attempt, portion ?? null),
      })
      if (portion !== null) autoSlice = { attempts: attempt, portion }
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 타임아웃이 아니거나, 유저가 멈췄거나, 더 쪼갤 단계가 없으면 그대로 실패.
      if (msg !== 'turn_timeout' || deps.abort.aborted || attempt >= portions.length) throw err
      // 타임아웃난 turn 은 게이트웨이에서 아직 돌고 있다. 죽이지 않고 재전송하면
      // 그 turn 의 뒤늦은 final 이 다음 awaiter(FIFO)와 짝이 어긋나, 이후 노드들이
      // 이전 노드의 출력을 받아 즉시 done 처리되고 리뷰 카드에 엉뚱한 출력이 뜬다.
      // 반드시 abort 하고 재시도한다.
      try { await deps.cancel?.() } catch { /* non-fatal */ }
      // abort 가 만들 수 있는 지연 final/error 이벤트가 빈 큐로 흘러 나가도록 잠깐
      // 배수(drain) — 이 사이 도착한 이벤트는 awaiter 가 없어 무해하게 버려진다.
      await new Promise(r => setTimeout(r, drainMs))
      if (deps.abort.aborted) throw err   // drain 중 Stop 눌렀으면 중단
      policy.onSliceRetry?.(attempt, portions[attempt])
    }
  }

  const rawText = result?.text ?? ''
  return {
    rawText,
    text:      stripNodeStatus(rawText),
    failure:   detectNodeFailure(rawText),
    toolCalls: result?.toolCalls ?? [],
    autoSlice,
  }
}
