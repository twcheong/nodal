// ─────────────────────────────────────────────────────────────────────────────
// workflowTools.ts — 정적 Tool / Tool Skills 카탈로그.
//
// PDF 0613 의 정의에 따라 노드는 다음 두 계층의 Tool 관련 메타데이터를 가진다:
//   - Tool (depth 1): 어떤 능력으로 노드를 실행하는가 (Chrome, Read, Write, …)
//   - Tool Skills (depth 2): Tool 안의 더 좁은 단위 (Chrome > instagram, …)
//
// 이 모듈은 UI 의 좌하단 ToolsCatalog 데이터 소스이자, 노드의 tool / toolSkills
// 값이 카탈로그 안에 있는지 검증하는 단일 진실 공급원이다. 카탈로그 자체는
// 정적이며, 실제 실행/배포 시 확장될 예정 — v1 은 사람이 직접 편집한다.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowToolDef {
  id:          WorkflowTool
  label:       string
  description: string
  // tool skills — 카탈로그가 미리 정의한 것들만 노드에 부착할 수 있다 (v1).
  skills:      WorkflowToolSkillDef[]
}

export interface WorkflowToolSkillDef {
  id:          string
  label:       string
  description: string
}

export const WORKFLOW_TOOLS: WorkflowToolDef[] = [
  {
    id: 'chrome', label: 'Chrome',
    description: 'Browser automation — navigate, click, scrape, screenshot. For pages that genuinely need a real browser: a login, JS-rendered content, or a form to drive. NOT for gathering many records — a node that opens items one at a time costs more the more it collects; use `data` for that.',
    skills: [
      // Broad website domains
      { id: 'instagram',         label: 'Instagram',          description: 'Feed, DM, Saved, profile flows.' },
      { id: 'threads',           label: 'Threads',            description: 'Browse posts, search by handle.' },
      { id: 'youtube',           label: 'YouTube',            description: 'Channel, video, transcript flows.' },
      { id: 'seo-crawl',         label: 'SEO Crawl',          description: 'Discover internal links + per-page metrics.' },
      // Specific L7 recipes (absorbed from former runtime skills)
      { id: 'instagram-saved',   label: 'Instagram Saved',    description: 'Extract recently saved reels/posts with engagement data.' },
      { id: 'youtube-transcript',label: 'YouTube Transcript', description: 'Open video, handle ads, extract full transcript text.' },
      { id: 'data-scout',        label: 'Data Scout',         description: 'Cross-platform collection of posts, engagement, comments, trends.' },
      { id: 'watchtower',        label: 'Watchtower',         description: 'Periodic metric polling + diff across platforms.' },
    ],
  },
  {
    id: 'web-fetch', label: 'Web Fetch',
    description: 'HTTP fetch for ONE small resource — a single API response or page, when the node needs to read and reason about it. The body comes back into the conversation, so never point it at a paginated list; use `data` to collect many records.',
    skills: [],
  },
  {
    id: 'read', label: 'Read',
    description: 'Read text / structured files from the workspace.',
    skills: [],
  },
  {
    id: 'data', label: 'Data',
    description: 'Collect many records, and reshape them, entirely on disk — the payload never enters the conversation, so the node costs the same for 50 records as for 50,000. Use this, NOT `chrome` or `web-fetch`, for any "collect every X from Y" node — products, listings, posts, rows, search results — including from ordinary websites, whose pages are usually backed by a paginated data endpoint. Sub-skill `collect` walks that endpoint into workspace files and returns counts only; `query` runs read-only SQL over those files to select, filter, aggregate, join, dedupe or convert, so totals it computes are exact rather than estimated. It reads .xlsx/.csv/.tsv/.json/.parquet (spreadsheets by sheet — "book.xlsx#Sheet2" picks one). ALWAYS use `query` — never the attached file text — to count, filter or aggregate a spreadsheet: an attachment can be cut short by the prompt budget, and a table that has been cut short reads as a table that ended, which has produced confidently wrong "these rows are missing" conclusions. The query sees every row. Reach for `chrome` only if the data truly exists nowhere but a rendered page.',
    skills: [
      // NOTE: renderToolCatalog() emits sub-skill IDs only — these descriptions
      // never reach the builder. Any steering has to live in `description` above.
      { id: 'collect', label: 'Collect', description: 'Walk a paginated HTTP resource into workspace files; returns counts only.' },
      { id: 'query',   label: 'Query',   description: 'Read-only SQL over workspace data files — select, filter, aggregate, join, dedupe, convert.' },
    ],
  },
  {
    id: 'write', label: 'Write',
    description: 'Write files to the workspace.',
    skills: [
      { id: 'pdf',         label: 'PDF',         description: 'Generate a PDF document.' },
      { id: 'md',          label: 'Markdown',    description: 'Write a .md file.' },
      { id: 'json',        label: 'JSON',        description: 'Write a .json data file.' },
      { id: 'csv',         label: 'CSV',         description: 'Write a .csv table.' },
      { id: 'xlsx',        label: 'XLSX',        description: 'Write an Excel workbook.' },
      { id: 'pptx',        label: 'PPTX',        description: 'Build a designed PowerPoint deck — 6 deck purposes with page tables, 14 slide kinds incl. a 12-column composable layout, 7 theme presets (incl. dark), 4 style recipes, speaker notes, visual QA.' },
    ],
  },
  {
    id: 'edit', label: 'Edit',
    description: 'In-place edits on an existing workspace file (text patch).',
    skills: [],
  },
  {
    id: 'api', label: 'API',
    description: 'Call an external API by name.',
    skills: [
      { id: 'google-workspace', label: 'Google Workspace', description: 'Docs, Sheets, Drive, Calendar.' },
      // Specific Google Workspace recipes (absorbed)
      { id: 'gdoc-report',      label: 'Google Docs Report', description: 'Create a Google Doc from an analytics insight, return share URL.' },
      { id: 'sheet-sync',       label: 'Sheet Sync',         description: 'One-shot mirror between local XLSX and Google Sheet.' },
    ],
  },
  {
    id: 'app', label: 'App',
    description: 'Drive a desktop / mobile app.',
    skills: [
      { id: 'kakaotalk', label: 'KakaoTalk', description: 'Send messages to chats / channels.' },
    ],
  },
  {
    id: 'mcp', label: 'MCP',
    description: 'Call into an MCP server connector.',
    skills: [
      { id: 'notion', label: 'Notion', description: 'Read/write pages, query databases.' },
    ],
  },
]

