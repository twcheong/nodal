// ─────────────────────────────────────────────────────────────────────────────
// contentSoul.ts — Content 모드(덱 authoring) 세션의 시스템 프롬프트.
//
// workflowSoul.ts 와 같은 패턴: 루트의 CONTENT_SOUL.md 를 ?raw 로 끌어와
// 첫 메시지 앞에 붙인다. .md 가 단일 소스 — 사람이 읽기 위해 .md 로 두고,
// 런타임 주입에도 같은 파일을 쓴다.
//
// 여기 소울이 skills/pptx 런북 대신인 이유: Content 모드의 에이전트는
// tool-less 'builder' 라 tool_write_pptx 를 부르지 않는다. 즉 SKILLS.md →
// SKILL.md 발견 경로를 타지 않으므로 덱 구성 규칙을 소울로 직접 주입한다.
// (워크플로 노드 경로는 여전히 skills/pptx/SKILL.md 를 쓴다 — 두 경로가 같은
// 규칙을 말하도록 둘 다 고칠 것.)
// ─────────────────────────────────────────────────────────────────────────────

import { CONTENT_SOUL_MD as soul } from './agents/generated/soulText'

export function getContentSoul(): string {
  return soul
}
