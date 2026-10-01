// 기본 워크플로 러너 에이전트의 골든 테스트.
//
// 여기 문자열들은 Track C 의 골든(src/hooks/useWorkflowTest.prompt.test.ts)을 **그대로
// 복사한 것**이다. 아직 프로덕션 빌더를 호출할 수 없어서(호출부 이동은 C 의 하네스 통합
// 이후) 같은 기대값을 양쪽에 두고 비교한다. 두 파일이 갈리면 그게 바로 신호다 —
// 골든을 맞추지 말고 무엇이 달라졌는지 먼저 보고할 것.
//
// 하네스(runnerHarnessPreamble)는 프로덕션에서 기본 ON 이고 SOUL 전문을 앞에 붙여
// 골든을 읽을 수 없게 만든다. 이 좌석은 그 텍스트를 ctx 로 주입받으므로, 대부분의
// 케이스는 그냥 넘기지 않으면 된다(= off 와 같은 출력). localStorage stub 이 필요 없다.

import { describe, it, expect } from 'vitest'
import { buildWorkflowNodePrompt, workflowRunnerAgent, WORKFLOW_RUNNER_AGENT_ID } from './workflowRunner'
import { getWorkflowAgent, registerWorkflowAgent, listWorkflowAgents } from './workflowAgents'
import type { NodePromptCtx, NodeRunContext } from './types'

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

const build = (
  workflow: TwixyWorkflow, n: TwixyWorkflowNode,
  inputs: Record<string, string>, isFirst: boolean, run?: NodeRunContext,
) => buildWorkflowNodePrompt({ workflow, node: n, inputs, isFirst, run } as NodePromptCtx)

// useWorkflowTest.prompt.test.ts 의 NODE_STATUS_BLOCK 과 **바이트 동일**이어야 한다.
const NODE_STATUS_BLOCK = `
When you finish THIS node, end your reply with a status line on its own last line — EXACTLY one of:
  NODE_STATUS: OK   — you actually achieved the goal above (file written, data extracted, action done).
  NODE_STATUS: FAILED — <one short reason>   — you could NOT (a required file/page was missing, you were blocked, or tools kept erroring).
Report FAILED honestly instead of pretending success — a false OK makes the next step build on missing/wrong data. Do not mark OK just because you produced a message.
There are NO other statuses — no PARTIAL, no WARNING. Completed part of the scope? That is FAILED, with the exact resume point (last item/page/cursor) in the reason so the run can continue from there.`

