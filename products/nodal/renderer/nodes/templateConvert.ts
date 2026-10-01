// 에디터 그래프 ↔ MCP 템플릿 파일.
//
// 템플릿(<id>.nodal.json)은 definitions[<id>] 하나가 에이전트 툴이 된다: params → 툴 입력 스키마,
// returns → 툴 결과 (엔진 templates.py · design.md §12). 에디터 그래프에는 params 개념이 없으므로
// 저장할 때 사용자가 고른 입력을 {"$param": name} 으로 바꾸고, image.Load 노드는 지우고 그 자리에
// Image 파라미터를 꽂는다 — MCP 호출 때 엔진이 경로/asset:<hash> 를 image.Load(LoadAsset)로 되돌린다.
//
// 다시 열 때 손실이 없도록 원래 에디터 그래프를 ui.nodal_app_graph 에 같이 넣는다 (엔진은 ui 를
// 읽지 않는다). 그게 없는 번들 템플릿은 정의를 풀어서 연다 — 중첩 서브그래프는 에디터가 못 그린다.
import type { GraphDocument, GraphNode, InputValue, JsonValue } from '../../engine/apps/web/src/graph/types'
import { isLink, makeLink } from '../../engine/apps/web/src/graph/types'

export const TEMPLATE_ID_RE = /^[a-z][a-z0-9_]{0,47}$/
const APP_GRAPH_KEY = 'nodal_app_graph'

/** 노드의 리터럴 입력 하나를 툴 파라미터로. */
export interface LiteralParam { kind: 'literal'; nodeId: string; input: string; name: string; doc?: string }
/** image.Load 노드 하나를 Image 파라미터로 (노드는 빠지고 그 출력 링크가 파라미터가 된다). */
export interface ImageParam { kind: 'image'; nodeId: string; name: string; doc?: string }
export type ParamPick = LiteralParam | ImageParam
export interface ReturnPick { nodeId: string; socket: string; name: string }

export interface TemplateParamSpec { type: string; default?: JsonValue; doc?: string }
export interface TemplateDefinition {
  doc: string
  params: Record<string, TemplateParamSpec>
  nodes: Record<string, GraphNode>
  returns: Record<string, { $link: [string, string] }>
}
export interface TemplateDocument {
  nodal_version: '1'
  definitions: Record<string, TemplateDefinition>
  ui?: Record<string, JsonValue>
}

function literalType(value: JsonValue | undefined): string {
  if (typeof value === 'boolean') return 'BOOL'
  if (typeof value === 'number') return Number.isInteger(value) ? 'INT' : 'FLOAT'
  return 'STRING'
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 저장 전에 고른 것들이 말이 되는지 — 에러 메시지 목록 (비면 통과). */
export function checkTemplatePicks(graph: GraphDocument, id: string, doc: string, params: ParamPick[], returns: ReturnPick[]): string[] {
  const errs: string[] = []
  const nodes = graph.nodes ?? {}
  if (!TEMPLATE_ID_RE.test(id)) errs.push('이름은 영문 소문자로 시작하고 소문자·숫자·_ 만 쓸 수 있습니다 (최대 48자)')
  if (!doc.trim()) errs.push('설명을 적어 주세요 — 에이전트가 이 툴을 언제 쓸지 이걸 보고 정합니다')
  if (returns.length === 0) errs.push('결과로 돌려줄 출력을 하나 이상 고르세요')
  const names = new Set<string>()
  for (const p of params) {
    if (!/^[a-z][a-z0-9_]*$/.test(p.name)) errs.push(`입력 이름 "${p.name}" — 영문 소문자·숫자·_ 만`)
    if (names.has(p.name)) errs.push(`입력 이름 "${p.name}" 이 겹칩니다`)
    names.add(p.name)
    const node = nodes[p.nodeId]
    if (!node) { errs.push(`노드 ${p.nodeId} 가 없습니다`); continue }
    if (p.kind === 'image' && node.type !== 'image.Load') errs.push(`${p.nodeId} 는 이미지 불러오기 노드가 아닙니다`)
    if (p.kind === 'literal' && isLink((node.inputs ?? {})[p.input] as InputValue)) errs.push(`${p.nodeId}.${p.input} 는 다른 노드와 연결돼 있어 입력으로 뺄 수 없습니다`)
  }
  for (const r of returns) if (!nodes[r.nodeId]) errs.push(`출력 노드 ${r.nodeId} 가 없습니다`)
  return errs
}

export function graphToTemplate(graph: GraphDocument, opts: { id: string; doc: string; params: ParamPick[]; returns: ReturnPick[] }): TemplateDocument {
  const nodes = clone(graph.nodes ?? {})
  const params: Record<string, TemplateParamSpec> = {}
  const imageBySource = new Map<string, string>()   // image.Load 노드 id → 파라미터 이름

  for (const p of opts.params) {
    if (p.kind === 'image') {
      imageBySource.set(p.nodeId, p.name)
      params[p.name] = { type: 'Image', ...(p.doc ? { doc: p.doc } : {}) }
      delete nodes[p.nodeId]
      continue
    }
    const node = nodes[p.nodeId]
    const current = (node.inputs ?? {})[p.input] as JsonValue | undefined
    params[p.name] = { type: literalType(current), ...(current !== undefined ? { default: current } : {}), ...(p.doc ? { doc: p.doc } : {}) }
    node.inputs = { ...(node.inputs ?? {}), [p.input]: { $param: p.name } as unknown as JsonValue }
  }

  // 지운 image.Load 의 출력을 받던 입력 → Image 파라미터.
  for (const node of Object.values(nodes)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value as InputValue)) {
        const [src] = (value as { $link: [string, string] }).$link
        const param = imageBySource.get(src)
        if (param) node.inputs![key] = { $param: param } as unknown as JsonValue
      }
    }
  }

  const returns: TemplateDefinition['returns'] = {}
  for (const r of opts.returns) returns[r.name] = { $link: [r.nodeId, r.socket] }

  return {
    nodal_version: '1',
    definitions: { [opts.id]: { doc: opts.doc.trim(), params, nodes, returns } },
    ui: { $comment: 'Nodal 앱의 노드 탭에서 저장한 템플릿', [APP_GRAPH_KEY]: clone(graph) as unknown as JsonValue },
  }
}

