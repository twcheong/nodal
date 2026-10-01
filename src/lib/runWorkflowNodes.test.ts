// runWorkflowNodes (Orchestration 경로) — 프롬프트 골든 + 노드 성공/실패 판정.
//
// 짝: src/hooks/useWorkflowTest.prompt.test.ts (Test run 경로). 같은 이름의 빌더가
// 두 벌 있어서, 한쪽만 고치면 두 경로의 "성공" 정의가 갈린다. 실제로 갈려 있었고
// (Orchestration 이 게이트웨이 final 만 믿었다) 2026-09 에 strict 쪽으로 통일했다.
//
// 마지막 describe 가 아직 남아 있는 격차를 박제한다 — 합칠 때(stage3-harness-map
// §4 Move 2) 무엇이 사용자 눈에 바뀌는지가 거기서 드러난다.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runWorkflowNodes } from './runWorkflowNodes'
import { workflowRunnerAgent } from './agents/workflowRunner'
import { runnerHarnessPreamble } from './runnerHarness'

// 빌더는 좌석(src/lib/agents/workflowRunner.ts)으로 옮겨졌다 — 두 경로가 같은 빌더를
// promptStyle 만 달리해 부른다. 기대 문자열은 한 글자도 바꾸지 않는다: 이 골든이 고정하는 건
// 각 경로가 실제로 내보내는 바이트고, 그게 이동 전후로 같아야 하기 때문이다.
// 하네스는 예전에 빌더가 직접 읽던 것을 호출부가 읽어 넘긴다 (위 harness() stub 이 그대로 먹는다).
const promptFor = (promptStyle: 'workflow-test' | 'orchestration') => (
  workflow: TwixyWorkflow, node: TwixyWorkflowNode,
  inputs: Record<string, string>, isFirst: boolean, extra?: string,
): string => workflowRunnerAgent.buildBody({
  workflow, node, inputs, isFirst,
  run: {
    promptStyle, harnessPreamble: runnerHarnessPreamble(),
    // 위치 인자 5번째의 뜻이 경로마다 다르다: Orchestration 은 상류 출력, Test run 은 브라우저 프로필.
    ...(promptStyle === 'orchestration' ? { preamble: extra } : { browserProfile: extra }),
  },
}) as string

const buildNodePrompt = promptFor('orchestration')
const testRunPrompt   = promptFor('workflow-test')

function harness(value: string | null) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'twixy.runnerHarness' ? value : null),
    setItem: () => {}, removeItem: () => {},
  })
}

const wf = {
  version: 1, id: 'wf_x', title: 'SEO Action Plan',
  description: 'Crawl the site and produce a prioritised action plan.',
  outputDir: 'reports/seo',
  inputs: [
    { id: 'site_url', kind: 'scalar', valueType: 'url', label: 'Site URL', observed: 'https://example.com', confidence: 'low' },
    { id: 'depth', kind: 'scalar', valueType: 'number', label: 'Crawl depth', observed: 3, confidence: 'low' },
  ],
  author: { uid: 'u' }, createdAt: '', updatedAt: '', nodes: [],
} as unknown as TwixyWorkflow

const node = (p: Record<string, unknown>) => p as unknown as TwixyWorkflowNode

const collect = node({
  id: 'n1', type: 'action', title: 'Collect pages', tool: 'data', toolSkills: ['collect'],
  detail: 'Walk the sitemap into data files.', acceptance: 'Every URL captured.',
  inputScope: [{ name: 'site_url', type: 'url' }],
  outputScope: [{ name: 'pages', type: 'json' }],
})

// 골든은 production 상수(NODE_STATUS_LINES)에서 끌어오지 않고 리터럴로 둔다 —
// 상수에서 파생하면 상수가 바뀔 때 기대값도 같이 바뀌어 아무것도 못 잡는다.
const NODE_STATUS_BLOCK = `
When you finish THIS node, end your reply with a status line on its own last line — EXACTLY one of:
  NODE_STATUS: OK   — you actually achieved the goal above (file written, data extracted, action done).
  NODE_STATUS: FAILED — <one short reason>   — you could NOT (a required file/page was missing, you were blocked, or tools kept erroring).
Report FAILED honestly instead of pretending success — a false OK makes the next step build on missing/wrong data. Do not mark OK just because you produced a message.
There are NO other statuses — no PARTIAL, no WARNING. Completed part of the scope? That is FAILED, with the exact resume point (last item/page/cursor) in the reason so the run can continue from there.`

