// OrchestrationCanvas — 중앙 컬럼. 오케스트레이션을 "중첩 그룹 트리"로 편집/표시.
// 디자인: Workflow 탭처럼 깔끔한 세로 노드 플로우. 멤버 = simplified 노드, 사이는 얇은
// ↓ 커넥터. 컨트롤(이동/삭제/+/선택)은 hover 때만 미세하게. 그룹은 옅은 박스 + 로컬
// method 셀렉터. 빈 그룹엔 추천 구조(schematic)를 보여주고 그 자리에 노드를 채운다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { OrchestrationMemberCard } from './OrchestrationMemberCard'
import { WorkflowDetailModal, AgentDetailModal } from './OrchestrationDetailModal'
import { HoverTip } from './HoverTip'
import { WORKFLOW_DND_MIME, AGENT_DND_MIME } from './MemberPicker'
import { DISABLED_PATTERNS, PATTERN_META } from '../../lib/orchestrationPatterns'
import {
  ROOT_ID, isGroupNode, groupPattern,
  setNode, removeNode, moveNode, insertSiblingOf, appendToGroup, groupNodes, ungroupNode, wrapInParallel, addDownstream,
} from '../../lib/orchestrationTree'
import { deriveEntryInputs, memberOutputFields, compatOf, criticalPathMs, typeAbbrev, deriveEntryUnits, unitSatisfied, optionSatisfied, unmetUnitCount, type PairCompat, type EntryUnit, type EntryOption } from '../../lib/orchestrationIO'
import type { OrchestrationRunState } from '../../lib/orchestrationPatterns/types'
import { DisplayCost } from '../../lib/useDisplayUsd'

const PATTERNS: OrchestrationPattern[] = (['pipeline', 'parallel', 'research', 'relay', 'roundtable', 'conductor'] as OrchestrationPattern[])
  .filter(p => !DISABLED_PATTERNS.includes(p))
const GROUPABLE: OrchestrationPattern[] = PATTERNS.filter(p => p !== 'pipeline')

interface Props {
  orchestration: TwixyOrchestration | null
  workflows:     TwixyWorkflow[]
  runState:      OrchestrationRunState
  onRun:         (inputs: Record<string, string>) => void
  onStop:        () => void
  onReset:       () => void
  onTreeChange:  (members: OrchestrationMember[]) => void
  onRootPatternChange: (p: OrchestrationPattern) => void
  onConfigChange: (patch: Partial<OrchestrationConfig>) => void
  agents?:       TwixyAiAgent[]             // AI Agent 목록 — agent 그룹(relay) 렌더 + DnD 추가용
  onAddAgent?:   (agentId: string) => void  // AI Agent 그룹을 루트 멤버로 추가(파일 참조)
  onOpenWorkflow?: (id: string) => void     // 상세 popup → Workflow 탭으로 이동(편집)
}

interface GCtx {
  workflows: TwixyWorkflow[]
  wfById:    Map<string, TwixyWorkflow>
  runState:  OrchestrationRunState
  isRunning: boolean
  selected:  Set<string>
  toggleSelect: (id: string, parentId: string) => void
  insertSibling: (id: string, wfId: string, pos: 'above' | 'below') => void
  appendChild:   (groupId: string, wfId: string) => void
  remove:        (id: string) => void
  move:          (id: string, dir: -1 | 1) => void
  ungroup:       (id: string) => void
  // 워크플로를 노드 오른쪽에 드롭 → parallel 자동 묶기(또는 이미 가로 그룹이면 sibling 추가)
  dropBeside:    (targetId: string, parentId: string, parentPattern: OrchestrationPattern, wfId: string) => void
  canGroup:      boolean   // 현재 선택을 그룹할 수 있는지 (중첩-속-중첩 금지)
  setPattern:    (groupId: string, p: OrchestrationPattern) => void
  editManager:   (groupId: string) => void
  criteriaOf:    (groupId: string) => string
  setWidth:      (groupId: string, w: number) => void
  addDownstream: (branchId: string, wfId: string) => void
  outputOf:      (groupId: string) => WorkflowScopeField[]   // 그룹의 명시적 output 정의
  outputFromOf:  (groupId: string) => string[] | null        // Parallel: 선택된 멤버 id (null=전체)
  editOutput:    (groupId: string) => void
  pickItems:     { id: string; title: string }[]   // 워크플로 추가 picker 목록
  leafKey:       'workflowId'                       // 새 leaf = 워크플로
  dndMime:       string                             // 워크플로 드롭 MIME
  agentById:     Map<string, TwixyAiAgent>          // AI Agent 그룹 렌더용
  addAgent:      (agentId: string) => void          // AI Agent 그룹을 루트 멤버로 추가
  openWf:        (wf: TwixyWorkflow) => void         // 워크플로 상세 popup
  openAgent:     (a: TwixyAiAgent) => void           // AI Agent 상세 popup
}

