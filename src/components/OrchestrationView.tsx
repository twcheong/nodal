// ─────────────────────────────────────────────────────────────────────────────
// OrchestrationView — 사이드바 Orchestration 탭의 풀 화면. WorkflowView 의 L4 형제.
//
// 레이아웃: [260 Left: 리스트 + Workflow/AI Agent 추가] [flex Canvas] [320 Builder Chat]
// 멤버 = 워크플로(leaf) 또는 AI Agent(relay 그룹, 파일로 저장된 재사용 단위). 패턴으로 함께
// 실행. 실행은 격리 게이트웨이 세션들에서 useOrchestrationRun 이 패턴 전략으로 수행.
//
// AI Agent 는 파일이 원본(source). 오케스트레이션 멤버는 { id, agentId } 참조만 저장하고,
// 캔버스엔 파일의 options/criteria 를 펼친 relay 그룹으로 렌더한다(hydrate). 그룹을 편집하면
// 다시 agent 파일에 기록한다(split-on-save). → 같은 AI Agent 를 여러 오케스트레이션에서 재사용.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef } from 'react'
import { OrchestrationListsPanel } from './OrchestrationListsPanel'
import { MemberPicker } from './orchestration/MemberPicker'
import { AgentPicker } from './orchestration/AgentPicker'
import { OrchestrationCanvas } from './orchestration/OrchestrationCanvas'
import { OrchestrationBuilderChat, type OrchestrationSpec } from './orchestration/OrchestrationBuilderChat'
import { useOrchestrations } from '../hooks/useOrchestrations'
import { useWorkflows } from '../hooks/useWorkflows'
import { useAiAgents } from '../hooks/useAiAgents'
import { useOrchestrationGateway } from '../hooks/useOrchestrationGateway'
import { useOrchestrationRun } from '../hooks/useOrchestrationRun'
import { deriveEntryInputs } from '../lib/orchestrationIO'

interface Props {
  activeOrchestrationId: string | null
  onSelectOrchestration: (id: string | null) => void
  fetchUsageCost: () => Promise<{ totals: Record<string, number>; byModel: unknown[] } | null>
  onOpenWorkflow?: (id: string) => void   // 상세 popup → Workflow 탭으로 이동(편집)
}

// 펼친 AI Agent 옵션 id 는 'agentMemberId::optionId' 로 prefix — 같은 옵션 id 가 여러 agent 에
// 있어도 캔버스에서 충돌하지 않게. 저장 시 prefix 를 떼어 깨끗한 옵션 id 로 파일에 기록한다.
const AGENT_SEP = '::'