describe('buildNodePrompt — Orchestration (src/lib/runWorkflowNodes.ts)', () => {
  beforeEach(() => harness('off'))

  it('첫 노드 + 상류 preamble — 체이닝 블록이 맨 앞, NODE_STATUS 블록이 맨 뒤', () => {
    expect(buildNodePrompt(wf, collect, { site_url: 'https://acme.test', depth: '2' }, true, 'upstream text')).toBe(
`[Upstream output — context from the previous workflow in this orchestration]
upstream text

[Workflow — "SEO Action Plan"]
Crawl the site and produce a prioritised action plan.

Inputs:
  - site_url (Site URL): https://acme.test
  - depth (Crawl depth): 2

Save any files this workflow produces under: reports/seo

Run this workflow node by node. Execute exactly the current node only and stop. I will send the next node when you're done.

Language: write ALL prose you produce — file contents, summaries, column labels — in the same language as the workflow inputs/title above. Never mix languages mid-text (e.g. no Chinese/Japanese characters leaking into Korean output). Keep proper nouns, URLs, and scraped source data verbatim.

No screenshots or images: your model CANNOT receive image input — any screenshot/image-capture tool call will crash this turn. Never take screenshots; use text snapshots / extracted DOM text instead.

### Node Collect pages [data / collect]
Stay within the data tool for this node — use as many of its skills as you need, but if you find yourself needing a different top-level tool, that work belongs in a separate node. (data/query can write its result straight to a spreadsheet by giving the query an output ending in .xlsx or .csv — no separate write tool needed.)
Tools for this node: tool_fetch_to_file — call these directly. Do NOT substitute browser page reads, web_fetch, or shell scripts for them: those route the data through this conversation, which truncates and costs far more.
tool_fetch_to_file must be pointed at a STRUCTURED data source — a URL that answers with JSON/CSV records. A rendered listing page almost always has one behind it; find and verify it with ONE small request before walking pages. Saving HTML pages is a failure, not a fallback — the query tool cannot read markup. If no structured source exists, report FAILED and say so.
Goal: Walk the sitemap into data files.
Acceptance: Every URL captured.
Inputs from previous nodes: site_url (url)
Expected output: pages (json)
` + NODE_STATUS_BLOCK)
  })

  it('preamble 없으면 체이닝 블록도 없다 (공백 문자열도 마찬가지)', () => {
    const noPre = buildNodePrompt(wf, collect, {}, true)
    expect(noPre).not.toContain('[Upstream output')
    expect(noPre.startsWith('[Workflow — "SEO Action Plan"]')).toBe(true)
    expect(buildNodePrompt(wf, collect, {}, true, '   ')).not.toContain('[Upstream output')
  })

  it('후속 노드 — 헤더 없음, tool 없으면 [tool?]', () => {
    expect(buildNodePrompt(wf, node({ id: 'n2', type: 'action', title: 'Summarise' }), {}, false))
      .toBe('### Node Summarise [tool?]\n' + NODE_STATUS_BLOCK)
  })

  it('validation 노드 — [Validation] 태그 + NODE_STATUS 블록', () => {
    expect(buildNodePrompt(wf, node({ id: 'n4', type: 'validation', title: 'Verify counts' }), {}, false))
      .toBe('### Node Verify counts [Validation]\n' + NODE_STATUS_BLOCK)
  })

  it('review 노드에는 상태 줄을 요구하지 않는다 (판정 주체가 사람)', () => {
    // 참고: 실제 실행에서 review 노드는 러너 루프가 빌더 호출 전에 가로채므로
    // (runWorkflowNodes 의 reviewMode 분기) 이 경로는 프로덕션에서 도달하지 않는다.
    // 그래도 가드를 두는 이유는 도달했을 때 사람에게 프로토콜 찌꺼기를 보이지 않기 위함.
    expect(buildNodePrompt(wf, node({ id: 'r', type: 'review', title: 'Human check' }), {}, false))
      .not.toContain('NODE_STATUS')
  })

  it('하네스 기본 ON — 첫 노드 맨 앞 (preamble 보다도 앞)', () => {
    harness(null)
    const out = buildNodePrompt(wf, collect, {}, true, 'upstream text')
    expect(out.startsWith('[Runner Harness — follow this before executing the node below]\n')).toBe(true)
    expect(out.indexOf('[Runner Harness')).toBeLessThan(out.indexOf('[Upstream output'))
  })
})

