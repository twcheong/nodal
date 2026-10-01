// ─────────────────────────────────────────────────────────────────────────────
// useOrchestrationRun — Orchestration(L4) 실행 상태 머신.
//
// 멤버(=Workflow)를 패턴 전략(runPattern)에 따라 실행한다. 각 멤버는 격리된
// 게이트웨이 세션에서 runWorkflowNodes 로 노드별 실행된다. 멤버 상태/노드 상태/
// 총비용·시간을 집계하고, 종료 시 last-run.json 으로 영속화해 앱 재시작 후에도
// 캔버스가 직전 실행 결과를 복원한다.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react'
import { runWorkflowNodes } from '../lib/runWorkflowNodes'
import { runPattern } from '../lib/orchestrationPatterns'
import {
  EMPTY_RUN_STATE, type OrchestrationRunState, type MemberRunState, type StrategyCtx, type ResolvedConfig,
} from '../lib/orchestrationPatterns/types'
import type { OrchestrationGateway } from './useOrchestrationGateway'
import type { NodeRunMetrics } from './useWorkflowTest'
import type { RunWorkflowResult } from '../lib/runWorkflowNodes'

interface Deps {
  gateway:        OrchestrationGateway
  fetchUsageCost: () => Promise<{ totals: Record<string, number>; byModel: unknown[] } | null>
  workflows:      TwixyWorkflow[]
  // 직전 실행 결과 영속 채널 — 기본값은 orchestrationRunSave. 지금 주입하는 곳은 없다
  // (agent 탭용 aiAgentRunSave preload 래퍼는 아무도 안 써서 Stage 5 에서 삭제됐다).
  saveRun?:       (id: string, state: unknown) => unknown
  // 팀 멤버가 AI Agent 를 참조할 때, agent 를 relay 서브-오케스트레이션으로 펼치기 위한 조회.
  aiAgents?:      TwixyAiAgent[]
}

const DEFAULT_CONFIG = { aggregation: 'synthesize' as const, maxRounds: 6, maxHandoffs: 6 }

