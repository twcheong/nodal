// ─────────────────────────────────────────────────────────────────────────────
// useWorkflowTest — 워크플로 Test Mode 실행기 (병렬 실행 지원).
//
// 핵심 원칙: 실제 LLM 으로 노드들을 순차 실행한다. 시뮬레이션이 아니다.
// 그래야 노드별 시간/비용이 실전과 동일.
//
// 병렬 실행:
//   - 상태는 workflowId 별 맵 (states) — 서로 다른 워크플로는 동시에 돌 수 있고,
//     같은 워크플로의 이중 실행만 막는다.
//   - 각 run 은 자기 abort 객체 / 자기 게이트웨이 세션(sendAndAwaitFinal 에
//     workflowId 전달)을 쓰므로 Stop/실패가 다른 run 에 영향 없음.
//   - 알려진 부정확성: 비용/토큰 델타는 user-global usage 에서 계산하므로 두
//     run 이 겹치는 구간에선 서로의 사용량이 섞여 per-node cost 가 과대 표시될
//     수 있다 (합계는 보존됨 — 표시용 힌트로 취급).
//
// 각 노드:
//   1) 시작 시각 기록 + 노드 전 fetchUsageCost 스냅샷
//   2) buildNodePrompt() 로 만든 지시문을 sendAndAwaitFinal 로 전송
//   3) 어시스턴트 final reply 받으면 끝 시각 + 노드 후 사용량 스냅샷
//   4) 비용/토큰 = 후 - 전 델타
//
// Review 노드: 실제 사람의 결정을 기다린다 (approve/note/skip).
// 노드 하나가 실패하면 그 워크플로만 즉시 중단.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { friendlyRunError } from '../lib/runErrors'
import { runnerHarnessPreamble } from '../lib/runnerHarness'
import { workflowRunnerAgent } from '../lib/agents/workflowRunner'
import { bridgeToolsFor } from '../lib/workflowTools'
import { NODE_STATUS_LINES } from '../lib/nodeStatus'
import { runNodeSequence, type ReviewOutcome } from '../lib/harness/runNodeSequence'
import { extractTotals, settledUsage, usageDelta, type UsageTotals } from '../lib/harness/usage'
import {
  fileRefRegex, BINARY_DOC_EXTS, ATTACH_PER_FILE_CAP, ATTACH_TOTAL_BUDGET,
} from '../../shared/fileTypes'

export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting-review'   // Human Review 노드에서 실제 사람의 결정을 기다리는 중
  | 'done'
  | 'failed'
  | 'skipped'
  | 'aborted'

export type ReviewAction = 'approve' | 'note' | 'skip'
export interface ReviewDecision {
  action:   ReviewAction
  comment?: string       // 'note' 의 경우 사람이 적은 코멘트 — 다음 노드로 가기 전에
                         //   그 워크플로의 세션에 user 메시지로 주입돼 컨텍스트에 합쳐짐
}

export interface NodeRunMetrics {
  status:      NodeRunStatus
  startedAt?:  number
  endedAt?:    number
  durationMs?: number
  costUsd?:    number
  tokensIn?:   number
  tokensOut?:  number
  reason?:     string             // skip 사유 / 에러 메시지
  // 이 노드의 LLM 최종 응답 텍스트. 다음 노드(특히 Review)가 "직전 출력"
  // 으로 사람에게 보여줄 때 사용. action/validation 노드만 채워짐.
  output?:     string
  // 실행 로그(Epic 3) — 노드에 보낸 지시문(클립)과 턴 중 툴 호출 목록.
  // 브라우저 액션은 toolCalls 의 detail 에 URL/액션이 담긴다.
  prompt?:     string
  toolCalls?:  Array<{ name: string; detail?: string }>
  // 런타임 자동 분할이 개입했을 때만 채워진다: 타임아웃 몇 번 만에, 어느 크기로
  // 통과했는지. 이 노드는 이번 run 은 살았지만 스펙상 너무 크다는 증거이므로,
  // 자동 리뷰가 이걸 보고 빌더에게 영구 분할을 제안한다.
  autoSlice?:  { attempts: number; portion: string }
}

// 로그용 프롬프트 클립 상한 — 상세 로그 파일이 병리적으로 커지는 것 방지.
const LOG_PROMPT_MAX = 8_000

// 노드 1개의 실행 상한. 타임아웃은 노드마다 리셋된다 (누적 아님). 9분인 이유:
// sub-agent 위임이 막힌 workflow-runner 에서 긴 루프가 한 턴에 인라인으로
// 돌아 5분으론 부족한 케이스가 있었다. (openclaw 게이트웨이의 runTimeoutSeconds
// 기본값은 0=무제한이라, 실효 상한은 이 클라이언트 값이다.)
const NODE_TIMEOUT_MS = 540_000