export function OrchestrationCanvas({
  orchestration, workflows, runState, onRun, onStop, onReset, onTreeChange, onRootPatternChange, onConfigChange,
  agents, onAddAgent, onOpenWorkflow,
}: Props) {
  const wfById = useMemo(() => new Map(workflows.map(w => [w.id, w])), [workflows])
  const agentById = useMemo(() => new Map((agents ?? []).map(a => [a.id, a])), [agents])
  // 모든 leaf 는 워크플로(raw 멤버 또는 AI Agent 옵션). AI Agent 는 leaf 가 아니라 그룹.
  const leafKey: 'workflowId' = 'workflowId'
  const dndMime = WORKFLOW_DND_MIME
  const pickItems = useMemo(() => workflows.map(w => ({ id: w.id, title: w.title })), [workflows])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selParent, setSelParent] = useState<string | null>(null)
  const [editingManager, setEditingManager] = useState<string | null>(null)
  const [editingOutput, setEditingOutput] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ kind: 'wf'; wf: TwixyWorkflow } | { kind: 'agent'; agent: TwixyAiAgent } | null>(null)
  const [showInputs, setShowInputs] = useState(false)   // 입력 폼 — 기본 접힘, Start 누르면 펼침
  const [zoom, setZoom] = useState(1)

  // 진입 입력을 observed 기본값으로 prefill (오케스트레이션 전환 시). 빈 칸은 placeholder 로 안내.
  useEffect(() => {
    if (!orchestration) return
    const ei = deriveEntryInputs(orchestration.members ?? [], orchestration.pattern, wfById, agentById)
    setInputs(prev => {
      let changed = false
      const next = { ...prev }
      for (const p of ei) {
        if (next[p.id] === undefined) { next[p.id] = String(p.observed ?? ''); changed = true }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration?.id])

  if (!orchestration) return <Empty>Select or create an orchestration to begin.</Empty>
  const o = orchestration
  const isRunning = runState.isRunning
  const members = o.members ?? []
  // 실행 전 입력 — 단위(unit)로 그룹화. AI Agent 는 옵션 중 "하나만" 채우면 충족.
  // (observed 기본값 prefill 은 위 useEffect 가 평탄 union 으로 따로 처리.)
  const entryUnits = deriveEntryUnits(members, o.pattern, wfById, agentById)
  const unmet = unmetUnitCount(entryUnits, inputs)
  const clearSel = () => { setSelected(new Set()); setSelParent(null) }

  const g: GCtx = {
    workflows, wfById, runState, isRunning, selected,
    toggleSelect: (id, parentId) => {
      if (isRunning) return
      if (selParent !== parentId) { setSelParent(parentId); setSelected(new Set([id])); return }
      setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); if (n.size === 0) setSelParent(null); return n })
    },
    insertSibling: (id, wfId, pos) => { onTreeChange(insertSiblingOf(members, id, wfId, pos, leafKey)); clearSel() },
    appendChild:   (groupId, wfId) => { onTreeChange(appendToGroup(members, groupId, wfId, leafKey)); clearSel() },
    remove:        (id) => { onTreeChange(removeNode(members, id)); clearSel() },
    move:          (id, dir) => onTreeChange(moveNode(members, id, dir)),
    ungroup:       (id) => { onTreeChange(ungroupNode(members, id)); clearSel() },
    dropBeside:    (targetId, parentId, parentPattern, wfId) => {
      // 이미 가로 그룹(parallel/relay/research) 안이면 sibling 으로만 추가(중첩-속-중첩 금지),
      // 루트 pipeline 이면 target 과 함께 parallel 그룹으로 감싼다.
      if (parentPattern === 'pipeline' && parentId === ROOT_ID) onTreeChange(wrapInParallel(members, targetId, wfId, leafKey))
      else onTreeChange(insertSiblingOf(members, targetId, wfId, 'below', leafKey))
    },
    // 그룹 생성은 루트(pipeline)에서만 — 이미 parallel/specialist 안에서는 불가.
    canGroup: selParent === ROOT_ID && o.pattern === 'pipeline',
    setPattern:    (groupId, p) => groupId === ROOT_ID ? onRootPatternChange(p) : onTreeChange(setNode(members, groupId, { subPattern: p })),
    editManager:   (groupId) => setEditingManager(groupId),
    criteriaOf:    (groupId) => (groupId === ROOT_ID ? o.config?.managerInstructions : findNode(members, groupId)?.managerInstructions) ?? '',
    setWidth:      (groupId, w) => onTreeChange(setNode(members, groupId, { width: w })),
    addDownstream: (branchId, wfId) => { onTreeChange(addDownstream(members, branchId, wfId, leafKey)); clearSel() },
    outputOf:      (groupId) => findNode(members, groupId)?.outputScope ?? [],
    outputFromOf:  (groupId) => findNode(members, groupId)?.outputFrom ?? null,
    editOutput:    (groupId) => setEditingOutput(groupId),
    pickItems, leafKey, dndMime, agentById,
    addAgent:      (agentId) => { onAddAgent?.(agentId); clearSel() },
    openWf:        (wf) => setDetail({ kind: 'wf', wf }),
    openAgent:     (a) => setDetail({ kind: 'agent', agent: a }),
  }

  const doGroup = (pattern: OrchestrationPattern) => { onTreeChange(groupNodes(members, [...selected], pattern)); clearSel() }

  const mgrTarget = editingManager
  const mgrCur = mgrTarget === ROOT_ID ? (o.config?.managerInstructions ?? '')
    : mgrTarget ? (findNode(members, mgrTarget)?.managerInstructions ?? '') : ''
  const mgrPattern = mgrTarget === ROOT_ID ? o.pattern
    : mgrTarget ? groupPattern(findNode(members, mgrTarget) ?? { id: '', workflowId: '' }) : 'relay'
  const mgrKind: 'relay' | 'research' | 'manager' =
    mgrTarget === ROOT_ID ? 'manager' : mgrPattern === 'research' ? 'research' : 'relay'
  const saveMgr = (instructions: string) => {
    if (mgrTarget === ROOT_ID) onConfigChange({ managerInstructions: instructions })
    else if (mgrTarget) onTreeChange(setNode(members, mgrTarget, { managerInstructions: instructions }))
    setEditingManager(null)
  }

  // 그룹 output 편집 — Parallel 은 "어느 멤버 output 을 쓸지" 선택, 그 외는 필드 정의.
  const outNode = editingOutput ? findNode(members, editingOutput) : null
  const outIsParallel = outNode ? groupPattern(outNode) === 'parallel' : false
  const outInitial = outNode ? memberOutputFields(outNode, wfById, agentById) : []
  const saveOutput = (fields: WorkflowScopeField[]) => {
    if (editingOutput) onTreeChange(setNode(members, editingOutput, { outputScope: fields.length ? fields : undefined }))
    setEditingOutput(null)
  }
  const saveOutputFrom = (ids: string[]) => {
    if (editingOutput) {
      const outMembers = (outNode?.children ?? []).filter(c => branchHasOutput(c, wfById, agentById)).map(c => c.id)
      const norm = ids.length === 0 || ids.length === outMembers.length ? undefined : ids   // 전체/없음 = 미지정(=전체)
      onTreeChange(setNode(members, editingOutput, { outputFrom: norm }))
    }
    setEditingOutput(null)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {detail?.kind === 'wf' && <WorkflowDetailModal workflow={detail.wf} onOpenWorkflow={onOpenWorkflow} onClose={() => setDetail(null)} />}
      {detail?.kind === 'agent' && <AgentDetailModal agent={detail.agent} wfById={wfById} onOpenWorkflow={onOpenWorkflow} onViewWorkflow={(wf) => setDetail({ kind: 'wf', wf })} onClose={() => setDetail(null)} />}
      {editingManager && <CriteriaPanel kind={mgrKind} instructions={mgrCur} onClose={() => setEditingManager(null)} onSave={saveMgr} />}
      {editingOutput && outNode && (outIsParallel
        ? <GroupOutputSelectPanel members={outNode.children ?? []} wfById={wfById} agentById={agentById} selected={outNode.outputFrom ?? null} onClose={() => setEditingOutput(null)} onSave={saveOutputFrom} />
        : <GroupOutputPanel initial={outInitial} onClose={() => setEditingOutput(null)} onSave={saveOutput} />)}

      <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.title}</div>
            {o.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{o.description}</div>}
          </div>
          {!isRunning ? (<>
            <button
              onClick={() => { if (members.length === 0) return; if (unmet > 0) { setShowInputs(true); return } onRun(inputs) }}
              disabled={members.length === 0} style={runBtn(members.length === 0)}
              title={members.length === 0 ? 'Add a workflow first' : unmet > 0 ? 'Fill required inputs first (one option per AI Agent)' : undefined}>▶ Run</button>
            <button onClick={onReset} style={ghostBtn()}>Reset</button>
          </>) : <button onClick={onStop} style={stopBtn()}>■ Stop</button>}
        </div>
        {(runState.startedAt || runState.totalCost > 0) && (
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-secondary)' }}>
            <span title="Critical path: parallel groups take their slowest member; pipeline stages add up">{(criticalPathMs(members, o.pattern, runState.memberStates) / 1000).toFixed(1)}s</span><span><DisplayCost rawUsd={runState.totalCost} showZero /></span>
            <span>↓{runState.totalTokensIn} ↑{runState.totalTokensOut}</span>
            {runState.warning && <span style={{ color: '#d29922' }}>⚠ {runState.warning}</span>}
          </div>
        )}
        {entryUnits.length > 0 && !isRunning && (
          showInputs ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>Required inputs</span>
                {unmet > 0 && <span style={{ fontSize: 10, color: '#d29922' }}>{unmet} to fill</span>}
                <button onClick={() => setShowInputs(false)} style={{ ...miniBtn(false), marginLeft: 'auto' }}>▴ Collapse</button>
              </div>
              <EntryUnitsForm units={entryUnits} values={inputs} disabled={isRunning} unmet={unmet}
                onChange={(id, v) => setInputs(s => ({ ...s, [id]: v }))} />
            </div>
          ) : (
            <button onClick={() => setShowInputs(true)} style={{ ...miniBtn(false), alignSelf: 'flex-start' }}>
              ▾ Inputs{unmet > 0 ? ` · ${unmet} required` : ' · all set'}
            </button>
          )
        )}
        {selected.size >= 2 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)' }}>
            {g.canGroup ? (<>
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>Group {selected.size} as method:</span>
              {GROUPABLE.map(p => <button key={p} onClick={() => doGroup(p)} style={miniBtn(false)}>{PATTERN_META[p].label}</button>)}
            </>) : (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Can’t group here — nesting inside a group isn’t allowed (for now).</span>
            )}
            <button onClick={clearSel} style={{ ...miniBtn(false), marginLeft: 'auto' }}>Cancel</button>
          </div>
        )}
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 18px', position: 'relative' }}
        onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(z => Math.max(0.4, Math.min(2, z - e.deltaY * 0.0015))) } }}>
        {/* zoom 컨트롤 */}
        <div style={{ position: 'sticky', top: 0, left: 0, zIndex: 6, display: 'flex', justifyContent: 'flex-end', gap: 4, height: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 4px', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
            <button onClick={() => setZoom(z => Math.max(0.4, z - 0.1))} style={iconBtn} title="Zoom out">−</button>
            <button onClick={() => setZoom(1)} style={{ ...iconBtn, minWidth: 34 }} title="Reset zoom">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} style={iconBtn} title="Zoom in">+</button>
          </div>
        </div>
        <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.05s' }}>
        {/* Manager + 루트 파이프라인을 하나의 콘텐츠-중심 축에 묶는다 — 콘텐츠가 가로로 넘쳐도
            Manager 와 아래 spine(synthesis/planner/…)이 같은 세로선에 정렬되도록(첫 노드 기준). */}
        <div style={{ width: 'fit-content', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {members.length > 0 && (<>
            <ManagerNode text={o.config?.managerInstructions ?? ''} onEdit={() => !isRunning && setEditingManager(ROOT_ID)} disabled={isRunning} />
            <div style={{ width: 1.5, height: 14, background: 'var(--border)' }} />
          </>)}
          <GroupBox groupId={ROOT_ID} pattern={o.pattern} members={members} isRoot depth={0} g={g} />
        </div>

        {runState.thread && runState.thread.length > 0 && (
          <Section title="Thread">{runState.thread.map((t, i) => (
            <div key={i} style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <b style={{ color: 'var(--text-primary)' }}>{t.speaker}{t.role ? ` (${t.role})` : ''}:</b>{' '}
              <span style={{ color: 'var(--text-secondary)' }}>{clip(t.text, 280)}</span>
            </div>))}</Section>
        )}
        {runState.handoffPath && runState.handoffPath.length > 0 && (
          <Section title="Specialist path">
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {runState.handoffPath.map(id => findNode(members, id)?.label || wfById.get(findNode(members, id)?.workflowId ?? '')?.title || id).join('  →  ')}
            </div></Section>
        )}
        {runState.aggregateOutput && !isRunning && (
          <Section title="Result"><div style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{clip(runState.aggregateOutput, 2000)}</div></Section>
        )}
        </div>
      </div>
    </div>
  )
}

// ── GroupBox (재귀) — 깔끔한 세로/가로 플로우 ─────────────────────────────────
const DEFAULT_GROUP_W = 360
// ── 진입 입력 폼 — 단위(unit)별. AI Agent(옵션 N개)는 "하나만 채우면 됨"을 명시 ───────
function InputRow({ inp, value, onChange, disabled }: { inp: TwixyModuleParam; value?: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      <span style={{ width: 120, flexShrink: 0, color: 'var(--text-muted)' }} title={`${inp.id} · ${inp.valueType}`}>{inp.label || inp.id}</span>
      <input value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={String(inp.observed ?? '') || `${inp.valueType}…`} disabled={disabled}
        style={{ flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 11, padding: '4px 8px', outline: 'none' }} />
    </label>
  )
}

function EntryUnitsForm({ units, values, onChange, disabled, unmet }: {
  units: EntryUnit[]; values: Record<string, string>; onChange: (id: string, v: string) => void; disabled: boolean; unmet: number
}) {
  const inputRows = (opts: EntryOption[]) => opts[0]?.inputs ?? []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {units.map(u => {
        const multi = u.kind === 'agent' && u.options.length > 1
        // 단순 단위(워크플로 / 단일옵션 agent) — 입력 그대로. (입력 없으면 생략)
        if (!multi) {
          const ins = inputRows(u.options)
          if (!ins.length) return null
          return (
            <div key={u.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {u.kind === 'agent' && <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--accent)' }}>AI Agent · {u.label}</div>}
              {ins.map(inp => <InputRow key={inp.id} inp={inp} value={values[inp.id]} onChange={v => onChange(inp.id, v)} disabled={disabled} />)}
            </div>
          )
        }
        // 다중옵션 AI Agent — 옵션 중 "하나만" 채우면 됨.
        const sat = unitSatisfied(u, values)
        return (
          <div key={u.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '8px 10px', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--accent)' }}>AI Agent</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-primary)' }}>{u.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: sat ? '#3fb950' : '#d29922' }}>{sat ? '✓ one option filled' : 'fill ONE option ↓'}</span>
            </div>
            {u.options.map((opt, i) => {
              const oSat = optionSatisfied(opt, values)
              const dim = sat && !oSat
              return (
                <div key={opt.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 8, borderLeft: `2px solid ${oSat ? '#3fb950' : 'var(--border)'}`, opacity: dim ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{i === 0 ? '' : 'or '}{opt.label}</span>
                    {oSat && <span style={{ color: '#3fb950' }}>✓</span>}
                  </div>
                  {opt.inputs.length
                    ? opt.inputs.map(inp => <InputRow key={inp.id} inp={inp} value={values[inp.id]} onChange={v => onChange(inp.id, v)} disabled={disabled} />)
                    : <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>No inputs needed</span>}
                </div>
              )
            })}
          </div>
        )
      })}
      {unmet > 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Fill required inputs to run — each AI Agent needs only <b>one</b> option.</span>}
    </div>
  )
}