/** 템플릿 파일 → 에디터에 열 그래프. 열 수 없으면 throw (사람이 읽을 메시지). */
export function templateToGraph(doc: unknown, id: string): GraphDocument {
  const t = doc as Partial<TemplateDocument> & { ui?: Record<string, unknown> }
  const saved = t.ui?.[APP_GRAPH_KEY]
  if (saved && typeof saved === 'object') return clone(saved as unknown as GraphDocument)

  const def = t.definitions?.[id]
  if (!def) throw new Error(`템플릿에 "${id}" 정의가 없습니다`)
  const nested = Object.values(def.nodes ?? {}).find((n) => n.type.startsWith('subgraph.'))
  if (nested) throw new Error('다른 템플릿을 안에 품은(중첩) 템플릿은 에디터에서 열 수 없습니다')

  // 번들 템플릿은 파일 하단(최상위 nodes)에 `subgraph.<id>` 를 부르는 실행용 하네스를 둔다 — 모델
  // 파일명처럼 정의에 기본값이 없는 파라미터의 실제 값이 거기 있다. 있으면 그 값으로 채운다.
  const topNodes = (t as { nodes?: Record<string, GraphNode> }).nodes ?? {}
  const harness = Object.values(topNodes).find((n) => n.type === `subgraph.${id}`)
  const harnessValue = (param: string): InputValue | undefined => harness?.inputs?.[param] as InputValue | undefined
  const harnessImagePath = (param: string): string => {
    const v = harnessValue(param)
    if (!v || !isLink(v)) return ''
    const src = topNodes[v.$link[0]]
    const p = src?.type === 'image.Load' ? src.inputs?.path : undefined
    return typeof p === 'string' ? p : ''
  }

  const nodes: Record<string, GraphNode> = clone(def.nodes ?? {})
  const loaders = new Map<string, string>()   // Image 파라미터 → 새 image.Load 노드 id
  for (const [name, spec] of Object.entries(def.params ?? {})) {
    if (spec.type !== 'Image') continue
    let nodeId = `in_${name}`
    while (nodes[nodeId]) nodeId += '_'
    nodes[nodeId] = { type: 'image.Load', inputs: { path: harnessImagePath(name) }, meta: { title: spec.doc ?? name } }
    loaders.set(name, nodeId)
  }
  for (const node of Object.values(nodes)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      const param = (value as { $param?: unknown } | null)?.$param
      if (typeof param !== 'string') continue
      const loader = loaders.get(param)
      const fromHarness = harnessValue(param)
      node.inputs![key] = loader
        ? makeLink(loader, 'image')
        : (fromHarness !== undefined && !isLink(fromHarness) ? fromHarness as JsonValue : (def.params[param]?.default ?? null))
    }
  }
  const outputs = [...new Set(Object.values(def.returns ?? {}).map((r) => r.$link[0]))]
  return { nodal_version: '1', nodes, outputs }
}

/** 저장 대화상자의 기본 선택: image.Load 는 전부 Image 입력으로, 출력 노드의 결과는 전부 반환으로. */
export function suggestPicks(graph: GraphDocument, outputSockets: (nodeType: string) => string[]): { params: ParamPick[]; returns: ReturnPick[] } {
  const nodes = graph.nodes ?? {}
  const params: ParamPick[] = Object.entries(nodes)
    .filter(([, n]) => n.type === 'image.Load')
    .map(([nodeId], i) => ({ kind: 'image' as const, nodeId, name: i === 0 ? 'image' : `image_${i + 1}` }))
  const returns: ReturnPick[] = []
  for (const nodeId of graph.outputs ?? []) {
    const node = nodes[nodeId]
    if (!node) continue
    for (const socket of outputSockets(node.type)) {
      returns.push({ nodeId, socket, name: returns.some((r) => r.name === socket) ? `${socket}_${nodeId}` : socket })
    }
  }
  return { params, returns }
}
