// orchestrationIO.ts — Orchestration 의 input/output 규격(contract) 순수 헬퍼.
// Workflow 탭의 노드 I/O 룰(이전 outputScope → 다음 inputScope)을 L4 멤버 사이에도
// 적용한다. 모든 함수는 순수(부수효과 없음) — 단위 테스트 가능.
//
//   • Workflow INPUT  contract = workflow.inputs (TwixyModuleParam[])
//   • Workflow OUTPUT contract = write 노드들의 outputScope 합집합 (WorkflowScopeField[])
//   • 호환 = 다음 워크플로의 모든 input 이 이전 output 의 어떤 field 로 충족(name+type)
//   • 불일치는 "경고만"(여전히 실행 가능) — 런타임은 이전 output 을 텍스트로 넘겨 LLM 이 잇는다.

// 타입 버킷 — 자유 문자열 type / valueType 을 소수의 비교 가능 범주로 정규화.
export type IOTypeBucket = 'url' | 'path' | 'query' | 'text' | 'json' | 'number'

// 출력 type(자유 문자열) 또는 입력 valueType 을 하나의 버킷으로 정규화. 미상은 text(만능 sink).
export function normalizeType(raw: unknown): IOTypeBucket {
  const t = String(raw ?? '').toLowerCase().replace(/\[\]$/, '').trim()
  if (!t) return 'text'
  if (t.includes('url')) return 'url'
  if (t.includes('path') || t.includes('file')) return 'path'
  if (t.includes('query')) return 'query'
  if (t.includes('json') || t.includes('object') || t.includes('obj') || t.includes('dict')) return 'json'
  if (t.includes('num') || t.includes('int') || t.includes('float') || t.includes('count')) return 'number'
  return 'text'   // md / markdown / string / text / 기타 → text
}

