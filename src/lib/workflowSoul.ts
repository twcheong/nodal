// ─────────────────────────────────────────────────────────────────────────────
// workflowSoul.ts — Workflow Builder 어시스턴트의 시스템 프롬프트.
//
// 프로젝트 루트의 WORKFLOW_SOUL.md 를 빌드 타임에 raw 텍스트로 import 한다.
// .md 가 단일 소스 — 사람이 읽기 위해 .md 로 두고, 런타임 주입을 위해 vite 의
// ?raw 로더로 같은 파일을 그대로 끌어온다.
//
// 동적 부분: SOUL 안의 `<!-- TOOLS_CATALOG -->` placeholder 는 호출 시점의
// WORKFLOW_TOOLS 카탈로그로 치환된다 — 카탈로그가 바뀌면 다음 메시지부터 LLM
// 이 새 카탈로그를 본다. 게이트웨이가 끼워넣는 카탈로그 밖 skill 명칭들은
// SOUL 의 "Anything not in the catalog above is NOT a skill" 절로 차단.
//
// getWorkflowSoul() 을 매 sendMessage 시 호출해 최신 카탈로그를 갖다 쓴다.
// 정적 export 는 의도적으로 두지 않음 — 그러면 모듈 로드 시점 스냅샷이 박혀
// "real-time 업데이트" 가 깨진다.
// ─────────────────────────────────────────────────────────────────────────────

import { WORKFLOW_SOUL_MD as soul } from './agents/generated/soulText'
import { renderToolCatalog } from './workflowTools'

const CATALOG_PLACEHOLDER = '<!-- TOOLS_CATALOG -->'

export function getWorkflowSoul(): string {
  return soul.replace(CATALOG_PLACEHOLDER, renderToolCatalog())
}