// 타임아웃 시 범위를 줄여 재시도할 때 쓰는 단계. 아이템 수 N 을 모르는 채로
// 줄여야 하므로 개수가 아니라 "비율" 로 지시한다 — 실행기가 자기 스코프를
// 아는 유일한 주체다. 3단계까지만: 1/8 에서도 안 되면 크기 문제가 아니다.
const SLICE_PORTIONS = ['about half', 'about a quarter', 'about an eighth'] as const

export interface WorkflowTestState {
  isRunning:      boolean
  startedAt?:     number
  endedAt?:       number
  totalCost:      number
  totalMs:        number
  totalTokensIn:  number
  totalTokensOut: number
  // 이 run 에 쓰인 입력값 — Resume 이 입력 폼 없이 같은 값으로 재개할 때 사용.
  inputs?:        Record<string, string>
  nodeStates:     Record<string, NodeRunMetrics>
  // 시작 직전 한 번 stamping. UI 가 "Last test:" 로 표시할 때 사용.
  lastRunAt?:     number
  // 이 run 이 lease 한 브라우저 프로필 (wf-1..3). 프리뷰 패널이 이 값으로
  // 어느 Chrome(cdpPort 18800+N)을 볼지 정한다. run 종료 후에도 유지 —
  // "마지막으로 쓴 브라우저" 를 계속 보여주기 위함.
  browserProfile?: string
  // 이 state 가 이번 세션에서 실제로 실행된 run 이 아니라 디스크 스냅샷
  // (last-test-run.json)에서 복원된 것이면 true. run "종료" 부수효과 —
  // 자동 리뷰 요청, runs.jsonl append, 실패 알림/빌더 fix 요청 — 는 이
  // 플래그가 붙은 state 를 건너뛴다. 안 그러면 앱을 켤 때마다 마지막 run 이
  // 방금 끝난 것처럼 보여 리뷰/이력/알림이 매번 재발사된다.
  hydrated?:      boolean
}

export const EMPTY_TEST_STATE: WorkflowTestState = {
  isRunning:      false,
  totalCost:      0,
  totalMs:        0,
  totalTokensIn:  0,
  totalTokensOut: 0,
  nodeStates:     {},
  hydrated:       false,
}

interface Deps {
  // useWorkflowTestSession 이 노출하는 함수들 (workflowId-지향).
  sendAndAwaitFinal: (workflowId: string, text: string, opts?: { timeoutMs?: number; displayText?: string }) =>
    Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
  fetchUsageCost: () => Promise<{ totals: Record<string, number>; byModel: unknown[] } | null>
  // 특정 워크플로 세션 하나만의 누적 usage — 병렬 run 간 비용 오염을 막는다.
  // 없으면 fetchUsageCost(전역)로 폴백. null 이면 세션 미확보.
  fetchSessionUsage?: (workflowId: string) => Promise<{ usd?: number; tokensIn?: number; tokensOut?: number } | null>
  // Stop 버튼 즉시 효과를 위해 필수 — 해당 워크플로 세션의 turn 중단 + 진행 중인
  // sendAndAwaitFinal awaiter 즉시 reject. 없으면 abort 플래그만 세팅되고
  // chrome 노드 같이 오래 걸리는 단계가 끝날 때까지 Stop 이 무시됨.
  cancelTurn?: (workflowId: string) => Promise<void>
  // run 의 브라우저 슬롯(wf-1..3) 등록/해제 — useWorkflowTestSession 제공.
  // 등록 시 openclaw 훅이 그 세션의 browser 호출에 profile 을 강제.
  assignBrowserProfile?: (workflowId: string, profile: string | null) => Promise<void>
  // 러너 세션의 정체성을 workflowId 대신 여기서 매핑한 값으로 잡는다. Copilot
  // 탭은 `${convId}::${wfId}` 를 돌려줘 세션을 "탭별" 로 만든다 (같은 WF 를 두
  // 탭에서 열어도 러너 기억이 안 섞이고, 탭 닫으면 그 세션만 파괴 가능).
  // 미제공 시 workflowId 그대로 — WF 탭의 기존 동작(워크플로별 세션) 유지.
  sessionScope?: (workflowId: string) => string
  // 이 run 의 중간/수집 파일이 들어갈 workspace-상대 raw 폴더 (탭별). 노드
  // 프롬프트가 러너에게 "raw 는 여기 써라" 로 주입 → 탭 닫을 때 이 폴더만
  // 삭제하면 산출물(data/reports)은 두고 중간물만 정리된다. null 이면 미주입.
  rawScratchDir?: (workflowId: string) => string | null
}

// 동시 실행 상한 3 — 슬롯당 독립 Chrome (wf-1..3, openclaw.json browser.profiles).
// 상한/배정의 장부는 main 프로세스 전역(wf-slot-lease IPC) — 여기 상수는 IPC
// 미가용 환경의 폴백 용도로만 남아 있다.
const SLOT_PROFILES = ['wf-1', 'wf-2', 'wf-3'] as const

