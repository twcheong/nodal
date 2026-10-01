// ─────────────────────────────────────────────────────────────────────────────
// Orchestration 패턴 전략 공용 타입.
// 각 패턴(pipeline/parallel/roundtable/relay/conductor)은 runPattern 디스패처를
// 통해 동일한 StrategyCtx 를 받아 ctx.runMember / ctx.llm / ctx.update 로 실행한다.
// ─────────────────────────────────────────────────────────────────────────────

import type { NodeRunMetrics } from '../../hooks/useWorkflowTest'
import type { RunWorkflowResult } from '../runWorkflowNodes'

export type MemberRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted' | 'skipped'

export interface MemberRunState {
  status:      MemberRunStatus
  startedAt?:  number
  endedAt?:    number
  durationMs?: number
  cost?:       number
  tokensIn?:   number
  tokensOut?:  number
  output?:     string                       // 멤버(=Workflow)의 최종 출력
  reason?:     string
  nodeStates?: Record<string, NodeRunMetrics>  // leaf 멤버 내부 노드별 상세
}

// 기본값이 채워진 실행 설정 (StrategyCtx 가 사용).
export interface ResolvedConfig {
  aggregation: 'concat' | 'vote' | 'synthesize'
  maxRounds:   number
  maxHandoffs: number
  managerInstructions?: string
  managerModel?:        string
  outputFrom?:          string[]   // Parallel 그룹: output 으로 종합할 멤버 id 들(미지정=전체)
}

export interface LedgerItem {
  id:       string
  goal:     string
  memberId?: string
  status:   'pending' | 'running' | 'done' | 'failed' | 'dropped'
  note?:    string
}

export interface ThreadEntry {
  speaker: string        // member label or 'manager'
  role?:   string
  text:    string
  ts:      number
}

export interface OrchestrationRunState {
  isRunning:      boolean
  pattern?:       OrchestrationPattern
  startedAt?:     number
  endedAt?:       number
  lastRunAt?:     number
  totalCost:      number
  totalMs:        number
  totalTokensIn:  number
  totalTokensOut: number
  memberStates:   Record<string, MemberRunState>   // member.id → state
  // 패턴별 부가 산출물:
  aggregateOutput?: string      // pipeline / parallel 최종 종합
  ledger?:          LedgerItem[]  // conductor task ledger (감사 추적)
  thread?:          ThreadEntry[] // roundtable 공유 스레드
  handoffPath?:     string[]      // relay 인계 경로 (member.id 순서)
  warning?:         string        // 루프 캡 도달 등
}

export const EMPTY_RUN_STATE: OrchestrationRunState = {
  isRunning: false, totalCost: 0, totalMs: 0, totalTokensIn: 0, totalTokensOut: 0, memberStates: {},
}

// 패턴 전략이 사용하는 실행 컨텍스트. useOrchestrationRun 이 구현해 주입한다.
export interface StrategyCtx {
  orchestration: TwixyOrchestration
  members:       OrchestrationMember[]            // validate 된 멤버 (workflow 존재)
  workflowOf:    (member: OrchestrationMember) => TwixyWorkflow | null
  inputs:        Record<string, string>
  abort:         { aborted: boolean }
  config:        ResolvedConfig
  // 한 멤버(=Workflow)를 새 세션에서 실행. 멤버 상태/총합/노드 상태를 자동 갱신.
  runMember:     (member: OrchestrationMember, opts?: { preamble?: string; reviewMode?: 'auto-approve' | 'auto-skip' }) => Promise<RunWorkflowResult>
  // 매니저/검수/종합용 단발 LLM 호출 (격리 세션). 비용은 총합에 반영.
  llm:           (prompt: string) => Promise<string>
  // run state 부분 갱신 (패턴별 산출물 기록).
  patch:         (p: Partial<OrchestrationRunState> | ((s: OrchestrationRunState) => Partial<OrchestrationRunState>)) => void
  log:           (msg: string) => void
}
