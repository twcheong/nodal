// ─────────────────────────────────────────────────────────────────────────────
// agents/workflowRunner.ts — 기본 워크플로 러너 에이전트.
//
// 지금 제품에서 가장 많이 나가는 프롬프트(Workflow Test 경로)를 **바이트 단위 그대로**
// 옮겨온 것이다. 설계가 아니라 박제다 — 문구를 고치려면 골든(useWorkflowTest.prompt.test.ts
// 와 여기 workflowRunner.test.ts)을 함께 고쳐야 한다.
//
// 아직 호출부를 바꾸지 않았다. Track C 가 Test run / Orchestration 두 빌더를 하나로
// 합치는 중이라, 합치기 전에 옮기면 3자 충돌만 난다. 합쳐진 하나가 남으면 그 호출부를
// 이 좌석으로 돌린다 (순서: 중복 합치기 → 살아남은 하나를 이동).
//
// 순수 TS 다 — React·window·localStorage·transport 없음. 하네스 블록 텍스트만 ctx 로
// 주입받는다 (이유는 types.ts 의 NodeRunContext.harnessPreamble 주석 참고).
// ─────────────────────────────────────────────────────────────────────────────

import { bridgeToolsFor } from '../workflowTools'
import { NODE_STATUS_LINES } from '../nodeStatus'
import type { NodePromptCtx, WorkflowAgent } from './types'

/** 게이트웨이 에이전트 id. 서브에이전트 spawn 이 없는 풀툴 러너 — "턴 종료 = 노드 종료" 를 위해. */
export const WORKFLOW_RUNNER_AGENT_ID = 'workflow-runner'

