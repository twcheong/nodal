// ─────────────────────────────────────────────────────────────────────────────
// parseWorkflowSpec — 빌더 채팅 응답에서 `workflow-spec` JSON 블록을 추출하고
// 우리 데이터 모델(TwixyWorkflow 생성 payload) 모양으로 정규화한다.
//
// LLM 이 SOUL 의 권장 필드명을 완벽히 지키지 않는 경우가 많아서 (`shape`/`label`
// /`prompt`/`order` 같은 자기 어휘로 출력) 너그럽게 받아 변환해준다.
//   shape  → type   (circle=action, triangle=review, square=validation)
//   label  → title
//   prompt → detail
//   order  → 배열 정렬 키
// inputs 의 valueType 도 모델 enum 밖 값(file/string 등)을 가까운 값으로 매핑.
//
// tool / toolSkills 는 카탈로그 (workflowTools.WORKFLOW_TOOLS) 안 값으로만
// 강제 — LLM 이 카탈로그 밖 명칭을 끼워넣어도 여기서 drop 되어 워크플로 JSON
// 에 안 남는다. 새 정의 (PDF 0613): skill = Tool | Tool Skill.
// ─────────────────────────────────────────────────────────────────────────────

import { validateTool, filterValidSkills } from './workflowTools'

export type ParsedWorkflowSpec = {
  title:       string
  description?: string
  prompt?:     string
  inputs:      Array<{
    id:         string
    kind:       'scalar' | 'list'
    valueType:  'url' | 'path' | 'query' | 'text' | 'json' | 'number'
    label:      string
    observed:   unknown
    confidence: 'low'
  }>
  nodes: Array<{
    id?:          string
    type:         'action' | 'review' | 'validation'
    title:        string
    detail?:      string
    acceptance?:  string
    skillHint?:   string | null
    tool?:        string
    toolSkills?:  string[]
    subtasks?:    Array<{ id: string; title: string; purpose?: string }>
    inputScope?:  Array<{ name: string; type: string; description?: string }>
    outputScope?: Array<{ name: string; type: string; description?: string }>
  }>
}

// Human Review 노드의 안내 문구 — 개발 용어(QA 등) 없이 일반인이 이해하게.
// 노드에 fine-print 로 은은히 표시된다(매번 읽을 정보는 아니고 모르는 사람용).
const HUMAN_REVIEW_DETAIL =
  'Optional pause so you can look at what the previous step produced before it continues — handy while you\'re still checking the workflow does what you want. It doesn\'t have to be here: continue, leave a note to guide it, or skip. Once you\'re happy with how it runs, you can delete these check steps (× on the card) so it runs start to finish on its own.'

// Human Review 노드 생성 — 캔버스의 (+) 삽입 버튼과 신규 워크플로 자동 삽입 공용.
export function makeHumanReviewNode(): TwixyWorkflowNode {
  return {
    id:     `rev_${crypto.randomUUID().slice(0, 8)}`,
    type:   'review',
    title:  'Human Review (optional)',
    detail: HUMAN_REVIEW_DETAIL,
  }
}

// 새 워크플로 "첫 생성" 시 노드 사이마다 Human Review 를 끼워 넣는다 — 사람이
// 각 단계 결과를 확인하며 진행하게. 스펙에 이미 review 노드가 있으면 빌더가
// 의도적으로 배치한 것이므로 그대로 둔다. (Update 경로에는 적용하지 않는다.)
export function interleaveHumanReviews(nodes: ParsedWorkflowSpec['nodes']): ParsedWorkflowSpec['nodes'] {
  if (nodes.length < 2) return nodes
  if (nodes.some(n => n.type === 'review')) return nodes
  const out: ParsedWorkflowSpec['nodes'] = []
  nodes.forEach((n, i) => {
    out.push(n)
    if (i < nodes.length - 1) {
      out.push({
        // id 필수 — 없으면 저장 계층의 위치 기반 fallback(`n${i+1}`)이 스펙의
        // 뒷번호 노드와 충돌한다 (예: 스펙 n1..n5 사이에 끼우면 리뷰가 n2/n4 를
        // 받아 실제 n2/n4 와 같은 id 가 됨). 런 상태가 id 로 키잉되므로 두
        // 노드가 상태 한 칸을 공유해 "수집 노드가 리뷰 대기로 표시" 같은
        // 유령이 생긴다. makeHumanReviewNode 와 같은 규칙으로 생성.
        id:     `rev_${crypto.randomUUID().slice(0, 8)}`,
        type:   'review',
        title:  'Human Review (optional)',
        detail: HUMAN_REVIEW_DETAIL,
      })
    }
  })
  return out
}

