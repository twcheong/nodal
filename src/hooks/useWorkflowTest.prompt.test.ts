// buildNodePrompt (Test run 경로) 의 특성화(characterization) 테스트.
//
// 이 프롬프트는 제품에서 가장 많이 나가는 프롬프트인데 지금까지 테스트가 0건이었다.
// 여기 있는 문자열들은 "이렇게 되어야 한다" 는 설계가 아니라 **2026-09 현재 실제로
// 나가고 있는 것을 그대로 박제한 것**이다. 고의로 프롬프트를 바꾼다면 골든도 같이
// 바꾸면 된다 — 목적은 *모르는 사이에* 바뀌는 걸 막는 것이다.
//
// 골든을 디스크 fixture 가 아니라 인라인으로 둔 이유: 리뷰어가 diff 에서 프롬프트
// 전문을 그대로 읽을 수 있어야 하기 때문.
//
// 하네스(runnerHarnessPreamble)는 기본 ON 이고 SOUL 본문 전체를 앞에 붙인다. 골든을
// 읽을 수 없게 만들므로 대부분의 케이스에서 localStorage 로 'off' 시킨다 — ON 경로는
// 마지막 테스트가 따로 덮는다.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { workflowRunnerAgent } from '../lib/agents/workflowRunner'
import { runnerHarnessPreamble } from '../lib/runnerHarness'

// 빌더는 좌석(src/lib/agents/workflowRunner.ts)으로 옮겨졌다. 이 골든은 **Test run 경로가
// 내보내는 바이트**를 고정하는 것이므로, 호출 모양만 바꾸고 기대 문자열은 그대로 둔다.
// 하네스는 예전에 빌더가 직접 읽던 것을 호출부가 읽어 넘긴다 — 위 harness() stub 이 그대로 먹는다.
function buildNodePrompt(
  workflow: TwixyWorkflow, node: TwixyWorkflowNode, inputs: Record<string, string>, isFirst: boolean,
  browserProfile?: string, resumeRecap?: string, attachedFiles?: string, rawScratchDir?: string | null,
): string {
  return workflowRunnerAgent.buildBody({
    workflow, node, inputs, isFirst,
    run: {
      promptStyle: 'workflow-test', harnessPreamble: runnerHarnessPreamble(),
      browserProfile, resumeRecap, attachedFiles, rawScratchDir,
    },
  }) as string
}

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

// 모든 비-review 노드 끝에 붙는 자기보고 블록. 프로덕션이 노드 실패를 판별하는
// 유일한 수단이라 상수로 빼서 "있다/없다" 를 명시적으로 검증한다.
const NODE_STATUS_BLOCK = `
When you finish THIS node, end your reply with a status line on its own last line — EXACTLY one of:
  NODE_STATUS: OK   — you actually achieved the goal above (file written, data extracted, action done).
  NODE_STATUS: FAILED — <one short reason>   — you could NOT (a required file/page was missing, you were blocked, or tools kept erroring).
Report FAILED honestly instead of pretending success — a false OK makes the next step build on missing/wrong data. Do not mark OK just because you produced a message.
There are NO other statuses — no PARTIAL, no WARNING. Completed part of the scope? That is FAILED, with the exact resume point (last item/page/cursor) in the reason so the run can continue from there.`

