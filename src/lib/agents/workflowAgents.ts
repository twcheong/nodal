// ─────────────────────────────────────────────────────────────────────────────
// agents/workflowAgents.ts — 워크플로 에이전트 레지스트리.
//
// 조회는 **총(total)** 이다. 이유: Twixy(주력 제품)는 아무것도 등록하지 않는다 —
// 제품 렌더러 엔트리를 가진 건 nodal 뿐이고 src/main.tsx 는 initTheme() 만 부른다.
// 그래서 코어가 기본 러너를 모듈 로드 시점에 등록해 두고, 못 찾으면 그걸 돌려준다.
// 호출부가 undefined 를 다룰 일이 없다.
// ─────────────────────────────────────────────────────────────────────────────

import { createAgentRegistry } from './registry'
import { workflowRunnerAgent, WORKFLOW_RUNNER_AGENT_ID } from './workflowRunner'
import type { WorkflowAgent } from './types'

const registry = createAgentRegistry<WorkflowAgent>()

// 코어 기본값 — 제품이 아무것도 안 해도 좌석이 비지 않는다.
registry.register(workflowRunnerAgent)

/** 제품이 자기 러너 에이전트를 끼운다. App 렌더 전에 부를 것. */
export function registerWorkflowAgent(agent: WorkflowAgent): void {
  registry.register(agent)
}

/** 항상 에이전트를 돌려준다 — 모르는 id 면 기본 러너. */
export function getWorkflowAgent(id?: string | null): WorkflowAgent {
  return registry.get(id) ?? workflowRunnerAgent
}

export function listWorkflowAgents(): WorkflowAgent[] {
  return registry.list()
}

export { WORKFLOW_RUNNER_AGENT_ID }