const HCARD_W = 360   // 가로 배치(그룹 안) 워크플로/agent 카드 폭 — 이름 잘 보이게 넓게
const VCARD_W = 560   // 세로(루트) 워크플로 카드 폭
function GroupBox({ groupId, pattern, members, isRoot, depth, g, width, onResize, bare, cardW, agent }: {
  groupId: string; pattern: OrchestrationPattern; members: OrchestrationMember[]; isRoot: boolean; depth: number; g: GCtx
  width?: number; onResize?: (w: number) => void; bare?: boolean; cardW?: number; agent?: TwixyAiAgent | null
}) {
  const CW = cardW ?? VCARD_W
  const [dragOver, setDragOver] = useState(false)
  // width 미설정 시 'fit-content' — 워크플로가 안 가려짐. 리사이즈하면 px 고정.
  const [w, setW] = useState<number | undefined>(width)
  const baseRef = useRef(0)
  const wRef = useRef(w); wRef.current = w
  const boxRef = useRef<HTMLDivElement | null>(null)
  const horizontal = pattern !== 'pipeline'
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    const wf = e.dataTransfer.getData(WORKFLOW_DND_MIME); if (wf) { g.appendChild(groupId, wf); return }
    const ag = e.dataTransfer.getData(AGENT_DND_MIME); if (ag) g.addAgent(ag)   // AI Agent 는 루트 그룹 멤버로
  }
  const onDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types
    if (!g.isRunning && (t.includes(WORKFLOW_DND_MIME) || t.includes(AGENT_DND_MIME))) { e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  }

  const empty = members.length === 0
  const addCtl = !g.isRunning && (
    horizontal
      ? <div style={{ alignSelf: 'center', flexShrink: 0 }}><AddPicker items={g.pickItems} onPick={(id) => g.appendChild(groupId, id)} compact /></div>
      : <InsertLine onPick={(id) => g.appendChild(groupId, id)} items={g.pickItems} />
  )
  const nodeEls = members.map((m, i) => (
    <NodeWrap key={m.id} node={m} parentId={groupId} parentPattern={pattern} index={i} count={members.length} horizontal={horizontal} siblings={members} depth={depth} g={g} cardW={CW} />
  ))
  // 가로 행 — 박스 폭 안에서 스크롤(넘쳐도 박스 밖으로 안 나감).
  const hrow = (extra?: React.CSSProperties) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, overflowX: 'auto', maxWidth: '100%', padding: '4px 6px 8px', ...extra }}>
      {nodeEls}{addCtl}
    </div>
  )

  let flow: React.ReactNode
  if (empty) {
    flow = <div style={{ padding: '8px 6px' }}>
      <PatternSchematic pattern={pattern} />
      {!g.isRunning && <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}><AddPicker items={g.pickItems} onPick={(id) => g.appendChild(groupId, id)} /></div>}
    </div>
  } else if (pattern === 'parallel') {
    flow = hrow()
  } else if (pattern === 'research') {
    // Parallel research: 워크플로들(가로) → 수렴 버스 → 끝점의 종합(synthesis) 노드.
    // criteria 가 시작점이면, 종합 노드는 끝점에 있다. 모든 output 을 하나로 합친다.
    const HALF = HCARD_W / 2
    flow = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 'max-content' }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              {members.map((m, i) => (
                <div key={m.id} style={{ minWidth: HCARD_W, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                  <NodeWrap node={m} parentId={groupId} parentPattern={pattern} index={i} count={members.length} horizontal siblings={members} depth={depth} g={g} cardW={CW} />
                </div>
              ))}
            </div>
            {/* 수렴 버스 — 각 카드 중심 → 하단 bus(첫~마지막 카드 중심) */}
            <div style={{ position: 'relative', height: 16, alignSelf: 'stretch' }}>
              <div style={{ display: 'flex', gap: 14 }}>
                {members.map(m => (
                  <div key={m.id} style={{ width: HCARD_W, display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: 1.5, height: 12, background: 'var(--border)' }} />
                  </div>
                ))}
              </div>
              <div style={{ position: 'absolute', top: 12, left: HALF, right: HALF, height: 2, background: 'var(--border)' }} />
            </div>
          </div>
        </div>
        <div style={{ width: 1.5, height: 12, background: 'var(--border)' }} />
        <AggregateNode text={g.criteriaOf(groupId)} onEdit={() => g.editManager(groupId)} disabled={g.isRunning} count={members.length} />
      </div>
    )
  } else if (pattern === 'relay') {
    // Specialist 포크: criteria → | → ─── (bus는 wf1~wfN 중심선까지만) → ||| → 워크플로
    const HALF = HCARD_W / 2   // bus 양끝 inset = 카드 절반(첫/마지막 드롭선 중심)
    flow = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <CriteriaNode text={g.criteriaOf(groupId)} onEdit={() => g.editManager(groupId)} disabled={g.isRunning} />
        <div style={{ width: 1.5, height: 12, background: 'var(--border)' }} />
        <div>
          <div style={{ position: 'relative', display: 'flex', gap: 14, width: 'max-content', padding: '0 0 8px' }}>
            {/* bus — 첫 카드 중심에서 마지막 카드 중심까지 */}
            <div style={{ position: 'absolute', top: 0, left: HALF, right: HALF, height: 2, background: 'var(--border)' }} />
            {members.map((m, i) => (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: HCARD_W, flexShrink: 0 }}>
                <div style={{ width: 1.5, height: 10, background: 'var(--border)' }} />
                <NodeWrap node={m} parentId={groupId} parentPattern={pattern} index={i} count={members.length} horizontal siblings={members} depth={depth} g={g} cardW={CW} />
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginTop: 4 }}>
          <span style={{ fontSize: 8.5, color: 'var(--text-muted)' }}>only 1 of {members.length} runs</span>
        </div>
      </div>
    )
  } else {
    // pipeline (세로 체인) — 루트에서만. 중심 정렬.
    flow = <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: isRoot ? 0 : '8px 10px 10px' }}>{nodeEls}{addCtl}</div>
  }

  const body = (
    <div onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
      style={{ outline: dragOver ? '2px dashed var(--accent)' : 'none', outlineOffset: -3, borderRadius: 8 }}>
      {flow}
    </div>
  )

  // bare = 병렬 분기(branch)의 pipeline 체인 — 박스/헤더 없이 세로 체인만.
  if (bare) return body
  if (isRoot) return <div style={{ width: 'fit-content', margin: '0 auto' }}>{body}</div>
  // width = max-content(항상 내용물 fit) + minWidth=저장폭 → 저장 폭은 박스를 넓히기만,
  // 절대 내용물보다 좁게 잘라 노드가 박스 밖으로 그려지지 않게 한다.
  return (
    <div ref={boxRef} style={{ position: 'relative', width: 'max-content', minWidth: w, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md, 8px)', background: depth % 2 ? 'transparent' : 'var(--bg-base)' }}>
      <GroupHeader groupId={groupId} pattern={pattern} g={g} count={members.length} agent={agent} />
      {body}
      {/* AI Agent(relay) 그룹은 output = 옵션 교집합(고정) → output 노드 없음.
          일반 그룹: Parallel 은 멤버 output 선택, 그 외는 field 정의. */}
      {agent ? null : pattern === 'parallel'
        ? <GroupOutputSelectNode members={members} selected={g.outputFromOf(groupId)} wfById={g.wfById} agentById={g.agentById} onEdit={() => g.editOutput(groupId)} disabled={g.isRunning} />
        : <GroupOutputNode fields={g.outputOf(groupId)} onEdit={() => g.editOutput(groupId)} disabled={g.isRunning} />}
      {!g.isRunning && onResize && (
        <div title="Drag to resize width"
          onPointerDown={e => {
            e.preventDefault(); e.stopPropagation()
            baseRef.current = w ?? boxRef.current?.offsetWidth ?? DEFAULT_GROUP_W
            const sx = e.clientX
            const mv = (ev: PointerEvent) => setW(Math.max(240, Math.min(3000, baseRef.current + (ev.clientX - sx))))
            const up = () => { if (wRef.current != null) onResize(wRef.current); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
            window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
          }}
          style={{ position: 'absolute', top: 0, right: -3, width: 8, height: '100%', cursor: 'ew-resize', zIndex: 4 }} />
      )}
    </div>
  )
}

function GroupHeader({ groupId, pattern, g, count, agent }: { groupId: string; pattern: OrchestrationPattern; g: GCtx; count: number; agent?: TwixyAiAgent | null }) {
  const [hover, setHover] = useState(false)
  // AI Agent 그룹 — method 잠금(relay), label 'AI Agent · <title>' + type 배지. remove = 참조만 제거.
  if (agent) {
    const research = agent.agentType === 'research'
    return (
      <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onClick={() => g.openAgent(agent)} title="Click for AI Agent details"
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 9px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--accent-dim)', cursor: 'pointer' }}>
        <span style={{ fontSize: 8.5, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>AI Agent</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }} title={agent.title}>{agent.title}</span>
        <span title={agent.agentType} style={{ flexShrink: 0, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, padding: '1px 5px', borderRadius: 4, color: research ? '#3fb950' : '#d29922', background: research ? 'rgba(63,185,80,0.12)' : 'rgba(210,153,34,0.12)' }}>{typeAbbrev(agent.agentType)}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>{count} option{count === 1 ? '' : 's'}</span>
        {!g.isRunning && (
          <button onClick={e => { e.stopPropagation(); g.remove(groupId) }} title="Remove from orchestration (keeps the saved AI Agent)" style={{ ...iconBtn, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }}>×</button>
        )}
      </div>
    )
  }
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 9px', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ fontSize: 8.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>group</span>
      <select value={pattern} disabled={g.isRunning} onChange={e => g.setPattern(groupId, e.target.value as OrchestrationPattern)} style={selStyle}>
        {GROUPABLE.map(p => <option key={p} value={p}>{PATTERN_META[p].label}</option>)}
      </select>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>{count}</span>
      {!g.isRunning && (
        <span style={{ display: 'flex', gap: 3, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }}>
          <button onClick={() => g.ungroup(groupId)} title="Ungroup" style={iconBtn}>⊟</button>
          <button onClick={() => g.remove(groupId)} title="Remove group" style={iconBtn}>×</button>
        </span>
      )}
    </div>
  )
}