// ── 카탈로그 이름 → 실제 호출 가능한 툴 이름 ────────────────────────────────
// 빌더가 고르는 `tool`/`toolSkills` 는 카탈로그 어휘(`data`, `collect`)이고,
// 노드를 실행하는 LLM 이 실제로 부를 수 있는 건 openclaw 에 주입된 브리지 툴
// (`tool_fetch_to_file`) 이다. 둘을 잇는 매핑이 없으면 실행기는 라벨만 보고
// "그런 툴은 없다" 고 판단해 browser/web_fetch 로 되돌아간다 — 노드가 값비싼
// 경로로 조용히 우회하는 원인이었다.
//
// 여기 없는 조합은 openclaw 기본 툴(browser/web_fetch/read/write)로 충분한
// 경우다 — 굳이 이름을 지정하지 않는다.
const BRIDGE_TOOL_BY_SKILL: Record<string, string[]> = {
  'data/collect':          ['tool_fetch_to_file'],
  'data/query':            ['tool_query_data'],
  'write/xlsx':            ['tool_write_xlsx'],
  'write/pdf':             ['tool_write_pdf'],
  'write/pptx':            ['tool_write_pptx'],
  'api/google-workspace':  ['tool_write_gdoc', 'tool_read_gdoc', 'tool_write_gsheet', 'tool_read_gsheet'],
  'api/gdoc-report':       ['tool_write_gdoc'],
  'api/sheet-sync':        ['tool_write_gsheet', 'tool_read_gsheet'],
}
// tool 만 지정되고 skill 이 없을 때의 기본값.
const BRIDGE_TOOL_BY_TOOL: Record<string, string[]> = {
  data: ['tool_fetch_to_file', 'tool_query_data'],
}

/**
 * 이 노드가 반드시 써야 할 브리지 툴 이름들. 없으면 빈 배열.
 * 노드 프롬프트 빌더 **두 곳**이 실행기에게 명시한다 — Test run 은
 * useWorkflowTest.ts 의 buildNodePrompt, Orchestration 은
 * runWorkflowNodes.ts 의 buildNodePrompt. 한쪽만 고치면 다른 경로가
 * 조용히 비싼 폴백(browser/web_fetch)으로 돈다.
 */
export function bridgeToolsFor(tool: WorkflowTool | undefined, toolSkills?: string[]): string[] {
  if (!tool) return []
  const out = new Set<string>()
  for (const s of toolSkills ?? []) {
    for (const name of BRIDGE_TOOL_BY_SKILL[`${tool}/${s}`] ?? []) out.add(name)
  }
  if (out.size === 0) for (const name of BRIDGE_TOOL_BY_TOOL[tool] ?? []) out.add(name)
  return [...out]
}

