// orchestrationTree.ts — 오케스트레이션 멤버 트리(중첩 그룹)의 순수 편집 헬퍼.
// 모든 노드는 트리 전체에서 유일한 id 를 가지며, 헬퍼는 불변(immutable) 재구성으로
// 새 members 배열을 반환한다. 루트 그룹의 children = orchestration.members.
// (그룹 = children 보유 노드, leaf = workflowId 참조 노드)

export const ROOT_ID = '__root__'

let _seq = 0
export function newNodeId(prefix = 'n'): string {
  _seq = (_seq + 1) % 1_000_000
  return `${prefix}-${Date.now().toString(36)}-${_seq}`
}

export function isGroupNode(m: OrchestrationMember): boolean {
  return !!(m.children && m.children.length > 0)
}

// leaf 생성 — team(agentId) / workflow(workflowId) 공용. refId 는 agent id 또는 workflow id.
export type LeafKey = 'workflowId' | 'agentId'
function makeLeaf(refId: string, leafKey: LeafKey = 'workflowId'): OrchestrationMember {
  return leafKey === 'agentId'
    ? { id: newNodeId('a'), workflowId: '', agentId: refId }
    : { id: newNodeId('wf'), workflowId: refId }
}
export function groupPattern(m: OrchestrationMember): OrchestrationPattern {
  return m.subPattern ?? 'pipeline'
}

// id 를 "포함한 배열"(=형제 배열)에 transform 을 적용.
function transformParent(
  members: OrchestrationMember[], id: string,
  fn: (arr: OrchestrationMember[]) => OrchestrationMember[],
): OrchestrationMember[] {
  if (members.some(m => m.id === id)) return fn(members)
  return members.map(m => m.children ? { ...m, children: transformParent(m.children, id, fn) } : m)
}

// 그룹(또는 루트)의 children 배열에 transform 을 적용.
function transformGroup(
  members: OrchestrationMember[], groupId: string,
  fn: (arr: OrchestrationMember[]) => OrchestrationMember[],
): OrchestrationMember[] {
  if (groupId === ROOT_ID) return fn(members)
  return members.map(m => m.id === groupId
    ? { ...m, children: fn(m.children ?? []) }
    : (m.children ? { ...m, children: transformGroup(m.children, groupId, fn) } : m))
}

// 노드에 부분 패치 적용 (pattern/label/manager 등).
export function setNode(members: OrchestrationMember[], id: string, patch: Partial<OrchestrationMember>): OrchestrationMember[] {
  return members.map(m => m.id === id ? { ...m, ...patch } : (m.children ? { ...m, children: setNode(m.children, id, patch) } : m))
}

export function removeNode(members: OrchestrationMember[], id: string): OrchestrationMember[] {
  return transformParent(members, id, arr => arr.filter(m => m.id !== id))
}

// 형제 배열 내에서 위(-1)/아래(+1)로 이동.
export function moveNode(members: OrchestrationMember[], id: string, dir: -1 | 1): OrchestrationMember[] {
  return transformParent(members, id, arr => {
    const i = arr.findIndex(m => m.id === id), j = i + dir
    if (i < 0 || j < 0 || j >= arr.length) return arr
    const next = arr.slice(); const [n] = next.splice(i, 1); next.splice(j, 0, n); return next
  })
}

// id 노드 기준 위/아래에 새 leaf 삽입 (같은 그룹 내 sibling).
export function insertSiblingOf(members: OrchestrationMember[], id: string, refId: string, pos: 'above' | 'below', leafKey: LeafKey = 'workflowId'): OrchestrationMember[] {
  const node = makeLeaf(refId, leafKey)
  return transformParent(members, id, arr => {
    const i = arr.findIndex(m => m.id === id)
    const at = pos === 'above' ? i : i + 1
    const next = arr.slice(); next.splice(Math.max(0, at), 0, node); return next
  })
}

// 그룹(또는 루트) 끝에 새 leaf 추가.
export function appendToGroup(members: OrchestrationMember[], groupId: string, refId: string, leafKey: LeafKey = 'workflowId'): OrchestrationMember[] {
  return transformGroup(members, groupId, arr => [...arr, makeLeaf(refId, leafKey)])
}

// 선택된 sibling ids(2개 이상)를 한 그룹으로 묶음 — 첫 선택 위치에 그룹 삽입.
export function groupNodes(members: OrchestrationMember[], ids: string[], pattern: OrchestrationPattern): OrchestrationMember[] {
  if (ids.length < 2) return members
  return transformParent(members, ids[0], arr => {
    const sel = arr.filter(m => ids.includes(m.id))
    if (sel.length < 2) return arr
    const group: OrchestrationMember = { id: newNodeId('grp'), workflowId: '', subPattern: pattern, children: sel }
    const result: OrchestrationMember[] = []
    let inserted = false
    for (const m of arr) {
      if (ids.includes(m.id)) { if (!inserted) { result.push(group); inserted = true } }
      else result.push(m)
    }
    return result
  })
}

// targetId leaf 를 [target, newLeaf(wfId)] 로 묶는 parallel 그룹으로 제자리 대체.
// (워크플로를 다른 워크플로 오른쪽에 드롭 → 자동 parallel)
export function wrapInParallel(members: OrchestrationMember[], targetId: string, refId: string, leafKey: LeafKey = 'workflowId'): OrchestrationMember[] {
  return transformParent(members, targetId, arr => {
    const i = arr.findIndex(m => m.id === targetId)
    if (i < 0) return arr
    const group: OrchestrationMember = {
      id: newNodeId('grp'), workflowId: '', subPattern: 'parallel',
      children: [arr[i], makeLeaf(refId, leafKey)],
    }
    const next = arr.slice(); next.splice(i, 1, group); return next
  })
}

// 병렬 분기(branchId)에 후속 워크플로 추가 — 분기를 pipeline 체인으로 만들어 이어붙임.
// leaf 분기면 [leaf, new] pipeline 그룹으로 감싸고, 이미 pipeline 체인이면 끝에 append.
export function addDownstream(members: OrchestrationMember[], branchId: string, refId: string, leafKey: LeafKey = 'workflowId'): OrchestrationMember[] {
  return transformParent(members, branchId, arr => {
    const i = arr.findIndex(m => m.id === branchId)
    if (i < 0) return arr
    const node = arr[i]
    const leaf = makeLeaf(refId, leafKey)
    const next: OrchestrationMember = (node.children && (node.subPattern ?? 'pipeline') === 'pipeline')
      ? { ...node, children: [...node.children, leaf] }
      : { id: newNodeId('grp'), workflowId: '', subPattern: 'pipeline', children: [node, leaf] }
    const a = arr.slice(); a.splice(i, 1, next); return a
  })
}

// 그룹 해제 — 그룹 노드를 그 자식들로 제자리 대체.
export function ungroupNode(members: OrchestrationMember[], id: string): OrchestrationMember[] {
  return transformParent(members, id, arr => {
    const i = arr.findIndex(m => m.id === id)
    if (i < 0 || !arr[i].children?.length) return arr
    const next = arr.slice(); next.splice(i, 1, ...(arr[i].children ?? [])); return next
  })
}

// 한 노드의 부모 그룹 id 를 찾음 (루트면 ROOT_ID).
export function parentIdOf(members: OrchestrationMember[], id: string, current = ROOT_ID): string | null {
  if (members.some(m => m.id === id)) return current
  for (const m of members) {
    if (m.children) { const r = parentIdOf(m.children, id, m.id); if (r) return r }
  }
  return null
}