export function OrchestrationView({ activeOrchestrationId, onSelectOrchestration, fetchUsageCost, onOpenWorkflow }: Props) {
  const orchApi = useOrchestrations()
  const wfApi   = useWorkflows()
  const aiApi   = useAiAgents()
  const gateway = useOrchestrationGateway()
  const run     = useOrchestrationRun({ gateway, fetchUsageCost, workflows: wfApi.workflows, aiAgents: aiApi.agents })

  const active = activeOrchestrationId
    ? (orchApi.orchestrations.find(o => o.id === activeOrchestrationId) ?? null)
    : null

  const agentById = useMemo(() => new Map(aiApi.agents.map(a => [a.id, a])), [aiApi.agents])
  const wfMap = () => new Map(wfApi.workflows.map(w => [w.id, w]))
  const agentMap = () => new Map(aiApi.agents.map(a => [a.id, a]))

  // 첫 로드 시 첫 항목 자동 선택.
  useEffect(() => {
    if (activeOrchestrationId === null && orchApi.orchestrations.length > 0) {
      onSelectOrchestration(orchApi.orchestrations[0].id)
    }
  }, [activeOrchestrationId, orchApi.orchestrations, onSelectOrchestration])

  // active 변경 시 디스크에서 직전 run 결과 hydrate (재시작 후 캔버스 복원).
  useEffect(() => {
    if (!activeOrchestrationId) { run.reset(); return }
    let cancelled = false
    ;(async () => {
      try {
        const saved = await window.twixy?.orchestrationRunLoad?.(activeOrchestrationId)
        if (cancelled) return
        if (saved) run.hydrate(saved); else run.reset()
      } catch { if (!cancelled) run.reset() }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrchestrationId])

  // ── hydrate: 저장된 { agentId } 참조 → 파일의 options/criteria 로 펼친 relay 그룹(렌더용) ──
  const prefixIds = (members: OrchestrationMember[], prefix: string): OrchestrationMember[] =>
    members.map(m => ({ ...m, id: prefix + m.id, children: m.children ? prefixIds(m.children, prefix) : undefined }))
  const hydrate = (members: OrchestrationMember[]): OrchestrationMember[] => members.map(m => {
    if (m.agentId) {
      const a = agentById.get(m.agentId)
      if (!a) return m   // 파일 없음 → leaf 로 렌더('Agent not found')
      return { ...m, workflowId: '', subPattern: 'relay', managerInstructions: a.criteria, children: prefixIds(a.options ?? [], m.id + AGENT_SEP) }
    }
    return m.children ? { ...m, children: hydrate(m.children) } : m
  })
  const displayOrch: TwixyOrchestration | null = active ? { ...active, members: hydrate(active.members ?? []) } : null

  // ── split-on-save: 편집된 display 트리 → (agent 파일 update) + (참조만 담은 raw 멤버) ──
  const optionsPayload = (members: OrchestrationMember[], prefix: string): OrchestrationMember[] => members.map((m, i) => ({
    id: m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id,
    workflowId: m.workflowId, label: m.label, order: i,
    subPattern: m.subPattern, width: m.width, outputScope: m.outputScope, outputFrom: m.outputFrom,
    managerInstructions: m.managerInstructions,
    children: m.children ? optionsPayload(m.children, prefix) : undefined,
  }))
  const onTreeChange = async (display: OrchestrationMember[]) => {
    if (!active) return
    const agentEdits: { id: string; options: OrchestrationMember[]; criteria?: string }[] = []
    const toRaw = (members: OrchestrationMember[]): OrchestrationMember[] => members.map((m, i) => {
      if (m.agentId) {
        // hydrate 된(children 배열 존재) agent 만 파일에 기록 — 미 hydrate 참조는 파일 보존.
        if (Array.isArray(m.children)) agentEdits.push({ id: m.agentId, options: optionsPayload(m.children, m.id + AGENT_SEP), criteria: m.managerInstructions })
        return { id: m.id, workflowId: '', agentId: m.agentId, label: m.label, order: i, width: m.width }
      }
      return {
        id: m.id, workflowId: m.workflowId, label: m.label, order: i,
        role: m.role, handoffTo: m.handoffTo, subPattern: m.subPattern, width: m.width,
        outputScope: m.outputScope, outputFrom: m.outputFrom,
        managerInstructions: m.managerInstructions, managerModel: m.managerModel,
        children: m.children ? toRaw(m.children) : undefined,
      }
    })
    const raw = toRaw(display)
    await Promise.all(agentEdits.map(e => aiApi.update(e.id, { options: e.options, criteria: e.criteria })))
    // 입력 도출은 방금 저장한 옵션을 반영해야 정확 → merged map.
    const merged = new Map(aiApi.agents.map(a => [a.id, a]))
    for (const e of agentEdits) { const cur = merged.get(e.id); if (cur) merged.set(e.id, { ...cur, options: e.options, criteria: e.criteria }) }
    await orchApi.update(active.id, { members: raw, inputs: deriveEntryInputs(raw, active.pattern, wfMap(), merged) })
  }

  const onRootPatternChange = async (pattern: OrchestrationPattern) => {
    if (!active) return
    await orchApi.update(active.id, { pattern, inputs: deriveEntryInputs(active.members ?? [], pattern, wfMap(), agentMap()) })
  }
  const onConfigChange = async (patch: Partial<OrchestrationConfig>) => {
    if (!active) return
    await orchApi.update(active.id, { config: { ...active.config, ...patch } })
  }

  // 좌측 패널 추가 — raw 멤버에 참조만 append(파일 변경 없음). 캔버스가 다시 hydrate.
  const appendRaw = async (member: OrchestrationMember) => {
    if (!active) return
    const raw = [...(active.members ?? []), member]
    await orchApi.update(active.id, { members: raw, inputs: deriveEntryInputs(raw, active.pattern, wfMap(), agentMap()) })
  }
  const onAddWorkflow = (workflowId: string) => appendRaw({ id: `w-${Date.now().toString(36)}`, workflowId })
  const onAddAgent    = (agentId: string)    => appendRaw({ id: `a-${Date.now().toString(36)}`, workflowId: '', agentId })
  const onCreateAgent = async (title: string) => {
    const created = await aiApi.create({ title })
    if (created) await onAddAgent(created.id)
  }

  const savedEndedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeOrchestrationId) return
    const { isRunning, endedAt } = run.state
    if (isRunning || !endedAt || savedEndedAtRef.current === endedAt) return
    savedEndedAtRef.current = endedAt
    void window.twixy?.orchestrationRunSave?.(activeOrchestrationId, run.state)
  }, [activeOrchestrationId, run.state])

  const applySpec = async (spec: OrchestrationSpec) => {
    if (active) {
      await orchApi.update(active.id, {
        title: spec.title, description: spec.description, pattern: spec.pattern,
        prompt: spec.prompt, inputs: spec.inputs, members: spec.members, config: spec.config,
      })
    } else {
      const created = await orchApi.create({
        title: spec.title || 'Untitled orchestration', description: spec.description,
        pattern: spec.pattern, prompt: spec.prompt, inputs: spec.inputs, members: spec.members, config: spec.config,
      })
      if (created) onSelectOrchestration(created.id)
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', background: 'var(--bg-base)' }}>
      {/* Left column */}
      <aside style={{ width: 260, background: 'var(--bg-surface)', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <OrchestrationListsPanel
            orchestrations={orchApi.orchestrations}
            activeId={activeOrchestrationId}
            isLoading={orchApi.isLoading}
            onSelect={onSelectOrchestration}
            onCreate={async (title) => orchApi.create({ title })}
            onDelete={async (id) => {
              const ok = await orchApi.remove(id)
              if (ok && activeOrchestrationId === id) onSelectOrchestration(null)
              return ok
            }} />
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)' }} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <MemberPicker
            workflows={wfApi.workflows}
            activeMembers={active?.members ?? []}
            disabled={!active || run.state.isRunning}
            onAdd={onAddWorkflow} />
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)' }} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <AgentPicker
            agents={aiApi.agents}
            activeMembers={active?.members ?? []}
            disabled={!active || run.state.isRunning}
            onAdd={onAddAgent}
            onCreate={onCreateAgent}
            onDelete={async (id) => aiApi.remove(id)} />
        </div>
      </aside>

      {/* Center: canvas */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <OrchestrationCanvas
          orchestration={displayOrch}
          workflows={wfApi.workflows}
          agents={aiApi.agents}
          runState={run.state}
          onRun={(inputs) => { if (active) void run.start(active, inputs) }}
          onStop={run.stop}
          onReset={() => {
            run.reset(); savedEndedAtRef.current = null
            if (activeOrchestrationId) void window.twixy?.orchestrationRunClear?.(activeOrchestrationId)
          }}
          onTreeChange={onTreeChange}
          onRootPatternChange={onRootPatternChange}
          onConfigChange={onConfigChange}
          onAddAgent={onAddAgent}
          onOpenWorkflow={onOpenWorkflow} />
      </main>

      {/* Right: builder chat */}
      <aside style={{ width: 320, background: 'var(--bg-surface)', borderLeft: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <OrchestrationBuilderChat
          orchestrationId={activeOrchestrationId}
          workflows={wfApi.workflows}
          agents={aiApi.agents}
          onApplySpec={applySpec} />
      </aside>
    </div>
  )
}