// 메시지 텍스트에서 spec 블록을 제거해 prose 만 남긴다 — 채팅에서 raw JSON 을
// 코드 블록으로 출력하지 않고 node 카드로 대신 보여줄 때 사용. extract 와 같은
// 규칙(tagged 우선, fallback 으로 title+nodes 가진 json 블록)을 미러링.
export function stripWorkflowSpecBlock(text: string): string {
  const taggedRe = /```workflow-spec\s*\n[\s\S]*?```/gi
  if (taggedRe.test(text)) {
    return text.replace(taggedRe, '').replace(/\n{3,}/g, '\n\n').trim()
  }
  // tagged 가 없을 때만 첫 번째 매칭 json 블록을 제거.
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/i
  const m = fenceRe.exec(text)
  if (m && /"title"\s*:/.test(m[1]) && /"nodes"\s*:/.test(m[1])) {
    return (text.slice(0, m.index) + text.slice(m.index + m[0].length))
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  return text
}

// 메시지 텍스트에서 첫 번째 ```workflow-spec``` 블록 추출. 없으면 null.
// 일반 ```json 블록도 폴백으로 시도 — LLM 이 fence 태그를 잊을 때 대비.
export function extractWorkflowSpecBlock(text: string): string | null {
  const tagged = text.match(/```workflow-spec\s*\n([\s\S]*?)```/i)
  if (tagged?.[1]) return tagged[1].trim()
  // 폴백: 임의의 fenced JSON 블록 중 title + nodes 가 같이 있는 첫 번째
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1].trim()
    if (/"title"\s*:/.test(body) && /"nodes"\s*:/.test(body)) return body
  }
  return null
}

// ── simple-plan (1회용 플랜) ─────────────────────────────────────────────────
// Copilot Simple 모드의 산출물 — workflow-spec 과 같은 노드 스키마를 재사용하되
// 별도 fence 태그로 완전히 구분한다 (저장되는 워크플로가 아니라 즉시 실행되고
// 버려지는 플랜). review 노드는 개념상 존재할 수 없어 방어적으로 걸러낸다.
export function parseSimplePlanFromText(text: string): ParsedWorkflowSpec | null {
  const tagged = text.match(/```simple-plan\s*\n([\s\S]*?)```/i)
  if (!tagged?.[1]) return null
  let json: unknown
  try { json = JSON.parse(tagged[1].trim()) } catch { return null }
  if (!json || typeof json !== 'object') return null
  const spec = normalizeSpec(json as Record<string, unknown>)
  if (!spec) return null
  return { ...spec, nodes: spec.nodes.filter(n => n.type !== 'review') }
}