export function buildWorkflowNodePrompt(ctx: NodePromptCtx): string {
  const { workflow, node, inputs, isFirst } = ctx
  const run = ctx.run ?? {}
  const isTestRun = (run.promptStyle ?? 'workflow-test') === 'workflow-test'
  const parts: string[] = []

  if (isFirst) {
    // v3 하네스(기본 ON). 호출자가 플래그를 읽어 이미 포맷된 블록을 넘긴다.
    if (run.harnessPreamble) { parts.push(run.harnessPreamble); parts.push('') }
    // Orchestration 체이닝: 상류 멤버의 출력. Test run 경로에는 없다.
    if (run.preamble && run.preamble.trim()) {
      parts.push('[Upstream output — context from the previous workflow in this orchestration]')
      parts.push(run.preamble.trim())
      parts.push('')
    }
    parts.push(`[${isTestRun ? 'Workflow Test' : 'Workflow'} — "${workflow.title}"]`)
    if (workflow.description) parts.push(workflow.description)
    if (workflow.inputs && workflow.inputs.length > 0) {
      parts.push('')
      parts.push('Inputs:')
      for (const inp of workflow.inputs) {
        const value = inputs[inp.id]?.trim() || String(inp.observed ?? '') || '(not provided)'
        parts.push(`  - ${inp.id} (${inp.label}): ${value}`)
      }
    }
    // workspace 상대경로일 때만 안내한다. 쓰기는 workspace 에 갇혀 있어서 절대경로
    // (~/Downloads/…)를 시키면 어차피 막힌다 — 못 쓸 곳을 지시하지 않는다.
    const outDir = workflow.outputDir?.trim()
    if (outDir && !outDir.startsWith('/') && !outDir.startsWith('~')) {
      parts.push('')
      parts.push(`Save any files this workflow produces under: ${outDir}`)
    }
    // 탭별 raw scratch — 중간/수집 파일은 이 폴더 아래로 강제. 탭을 닫으면 이 폴더만
    // 삭제돼 산출물(outputDir)은 남는다. 노드 detail 이 data/raw/xxx 를 말해도 이 지시가
    // 우선하도록 명시적으로 remap 을 요구한다.
    if (run.rawScratchDir) {
      parts.push('')
      parts.push(
        `Scratch/intermediate files (collected pages, raw dumps, temp CSVs — anything that is NOT the final deliverable) MUST go under: ${run.rawScratchDir}`
        + ` — if a node's instructions name a path like data/raw/<name>, write it under ${run.rawScratchDir}/<name> instead.`
        + ` This folder is cleared when the tab closes; only the final deliverable in ${outDir || 'the output folder'} is kept.`,
      )
    }
    if (run.browserProfile) {
      parts.push('')
      parts.push(`This run has its own dedicated browser: pass profile: "${run.browserProfile}" on every browser tool call.`)
    }
    parts.push('')
    parts.push(isTestRun
      ? `I will run this workflow node by node. Execute exactly the current node only and stop. I will send the next node when you're done.`
      : `Run this workflow node by node. Execute exactly the current node only and stop. I will send the next node when you're done.`)
    // 아래 두 블록은 **두 경로 모두**에 들어간다. Test run 기능이 아니라 모델이 산출물을
    // 망가뜨리는 걸 막는 가드레일이기 때문이다 — Orchestration 이라고 면제될 이유가 없다.
    // 언어 일관성: 채팅의 post-turn 언어 교정과 달리 파일은 사후 재작성이 불가능하고(xlsx 는
    // 바이너리) 데이터 훼손 위험이 있어, 생성 시점에 프롬프트로 강제한다.
    parts.push('')
    parts.push(`Language: write ALL prose you produce — file contents, summaries, column labels — in the same language as the workflow inputs/title above. Never mix languages mid-text (e.g. no Chinese/Japanese characters leaking into Korean output). Keep proper nouns, URLs, and scraped source data verbatim.`)
    // 이미지 입력 미지원 모델 가드: 스크린샷이 LLM 에 전달되는 순간 404 로 턴이 죽는다
    // (관측된 사고이지 가정이 아니다 — "No endpoints found that support image input").
    parts.push('')
    parts.push(`No screenshots or images: your model CANNOT receive image input — any screenshot/image-capture tool call will crash this turn. Never take screenshots; use text snapshots / extracted DOM text instead.`)
    parts.push('')
    if (run.resumeRecap) {
      parts.push(run.resumeRecap)
      parts.push('')
    }
  }

  const tag = node.type === 'review' && isTestRun
    ? '[Human Review]'
    : node.type === 'validation'
      ? '[Validation]'
      : `[${node.tool ?? 'tool?'}${node.toolSkills?.length ? ' / ' + node.toolSkills.join(', ') : ''}]`

  parts.push(`### Node ${node.title} ${tag}`)
  // 단일 depth-1 tool 원칙(soft). 그 tool 의 skill 은 여럿 써도 되지만, 다른 L1 tool 이
  // 필요하면 "이 노드 범위 밖" 신호다. reject 는 하지 않는다 — 명시만.
  if (node.tool && node.type === 'action') {
    parts.push(
      `Stay within the ${node.tool} tool for this node — use as many of its skills as you need,`
      + ` but if you find yourself needing a different top-level tool, that work belongs in a separate node.`
      + (node.tool === 'data'
        ? ` (data/query can write its result straight to a spreadsheet by giving the query an output ending in .xlsx or .csv — no separate write tool needed.)`
        : ''),
    )
  }
  // 카탈로그 라벨(`data / collect`)은 실행기가 부를 수 있는 이름이 아니다 — 대응하는
  // 브리지 툴(`tool_fetch_to_file` 등)을 이름으로 지목해야 browser/web_fetch 로 되돌아가지 않는다.
  const bridge = bridgeToolsFor(node.tool, node.toolSkills)
  if (bridge.length > 0) {
    parts.push(
      `Tools for this node: ${bridge.join(', ')} — call these directly.`
      + ` Do NOT substitute browser page reads, web_fetch, or shell scripts for them:`
      + ` those route the data through this conversation, which truncates and costs far more.`,
    )
    // HTML 페이지네이션을 수집 툴에 먹이는 사고 방지 — 렌더된 목록 페이지를 markup 그대로
    // 저장하면 query 가 못 읽는 쓰레기가 된다. 뒤의 "구조화 소스" 를 먼저 찾게 한다.
    if (bridge.includes('tool_fetch_to_file')) {
      parts.push(
        'tool_fetch_to_file must be pointed at a STRUCTURED data source — a URL that'
        + ' answers with JSON/CSV records. A rendered listing page almost always has one'
        + ' behind it; find and verify it with ONE small request before walking pages.'
        + ' Saving HTML pages is a failure, not a fallback — the query tool cannot read'
        + ' markup. If no structured source exists, report FAILED and say so.',
      )
    }
  }
  if (node.detail)     parts.push(`Goal: ${node.detail}`)
  if (node.acceptance) parts.push(`Acceptance: ${node.acceptance}`)
  if (node.inputScope?.length) {
    parts.push(`Inputs from previous nodes: ${node.inputScope.map(f => `${f.name} (${f.type})`).join(', ')}`)
  }
  if (node.outputScope?.length) {
    parts.push(`Expected output: ${node.outputScope.map(f => `${f.name} (${f.type})`).join(', ')}`)
  }
  // 이 노드가 참조하는 xlsx 내용 첨부 (앱이 미리 읽어 CSV 로 넘김). 러너가 바이너리
  // Excel 을 read 툴로 열려다 실패하는 걸 원천 차단.
  if (run.attachedFiles) {
    parts.push('')
    parts.push(run.attachedFiles)
  }
  // chrome 노드마다 프로필 재고지 — 첫 노드 preamble 은 노드 5+ 쯤이면 잊힌다.
  if (run.browserProfile && node.tool === 'chrome') {
    parts.push(`Browser: pass profile: "${run.browserProfile}" on every browser tool call in this node.`)
  }
  // 자기보고 상태 줄 — 매 노드마다. 게이트웨이는 final 메시지만 나오면 turn 을 성공으로
  // 치므로, 러너가 실제로 목표를 못 이뤘는지는 이 줄로만 판별 가능하다.
  if (node.type !== 'review') parts.push('', ...NODE_STATUS_LINES)
  return parts.join('\n')
}

/** 코어 기본 에이전트. 제품이 아무것도 등록하지 않아도 이게 있어서 조회가 총(total)이다. */
export const workflowRunnerAgent: WorkflowAgent = {
  id:        WORKFLOW_RUNNER_AGENT_ID,
  agentId:   WORKFLOW_RUNNER_AGENT_ID,
  buildBody: buildWorkflowNodePrompt,
}