// WORKFLOW_TOOLS 를 SOUL 에 주입할 마크다운 카탈로그로 직렬화.
// workflowSoul.ts 에서 placeholder 치환에 사용 — 카탈로그가 바뀌면 다음
// sendMessage 부터 LLM 이 새 카탈로그를 보게 된다.
export function renderToolCatalog(): string {
  const lines: string[] = []
  for (const t of WORKFLOW_TOOLS) {
    const subs = t.skills.length
      ? ` (sub-skills: ${t.skills.map(s => s.id).join(', ')})`
      : ''
    lines.push(`- \`${t.id}\` — ${t.description}${subs}`)
  }
  return lines.join('\n')
}

export function findTool(id: WorkflowTool | undefined): WorkflowToolDef | undefined {
  if (!id) return undefined
  return WORKFLOW_TOOLS.find(t => t.id === id)
}

export function findSkill(tool: WorkflowTool | undefined, skillId: string): WorkflowToolSkillDef | undefined {
  const t = findTool(tool)
  return t?.skills.find(s => s.id === skillId)
}

// ── Catalog gatekeepers ─────────────────────────────────────────────────────
// 워크플로 노드를 저장하기 직전 user 입력 (LLM 응답 포함) 을 카탈로그 안으로
// 강제. PDF 0613 의 새 정의에 따라 "skill" = Tool (depth 1) | Tool Skill
// (depth 2) 만 인정 — 카탈로그 밖 임의 문자열은 워크플로에 못 들어옴.

// 문자열을 받아 카탈로그에 있으면 정규화된 WorkflowTool 반환, 없으면 undefined.
// 호출 측은 undefined 면 "tool 미지정 노드" 로 둘지, 노드 자체를 drop 할지 결정.
export function validateTool(raw: unknown): WorkflowTool | undefined {
  if (typeof raw !== 'string') return undefined
  const t = WORKFLOW_TOOLS.find(t => t.id === raw)
  return t?.id
}

// tool 컨텍스트 안에서 toolSkills 후보들을 카탈로그로 필터. tool 이 undefined
// 거나 카탈로그 밖이면 빈 배열 — tool 없는 노드에 skill 만 있는 건 의미 없음.
// 결과가 비어 있으면 호출 측이 toolSkills 필드를 undefined 로 두면 됨.
export function filterValidSkills(tool: WorkflowTool | undefined, raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const t = findTool(tool)
  if (!t) return []
  const allowed = new Set(t.skills.map(s => s.id))
  return raw.filter((s): s is string => typeof s === 'string' && allowed.has(s))
}

// 개발 시 WORKFLOW_TOOLS 와 global.d.ts 의 WorkflowTool 유니온이 어긋났는지
// 모듈 로드 시점에 한 번 확인. 두 곳을 함께 수정하라는 신호 — 새 tool 을
// 카탈로그에만 추가하고 union 에 안 넣었으면 여기서 잡힘.
// (런타임 비용 무시 가능: O(N) 한 번, N ≤ 10.)
const __CATALOG_IDS = WORKFLOW_TOOLS.map(t => t.id)
const __EXPECTED_UNION: ReadonlyArray<WorkflowTool> = [
  'chrome', 'web-fetch', 'read', 'data', 'write', 'edit', 'api', 'app', 'mcp',
] as const
if (__CATALOG_IDS.length !== __EXPECTED_UNION.length ||
    !__EXPECTED_UNION.every(id => __CATALOG_IDS.includes(id))) {
  // 콘솔 경고만 — throw 하면 앱 부팅 실패. dev/console 으로 충분히 잡힘.
  console.warn('[workflowTools] WORKFLOW_TOOLS ids drifted from WorkflowTool union in global.d.ts.',
    'catalog:', __CATALOG_IDS, 'union:', __EXPECTED_UNION,
    '→ update both together.')
}

// Visualization helpers — node shape per type, label per type.
export function nodeShapeFor(type: WorkflowNodeType): 'circle' | 'triangle' | 'square' {
  switch (type) {
    case 'action':     return 'circle'
    case 'review':     return 'triangle'
    case 'validation': return 'square'
  }
}

export function nodeTagFor(node: TwixyWorkflowNode): string {
  if (node.type === 'review')     return 'Human Review'
  if (node.type === 'validation') return 'Validation'
  return findTool(node.tool)?.label ?? 'Tool?'
}
