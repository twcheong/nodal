// ─────────────────────────────────────────────────────────────────────────────
// copilotModes.ts — 제품이 Copilot 채팅 모드를 끼워 넣는 자리.
//
// 내장 모드(wf / simple / content)는 useCopilotChat · CopilotView 안에 구현돼 있다.
// 다른 제품(예: Nodal 의 video)은 코어를 고치지 않고 여기에 모드를 등록한다 —
// products/<id>/renderer/main.tsx 가 App 을 렌더하기 전에 registerCopilotMode() 를
// 부른다. 코어는 등록된 모드가 무엇인지 모른 채 아래 인터페이스만 따른다.
//
// 내장 모드와 다른 점: 등록 모드는 스펙 블록을 앱이 파싱·실행하는 구조가 아니라,
// 툴을 가진 에이전트가 직접 일하고 SidePanel 이 그 결과를 보여주는 구조다.
// ─────────────────────────────────────────────────────────────────────────────
import type { ComponentType, ReactNode } from 'react'
import { createAgentRegistry } from './agents/registry'
import type { AgentDef } from './agents/types'

export interface CopilotModeBodyCtx {
  /** 사용자가 입력한 텍스트. */
  text: string
  /** 이 (대화×모드) 세션의 첫 전송인가 — 시스템 프롬프트·트랜스크립트는 이때만 붙인다. */
  first: boolean
  /** 모드를 바꿔 들어온 대화의 이전 기록 (first 일 때만 의미가 있다). 없으면 ''. */
  transcriptSeed: string
  /** 메시지가 @멘션/드롭으로 참조한 파일의 첨부 블록. 없으면 ''. */
  fileAttach: string
}

export interface CopilotSidePanelProps {
  convId: string | null
  /** 어시스턴트가 턴을 끝낼 때마다 증가 — 패널이 그 시점에 다시 읽도록. */
  turnCount: number
  isThinking: boolean
}

/**
 * 채팅 좌석. 공통 core(AgentDef)에 **UI 블록**을 더한 것 — id / agentId / buildBody 는
 * 워크플로 좌석과 같은 정의를 쓴다 (src/lib/agents/types.ts).
 * 이 좌석만 React 를 안다: 모드 칩과 SidePanel 이 화면 요소이기 때문이다.
 */
export interface ProductCopilotMode extends AgentDef<CopilotModeBodyCtx> {
  /** 모드 칩 라벨 · 툴팁 · 칩 옆 한 줄 설명 · 입력창 placeholder. */
  label: string
  icon?: ReactNode
  title: string
  hint: string
  placeholder: string
  /** 오른쪽 패널. 없으면 채팅만. */
  SidePanel?: ComponentType<CopilotSidePanelProps>
}

// 워크플로 좌석과 같은 레지스트리 구현을 쓴다.
// 조회는 여기선 **부분(partial)** 이다 — 내장 모드(wf/simple/content)는 등록되지 않고
// useCopilotChat 안의 분기로 구현돼 있어서, undefined 가 "등록 모드가 아니다" 라는 뜻으로
// 쓰인다. 워크플로 좌석이 총(total)인 것과 다른 점.
const registry = createAgentRegistry<ProductCopilotMode>()

export function registerCopilotMode(mode: ProductCopilotMode): void {
  registry.register(mode)
}

export function getProductCopilotMode(id: string | null | undefined): ProductCopilotMode | undefined {
  return registry.get(id)
}