export function stripSimplePlanBlock(text: string): string {
  return text.replace(/```simple-plan\s*\n[\s\S]*?```/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

// 텍스트에서 워크플로 스펙 1개를 파싱해 정규화된 payload 로 반환.
// 실패 시 null — 호출 측에서 "이 메시지엔 스펙 없음" 으로 처리.
export function parseWorkflowSpecFromText(text: string): ParsedWorkflowSpec | null {
  const raw = extractWorkflowSpecBlock(text)
  if (!raw) return null
  let json: unknown
  try { json = JSON.parse(raw) }
  catch { return null }
  if (!json || typeof json !== 'object') return null
  return normalizeSpec(json as Record<string, unknown>)
}

function normalizeSpec(j: Record<string, unknown>): ParsedWorkflowSpec | null {
  const title = pickStr(j, ['title', 'name'])
  if (!title) return null
  const description = pickStr(j, ['description', 'summary'])
  const prompt      = pickStr(j, ['prompt', 'instruction', 'systemPrompt'])

  const inputsRaw = pickArr(j, ['inputs', 'variables', 'inputVariables'])
  const inputs = inputsRaw.map(normalizeInput).filter(Boolean) as ParsedWorkflowSpec['inputs']

  const nodesRaw = pickArr(j, ['nodes', 'steps', 'tasks'])
  // order 키 있으면 정렬, 없으면 원본 순서 보존
  const sortedNodes = [...nodesRaw].sort((a, b) => {
    const oa = numOf(a, ['order', 'index', 'idx']) ?? Number.POSITIVE_INFINITY
    const ob = numOf(b, ['order', 'index', 'idx']) ?? Number.POSITIVE_INFINITY
    return oa - ob
  })
  const nodes = sortedNodes.map((n, i) => normalizeNode(n, i)).filter(Boolean) as ParsedWorkflowSpec['nodes']

  return { title, description, prompt, inputs, nodes }
}

function normalizeInput(raw: unknown): ParsedWorkflowSpec['inputs'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id    = pickStr(r, ['id', 'key', 'name'])
  if (!id) return null
  const label = pickStr(r, ['label', 'description', 'name']) || id
  const vtRaw = pickStr(r, ['valueType', 'type', 'kind']) ?? 'text'
  return {
    id,
    kind:       isArrayLikeValueType(vtRaw) ? 'list' : 'scalar',
    valueType:  normalizeValueType(vtRaw),
    label,
    observed:   r.default ?? r.example ?? r.observed ?? '',
    confidence: 'low',
  }
}

function normalizeNode(raw: unknown, idx: number): ParsedWorkflowSpec['nodes'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type   = normalizeNodeType(pickStr(r, ['type', 'shape', 'kind']) ?? 'action')
  const detail = pickStr(r, ['detail', 'description', 'prompt', 'instruction'])
  // LLM often omits `title` and only sends `prompt`/`description`. Derive a
  // short label so the node still renders instead of being silently dropped.
  const title  = pickStr(r, ['title', 'label', 'name']) ?? deriveTitle(detail, type, idx)
  if (!title) return null
  // Accept `toolSkill` (singular string) in addition to the documented
  // `toolSkills` array — the LLM picks one or the other interchangeably.
  const toolSkillsRaw = pickStrArr(r, ['toolSkills', 'skills', 'subSkills'])
    ?? (pickStr(r, ['toolSkill']) ? [pickStr(r, ['toolSkill'])!] : undefined)
  // tool / toolSkills 를 카탈로그 안 값으로 강제. LLM 이 SOUL 무시하고
  // 카탈로그 밖 명칭을 끼워넣으면 여기서 drop.
  const rawToolName = pickStr(r, ['tool'])
  const validTool   = validateTool(rawToolName)
  if (rawToolName && !validTool) {
    console.warn(`[parseWorkflowSpec] node "${title}": dropped tool="${rawToolName}" — not in catalog`)
  }
  const validToolSkills = toolSkillsRaw ? filterValidSkills(validTool, toolSkillsRaw) : []
  if (toolSkillsRaw && toolSkillsRaw.length > 0 && validToolSkills.length < toolSkillsRaw.length) {
    const dropped = toolSkillsRaw.filter(s => !validToolSkills.includes(s))
    console.warn(`[parseWorkflowSpec] node "${title}": dropped toolSkills`, dropped, `(not in catalog for tool "${validTool ?? '<none>'}")`)
  }
  return {
    id:          pickStr(r, ['id']),
    type,
    title,
    detail,
    acceptance:  pickStr(r, ['acceptance', 'acceptanceCriteria', 'criteria']),
    skillHint:   pickStr(r, ['skillHint', 'skill']) ?? null,
    tool:        validTool,
    toolSkills:  validToolSkills.length > 0 ? validToolSkills : undefined,
    subtasks:    normalizeSubtasks(r['subtasks'] ?? r['l7'] ?? r['checklist']),
    inputScope:  normalizeScope(r['inputScope']  ?? r['inputs']  ?? r['input']),
    outputScope: normalizeScope(r['outputScope'] ?? r['outputs'] ?? r['output']),
  }
}

// L7 체크리스트 — { id, title, purpose }. id 없으면 인덱스 기반 부여.
function normalizeSubtasks(raw: unknown): Array<{ id: string; title: string; purpose?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Array<{ id: string; title: string; purpose?: string }> = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    if (!s) continue
    // 문자열만 들어오는 경우도 너그럽게 받아 title 로 승격.
    if (typeof s === 'string' && s.trim()) {
      out.push({ id: `s${i + 1}`, title: s.trim() })
      continue
    }
    if (typeof s !== 'object') continue
    const r = s as Record<string, unknown>
    const title = pickStr(r, ['title', 'label', 'name', 'description'])
    if (!title) continue
    out.push({
      id:      pickStr(r, ['id', 'key']) ?? `s${i + 1}`,
      title,
      purpose: pickStr(r, ['purpose', 'reason', 'why', 'note']),
    })
  }
  return out.length ? out : undefined
}

function deriveTitle(detail: string | undefined, type: 'action' | 'review' | 'validation', idx: number): string {
  if (detail) {
    // First sentence, capped at ~60 chars — enough to be meaningful in a node card.
    const firstSentence = detail.split(/(?<=[.!?])\s/)[0] ?? detail
    const trimmed = firstSentence.trim().replace(/\s+/g, ' ')
    if (trimmed) return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 57).trimEnd() + '…'
  }
  const label = type === 'review' ? 'Human review' : type === 'validation' ? 'Validation' : 'Action'
  return `${label} ${idx + 1}`
}