describe('buildNodePrompt — Test run (src/hooks/useWorkflowTest.ts)', () => {
  beforeEach(() => harness('off'))

  it('첫 노드 — 워크플로 헤더 · inputs · outputDir · 언어/스크린샷 규칙 · 브리지 툴 · scope · NODE_STATUS', () => {
    const n = node({
      id: 'n1', type: 'action', title: 'Collect pages', tool: 'data', toolSkills: ['collect'],
      detail: 'Walk the sitemap into data files.', acceptance: 'Every URL captured.',
      inputScope: [{ name: 'site_url', type: 'url' }],
      outputScope: [{ name: 'pages', type: 'json' }],
    })
    // inputs 에 넘긴 값이 profile 의 observed 를 이긴다 (https://acme.test / 2).
    expect(buildNodePrompt(wf, n, { site_url: 'https://acme.test', depth: '2' }, true)).toBe(
`[Workflow Test — "SEO Action Plan"]
Crawl the site and produce a prioritised action plan.

Inputs:
  - site_url (Site URL): https://acme.test
  - depth (Crawl depth): 2

Save any files this workflow produces under: reports/seo

I will run this workflow node by node. Execute exactly the current node only and stop. I will send the next node when you're done.

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

  it('후속 노드 — 헤더 없음. tool 없으면 [tool?] 태그, depth-1 문장도 브리지 블록도 없다', () => {
    const n = node({ id: 'n2', type: 'action', title: 'Summarise' })
    expect(buildNodePrompt(wf, n, {}, false)).toBe(`### Node Summarise [tool?]\n` + NODE_STATUS_BLOCK)
  })

  it('review 노드 — [Human Review] 태그, NODE_STATUS 블록 없음 (사람이 판정하므로)', () => {
    const n = node({ id: 'n3', type: 'review', title: 'Human check' })
    const out = buildNodePrompt(wf, n, {}, false)
    expect(out).toBe('### Node Human check [Human Review]')
    expect(out).not.toContain('NODE_STATUS')
  })

  it('validation 노드 — [Validation] 태그 + NODE_STATUS 블록은 있다', () => {
    const n = node({ id: 'n4', type: 'validation', title: 'Verify counts' })
    expect(buildNodePrompt(wf, n, {}, false)).toBe(`### Node Verify counts [Validation]\n` + NODE_STATUS_BLOCK)
  })

  it('브리지 툴이 없는 tool(read) — depth-1 문장은 있고 "Tools for this node" 는 없다', () => {
    const n = node({ id: 'n5', type: 'action', title: 'Read notes', tool: 'read', detail: 'Read the brief.' })
    const out = buildNodePrompt(wf, n, {}, false)
    expect(out).toBe(
`### Node Read notes [read]
Stay within the read tool for this node — use as many of its skills as you need, but if you find yourself needing a different top-level tool, that work belongs in a separate node.
Goal: Read the brief.
` + NODE_STATUS_BLOCK)
    expect(out).not.toContain('Tools for this node')
  })

  it('브리지 툴이 있지만 tool_fetch_to_file 은 아닌 경우(write/xlsx) — 구조화 소스 경고는 붙지 않는다', () => {
    const n = node({ id: 'n6', type: 'action', title: 'Write sheet', tool: 'write', toolSkills: ['xlsx'] })
    const out = buildNodePrompt(wf, n, {}, false)
    expect(out).toBe(
`### Node Write sheet [write / xlsx]
Stay within the write tool for this node — use as many of its skills as you need, but if you find yourself needing a different top-level tool, that work belongs in a separate node.
Tools for this node: tool_write_xlsx — call these directly. Do NOT substitute browser page reads, web_fetch, or shell scripts for them: those route the data through this conversation, which truncates and costs far more.
` + NODE_STATUS_BLOCK)
    expect(out).not.toContain('STRUCTURED data source')
  })

  it('scratch dir · 브라우저 profile · resume recap · 첨부파일 — chrome 노드는 profile 을 노드에서 재고지', () => {
    const n = node({ id: 'n7', type: 'action', title: 'Log in', tool: 'chrome', toolSkills: ['instagram'] })
    expect(buildNodePrompt(
      wf, n, {}, true,
      'wf-1',                                  // browserProfile
      '[RECAP]\n### (done) Node 1: X\nout',    // resumeRecap
      '[Attached: a.xlsx]\ncol,val',           // attachedFiles
      'data/raw/.scratch-1',                   // rawScratchDir
    )).toBe(
`[Workflow Test — "SEO Action Plan"]
Crawl the site and produce a prioritised action plan.

Inputs:
  - site_url (Site URL): https://example.com
  - depth (Crawl depth): 3

Save any files this workflow produces under: reports/seo

Scratch/intermediate files (collected pages, raw dumps, temp CSVs — anything that is NOT the final deliverable) MUST go under: data/raw/.scratch-1 — if a node's instructions name a path like data/raw/<name>, write it under data/raw/.scratch-1/<name> instead. This folder is cleared when the tab closes; only the final deliverable in reports/seo is kept.

This run has its own dedicated browser: pass profile: "wf-1" on every browser tool call.

I will run this workflow node by node. Execute exactly the current node only and stop. I will send the next node when you're done.

Language: write ALL prose you produce — file contents, summaries, column labels — in the same language as the workflow inputs/title above. Never mix languages mid-text (e.g. no Chinese/Japanese characters leaking into Korean output). Keep proper nouns, URLs, and scraped source data verbatim.

No screenshots or images: your model CANNOT receive image input — any screenshot/image-capture tool call will crash this turn. Never take screenshots; use text snapshots / extracted DOM text instead.

[RECAP]
### (done) Node 1: X
out

### Node Log in [chrome / instagram]
Stay within the chrome tool for this node — use as many of its skills as you need, but if you find yourself needing a different top-level tool, that work belongs in a separate node.

[Attached: a.xlsx]
col,val
Browser: pass profile: "wf-1" on every browser tool call in this node.
` + NODE_STATUS_BLOCK)
  })

  it('inputs 값이 비면 profile 의 observed 로, 그것도 없으면 (not provided)', () => {
    const wf2 = { ...wf, inputs: [
      { id: 'a', kind: 'scalar', valueType: 'text', label: 'A', observed: 'obs', confidence: 'low' },
      { id: 'b', kind: 'scalar', valueType: 'text', label: 'B', observed: null, confidence: 'low' },
    ] } as unknown as TwixyWorkflow
    const out = buildNodePrompt(wf2, node({ id: 'n', type: 'action', title: 'T' }), { a: '   ' }, true)
    expect(out).toContain('  - a (A): obs')
    expect(out).toContain('  - b (B): (not provided)')
  })

  it('절대경로 outputDir 는 안내하지 않는다 (workspace 밖이라 어차피 쓰기가 막힌다)', () => {
    const wf2 = { ...wf, outputDir: '~/Downloads/out' } as unknown as TwixyWorkflow
    expect(buildNodePrompt(wf2, node({ id: 'n', type: 'action', title: 'T' }), {}, true))
      .not.toContain('Save any files')
  })

  it('하네스 기본 ON — 첫 노드 맨 앞에 Runner Harness 블록이 붙는다', () => {
    harness(null)
    const out = buildNodePrompt(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, true)
    expect(out.startsWith('[Runner Harness — follow this before executing the node below]\n')).toBe(true)
    expect(out).toContain('[Workflow Test — "SEO Action Plan"]')
    // 후속 노드에는 안 붙는다.
    expect(buildNodePrompt(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, false))
      .not.toContain('Runner Harness')
  })
})