export type StartResult = { ok: true } | { ok: false; reason: 'max_concurrent' | 'already_running' | 'no_nodes' }

// Clear(reset) 브로드캐스트 — WF 탭과 Copilot 탭은 각자 useWorkflowTest 인스턴스를
// 갖고(둘 다 항상 마운트) run 상태를 인스턴스별 메모리에 들고 있다. 한 탭에서만
// 비우면 다른 탭 인스턴스엔 이전 run(aborted 등)이 그대로 남아, 그 탭을 열 때
// 되살아난 것처럼 보인다. 모듈 레벨 구독으로 모든 인스턴스가 같이 비운다.
const resetSubscribers = new Set<(workflowId: string) => void>()

export function useWorkflowTest(deps: Deps) {
  // workflowId → run 상태. 여러 워크플로가 동시에 존재/실행 가능.
  const [states, setStates] = useState<Record<string, WorkflowTestState>>({})
  // start(resume) 가 콜백 안에서 최신 상태를 읽기 위한 ref 미러.
  const statesRef = useRef(states)
  useEffect(() => { statesRef.current = states }, [states])
  // workflowId → 그 run 의 abort 플래그 객체.
  const abortsRef = useRef<Map<string, { aborted: boolean }>>(new Map())
  // 실행 중 워크플로 집합 — 같은 워크플로의 이중 start 방지 (state 는 비동기라 ref).
  const runningRef = useRef<Set<string>>(new Set())
  // workflowId → lease 한 브라우저 슬롯 프로필. 크기가 곧 동시 실행 수.
  const slotsRef = useRef<Map<string, string>>(new Map())
  // `${workflowId}:${nodeId}` → 그 노드의 review 결정을 기다리는 resolver.
  const pendingReviewRef = useRef<Map<string, (d: ReviewDecision) => void>>(new Map())

  // 특정 워크플로의 상태만 함수형 패치.
  const patch = useCallback((workflowId: string, updater: (s: WorkflowTestState) => WorkflowTestState) => {
    setStates(prev => ({ ...prev, [workflowId]: updater(prev[workflowId] ?? EMPTY_TEST_STATE) }))
  }, [])

  // run 상태는 workflowId 로 키잉하되, 러너 "세션"의 정체성만 deps.sessionScope
  // 로 갈아끼운다 (Copilot 은 탭별, WF 탭은 workflowId 그대로). 세션 관련 dep
  // (sendAndAwaitFinal/cancelTurn/assignBrowserProfile/fetchSessionUsage) 호출
  // 은 전부 이 값을 쓴다.
  const scopeFor = useCallback((workflowId: string): string => {
    return deps.sessionScope?.(workflowId) ?? workflowId
  }, [deps])

  const stateFor = useCallback((workflowId: string | null): WorkflowTestState => {
    if (!workflowId) return EMPTY_TEST_STATE
    return states[workflowId] ?? EMPTY_TEST_STATE
  }, [states])

  const stop = useCallback((workflowId: string) => {
    const abort = abortsRef.current.get(workflowId)
    if (abort) abort.aborted = true
    // 그 워크플로에서 대기 중인 review 가 있으면 skip 으로 보내 deadlock 회피.
    for (const [key, resolver] of pendingReviewRef.current) {
      if (key.startsWith(`${workflowId}:`)) {
        pendingReviewRef.current.delete(key)
        resolver({ action: 'skip' })
      }
    }
    // 진행 중인 sendAndAwaitFinal awaiter 즉시 reject — 그 워크플로 세션만.
    void deps.cancelTurn?.(scopeFor(workflowId))
  }, [deps, scopeFor])

  // 외부에서 사람의 결정을 hook 에 전달. 캔버스 카드 / overlay 둘 다 같은 API 호출.
  const resumeReview = useCallback((workflowId: string, nodeId: string, decision: ReviewDecision) => {
    const key = `${workflowId}:${nodeId}`
    const resolver = pendingReviewRef.current.get(key)
    if (resolver) {
      pendingReviewRef.current.delete(key)
      resolver(decision)
    }
  }, [])

  // 다른 인스턴스(다른 탭)의 Clear 를 받아 이 인스턴스의 상태도 비운다.
  // 그 워크플로를 실제로 돌리고 있는 인스턴스는 예외 — 진행 중인 run 의
  // 소유자가 자기 상태를 잃으면 안 된다.
  useEffect(() => {
    const onRemoteReset = (workflowId: string) => {
      if (runningRef.current.has(workflowId)) return
      abortsRef.current.delete(workflowId)
      setStates(prev => (prev[workflowId] ? { ...prev, [workflowId]: EMPTY_TEST_STATE } : prev))
    }
    resetSubscribers.add(onRemoteReset)
    return () => { resetSubscribers.delete(onRemoteReset) }
  }, [])

  const reset = useCallback((workflowId: string) => {
    abortsRef.current.delete(workflowId)
    runningRef.current.delete(workflowId)
    setStates(prev => ({ ...prev, [workflowId]: EMPTY_TEST_STATE }))
    // 디스크의 마지막 run 스냅샷(last-test-run.json)도 함께 삭제 — 안 지우면
    // 다른 탭이(또는 재시작 후 이 탭이) hydrate 로 지운 결과를 되살린다.
    // plan_* 처럼 저장된 적 없는 id 는 파일이 없어 no-op.
    void Promise.resolve(window.twixy?.workflowTestRunClear?.(workflowId)).catch(() => {})
    // 다른 탭 인스턴스에도 전파.
    for (const fn of resetSubscribers) fn(workflowId)
  }, [])

  // 외부 (디스크 저장된 직전 run) 에서 특정 워크플로의 state 를 주입.
  // isRunning 은 false 강제 — 화면에 "이전 결과" 만 표시하는 용도.
  const hydrate = useCallback((workflowId: string, s: unknown) => {
    if (runningRef.current.has(workflowId)) return  // 실행 중이면 덮지 않음
    if (!s || typeof s !== 'object') {
      setStates(prev => ({ ...prev, [workflowId]: EMPTY_TEST_STATE }))
      return
    }
    const o = s as Partial<WorkflowTestState>
    setStates(prev => {
      // 이번 세션에서 실제로 돌린 바로 그 run 이면 덮지 않는다 — 내용은 같지만
      // hydrated 표식이 붙는 순간 아직 못 보낸 리뷰/실패 보고가 영영 막힌다
      // (백그라운드 run 종료 → 그 워크플로로 전환하는 경로).
      const cur = prev[workflowId]
      if (cur && !cur.hydrated && cur.startedAt && cur.startedAt === o.startedAt) return prev
      return {
        ...prev,
        [workflowId]: {
          ...EMPTY_TEST_STATE,
          isRunning:      false,
          startedAt:      typeof o.startedAt   === 'number' ? o.startedAt   : undefined,
          endedAt:        typeof o.endedAt     === 'number' ? o.endedAt     : undefined,
          lastRunAt:      typeof o.lastRunAt   === 'number' ? o.lastRunAt   : undefined,
          totalCost:      typeof o.totalCost     === 'number' ? o.totalCost     : 0,
          totalMs:        typeof o.totalMs       === 'number' ? o.totalMs       : 0,
          totalTokensIn:  typeof o.totalTokensIn === 'number' ? o.totalTokensIn : 0,
          totalTokensOut: typeof o.totalTokensOut=== 'number' ? o.totalTokensOut: 0,
          nodeStates:     (o.nodeStates && typeof o.nodeStates === 'object') ? o.nodeStates : {},
          browserProfile: typeof o.browserProfile === 'string' ? o.browserProfile : undefined,
          // Resume 이 앱 재시작 후에도 같은 입력값으로 재개할 수 있게 복원.
          inputs:         (o.inputs && typeof o.inputs === 'object') ? o.inputs : undefined,
          // 복원본 표식 — "run 이 방금 끝났다" 부수효과를 막는다.
          hydrated:       true,
        },
      }
    })
  }, [])

  const start = useCallback(async (
    workflow: TwixyWorkflow,
    inputs: Record<string, string>,
    opts?: { resume?: boolean; fromIndex?: number },
  ): Promise<StartResult> => {
    if (!workflow || workflow.nodes.length === 0) return { ok: false, reason: 'no_nodes' }
    const wfId = workflow.id
    if (runningRef.current.has(wfId)) return { ok: false, reason: 'already_running' }

    // ── Resume / Run-from-node — 직전 run 을 보존하고 중간부터 재개 ────────
    // resume: 앞에서부터 연속 done/skipped 인 prefix 다음(=실패 지점)부터.
    // fromIndex: 사용자가 고른 노드부터 — 그 앞 노드들의 상태는 전부 보존.
    // 보존 노드들의 output 은 재개 첫 프롬프트에 recap 으로 주입돼, 세션이
    // 날아간 뒤(앱 재시작)에도 LLM 이 이전 맥락을 이어받는다.
    const prevRun = (opts?.resume || opts?.fromIndex != null) ? statesRef.current[wfId] : undefined
    const preserved: Record<string, NodeRunMetrics> = {}
    let startIndex = 0
    if (prevRun) {
      if (opts?.fromIndex != null) {
        startIndex = Math.max(0, Math.min(opts.fromIndex, workflow.nodes.length - 1))
        for (let i = 0; i < startIndex; i++) {
          const st = prevRun.nodeStates[workflow.nodes[i].id]
          if (st && st.status !== 'pending') preserved[workflow.nodes[i].id] = st
        }
      } else {
        for (let i = 0; i < workflow.nodes.length; i++) {
          const st = prevRun.nodeStates[workflow.nodes[i].id]
          if (st && (st.status === 'done' || st.status === 'skipped')) {
            preserved[workflow.nodes[i].id] = st
            startIndex = i + 1
          } else break
        }
      }
    }
    // 보존 구간의 비용/시간 합계 — 직전 run 총합을 그대로 이어받으면 fromIndex
    // 재실행 시 뒤 노드들의 비용이 이중 계상되므로 preserved 에서 재계산한다.
    let preservedCost = 0, preservedMs = 0, preservedIn = 0, preservedOut = 0
    for (const st of Object.values(preserved)) {
      preservedCost += st.costUsd    ?? 0
      preservedMs   += st.durationMs ?? 0
      preservedIn   += st.tokensIn   ?? 0
      preservedOut  += st.tokensOut  ?? 0
    }

    // ── 브라우저 슬롯 lease — 동시 실행 3개 상한의 실체 ──────────────────
    // 장부는 main 프로세스 전역 (wf-slot-lease IPC). 이 훅은 Copilot 탭과
    // Workflow 탭에 인스턴스가 하나씩 있는데, 풀이 인스턴스별 로컬이면 두 탭이
    // 같은 슬롯(=같은 Chrome)을 동시에 잡는다. 전역 장부는 그 충돌과 같은
    // 워크플로의 탭 간 이중 실행을 함께 막는다.
    const lease = await window.twixy?.wfSlotLease?.({ workflowId: wfId })
      // IPC 미가용(비 electron dev 등) 시 폴백 — 단일 슬롯으로 동작.
      ?? { ok: true as const, profile: SLOT_PROFILES[0] as string }
    if (!lease.ok || !lease.profile) {
      return { ok: false, reason: lease.reason === 'already_running' ? 'already_running' : 'max_concurrent' }
    }
    const slotProfile = lease.profile
    slotsRef.current.set(wfId, slotProfile)
    runningRef.current.add(wfId)

    // 세션 확보 + sessionKey→profile 매핑 등록 (openclaw 훅이 browser 호출에
    // 이 프로필을 강제). 첫 노드 전송 전에 완료돼야 함.
    try { await deps.assignBrowserProfile?.(scopeFor(wfId), slotProfile) } catch { /* non-fatal */ }

    const abort = { aborted: false }
    abortsRef.current.set(wfId, abort)

    const finishRun = () => {
      runningRef.current.delete(wfId)
      slotsRef.current.delete(wfId)
      void window.twixy?.wfSlotRelease?.({ workflowId: wfId })  // 전역 lease 반납
      void deps.assignBrowserProfile?.(scopeFor(wfId), null)  // 매핑 해제 (fire-and-forget)
      patch(wfId, s => ({ ...s, isRunning: false, endedAt: Date.now() }))
    }

    const runStartedAt = Date.now()
    setStates(prev => ({
      ...prev,
      [wfId]: {
        ...EMPTY_TEST_STATE,
        isRunning:      true,
        startedAt:      runStartedAt,
        lastRunAt:      runStartedAt,
        browserProfile: slotProfile,
        inputs,
        // 보존 노드들의 비용/시간 합계에서 이어서 누적.
        totalCost:      preservedCost,
        totalMs:        preservedMs,
        totalTokensIn:  preservedIn,
        totalTokensOut: preservedOut,
        nodeStates: Object.fromEntries(workflow.nodes.map(n =>
          [n.id, preserved[n.id] ?? { status: 'pending' as NodeRunStatus }])),
      },
    }))

    // 이 run 의 usage 소스. fetchSessionUsage(이 워크플로 세션만) 를 우선 —
    // 병렬 run 이 돌아도 자기 세션 델타만 보므로 노드별 비용/토큰이 섞이지 않는다.
    // 세션 usage 를 못 얻으면 전역 fetchUsageCost 로 폴백.
    const getUsage = async (): Promise<UsageTotals> => {
      if (deps.fetchSessionUsage) {
        try {
          const s = await deps.fetchSessionUsage(scopeFor(wfId))
          if (s) return { usd: s.usd, tokensIn: s.tokensIn, tokensOut: s.tokensOut }
        } catch { /* 폴백 */ }
      }
      const u = await deps.fetchUsageCost()
      return extractTotals(u?.totals)
    }

    let totalCost      = preservedCost
    let totalMs        = preservedMs
    let totalTokensIn  = preservedIn
    let totalTokensOut = preservedOut

    // resume 첫 프롬프트에 붙는 완료 노드 recap — 세션이 사라졌어도(재시작)
    // 이전 노드들의 출력으로 맥락을 복원한다.
    const resumeRecap = startIndex > 0 ? buildResumeRecap(workflow, preserved, startIndex) : undefined

    // Human Review 노드 — 실제 사람의 결정을 기다린다 (테스트 모드도 똑같이).
    // 이 대기는 Test run 에만 있는 정책이라 훅에 남는다. Orchestration 은 같은
    // 자리에 자동 승인/건너뜀을 끼운다.
    const awaitHumanReview = async (node: TwixyWorkflowNode): Promise<ReviewOutcome> => {
      const reviewStartedAt = Date.now()
      const decision = await new Promise<ReviewDecision>(resolve => {
        pendingReviewRef.current.set(`${wfId}:${node.id}`, resolve)
      })
      const reviewEndedAt = Date.now()
      const reviewDurationMs = reviewEndedAt - reviewStartedAt

      if (decision.action === 'skip') {
        // 건너뛴 시간은 노드에만 남기고 run 합계에는 더하지 않는다 (기존 동작).
        return {
          metrics: {
            status: 'skipped', startedAt: reviewStartedAt, endedAt: reviewEndedAt,
            durationMs: reviewDurationMs, reason: 'Human chose to skip',
          },
        }
      }

      if (decision.action === 'approve') {
        return {
          metrics: {
            status: 'done', startedAt: reviewStartedAt, endedAt: reviewEndedAt,
            durationMs: reviewDurationMs, costUsd: 0, reason: 'Approved by human',
          },
          totalsDelta: { ms: reviewDurationMs },
        }
      }

      // 'note' — 코멘트를 그 워크플로 세션에 user 메시지로 보내 LLM 응답까지 받고 다음 노드로.
      const note = (decision.comment ?? '').trim()
      const noteMsg = `[Human reviewer note on "${node.title}"] ${note || '(no comment)'}`
      let noteReplyText = ''
      // 노트 전송 직전 원장 스냅샷 — 이 턴이 쓴 만큼만 노드에 기록하기 위해.
      let before: UsageTotals = {}
      try { before = await getUsage() } catch { /* 0 기준 */ }
      try {
        const noteResult = await deps.sendAndAwaitFinal(scopeFor(wfId), noteMsg, { timeoutMs: 120_000 })
        noteReplyText = noteResult?.text ?? ''
      } catch {
        // 응답 실패해도 워크플로는 계속.
      }
      let d = { costUsd: 0, tokensIn: 0, tokensOut: 0 }
      try { d = usageDelta(before, await settledUsage(getUsage, before)) } catch { /* 0 */ }
      const noteEndedAt = Date.now()
      return {
        metrics: {
          status: 'done', startedAt: reviewStartedAt, endedAt: noteEndedAt,
          durationMs: noteEndedAt - reviewStartedAt,
          costUsd: d.costUsd, tokensIn: d.tokensIn, tokensOut: d.tokensOut,
          reason: note ? `Note sent: ${note.slice(0, 80)}` : 'Note sent',
          output: noteReplyText,
        },
        totalsDelta: {
          cost: d.costUsd, ms: noteEndedAt - reviewStartedAt,
          tokensIn: d.tokensIn, tokensOut: d.tokensOut,
        },
      }
    }

    // 노드 시퀀싱은 harness/runNodeSequence 가 한다 — Orchestration 과 같은 루프다.
    // 여기 남는 건 React state 배선, 사람이 누르는 review, run 종료 뒷정리뿐.
    const seq = await runNodeSequence({
      workflow,
      startIndex,
      abort,

      buildPrompt: async ({ node, isFirst }) => {
        // 이 노드가 참조하는 바이너리 문서(.xlsx/.xls/.pdf) 내용을 미리 추출해
        // 프롬프트에 첨부한다. 러너의 read 툴은 바이너리를 못 연다 (관측: EISDIR /
        // require 에러로 헤매다 노드가 헛돌음). 앱의 인제스트 레지스트리가 텍스트로
        // 뽑아 넘겨준다. 텍스트 파일은 러너가 직접 읽으므로 여기 대상 아님.
        const attachedFiles = await loadReferencedFiles(node)
        return workflowRunnerAgent.buildBody({
          workflow, node, inputs, isFirst,
          run: {
            promptStyle:     'workflow-test',
            harnessPreamble: runnerHarnessPreamble(),
            browserProfile:  slotProfile,
            resumeRecap:     isFirst ? resumeRecap : undefined,
            attachedFiles,
            rawScratchDir:   deps.rawScratchDir?.(wfId) ?? null,
          },
        }) as string
      },

      turn: {
        send:   (text, opts) => deps.sendAndAwaitFinal(scopeFor(wfId), text, opts),
        cancel: () => deps.cancelTurn?.(scopeFor(wfId)) ?? Promise.resolve(),
      },
      // 타임아웃은 노드마다 리셋된다(누적 아님). 9분인 이유: sub-agent 위임이 막힌
      // workflow-runner 에서 긴 크롤 루프가 한 턴에 인라인으로 돌아 5분으론 부족한
      // 케이스가 있었다. 타임아웃은 "이 노드가 감당할 수 없는 크기" 라는 신호라,
      // 스펙을 건드리지 않고 범위를 줄여 다시 던진다(이번 run 을 살리는 쪽).
      turnPolicy: ({ node, index }) => ({
        timeoutMs:     NODE_TIMEOUT_MS,
        slicePortions: SLICE_PORTIONS,
        onSliceRetry: (_a, next) =>
          console.warn(`[workflowTest] node "${node.title}" timed out — turn aborted, retrying at ${next}`),
        label: (attempt, portion) => portion === null
          ? `▶ Node ${index + 1} started — ${node.title}`
          : `▶ Node ${index + 1} retry ${attempt} (${portion}) — ${node.title}`,
      }),

      getUsage,
      onReview: ({ node }) => awaitHumanReview(node),

      // 합계는 재개된 run 의 보존분 위에 얹는다 — 시퀀스는 이번 구간만 센다.
      onNode: ({ nodeId, metrics, totals }) => {
        patch(wfId, s => ({
          ...s,
          totalCost:      preservedCost + totals.cost,
          totalMs:        preservedMs   + totals.ms,
          totalTokensIn:  preservedIn   + totals.tokensIn,
          totalTokensOut: preservedOut  + totals.tokensOut,
          nodeStates: { ...s.nodeStates, [nodeId]: metrics },
        }))
      },

      // 프로바이더 raw 에러("403 Key limit exceeded …")를 그대로 노출하면 유저는
      // 노드가 왜 죽었는지 못 읽는다. 크레딧 소진/레이트리밋/키 무효를 문장으로.
      mapError:        friendlyRunError,
      recordPrompt:    LOG_PROMPT_MAX,
      recordToolCalls: true,
      logLabel:        'workflowTest',
    })

    // 멈춘 지점 뒤의 pending 노드들을 aborted 로 칠한다. 멈춘 노드 자신은 시퀀스가
    // 이미 보고했으므로 exclusive.
    if (seq.stoppedAtNodeId) {
      const stoppedTitle = workflow.nodes.find(nd => nd.id === seq.stoppedAtNodeId)?.title ?? ''
      markRemainingAborted(patch, wfId, workflow, seq.stoppedAtNodeId, /* exclusive */ true,
        seq.status === 'aborted'
          ? 'Stopped by user'
          : seq.failureKind === 'self-report'
            ? `Stopped after "${stoppedTitle}" reported it could not complete`
            : `Stopped after "${stoppedTitle}" failed`)
    }

    finishRun()
    return { ok: true }
  }, [deps, patch, scopeFor])

  // 중단/실패한 run 을 실패 지점부터 재개 — 입력값은 직전 run 것을 재사용.
  // 완료 prefix 는 보존되고 recap 으로 LLM 에 전달된다 (세션 유실에도 안전).
  const resume = useCallback((workflow: TwixyWorkflow): Promise<StartResult> => {
    const st = statesRef.current[workflow.id]
    return start(workflow, st?.inputs ?? {}, { resume: true })
  }, [start])

  // 마지막 run 을 기반으로 특정 노드부터 재실행 — 그 앞 노드들의 결과는 보존돼
  // recap 으로 전달되고, 고른 노드부터 다시 돈다. 입력값은 직전 run 재사용.
  const startFromNode = useCallback((workflow: TwixyWorkflow, nodeId: string): Promise<StartResult> => {
    const idx = workflow.nodes.findIndex(n => n.id === nodeId)
    if (idx < 0) return Promise.resolve({ ok: false, reason: 'no_nodes' } as StartResult)
    const st = statesRef.current[workflow.id]
    return start(workflow, st?.inputs ?? {}, { fromIndex: idx })
  }, [start])

  return { states, stateFor, start, resume, startFromNode, stop, reset, hydrate, resumeReview }
}