// ── NodeWrap — 노드 1개 + hover 컨트롤(미세) ──────────────────────────────────
function NodeWrap({ node, parentId, parentPattern, index, count, horizontal, siblings, depth, g, cardW }: {
  node: OrchestrationMember; parentId: string; parentPattern: OrchestrationPattern; index: number; count: number
  horizontal: boolean; siblings: OrchestrationMember[]; depth: number; g: GCtx; cardW?: number
}) {
  const [hover, setHover] = useState(false)
  const [rightOver, setRightOver] = useState(false)
  const isGroup = isGroupNode(node)
  const sel = g.selected.has(node.id)
  const st = g.runState.memberStates[node.id]

  // 노드 오른쪽 가장자리 드롭존 — 워크플로를 떨구면 parallel 로 자동 묶기.
  const rightDrop = !g.isRunning && !isGroup && (
    <div
      onDragOver={e => { if (e.dataTransfer.types.includes(g.dndMime)) { e.preventDefault(); e.stopPropagation(); setRightOver(true) } }}
      onDragLeave={() => setRightOver(false)}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setRightOver(false); const id = e.dataTransfer.getData(g.dndMime); if (id) g.dropBeside(node.id, parentId, parentPattern, id) }}
      title="Drop a workflow here to run in parallel"
      style={{ position: 'absolute', top: 18, right: -2, width: 22, height: 'calc(100% - 18px)', zIndex: 1,
        borderRight: rightOver ? '3px solid var(--accent)' : '3px solid transparent',
        background: rightOver ? 'linear-gradient(to right, transparent, var(--accent-dim))' : 'transparent' }} />
  )

  const toolbar = !g.isRunning && (
    <div style={{ position: 'absolute', top: -9, right: 6, display: 'flex', gap: 2, opacity: hover || sel ? 1 : 0, transition: 'opacity 0.12s', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 3px', zIndex: 2 }}>
      {/* 그룹 선택(묶기) 버튼은 루트의 leaf 워크플로에서만 (그룹 노드 제외) */}
      {parentId === ROOT_ID && !isGroup && <button onClick={() => g.toggleSelect(node.id, parentId)} title="Select (to group)" style={{ ...iconBtn, color: sel ? 'var(--accent)' : 'var(--text-muted)' }}>{sel ? '☑' : '☐'}</button>}
      <button onClick={() => g.move(node.id, -1)} disabled={index === 0} style={iconBtn} title="Move up">↑</button>
      <button onClick={() => g.move(node.id, 1)} disabled={index === count - 1} style={iconBtn} title="Move down">↓</button>
      <button onClick={() => g.remove(node.id)} style={iconBtn} title="Remove">×</button>
    </div>
  )

  // 병렬 분기(branch)가 pipeline 체인이면 박스 없이 세로 체인으로(bare).
  // AI Agent 그룹은 항상 박스+헤더로(분기여도 'AI Agent' 헤더 유지).
  const agentOfNode = node.agentId ? (g.agentById.get(node.agentId) ?? null) : null
  const isBranch = parentPattern === 'parallel' && isGroup && !node.agentId
  const node_el = (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', width: isGroup ? 'auto' : (horizontal ? HCARD_W : (cardW ?? VCARD_W)), flexShrink: 0,
        outline: sel ? '2px solid var(--accent)' : 'none', outlineOffset: 2, borderRadius: 'var(--radius-md, 8px)' }}>
      {toolbar}
      {rightDrop}
      {isGroup
        ? <GroupBox groupId={node.id} pattern={groupPattern(node)} members={node.children ?? []} isRoot={false} depth={depth + 1} g={g} width={node.width} onResize={(wv) => g.setWidth(node.id, wv)} bare={isBranch} cardW={horizontal || isBranch ? HCARD_W : undefined} agent={agentOfNode} />
        : <OrchestrationMemberCard member={node} workflow={g.wfById.get(node.workflowId) ?? null} agent={node.agentId ? (g.agentById.get(node.agentId) ?? null) : null} pattern={parentPattern} runState={st}
            onOpenDetail={() => { const wf = g.wfById.get(node.workflowId); if (wf) g.openWf(wf) }} />}
    </div>
  )

  if (horizontal) {
    // parallel 분기 / relay(Specialist·AI Agent) 옵션 leaf: 카드 아래 '＋ next' 로 후속 워크플로 체인 추가.
    if ((parentPattern === 'parallel' || parentPattern === 'relay') && !isGroup) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {node_el}
          {!g.isRunning && <DownstreamConnector onPick={(id) => g.addDownstream(node.id, id)} items={g.pickItems} />}
        </div>
      )
    }
    return node_el
  }

  // parallel 그룹은 분기마다 독립 output → write 노드 있는 분기 수만큼 output 라인.
  const outCount = isGroup && groupPattern(node) === 'parallel'
    ? (node.children ?? []).filter(c => branchHasOutput(c, g.wfById, g.agentById)).length : 0

  // 연속(pipeline) I/O 호환 — 이전 output 이 다음 input 을 충족하나(경고만).
  // 이전/다음 모두 그룹 가능: 이전 그룹 → memberOutputFields(패턴별 출력), 다음 그룹 → 진입 입력.
  const nextSib = siblings[index + 1]
  let compat: PairCompat | undefined
  if (parentPattern === 'pipeline' && nextSib) {
    const prevOut = memberOutputFields(node, g.wfById, g.agentById)
    // 다음 멤버(그룹/agent/leaf 모두)의 진입 입력 — 단일 멤버를 pipeline 으로 도출하면 통일 처리.
    const nextIn = deriveEntryInputs([nextSib], 'pipeline', g.wfById, g.agentById)
    compat = compatOf(prevOut, nextIn)
  }

  // 세로 플로우(루트 pipeline): 노드 중심 정렬 + 사이에 얇은 ↓ 커넥터.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'center' }}>
      {node_el}
      {outCount > 0 && <ParallelMerge count={outCount} />}
      {index < count - 1
        ? <Connector pattern={parentPattern} compat={compat} onPick={!g.isRunning ? (id) => g.insertSibling(node.id, id, 'below') : undefined} items={g.pickItems} />
        : null}
    </div>
  )
}