// ── 노드 성공/실패 판정 (2026-09: strict 로 통일) ─────────────────────────────
describe('runWorkflowNodes — NODE_STATUS 자기보고 판정', () => {
  beforeEach(() => harness('off'))

  const twoNodes = {
    ...wf,
    nodes: [node({ id: 'a', type: 'action', title: 'A' }), node({ id: 'b', type: 'action', title: 'B' })],
  } as unknown as TwixyWorkflow

  async function run(replies: string[]) {
    const seen: Array<{ id: string; status: string; reason?: string; output?: string }> = []
    const sent: string[] = []
    let i = 0
    let usd = 0
    const r = await runWorkflowNodes(twoNodes, {}, {
      send: async (text: string) => {
        sent.push(text)
        return { text: replies[i++] ?? '', messageId: null, toolCalls: [] }
      },
      // 원장이 매번 움직이게 둔다 — 안 움직이면 fetchUsageWithRetry 가 노드마다
      // 6회×500ms 를 다 돌아 테스트가 기본 타임아웃(5s)을 넘긴다.
      fetchUsageCost: async () => ({ totals: { usd: ++usd }, byModel: [] }),
      abort: { aborted: false },
      onNode: (id, m) => { seen.push({ id, status: m.status, reason: m.reason, output: m.output }) },
    })
    return { r, seen, sent }
  }

  it('OK → 성공. 저장되는 output 에서 상태 줄은 제거된다', async () => {
    const { r, seen } = await run(['Wrote the file.\nNODE_STATUS: OK', 'Done.\nNODE_STATUS: OK'])
    expect(r.status).toBe('done')
    expect(r.outputs.a).toBe('Wrote the file.')
    expect(seen.find(s => s.id === 'a' && s.status === 'done')?.output).toBe('Wrote the file.')
    expect(r.finalOutput).not.toContain('NODE_STATUS')
  })

  it('상태 줄이 아예 없으면 성공 (약한 모델이 빠뜨린 걸로 실제 성공을 뒤집지 않는다)', async () => {
    const { r } = await run(['Just prose, no status line.', 'Also none.'])
    expect(r.status).toBe('done')
    expect(r.outputs.a).toBe('Just prose, no status line.')
  })

  it('FAILED → 실패. 사유 보존, 즉시 반환, 뒤 노드는 보내지 않는다', async () => {
    const { r, seen, sent } = await run(['Could not open it.\nNODE_STATUS: FAILED — sitemap 404', 'never'])
    expect(r.status).toBe('failed')
    expect(r.failedNodeId).toBe('a')
    expect(r.reason).toBe('sitemap 404')
    expect(sent).toHaveLength(1)                     // 두 번째 노드는 실행되지 않음
    expect(seen.map(s => s.id)).toEqual(['a', 'a'])  // running → failed, b 는 보고조차 안 됨
    expect(seen.at(-1)).toMatchObject({ status: 'failed', reason: 'sitemap 404' })
    expect(seen.at(-1)?.output).toBe('Could not open it.')
  })

  it('사유 없는 FAILED 도 실패 — 기본 문구가 들어간다', async () => {
    const { r } = await run(['NODE_STATUS: FAILED'])
    expect(r.status).toBe('failed')
    expect(r.reason).toBe('The step reported it could not complete.')
  })

  it('지어낸 상태(PARTIAL)도 실패로 취급하고 재개 지점을 사유에 보존한다', async () => {
    const { r } = await run(['NODE_STATUS: PARTIAL — stopped at page 262'])
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('PARTIAL')
    expect(r.reason).toContain('stopped at page 262')
  })

  it('실패해도 남은 노드를 aborted 로 칠하지 않는다 — throw 경로와 같은 모양', async () => {
    const { seen } = await run(['NODE_STATUS: FAILED — nope', 'never'])
    expect(seen.some(s => s.status === 'aborted')).toBe(false)
    expect(seen.some(s => s.id === 'b')).toBe(false)
  })
})