export function useOrchestrationRun(deps: Deps) {
  const [state, setState] = useState<OrchestrationRunState>(EMPTY_RUN_STATE)
  const abortRef = useRef<{ aborted: boolean } | null>(null)

  const reset = useCallback(() => { abortRef.current = null; setState(EMPTY_RUN_STATE) }, [])

  const hydrate = useCallback((s: unknown) => {
    abortRef.current = null
    if (!s || typeof s !== 'object') { setState(EMPTY_RUN_STATE); return }
    const o = s as Partial<OrchestrationRunState>
    setState({
      ...EMPTY_RUN_STATE,
      ...o,
      isRunning: false,                     // 항상 false — 표시 전용
      memberStates: (o.memberStates && typeof o.memberStates === 'object') ? o.memberStates : {},
      totalCost: o.totalCost ?? 0, totalMs: o.totalMs ?? 0,
      totalTokensIn: o.totalTokensIn ?? 0, totalTokensOut: o.totalTokensOut ?? 0,
    })
  }, [])

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.aborted = true
    void deps.gateway.abortAll()
  }, [deps.gateway])

  const start = useCallback(async (orch: TwixyOrchestration, inputs: Record<string, string>) => {
    if (abortRef.current && state.isRunning) return
    const abort = { aborted: false }
    abortRef.current = abort

    const wfById = new Map(deps.workflows.map(w => [w.id, w]))
    const aiAgentById = new Map((deps.aiAgents ?? []).map(a => [a.id, a]))
    // group(children) / agent leaf(실존 agentId) / workflow leaf(실존 workflowId) 만 유지.
    const isGroup = (m: OrchestrationMember) => !!(m.children && m.children.length > 0)
    const validMembers = (ms: OrchestrationMember[]) => ms.filter(m => isGroup(m) || (m.agentId ? aiAgentById.has(m.agentId) : wfById.has(m.workflowId)))
    const members = validMembers(orch.members ?? [])
    const config: ResolvedConfig = { ...DEFAULT_CONFIG, ...(orch.config ?? {}) }
    const fail = (reason: string): RunWorkflowResult => ({ status: 'failed', finalOutput: '', totals: { cost: 0, ms: 0, tokensIn: 0, tokensOut: 0 }, outputs: {}, reason })

    // 트리 전체 노드 id 를 평탄 수집 — 시드용.
    const collectIds = (ms: OrchestrationMember[]): string[] => ms.flatMap(m => [m.id, ...(m.children ? collectIds(m.children) : [])])

    const runStartedAt = Date.now()
    setState({
      ...EMPTY_RUN_STATE,
      isRunning: true, pattern: orch.pattern, startedAt: runStartedAt, lastRunAt: runStartedAt,
      memberStates: Object.fromEntries(collectIds(members).map(id => [id, { status: 'pending' as const }])),
    })

    // ── 상태 갱신기 (flat — 깊이 무관, node.id 로 기록) ───────────────────────
    const setMember = (memberId: string, patch: Partial<MemberRunState>) =>
      setState(s => ({ ...s, memberStates: { ...s.memberStates, [memberId]: { ...(s.memberStates[memberId] ?? { status: 'pending' }), ...patch } } }))
    const setMemberNode = (memberId: string, nodeId: string, m: NodeRunMetrics) =>
      setState(s => {
        const ms = s.memberStates[memberId] ?? { status: 'running' as const }
        return { ...s, memberStates: { ...s.memberStates, [memberId]: { ...ms, nodeStates: { ...(ms.nodeStates ?? {}), [nodeId]: m } } } }
      })

    const addTotals = (t: { cost: number; ms: number; tokensIn: number; tokensOut: number }) =>
      setState(s => ({
        ...s,
        totalCost: s.totalCost + t.cost, totalMs: s.totalMs + t.ms,
        totalTokensIn: s.totalTokensIn + t.tokensIn, totalTokensOut: s.totalTokensOut + t.tokensOut,
      }))

    // 매니저/검수/종합용 단발 LLM — 그룹별 managerModel 적용, 비용 delta 를 총합에 반영.
    const makeLlm = (cfg: ResolvedConfig) => async (prompt: string): Promise<string> => {
      let key: string
      try { key = await deps.gateway.createSession() } catch { return '' }
      let before: Record<string, number> | undefined
      try { before = (await deps.fetchUsageCost())?.totals } catch { /* 0 */ }
      let text = ''
      try { text = (await deps.gateway.send(key, prompt, { timeoutMs: 120_000, model: cfg.managerModel })).text }
      catch { return '' }
      try {
        const after = (await deps.fetchUsageCost())?.totals
        addTotals({ cost: deltaUsd(before, after), ms: 0, tokensIn: 0, tokensOut: 0 })
      } catch { /* skip */ }
      return text
    }

    // leaf 멤버(=Workflow) 실행 — flat 상태로 기록.
    const runLeaf = async (member: OrchestrationMember, opts?: { preamble?: string; reviewMode?: 'auto-approve' | 'auto-skip' }): Promise<RunWorkflowResult> => {
      const wf = wfById.get(member.workflowId)
      if (!wf) { setMember(member.id, { status: 'skipped', reason: 'missing workflow' }); return fail('missing workflow') }
      const startedAt = Date.now()
      setMember(member.id, { status: 'running', startedAt, nodeStates: {} })
      let key: string
      try { key = await deps.gateway.createSession() }
      catch (e) { setMember(member.id, { status: 'failed', endedAt: Date.now(), reason: (e as Error).message }); return fail((e as Error).message) }
      const result = await runWorkflowNodes(wf, inputs, {
        send: (t, o) => deps.gateway.send(key, t, o),
        fetchUsageCost: deps.fetchUsageCost,
        abort,
        reviewMode: opts?.reviewMode ?? 'auto-approve',
        preamble: opts?.preamble,
        onNode: (nodeId, m) => setMemberNode(member.id, nodeId, m),
      })
      const endedAt = Date.now()
      addTotals(result.totals)
      setMember(member.id, {
        status: result.status === 'done' ? 'done' : result.status === 'aborted' ? 'aborted' : 'failed',
        endedAt, durationMs: endedAt - startedAt,
        cost: result.totals.cost, tokensIn: result.totals.tokensIn, tokensOut: result.totals.tokensOut,
        output: result.finalOutput, reason: result.reason,
      })
      return result
    }

    // 그룹 멤버 실행 — subPattern 으로 자식들을 조율(재귀), 종합 출력을 그룹 결과로.
    const runGroup = async (member: OrchestrationMember, opts?: { preamble?: string }): Promise<RunWorkflowResult> => {
      const children = validMembers(member.children ?? [])
      if (children.length === 0) { setMember(member.id, { status: 'skipped', reason: 'no valid children' }); return fail('no valid children') }
      const startedAt = Date.now()
      setMember(member.id, { status: 'running', startedAt })
      // 그룹 매니저 설정 — caps 는 루트 config 상속, manager 지시문/모델은 그룹 자체.
      const groupConfig: ResolvedConfig = { ...config, managerInstructions: member.managerInstructions, managerModel: member.managerModel, outputFrom: member.outputFrom }
      const groupLlm = makeLlm(groupConfig)
      let groupOutput = '', groupWarning: string | undefined
      const subCtx: StrategyCtx = {
        orchestration: { ...orch, pattern: member.subPattern ?? 'pipeline', members: children, prompt: opts?.preamble || orch.prompt },
        members: children,
        workflowOf: (m) => wfById.get(m.workflowId) ?? null,
        inputs, abort, config: groupConfig,
        runMember,   // ← 재귀 디스패치 (그룹 안의 그룹도 실행)
        llm: groupLlm,
        patch: (p) => { const v = (typeof p === 'function' ? {} : p) as Partial<OrchestrationRunState>; if (v.aggregateOutput != null) groupOutput = v.aggregateOutput; if (v.warning != null) groupWarning = v.warning },
        log: (msg) => console.info('[orchestration:sub]', msg),
      }
      try { await runPattern(subCtx) } catch (e) { groupWarning = (e as Error).message }

      // 명시적 output 정의가 있으면 — 그룹 결과(종합/마지막/선택 분기)를 마지막에 LLM 1회로
      // 선언 필드(name/type) 구조(JSON)에 맞게 강제 포맷해 다음 노드로 넘긴다.
      if (!abort.aborted && member.outputScope?.length && groupOutput.trim()) {
        const spec = member.outputScope.map(f => `- ${f.name} (${f.type})${f.description ? `: ${f.description}` : ''}`).join('\n')
        try {
          const formatted = await groupLlm(
            `Reformat the result below into the group's declared output fields. Return ONLY a single JSON object whose keys are exactly these field names (respect the stated types). No prose, no markdown fence.\n\n` +
            `Fields:\n${spec}\n\nResult to reformat:\n${groupOutput}`)
          if (formatted.trim()) groupOutput = formatted.trim()
        } catch { /* 포맷 실패 시 원본 출력 유지 */ }
      }
      const endedAt = Date.now()
      const status: MemberRunState['status'] = abort.aborted ? 'aborted' : 'done'
      setMember(member.id, { status, endedAt, durationMs: endedAt - startedAt, output: groupOutput, reason: groupWarning })
      return { status: status === 'aborted' ? 'aborted' : 'done', finalOutput: groupOutput, totals: { cost: 0, ms: 0, tokensIn: 0, tokensOut: 0 }, outputs: {}, reason: groupWarning }
    }

    // 그룹/리프 디스패치 (mutual recursion — function 선언으로 hoist).
    // agent leaf(team 멤버) → 그 AI Agent 를 relay 그룹(옵션들 + criteria)으로 펼쳐 실행.
    function runMember(member: OrchestrationMember, opts?: { preamble?: string; reviewMode?: 'auto-approve' | 'auto-skip' }): Promise<RunWorkflowResult> {
      if (member.agentId) {
        const agent = aiAgentById.get(member.agentId)
        if (!agent) { setMember(member.id, { status: 'skipped', reason: 'missing agent' }); return Promise.resolve(fail('missing agent')) }
        return runGroup({ id: member.id, workflowId: '', subPattern: 'relay', children: agent.options ?? [], managerInstructions: agent.criteria }, opts)
      }
      return isGroup(member) ? runGroup(member, opts) : runLeaf(member, opts)
    }

    const patch: StrategyCtx['patch'] = (p) =>
      setState(s => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }))

    const ctx: StrategyCtx = {
      orchestration: orch,
      members,
      workflowOf: (m) => wfById.get(m.workflowId) ?? null,
      inputs,
      abort,
      config,
      runMember,
      llm: makeLlm(config),
      patch,
      log: (msg) => console.info('[orchestration]', msg),
    }

    try {
      await runPattern(ctx)
    } catch (err) {
      patch({ warning: `Run error: ${(err as Error).message}` })
    } finally {
      setState(s => {
        const finalState = { ...s, isRunning: false, endedAt: Date.now() }
        // 영속화 — 표시용 스냅샷(주입된 채널 우선, 기본 orchestration).
        try { void (deps.saveRun ?? window.twixy?.orchestrationRunSave)?.(orch.id, finalState) } catch { /* non-fatal */ }
        return finalState
      })
    }
  }, [deps, state.isRunning])

  return { state, start, stop, reset, hydrate }
}

function deltaUsd(before?: Record<string, number>, after?: Record<string, number>): number {
  const pick = (t?: Record<string, number>) => {
    if (!t) return undefined
    for (const k of ['usd', 'cost', 'totalCost', 'cost_usd', 'usdCost']) if (typeof t[k] === 'number') return t[k]
    return undefined
  }
  const a = pick(after), b = pick(before)
  if (typeof a !== 'number') return 0
  if (typeof b !== 'number') return a
  return Math.max(0, a - b)
}