// 분기(세로 체인)에 write 노드(=output)가 있는지 — 있으면 그룹 밖으로 output 라인.
function branchHasOutput(m: OrchestrationMember, wfById: Map<string, TwixyWorkflow>, agentById?: Map<string, TwixyAiAgent>): boolean {
  // agent leaf → 옵션 중 하나라도 output(write) 내면 output 있음.
  if (m.agentId && agentById) return (agentById.get(m.agentId)?.options ?? []).some(c => branchHasOutput(c, wfById, agentById))
  if (m.children && m.children.length) return m.children.some(c => branchHasOutput(c, wfById, agentById))
  return !!wfById.get(m.workflowId)?.nodes?.some(n => n.tool === 'write')
}

// parallel 그룹의 분기별 독립 output 라인(회색) — 합류바 없음. 각 output 은 분기 자체의
// downstream 체인(분기 안의 '＋ next')으로 이어진다(서로 합쳐지지 않음).
function ParallelMerge({ count }: { count: number }) {
  return (
    <div style={{ display: 'flex', gap: 26, padding: '2px 10px 0' }} title={`${count} independent output${count > 1 ? 's' : ''}`}>
      {Array.from({ length: count }).map((_, k) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ width: 1.5, height: 14, background: 'var(--text-muted)' }} />
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-muted)' }} />
        </div>
      ))}
    </div>
  )
}

