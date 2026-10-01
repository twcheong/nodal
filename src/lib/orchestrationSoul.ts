// ─────────────────────────────────────────────────────────────────────────────
// orchestrationSoul.ts — Orchestration Builder 어시스턴트 시스템 프롬프트.
// 루트 ORCHESTRATION_SOUL.md 를 raw import 하고, <!-- WORKFLOWS_CATALOG -->
// placeholder 를 현재 사용 가능한 Workflow(L5) 목록으로 치환한다 — 멤버로 참조
// 가능한 workflowId 들을 LLM 이 알도록.
// ─────────────────────────────────────────────────────────────────────────────

import { ORCHESTRATION_SOUL_MD as soul } from './agents/generated/soulText'

const CATALOG_PLACEHOLDER = '<!-- WORKFLOWS_CATALOG -->'

// 멤버는 워크플로(leaf) 또는 AI Agent(relay 그룹, 파일 단위) — 둘 다 카탈로그로 주입.
export function getOrchestrationSoul(workflows: TwixyWorkflow[] = [], agents: TwixyAiAgent[] = []): string {
  const wfList = workflows.length === 0
    ? '_(no workflows yet — create one in the Workflow tab)_'
    : workflows.map(w => {
        const t = w.type ? ` ${w.type}` : ''
        const n = w.nodes?.length ?? 0
        return `- \`${w.id}\` · **${w.title}** (${n} node${n === 1 ? '' : 's'}${t})`
      }).join('\n')
  const agentList = agents.length === 0
    ? '_(no AI agents yet — create one with ＋ New AI Agent in the left panel)_'
    : agents.map(a => {
        const opts = a.options?.length ?? 0
        const desc = a.description ? ` — ${a.description.slice(0, 100)}` : ''
        return `- \`${a.id}\` · **${a.title}** (${a.agentType}, ${opts} option${opts === 1 ? '' : 's'})${desc}`
      }).join('\n')
  const catalog = `### Workflows (use as workflowId leaf)\n${wfList}\n\n### AI Agents (use as agentId member)\n${agentList}`
  return soul.replace(CATALOG_PLACEHOLDER, catalog)
}