describe('workflowRunnerAgent — Test run 프롬프트 골든 (Track C 골든 복사본)', () => {
  it('첫 노드 — 워크플로 헤더 · inputs · outputDir · 언어/스크린샷 규칙 · 브리지 툴 · scope · NODE_STATUS', () => {
    const n = node({
      id: 'n1', type: 'action', title: 'Collect pages', tool: 'data', toolSkills: ['collect'],
      detail: 'Walk the sitemap into data files.', acceptance: 'Every URL captured.',
      inputScope: [{ name: 'site_url', type: 'url' }],
      outputScope: [{ name: 'pages', type: 'json' }],
    })
    expect(build(wf, n, { site_url: 'https://acme.test', depth: '2' }, true)).toBe(
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
    expect(build(wf, node({ id: 'n2', type: 'action', title: 'Summarise' }), {}, false))
      .toBe(`### Node Summarise [tool?]\n` + NODE_STATUS_BLOCK)
  })

  it('review 노드 — [Human Review] 태그, NODE_STATUS 블록 없음 (사람이 판정하므로)', () => {
    const out = build(wf, node({ id: 'n3', type: 'review', title: 'Human check' }), {}, false)
    expect(out).toBe('### Node Human check [Human Review]')
    expect(out).not.toContain('NODE_STATUS')
  })

  it('validation 노드 — [Validation] 태그 + NODE_STATUS 블록은 있다', () => {
    expect(build(wf, node({ id: 'n4', type: 'validation', title: 'Verify counts' }), {}, false))
      .toBe(`### Node Verify counts [Validation]\n` + NODE_STATUS_BLOCK)
  })

  it('브리지 툴이 없는 tool(read) — depth-1 문장은 있고 "Tools for this node" 는 없다', () => {
    const n = node({ id: 'n5', type: 'action', title: 'Read notes', tool: 'read', detail: 'Read the brief.' })
    const out = build(wf, n, {}, false)
    expect(out).toBe(
`### Node Read notes [read]
Stay within the read tool for this node — use as many of its skills as you need, but if you find yourself needing a different top-level tool, that work belongs in a separate node.
Goal: Read the brief.
` + NODE_STATUS_BLOCK)
    expect(out).not.toContain('Tools for this node')
  })

  it('브리지 툴이 있지만 tool_fetch_to_file 은 아닌 경우(write/xlsx) — 구조화 소스 경고는 붙지 않는다', () => {
    const n = node({ id: 'n6', type: 'action', title: 'Write sheet', tool: 'write', toolSkills: ['xlsx'] })
    const out = build(wf, n, {}, false)
    expect(out).toBe(
`### Node Write sheet [write / xlsx]
Stay within the write tool for this node — use as many of its skills as you need, but if you find yourself needing a different top-level tool, that work belongs in a separate node.
Tools for this node: tool_write_xlsx — call these directly. Do NOT substitute browser page reads, web_fetch, or shell scripts for them: those route the data through this conversation, which truncates and costs far more.
` + NODE_STATUS_BLOCK)
    expect(out).not.toContain('STRUCTURED data source')
  })

  it('scratch dir · 브라우저 profile · resume recap · 첨부파일 — chrome 노드는 profile 을 노드에서 재고지', () => {
    const n = node({ id: 'n7', type: 'action', title: 'Log in', tool: 'chrome', toolSkills: ['instagram'] })
    expect(build(wf, n, {}, true, {
      browserProfile: 'wf-1',
      resumeRecap:    '[RECAP]\n### (done) Node 1: X\nout',
      attachedFiles:  '[Attached: a.xlsx]\ncol,val',
      rawScratchDir:  'data/raw/.scratch-1',
    })).toBe(
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
    const out = build(wf2, node({ id: 'n', type: 'action', title: 'T' }), { a: '   ' }, true)
    expect(out).toContain('  - a (A): obs')
    expect(out).toContain('  - b (B): (not provided)')
  })

  it('절대경로 outputDir 는 안내하지 않는다 (workspace 밖이라 어차피 쓰기가 막힌다)', () => {
    const wf2 = { ...wf, outputDir: '~/Downloads/out' } as unknown as TwixyWorkflow
    expect(build(wf2, node({ id: 'n', type: 'action', title: 'T' }), {}, true)).not.toContain('Save any files')
  })

  it('하네스 블록은 주입받아 첫 노드 맨 앞에만 붙인다 (프로덕션의 기본 ON 경로)', () => {
    const harnessPreamble = '[Runner Harness — follow this before executing the node below]\nBe thorough.\n'
    const first = build(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, true, { harnessPreamble })
    expect(first.startsWith('[Runner Harness — follow this before executing the node below]\n')).toBe(true)
    expect(first).toContain('[Workflow Test — "SEO Action Plan"]')
    // 후속 노드에는 안 붙는다 — 주입해도 isFirst 가 아니면 무시.
    expect(build(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, false, { harnessPreamble }))
      .not.toContain('Runner Harness')
    // 주입하지 않으면 'off' 와 같은 출력.
    expect(build(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, true))
      .not.toContain('Runner Harness')
  })

  it('Orchestration 의 상류 출력(preamble)은 하네스 뒤 · 워크플로 헤더 앞에 들어간다', () => {
    const out = build(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, true, { preamble: '  prior output  ' })
    expect(out.startsWith(
`[Upstream output — context from the previous workflow in this orchestration]
prior output

[Workflow Test — "SEO Action Plan"]`)).toBe(true)
    // 공백뿐이면 블록 자체가 없다.
    expect(build(wf, node({ id: 'n', type: 'action', title: 'T' }), {}, true, { preamble: '   ' }))
      .not.toContain('Upstream output')
  })
})

describe('워크플로 에이전트 레지스트리 — 조회는 총(total)', () => {
  it('코어 기본 러너가 모듈 로드 시점에 등록돼 있다', () => {
    expect(getWorkflowAgent(WORKFLOW_RUNNER_AGENT_ID)).toBe(workflowRunnerAgent)
    expect(listWorkflowAgents()).toContain(workflowRunnerAgent)
    expect(workflowRunnerAgent.agentId).toBe('workflow-runner')
  })

  it('모르는 id · null · undefined 는 기본 러너로 떨어진다 (undefined 를 돌려주지 않는다)', () => {
    expect(getWorkflowAgent('nope')).toBe(workflowRunnerAgent)
    expect(getWorkflowAgent(null)).toBe(workflowRunnerAgent)
    expect(getWorkflowAgent(undefined)).toBe(workflowRunnerAgent)
  })

  it('제품이 등록한 에이전트가 우선한다 (nodal 의 video 모드와 같은 방식)', () => {
    const custom = {
      id: 'test-product-runner', agentId: 'main',
      buildBody: (ctx: NodePromptCtx) => `custom:${ctx.node.title}`,
    }
    registerWorkflowAgent(custom)
    expect(getWorkflowAgent('test-product-runner')).toBe(custom)
    expect(getWorkflowAgent('test-product-runner').buildBody(
      { workflow: wf, node: node({ id: 'n', type: 'action', title: 'X' }), inputs: {}, isFirst: true },
    )).toBe('custom:X')
    // 기본 러너는 그대로 남는다.
    expect(getWorkflowAgent(WORKFLOW_RUNNER_AGENT_ID)).toBe(workflowRunnerAgent)
  })
})

// 차등 테스트(프로덕션 빌더와 바이트 비교)는 **이동을 증명하는 비계**였고, 두 빌더를 지운
// 지금은 비교 대상이 없어 함께 내렸다. 이제 각 경로의 바이트를 지키는 건 그 경로의 골든이다:
//   · Test run      → src/hooks/useWorkflowTest.prompt.test.ts
//   · Orchestration → src/lib/runWorkflowNodes.test.ts (두 경로의 격차 대조도 그 안에 있다)
// 둘 다 이 좌석을 호출하도록 바뀌었고, 기대 문자열은 이동 전 그대로다.