// 세로 커넥터(얇은 선 + 화살표) — hover 시 가운데 + 로 워크플로 삽입. compat = I/O 호환 배지.
function Connector({ pattern, onPick, items, compat }: { pattern: OrchestrationPattern; onPick?: (wfId: string) => void; items: PickItem[]; compat?: PairCompat }) {
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const arrow = pattern === 'relay' ? '⇣' : '↓'
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setOpen(false) }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3px 0', position: 'relative' }}>
      <div style={{ width: 1.5, height: 11, background: 'var(--border)' }} />
      {open && onPick
        ? <WfSelect items={items} onPick={(id) => { onPick(id); setOpen(false) }} />
        : <span style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1, cursor: onPick ? 'pointer' : 'default' }}
            onClick={() => onPick && setOpen(true)} title={onPick ? 'Insert workflow here' : undefined}>{hover && onPick ? '＋' : arrow}</span>}
      <div style={{ width: 1.5, height: 11, background: 'var(--border)' }} />
      {compat && compat.status !== 'neutral' && <IOBadge compat={compat} />}
    </div>
  )
}
// 연속 워크플로 I/O 호환 배지 — ✓(충족) / ⚠(미충족, 경고만). hover 시 공용 커스텀 툴팁.
function IOBadge({ compat }: { compat: PairCompat }) {
  const warn = compat.status === 'warn'
  const content = (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: warn ? '#d29922' : '#3fb950', marginBottom: warn ? 5 : 0 }}>
        {warn ? 'Previous output may not satisfy next input' : 'Previous output satisfies next input'}
      </div>
      {warn && compat.unmet.map(u => (
        <div key={u.id} style={{ display: 'flex', gap: 5, marginTop: 2, fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          <span style={{ color: 'var(--text-muted)' }}>•</span>
          <span><b style={{ color: 'var(--text-primary)' }}>{u.id}</b> — {u.reason}</span>
        </div>
      ))}
      {warn && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45, fontStyle: 'italic' }}>
          Still runs — the previous output is passed as context and the model bridges it.
        </div>
      )}
    </div>
  )
  return (
    <HoverTip content={content}
      style={{ position: 'absolute', left: 'calc(50% + 11px)', top: '50%', transform: 'translateY(-50%)',
        fontSize: 11, lineHeight: 1, color: warn ? '#d29922' : '#3fb950', whiteSpace: 'nowrap' }}>
      {warn ? `⚠ ${compat.unmet.length}` : '✓'}
    </HoverTip>
  )
}

// 그룹 끝의 + 삽입 라인 (세로).
function InsertLine({ onPick, items }: { onPick: (wfId: string) => void; items: PickItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 0' }}>
      <div style={{ width: 1.5, height: 10, background: 'var(--border)' }} />
      {open
        ? <WfSelect items={items} onPick={(id) => { onPick(id); setOpen(false) }} />
        : <button onClick={() => setOpen(true)} title="Add" style={{ ...iconBtn, fontSize: 12, padding: '1px 9px' }}>＋</button>}
    </div>
  )
}