// field 이름과 input id 비교용 정규화 — 대소문자/구분자 무시.
export function normalizeName(raw: unknown): string {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// 출력 type 이 입력 valueType 을 충족하는가 — 같은 버킷이거나, 입력이 text(만능)면 OK.
export function typesCompatible(outType: unknown, inValueType: unknown): boolean {
  const inB = normalizeType(inValueType)
  return normalizeType(outType) === inB || inB === 'text'
}

// research/execution 타입 약어 — 모든 탭의 배지 표기 공통(노드 이름 공간 확보용).
//   research → RSCH · execution → EXEC.
export function typeAbbrev(t: string | null | undefined): string {
  return t === 'research' ? 'RSCH' : t === 'execution' ? 'EXEC' : (t ? String(t).toUpperCase() : '')
}

// 워크플로 타입 — 명시 type 우선, 없으면 도출(write 로 끝/검증-직전-write → research, 아니면 execution).
export function workflowType(wf: TwixyWorkflow | null | undefined): WorkflowType {
  if (wf?.type === 'research' || wf?.type === 'execution') return wf.type
  const seq = (wf?.nodes ?? []).filter(n => n.type !== 'review')
  const last = seq[seq.length - 1]
  if (!last) return 'execution'
  if (last.tool === 'write') return 'research'
  if (last.type === 'validation' && seq[seq.length - 2]?.tool === 'write') return 'research'
  return 'execution'
}

// 워크플로의 OUTPUT contract = write 노드들의 outputScope 합집합(name 기준 dedup).
export function workflowOutputFields(wf: TwixyWorkflow | null | undefined): WorkflowScopeField[] {
  if (!wf?.nodes?.length) return []
  const seen = new Set<string>()
  const out: WorkflowScopeField[] = []
  for (const n of wf.nodes) {
    if (n.tool !== 'write' || !n.outputScope?.length) continue
    for (const f of n.outputScope) {
      const k = normalizeName(f.name)
      if (!k || seen.has(k)) continue
      seen.add(k); out.push(f)
    }
  }
  return out
}

// 입력 1개가 주어진 출력 field 집합으로 충족되는지 + 미충족 사유.
export function inputSatisfied(input: TwixyModuleParam, outputs: WorkflowScopeField[]): { ok: boolean; reason?: string } {
  const byName = outputs.find(o => normalizeName(o.name) === normalizeName(input.id))
  if (!byName) return { ok: false, reason: `no output named "${input.id}"` }
  if (!typesCompatible(byName.type, input.valueType)) return { ok: false, reason: `type ${byName.type} ≠ ${input.valueType}` }
  return { ok: true }
}

export interface UnmetInput { id: string; label: string; reason: string }
export interface PairCompat { status: 'ok' | 'warn' | 'neutral'; unmet: UnmetInput[] }

// 출력 field 집합 vs 입력 목록의 호환 — 다음의 모든 input 이 이전 output 으로 충족되면 ok.
// 다음이 input 없으면 neutral(검사 대상 아님). 이전이 output 이 없으면 모든 input 이 미충족 → warn.
export function compatOf(outputs: WorkflowScopeField[], inputs: TwixyModuleParam[]): PairCompat {
  if (inputs.length === 0) return { status: 'neutral', unmet: [] }
  const unmet: UnmetInput[] = []
  for (const inp of inputs) {
    const r = inputSatisfied(inp, outputs)
    if (!r.ok) unmet.push({ id: inp.id, label: inp.label || inp.id, reason: r.reason ?? 'unmet' })
  }
  return { status: unmet.length ? 'warn' : 'ok', unmet }
}

// 연속(pipeline) 한 쌍(워크플로→워크플로)의 호환성.
export function pairCompatibility(prevWf: TwixyWorkflow | null | undefined, nextWf: TwixyWorkflow | null | undefined): PairCompat {
  return compatOf(workflowOutputFields(prevWf), nextWf?.inputs ?? [])
}

// ── 진입(entry) 입력 도출 ──────────────────────────────────────────────────────
const isGroup = (m: OrchestrationMember) => !!(m.children && m.children.length > 0)
const ordered = (ms: OrchestrationMember[]) => [...ms].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

// 멤버(leaf 또는 그룹)의 OUTPUT contract — 다음 노드 input 호환 검사에 사용. 패턴별로 다르다:
//   leaf      → 워크플로 write 노드 outputScope.
//   pipeline  → 마지막 멤버의 output(체인의 최종 출력만 다음으로 흐른다).
//   parallel  → 모든 분기 output 의 합집합. 종합(concat/vote/synthesize)으로 전 분기가 합쳐져
//               다음으로 가므로, 어떤 분기 필드든 나타날 수 있다.
//   research  → 합집합. 끝점 종합 노드가 전 분기를 합쳐 하나로 내므로 parallel 과 동일 취급.
//   relay     → 분기 output 의 "교집합"(name 기준). N개 중 1개만 실행되므로, 어떤 specialist 가
//               뽑혀도 보장되는 필드 = 모든 분기가 공통으로 내는 필드뿐이다.
// agent leaf(agentId)는 그 에이전트의 옵션들을 children 으로 가진 relay 그룹으로 취급.
// (어느 옵션이 뽑혀도 입력은 받아야 하고, 출력은 옵션 교집합이 보장된다.)
function expandAgent(member: OrchestrationMember, agentById?: Map<string, TwixyAiAgent>): OrchestrationMember | null {
  if (!member.agentId || !agentById) return null
  const a = agentById.get(member.agentId)
  if (!a) return null
  // agentId 제거 — 확장 결과를 다시 expand 하지 않게(무한재귀 방지). relay 그룹으로 취급.
  return { ...member, agentId: undefined, subPattern: 'relay', children: a.options ?? [] }
}

export function memberOutputFields(member: OrchestrationMember, wfById: Map<string, TwixyWorkflow>, agentById?: Map<string, TwixyAiAgent>, depth = 0): WorkflowScopeField[] {
  if (depth > 8) return []
  // agent leaf → 옵션 relay 그룹으로 확장 후 동일 로직.
  const asAgent = expandAgent(member, agentById)
  if (asAgent) return memberOutputFields(asAgent, wfById, agentById, depth)
  if (!isGroup(member)) return workflowOutputFields(wfById.get(member.workflowId))
  // 그룹에 명시적 output 정의가 있으면 그것을 OUTPUT contract 로 사용(자동 도출보다 우선).
  if (member.outputScope?.length) return member.outputScope
  const children = member.children ?? []
  const pat = member.subPattern ?? 'pipeline'

  if (pat === 'pipeline') {
    const last = ordered(children).slice(-1)[0]
    return last ? memberOutputFields(last, wfById, agentById, depth + 1) : []
  }

  if (pat === 'relay') {
    // 교집합 — 모든 분기가 공통으로 내는 필드만(어느 분기가 실행돼도 보장).
    const perBranch = children.map(c => memberOutputFields(c, wfById, agentById, depth + 1))
    if (perBranch.length === 0) return []
    const [first, ...rest] = perBranch
    return first.filter(f => rest.every(b => b.some(g => normalizeName(g.name) === normalizeName(f.name))))
  }

  // parallel → outputFrom 으로 고른 멤버(여러 개)만(미지정=전체). research → 전체. 합집합(name dedup).
  const picked = (pat === 'parallel' && member.outputFrom?.length)
    ? children.filter(c => member.outputFrom!.includes(c.id))
    : children
  const seen = new Set<string>()
  const out: WorkflowScopeField[] = []
  for (const c of picked) {
    for (const f of memberOutputFields(c, wfById, agentById, depth + 1)) {
      const k = normalizeName(f.name)
      if (k && !seen.has(k)) { seen.add(k); out.push(f) }
    }
  }
  return out
}

// 패턴에 따라 "진입 입력을 받는" leaf 워크플로 id 들을 수집(재귀).
//   pipeline → 첫 멤버 / 그 외(parallel·research·relay) → 모든 멤버 합집합.
//   (relay/Specialist 도 어느 옵션이 선택될지 모르므로 모든 옵션의 입력을 받아야 함 = 합집합.)
//   agent leaf 는 그 에이전트의 옵션(relay)으로 확장해 옵션 워크플로들의 입력을 모은다.
function entryLeafIds(members: OrchestrationMember[], pattern: OrchestrationPattern, agentById?: Map<string, TwixyAiAgent>, depth = 0): string[] {
  if (!members.length || depth > 8) return []
  const rec = (m: OrchestrationMember): string[] => {
    const asAgent = expandAgent(m, agentById)
    if (asAgent) return entryLeafIds(asAgent.children ?? [], 'relay', agentById, depth + 1)
    return isGroup(m) ? entryLeafIds(m.children ?? [], m.subPattern ?? 'pipeline', agentById, depth + 1) : (m.workflowId ? [m.workflowId] : [])
  }
  if (pattern === 'pipeline') return rec(ordered(members)[0])
  return members.flatMap(rec)   // parallel | research | relay | (기타) → 합집합
}

// 오케스트레이션 실행 전 사용자가 채워야 할 입력 = 진입 워크플로(들)의 inputs(id 기준 dedup).
export function deriveEntryInputs(
  members: OrchestrationMember[], pattern: OrchestrationPattern, wfById: Map<string, TwixyWorkflow>,
  agentById?: Map<string, TwixyAiAgent>,
): TwixyModuleParam[] {
  const seen = new Set<string>()
  const out: TwixyModuleParam[] = []
  for (const id of entryLeafIds(members, pattern, agentById)) {
    for (const p of wfById.get(id)?.inputs ?? []) {
      if (seen.has(p.id)) continue
      seen.add(p.id); out.push(p)
    }
  }
  return out
}

// 비어 있고 observed 기본값도 없는(=필수) 입력만 반환 — Run 게이팅용.
export function missingRequired(entryInputs: TwixyModuleParam[], values: Record<string, string>): TwixyModuleParam[] {
  return entryInputs.filter(p => !(values[p.id]?.trim()) && !String(p.observed ?? '').trim())
}

// ── 진입 입력을 "단위(unit)"로 그룹화 ────────────────────────────────────────
// AI Agent(relay/Specialist)는 옵션 N개 중 1개만 실행되므로, 그 입력은 "모두 required"가
// 아니라 "옵션 중 하나만 채우면 됨"이다. 진입 프런티어를 agent 경계에서 멈춰 단위로 묶는다:
//   workflow 단위 → 옵션 1개(그 워크플로 입력 전부 required)
//   agent 단위    → 옵션 N개(그중 한 옵션의 입력만 채우면 충족)
export interface EntryOption { id: string; label: string; inputs: TwixyModuleParam[] }
export interface EntryUnit { kind: 'workflow' | 'agent'; id: string; label: string; options: EntryOption[] }

// 진입 프런티어 멤버 — agent/워크플로 leaf 에서 멈춤(agent 는 펼치지 않음). 일반 그룹은 패턴대로 재귀.
function entryFrontier(members: OrchestrationMember[], pattern: OrchestrationPattern, agentById?: Map<string, TwixyAiAgent>, depth = 0): OrchestrationMember[] {
  if (!members.length || depth > 8) return []
  const rec = (m: OrchestrationMember): OrchestrationMember[] => {
    if (m.agentId && agentById?.get(m.agentId)) return [m]                      // agent = 단위 경계
    if (isGroup(m)) return entryFrontier(m.children ?? [], m.subPattern ?? 'pipeline', agentById, depth + 1)
    return m.workflowId ? [m] : []                                              // workflow leaf
  }
  if (pattern === 'pipeline') { const first = ordered(members)[0]; return first ? rec(first) : [] }
  return members.flatMap(rec)
}

export function deriveEntryUnits(
  members: OrchestrationMember[], pattern: OrchestrationPattern,
  wfById: Map<string, TwixyWorkflow>, agentById?: Map<string, TwixyAiAgent>,
): EntryUnit[] {
  return entryFrontier(members, pattern, agentById).map((m): EntryUnit => {
    const agent = m.agentId ? agentById?.get(m.agentId) : undefined
    if (agent) {
      return {
        kind: 'agent', id: agent.id, label: m.label || agent.title,
        options: (agent.options ?? []).map(opt => ({
          id: opt.id,
          label: opt.label || wfById.get(opt.workflowId)?.title || (opt.children?.length ? 'Sub-chain' : opt.workflowId || 'option'),
          inputs: deriveEntryInputs([opt], 'pipeline', wfById, agentById),
        })),
      }
    }
    const wf = wfById.get(m.workflowId)
    return { kind: 'workflow', id: m.id, label: m.label || wf?.title || m.workflowId, options: [{ id: m.id, label: wf?.title ?? m.workflowId, inputs: wf?.inputs ?? [] }] }
  })
}

// 한 옵션이 충족됐는가(필수 입력이 모두 채워짐). 입력이 0개면 자명하게 충족.
export function optionSatisfied(opt: EntryOption, values: Record<string, string>): boolean {
  return missingRequired(opt.inputs, values).length === 0
}
// 단위가 충족됐는가 — workflow: 그 옵션 충족 / agent: 옵션 중 하나라도 충족.
export function unitSatisfied(unit: EntryUnit, values: Record<string, string>): boolean {
  return unit.options.length === 0 ? true : unit.options.some(o => optionSatisfied(o, values))
}
// 아직 충족 안 된 단위 수 — Run 게이팅용.
export function unmetUnitCount(units: EntryUnit[], values: Record<string, string>): number {
  return units.filter(u => !unitSatisfied(u, values)).length
}

// ── 실행 시간 총합 = 임계 경로(critical path) ────────────────────────────────
// 전체 runtime 은 모든 멤버 시간의 단순 합이 아니라 트리의 임계 경로다:
//   pipeline  → 자식 경로 시간의 합(순차).
//   parallel/research/relay → 자식 경로 시간의 최댓값(동시 실행 = 가장 느린 분기가 결정).
// 멤버(그룹)의 자체 durationMs(벽시계)는 무시하고 자식에서 재계산해, parallel 그룹은
// 항상 "가장 긴 agent" 시간이 되도록 한다(요청 사양). agent leaf 는 자신의 durationMs 사용.
export function criticalPathMs(
  members: OrchestrationMember[], pattern: OrchestrationPattern,
  durationById: Record<string, { durationMs?: number } | undefined>, depth = 0,
): number {
  if (!members.length || depth > 12) return 0
  const pathOf = (m: OrchestrationMember): number =>
    // AI Agent 그룹은 런타임이 멤버 자신의 durationMs 를 기록(옵션은 펼침-표시용이라 런타임 id 가 다름)
    // → 자식으로 재귀하지 말고 자신의 측정값을 쓴다. 일반 그룹만 자식 경로로 계산.
    (!m.agentId && isGroup(m))
      ? criticalPathMs(m.children ?? [], m.subPattern ?? 'pipeline', durationById, depth + 1)
      : (durationById[m.id]?.durationMs ?? 0)
  const ds = members.map(pathOf)
  return pattern === 'pipeline' ? ds.reduce((a, b) => a + b, 0) : Math.max(0, ...ds)
}