function normalizeNodeType(s: string): 'action' | 'review' | 'validation' {
  const v = s.toLowerCase()
  if (v === 'circle'   || v === 'action')     return 'action'
  if (v === 'triangle' || v === 'review' || v === 'human-review' || v === 'human_review') return 'review'
  if (v === 'square'   || v === 'validation' || v === 'validate') return 'validation'
  return 'action'
}

function normalizeValueType(s: string): 'url' | 'path' | 'query' | 'text' | 'json' | 'number' {
  const v = s.toLowerCase()
  if (v === 'url'    || v === 'link' || v === 'website') return 'url'
  if (v === 'path'   || v === 'file' || v === 'filepath') return 'path'
  if (v === 'query'  || v === 'search') return 'query'
  if (v === 'number' || v === 'int'  || v === 'integer' || v === 'float' || v === 'boolean' || v === 'bool') return 'number'
  if (v === 'json'   || v === 'object' || v === 'list' || v === 'array' || v.endsWith('[]')) return 'json'
  return 'text'
}

function isArrayLikeValueType(s: string): boolean {
  const v = s.toLowerCase()
  return v === 'list' || v === 'array' || v.endsWith('[]')
}

function normalizeScope(raw: unknown): Array<{ name: string; type: string; description?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Array<{ name: string; type: string; description?: string }> = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue
    const r = f as Record<string, unknown>
    const name = pickStr(r, ['name', 'field', 'id', 'key'])
    if (!name) continue
    out.push({
      name,
      type:        pickStr(r, ['type', 'valueType']) ?? 'text',
      description: pickStr(r, ['description', 'desc', 'note']),
    })
  }
  return out.length ? out : undefined
}

// ── helpers ─────────────────────────────────────────────────────────────────
function pickStr(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}
function pickStrArr(o: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = o[k]
    if (Array.isArray(v)) {
      const ss = v.filter(x => typeof x === 'string') as string[]
      if (ss.length) return ss
    }
  }
  return undefined
}
function pickArr(o: Record<string, unknown>, keys: string[]): unknown[] {
  for (const k of keys) {
    const v = o[k]
    if (Array.isArray(v)) return v
  }
  return []
}
function numOf(o: unknown, keys: string[]): number | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  for (const k of keys) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}