function AddPicker({ items, onPick, compact }: { items: PickItem[]; onPick: (wfId: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  if (open) return <WfSelect items={items} onPick={(id) => { onPick(id); setOpen(false) }} />
  return <button onClick={() => setOpen(true)} title="Add" style={{ ...iconBtn, fontSize: 12, padding: compact ? '4px 9px' : '5px 12px' }}>＋ add</button>
}
// 병렬 분기 / Specialist 옵션 카드 아래 — 후속(downstream) 연결.
function DownstreamConnector({ onPick, items }: { onPick: (wfId: string) => void; items: PickItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
      <div style={{ width: 1.5, height: 9, background: 'var(--text-muted)' }} />
      {open
        ? <WfSelect items={items} onPick={(id) => { onPick(id); setOpen(false) }} />
        : <button onClick={() => setOpen(true)} title="Add downstream (this output → next)" style={{ ...iconBtn, fontSize: 11, padding: '1px 7px' }}>＋ next</button>}
    </div>
  )
}
type PickItem = { id: string; title: string }
function WfSelect({ items, onPick }: { items: PickItem[]; onPick: (wfId: string) => void }) {
  return (
    <select autoFocus value="" onChange={e => { if (e.target.value) onPick(e.target.value) }} style={{ ...selStyle, borderStyle: 'dashed' }}>
      <option value="">pick…</option>
      {items.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}
    </select>
  )
}

// Specialist 의 criteria 노드 — 어떤 워크플로로 갈지 기준. 클릭하면 편집.
function CriteriaNode({ text, onEdit, disabled }: { text: string; onEdit: () => void; disabled: boolean }) {
  return (
    <div onClick={disabled ? undefined : onEdit}
      style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)', borderRadius: 'var(--radius-md, 8px)', padding: '7px 14px', cursor: disabled ? 'default' : 'pointer', maxWidth: 360, textAlign: 'center' }}
      title={disabled ? undefined : 'Edit criteria'}>
      <div style={{ fontSize: 8.5, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>criteria</div>
      <div style={{ fontSize: 11, color: text ? 'var(--text-secondary)' : 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
        {text ? clip(text, 90) : 'Set the criteria for which option to use…'}
      </div>
    </div>
  )
}

// Parallel research 의 종합 노드 — 끝점에서 모든 output 을 하나로 합친다(기준 편집).
function AggregateNode({ text, onEdit, disabled, count }: { text: string; onEdit: () => void; disabled: boolean; count: number }) {
  return (
    <div onClick={disabled ? undefined : onEdit}
      style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)', borderRadius: 'var(--radius-md, 8px)', padding: '7px 14px', cursor: disabled ? 'default' : 'pointer', maxWidth: 380, textAlign: 'center' }}
      title={disabled ? undefined : 'Edit synthesis criteria'}>
      <div style={{ fontSize: 8.5, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>synthesis · aggregates {count} output{count === 1 ? '' : 's'}</div>
      <div style={{ fontSize: 11, color: text ? 'var(--text-secondary)' : 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
        {text ? clip(text, 90) : 'Set how to combine all outputs into one result…'}
      </div>
    </div>
  )
}

// 모든 그룹 하단의 OUTPUT 정의 노드 — 그룹이 내는 필드(name/type)를 보여주고 클릭해 편집.
function GroupOutputNode({ fields, onEdit, disabled }: { fields: WorkflowScopeField[]; onEdit: () => void; disabled: boolean }) {
  const has = fields.length > 0
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 10px 9px' }}>
      <div onClick={disabled ? undefined : onEdit}
        style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '92%', cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${has ? '#3fb950' : 'var(--border)'}`, background: has ? 'rgba(63,185,80,0.08)' : 'var(--bg-base)', borderRadius: 6, padding: '4px 10px' }}
        title={disabled ? undefined : 'Define group output'}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3fb950', flexShrink: 0 }} />
        <span style={{ fontSize: 8.5, color: '#3fb950', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, flexShrink: 0 }}>output</span>
        <span style={{ fontSize: 10, color: has ? 'var(--text-secondary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {has ? fields.map(f => `${f.name} (${f.type})`).join(', ') : 'Define output…'}
        </span>
      </div>
    </div>
  )
}

// Team 매니저 노드 — 입력 분배 + output 통합 지시(클릭해 편집).
function ManagerNode({ text, onEdit, disabled }: { text: string; onEdit: () => void; disabled: boolean }) {
  return (
    <div onClick={disabled ? undefined : onEdit}
      style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)', borderRadius: 'var(--radius-md, 8px)', padding: '7px 14px', cursor: disabled ? 'default' : 'pointer', maxWidth: 420, textAlign: 'center' }}
      title={disabled ? undefined : 'Edit manager instructions'}>
      <div style={{ fontSize: 8.5, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>manager</div>
      <div style={{ fontSize: 11, color: text ? 'var(--text-secondary)' : 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
        {text ? clip(text, 110) : 'Distributes input to agents · integrates their outputs…'}
      </div>
    </div>
  )
}

// 멤버 표시 이름 (output 선택 UI 용).
function memberDisplayName(m: OrchestrationMember, wfById: Map<string, TwixyWorkflow>, agentById?: Map<string, TwixyAiAgent>): string {
  if (m.agentId && agentById) return m.label || agentById.get(m.agentId)?.title || m.agentId
  return m.label || (isGroupNode(m) ? `${PATTERN_META[groupPattern(m)].label} group` : (wfById.get(m.workflowId)?.title || m.workflowId || 'workflow'))
}

// Parallel 그룹 output 노드 — Parallel research 의 synthesis 노드와 동일한 디자인(↓ + accent 박스).
// output(write 노드) 있는 멤버 중 선택된 것을 표시. 클릭하면 멀티선택 패널.
function GroupOutputSelectNode({ members, selected, wfById, agentById, onEdit, disabled }: { members: OrchestrationMember[]; selected: string[] | null; wfById: Map<string, TwixyWorkflow>; agentById?: Map<string, TwixyAiAgent>; onEdit: () => void; disabled: boolean }) {
  const candidates = members.filter(m => branchHasOutput(m, wfById, agentById))
  const picked = selected && selected.length ? candidates.filter(m => selected.includes(m.id)) : null
  const count = picked ? picked.length : candidates.length
  const txt = picked ? picked.map(m => memberDisplayName(m, wfById, agentById)).join(', ') : `all (${candidates.length})`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 10px 10px' }}>
      <div style={{ width: 1.5, height: 12, background: 'var(--border)' }} />
      <div onClick={disabled ? undefined : onEdit} title={disabled ? undefined : 'Select which workflow outputs form the group output'}
        style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)', borderRadius: 'var(--radius-md, 8px)', padding: '7px 14px', cursor: disabled ? 'default' : 'pointer', maxWidth: 380, textAlign: 'center' }}>
        <div style={{ fontSize: 8.5, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>
          output{candidates.length ? ` · ${count} of ${candidates.length}` : ''}
        </div>
        <div style={{ fontSize: 11, color: candidates.length ? 'var(--text-secondary)' : 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
          {candidates.length === 0 ? 'No output — add a write node to a member' : `from ${txt}`}
        </div>
      </div>
    </div>
  )
}

// Parallel output 멤버 멀티선택 패널 — write 노드(=output) 있는 멤버만 나열하고 각 output scope 표시.
function GroupOutputSelectPanel({ members, wfById, agentById, selected, onSave, onClose }: { members: OrchestrationMember[]; wfById: Map<string, TwixyWorkflow>; agentById?: Map<string, TwixyAiAgent>; selected: string[] | null; onSave: (ids: string[]) => void; onClose: () => void }) {
  const candidates = members.filter(m => branchHasOutput(m, wfById, agentById))
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selected && selected.length ? selected.filter(id => candidates.some(c => c.id === id)) : candidates.map(m => m.id)))
  const toggle = (id: string) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 8px)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Group output (Parallel)</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pick which workflow outputs make up this group’s output — multiple allowed. Only workflows that produce output (have a <b>write</b> node) are listed. All branches still run; only the selected outputs are combined and passed on.</div>
        {candidates.length === 0
          ? <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '8px 2px' }}>No member produces output — give a member workflow a write node first.</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
              {candidates.map(m => {
                const on = picked.has(m.id)
                const fields = memberOutputFields(m, wfById, agentById)
                return (
                  <label key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                    background: on ? 'var(--accent-dim)' : 'var(--bg-base)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(m.id)} style={{ accentColor: 'var(--accent)', width: 14, height: 14, cursor: 'pointer' }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{memberDisplayName(m, wfById, agentById)}</span>
                    </div>
                    <div style={{ marginLeft: 24, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {fields.length ? fields.map(f => (
                        <span key={f.name} style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                          {f.name} <span style={{ color: 'var(--accent)' }}>({f.type})</span>
                        </span>
                      )) : <span style={{ fontSize: 9.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>write node has no declared output scope</span>}
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={ghostBtn()}>Cancel</button>
          <button onClick={() => onSave([...picked])} style={runBtn(candidates.length === 0)} disabled={candidates.length === 0}>Save</button>
        </div>
      </div>
    </div>
  )
}

// ── 패턴 schematic (추천 구조, gray outline) ──────────────────────────────────
function SBox({ label }: { label: string }) {
  return <div style={{ minWidth: 50, padding: '4px 9px', borderRadius: 6, fontSize: 9, fontWeight: 600, textAlign: 'center', border: '1px dashed var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</div>
}
function SArr({ d = '↓', label }: { d?: string; label?: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, padding: '1px 4px' }}>{d}{label && <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.8 }}>{label}</span>}</span>
}
const scol: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center' }
function PatternSchematic({ pattern }: { pattern: OrchestrationPattern }) {
  const meta = PATTERN_META[pattern]
  const wrap = (inner: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: 0.85 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{meta.label} <span style={{ fontSize: 8.5, color: 'var(--text-muted)', fontWeight: 500 }}>· suggested structure</span></div>
      {inner}
    </div>
  )
  if (pattern === 'pipeline') return wrap(<div style={scol}><SBox label="Input" /><SArr /><SBox label="WF 1" /><SArr label="out→in" /><SBox label="WF 2" /><SArr /><SBox label="Result" /></div>)
  if (pattern === 'parallel') return wrap(
    <div style={scol}><SBox label="Input" /><span style={{ color: 'var(--text-muted)', fontSize: 12, letterSpacing: 3 }}>╱│╲</span>
      <div style={{ display: 'flex', gap: 8 }}>{['WF 1', 'WF 2', 'WF 3'].map(l => <SBox key={l} label={l} />)}</div>
      <div style={{ display: 'flex', gap: 8 }}>{[0, 1, 2].map(k => <SArr key={k} d="↓" />)}</div>
      <span style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>independent outputs · no merge</span></div>)
  if (pattern === 'research') return wrap(
    <div style={scol}><SBox label="Input" /><span style={{ color: 'var(--text-muted)', fontSize: 12, letterSpacing: 3 }}>╱│╲</span>
      <div style={{ display: 'flex', gap: 8 }}>{['WF 1', 'WF 2', 'WF 3'].map(l => <SBox key={l} label={l} />)}</div>
      <SArr d="▼" label="combine" />
      <div style={{ border: '1px dashed var(--accent)', borderRadius: 6, padding: '4px 10px', fontSize: 9, fontWeight: 600, color: 'var(--accent)' }}>synthesis</div></div>)
  // relay (Specialist) — criteria 위, 워크플로 아래 (위아래 관계)
  return wrap(<div style={scol}>
    <div style={{ border: '1px dashed var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)' }}>criteria</div>
    <div style={{ width: 1.5, height: 12, background: 'var(--border)' }} />
    <div style={{ display: 'flex', gap: 8 }}>{['WF 1', 'WF 2'].map(l => <SBox key={l} label={l} />)}</div>
  </div>)
}

// ── Criteria 설정 패널 (어떤 워크플로로 갈지 기준) ────────────────────────────
function CriteriaPanel({ kind = 'relay', instructions, onSave, onClose }: { kind?: 'relay' | 'research' | 'manager'; instructions: string; onSave: (i: string) => void; onClose: () => void }) {
  const [instr, setInstr] = useState(instructions)
  const title = kind === 'research' ? 'Synthesis criteria' : kind === 'manager' ? 'Manager instructions' : 'Criteria'
  const desc = kind === 'research' ? 'Set how to combine all the outputs into one synthesized result.'
    : kind === 'manager' ? 'How the manager distributes the team input to agents and integrates their outputs into the team result.'
    : 'Set the criteria for which option to use.'
  const ph = kind === 'research'
    ? 'e.g. Merge findings into one brief; when sources disagree, flag the conflict and prefer the most recent.'
    : kind === 'manager'
    ? 'e.g. Send the brief to each research agent; merge their tables into one; then hand rows to the execution agents.'
    : 'e.g. Use the billing workflow for payment questions, the technical workflow for outages.'
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: '92vw', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 8px)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</div>
        <textarea value={instr} onChange={e => setInstr(e.target.value)} rows={6} autoFocus placeholder={ph}
          style={{ resize: 'vertical', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, padding: '8px 10px', outline: 'none', fontFamily: 'inherit' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={ghostBtn()}>Cancel</button>
          <button onClick={() => onSave(instr.trim())} style={runBtn(false)}>Save</button>
        </div>
      </div>
    </div>
  )
}

// 그룹 output 정의 편집 패널 — Workflow 노드 outputScope 처럼 name/type/description 행 편집.
function GroupOutputPanel({ initial, onSave, onClose }: { initial: WorkflowScopeField[]; onSave: (f: WorkflowScopeField[]) => void; onClose: () => void }) {
  const [rows, setRows] = useState<WorkflowScopeField[]>(() => initial.length ? initial.map(f => ({ ...f })) : [{ name: '', type: '' }])
  const set = (i: number, k: 'name' | 'type' | 'description', v: string) => setRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: v } : r))
  const add = () => setRows(rs => [...rs, { name: '', type: '' }])
  const del = (i: number) => setRows(rs => rs.filter((_, j) => j !== i))
  const save = () => onSave(rows.map(r => ({ name: r.name.trim(), type: r.type.trim() || 'text', description: r.description?.trim() || undefined })).filter(r => r.name))
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 580, maxWidth: '94vw', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 8px)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Group output</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Define the fields this group produces (name · type · description), like a workflow node’s output scope. Used to check the next step’s input. Prefilled from the group’s auto-derived output.</div>
        <div style={{ display: 'flex', gap: 6, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--text-muted)', fontWeight: 700, padding: '0 2px' }}>
          <span style={{ width: 140 }}>name</span><span style={{ width: 96 }}>type</span><span style={{ flex: 1 }}>description</span><span style={{ width: 18 }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={r.name} onChange={e => set(i, 'name', e.target.value)} placeholder="field_name" style={{ ...inpStyle, width: 140, fontFamily: 'var(--font-mono)' }} />
              <input value={r.type} onChange={e => set(i, 'type', e.target.value)} placeholder="json / url / text" list="orch-out-types" style={{ ...inpStyle, width: 96, fontFamily: 'var(--font-mono)' }} />
              <input value={r.description ?? ''} onChange={e => set(i, 'description', e.target.value)} placeholder="what this field is" style={{ ...inpStyle, flex: 1 }} />
              <button onClick={() => del(i)} title="Remove field" style={{ ...iconBtn, width: 18 }}>×</button>
            </div>
          ))}
        </div>
        <datalist id="orch-out-types">{['text', 'json', 'url', 'number', 'path', 'query', 'md'].map(t => <option key={t} value={t} />)}</datalist>
        <button onClick={add} style={{ ...ghostBtn(), alignSelf: 'flex-start', fontSize: 11, padding: '4px 10px' }}>+ field</button>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={ghostBtn()}>Cancel</button>
          <button onClick={save} style={runBtn(false)}>Save</button>
        </div>
      </div>
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────
function findNode(members: OrchestrationMember[], id: string): OrchestrationMember | null {
  for (const m of members) { if (m.id === id) return m; if (m.children) { const r = findNode(m.children, id); if (r) return r } }
  return null
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ marginTop: 22, maxWidth: 620, marginLeft: 'auto', marginRight: 'auto' }}>
    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{title}</div>{children}</div>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic', padding: 40, textAlign: 'center' }}>{children}</div>
}
function clip(s: string, max: number): string { return !s ? '' : s.length <= max ? s : s.slice(0, max) + '…' }

const selStyle: React.CSSProperties = { background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-secondary)', fontSize: 10, padding: '2px 5px', outline: 'none' }
const inpStyle: React.CSSProperties = { background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 11, padding: '4px 7px', outline: 'none' }
const iconBtn: React.CSSProperties = { border: 'none', background: 'transparent', color: 'var(--text-muted)', borderRadius: 4, fontSize: 11, padding: '1px 4px', cursor: 'pointer', lineHeight: 1.3 }
function miniBtn(active?: boolean): React.CSSProperties {
  return { border: active ? '1px solid var(--accent)' : '1px solid var(--border)', background: active ? 'var(--accent-dim)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-secondary)', borderRadius: 4, fontSize: 10, padding: '2px 7px', cursor: 'pointer' }
}
function runBtn(disabled: boolean): React.CSSProperties {
  return { background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }
}
function stopBtn(): React.CSSProperties { return { background: '#f85149', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: 'pointer' } }
function ghostBtn(): React.CSSProperties { return { background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' } }