// ── helpers ─────────────────────────────────────────────────────────────────


// ── 바이너리 문서 입력 첨부 ──────────────────────────────────────────────────
// 노드가 참조하는 .xlsx/.xls/.pdf 경로를 뽑아 앱(main)의 인제스트 레지스트리
// (extractText.ts)로 텍스트를 추출해 프롬프트에 첨부한다. 러너의 read 툴은
// 바이너리 문서를 못 열기 때문 — 이 첨부가 없으면 "엑셀/PDF에서 값 고치기" 류
// 작업이 파일을 못 읽고 실패한다. 텍스트 파일(json/csv/md/txt)은 러너가 직접
// read 툴로 읽으므로 여기 대상이 아니다 (프롬프트 절약).
// 목록은 shared/fileTypes.ts 소유. 예전엔 여기에 xlsx/xls/pdf 만 적혀 있어서
// .docx 와 .pptx 는 노드가 경로를 언급해도 아무것도 첨부되지 않았다 — 채팅
// 경로에선 붙는데 노드 경로에선 안 붙는, 목록 두 벌이 만든 조용한 비대칭.
const DOC_PATH_RE = fileRefRegex(BINARY_DOC_EXTS)

async function loadReferencedFiles(node: TwixyWorkflowNode): Promise<string | undefined> {
  const twixy = typeof window !== 'undefined' ? window.twixy : undefined
  if (!twixy?.extractFileText) return undefined
  const hay = [
    node.detail ?? '',
    node.acceptance ?? '',
    ...(node.inputScope  ?? []).map(f => `${f.name} ${f.description ?? ''}`),
    ...(node.outputScope ?? []).map(f => f.name),
  ].join(' ')
  DOC_PATH_RE.lastIndex = 0        // /g 정규식은 상태를 갖는다 — 재사용 전 리셋
  const paths = Array.from(new Set(
    (hay.match(DOC_PATH_RE) ?? [])
      .map(p => p.replace(/^[`'"@]+|[`'"]+$/g, '').replace(/^\.?\//, '').replace(/^~\//, '')),
  ))
  if (paths.length === 0) return undefined

  const blocks: string[] = []
  let budget = ATTACH_TOTAL_BUDGET
  for (const rel of paths) {
    if (budget <= 0) break
    try {
      const res = await twixy.extractFileText({ relPath: rel, maxChars: Math.min(budget, ATTACH_PER_FILE_CAP) })
      if (!res) continue
      if (res.ok && res.text) {
        budget -= res.text.length
        blocks.push(`--- ${rel} (${res.kind ?? 'file'}${res.truncated ? '; truncated' : ''}) ---\n${res.text}`)
      } else if (res.note) {
        blocks.push(`--- ${rel} — cannot read: ${res.note} ---`)
      }
    } catch { /* skip unreadable file */ }
  }
  if (blocks.length === 0) return undefined
  return [
    '[Attached file contents — these documents were extracted FOR you because your read tool cannot open binary files (Excel/Word/PowerPoint/PDF). Do NOT try to read them again with the read tool; use the text below directly. To save changes to a spreadsheet, produce the corrected table and use your xlsx write capability to write it back to the same path.',
    'If a block below ends in a [TRUNCATED …] marker, the rest of that file EXISTS — you are seeing a display limit, not the end of the data. Never report the missing part as absent or uncollected. For spreadsheets and CSVs, use the data → query tool (SQL over the whole file) to count, filter or aggregate the full table.]',
    ...blocks,
  ].join('\n')
}

function markRemainingAborted(
  patchFn: (workflowId: string, updater: (s: WorkflowTestState) => WorkflowTestState) => void,
  workflowId: string,
  workflow: TwixyWorkflow,
  fromNodeId: string,
  exclusive = false,
  reason?: string,
) {
  patchFn(workflowId, s => {
    const next = { ...s.nodeStates }
    let found = false
    for (const n of workflow.nodes) {
      if (n.id === fromNodeId) {
        found = true
        if (exclusive) continue
      }
      if (!found) continue
      if (next[n.id]?.status === 'pending') {
        next[n.id] = { status: 'aborted', reason }
      }
    }
    return { ...s, nodeStates: next }
  })
}

// ── Prompt builder — node-by-node instruction ───────────────────────────────
// 첫 노드일 때만 workflow 헤더+inputs를 같이 보내, 같은 채팅 세션에서 후속
// 노드 호출들이 컨텍스트를 자연스럽게 이어받게 한다.
// Resume 첫 프롬프트에 붙는 완료 노드 recap — 노드별 output 을 클립해 나열.
// 게이트웨이 세션이 살아 있으면 중복 컨텍스트지만 무해하고, 세션이 사라진
// 경우(앱 재시작)에는 이것이 유일한 이전 맥락 전달 수단이다.
function buildResumeRecap(
  workflow:  TwixyWorkflow,
  preserved: Record<string, NodeRunMetrics>,
  startIndex: number,
): string {
  const parts: string[] = [
    '[Resuming from the middle of a previous run — the nodes below already ran. Use their outputs as context; do NOT redo nodes marked done/skipped.]',
  ]
  for (let i = 0; i < startIndex; i++) {
    const n  = workflow.nodes[i]
    const st = preserved[n.id]
    parts.push(`### (${st?.status ?? 'not run'}) Node ${i + 1}: ${n.title}`)
    if (st?.output && (st.status === 'done' || st.status === 'skipped')) {
      parts.push(st.output.length > 1200 ? st.output.slice(0, 1200) + '…' : st.output)
    }
  }
  return parts.join('\n')
}