// ── 두 빌더에 남아 있는 격차 ─────────────────────────────────────────────────
// NODE_STATUS 항목은 2026-09 에 의도적으로 닫혔다 — 이제 "같은가" 를 검증한다.
// 나머지 격차는 계속 박제해 둔다 (stage3-harness-map §5.1).
describe('Test run 빌더 vs Orchestration 빌더', () => {
  beforeEach(() => harness('off'))
  const later = node({ id: 'n', type: 'action', title: 'T', tool: 'read' })

  it('닫힌 격차 — NODE_STATUS 블록을 양쪽이 바이트까지 똑같이 내보낸다', () => {
    const t = testRunPrompt(wf, later, {}, false)
    const o = buildNodePrompt(wf, later, {}, false)
    const cut = (s: string) => s.slice(s.indexOf('\nWhen you finish THIS node'))
    expect(cut(t)).toBe(NODE_STATUS_BLOCK)
    expect(cut(o)).toBe(NODE_STATUS_BLOCK)
    expect(cut(o)).toBe(cut(t))
  })

  it('닫힌 격차 — review 노드는 양쪽 다 상태 줄을 요구하지 않는다', () => {
    const review = node({ id: 'r', type: 'review', title: 'Human check' })
    expect(testRunPrompt(wf, review, {}, false)).not.toContain('NODE_STATUS')
    expect(buildNodePrompt(wf, review, {}, false)).not.toContain('NODE_STATUS')
  })

  it('남은 격차 — review 태그가 다르다: Test run [Human Review] vs Orchestration [tool?]', () => {
    const review = node({ id: 'r', type: 'review', title: 'Human check' })
    expect(testRunPrompt(wf, review, {}, false)).toBe('### Node Human check [Human Review]')
    expect(buildNodePrompt(wf, review, {}, false)).toBe('### Node Human check [tool?]')
  })

  it('남은 격차 — 첫 노드 헤더 문구: [Workflow Test — …] vs [Workflow — …]', () => {
    expect(testRunPrompt(wf, later, {}, true)).toContain('[Workflow Test — "SEO Action Plan"]')
    expect(buildNodePrompt(wf, later, {}, true)).toContain('[Workflow — "SEO Action Plan"]')
  })

  // 2026-09 에 닫힘 — 사용자 결정. 이 둘은 Test run 기능이 아니라 모델이 산출물을 망가뜨리는
  // 걸 막는 가드레일이라, Orchestration 이라고 면제될 이유가 없다.
  it('닫힌 격차 — Language / No screenshots 규칙을 두 경로가 똑같이 낸다', () => {
    const t = testRunPrompt(wf, later, {}, true)
    const o = buildNodePrompt(wf, later, {}, true)
    for (const rule of [
      'Language: write ALL prose you produce',
      'Never mix languages mid-text',
      'No screenshots or images: your model CANNOT receive image input',
    ]) {
      expect(t).toContain(rule)
      expect(o).toContain(rule)
    }
    // 위치도 같다 — 진행 안내 뒤, 첫 노드 헤더 앞.
    expect(o.indexOf('Language: write ALL prose')).toBeGreaterThan(o.indexOf('node by node'))
    expect(o.indexOf('No screenshots')).toBeLessThan(o.indexOf('### Node'))
  })

  it('남은 격차 — preamble 은 Orchestration 에만, scratch/profile/recap/첨부는 Test run 에만', () => {
    expect(buildNodePrompt(wf, later, {}, true, 'up')).toContain('[Upstream output')
    expect(testRunPrompt(wf, later, {}, true, 'wf-1')).toContain('dedicated browser: pass profile: "wf-1"')
    expect(buildNodePrompt(wf, later, {}, true)).not.toContain('dedicated browser')
  })

  it('공유 블록 — bridgeToolsFor 와 depth-1 원칙은 글자까지 같다', () => {
    const t = testRunPrompt(wf, collect, {}, false)
    const o = buildNodePrompt(wf, collect, {}, false)
    for (const shared of [
      'Stay within the data tool for this node',
      'Tools for this node: tool_fetch_to_file — call these directly.',
      'must be pointed at a STRUCTURED data source',
      'Inputs from previous nodes: site_url (url)',
      'Expected output: pages (json)',
    ]) {
      expect(t).toContain(shared)
      expect(o).toContain(shared)
    }
  })
})
