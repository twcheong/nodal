// ─────────────────────────────────────────────────────────────────────────────
// parseCopilotAction.ts — Copilot 챗 LLM 응답의 ```copilot-action``` 블록 파서.
//
// Copilot 라우팅 프로토콜: LLM 이 유저 요청을 기존 워크플로에 매칭하면 액션
// 블록을 응답에 포함시킨다. 앱(CopilotView)이 이를 파싱해 UI/실행을 처리한다
// — LLM 자신은 tool-less 'builder' 에이전트라 아무것도 실행 못 함.
//
//   ```copilot-action
//   { "action": "show", "workflowId": "wf_abc" }                                ← 매칭됨, 입력값 대기
//   { "action": "run",  "workflowId": "wf_abc", "inputs": { "url": "https…" } } ← 입력값 완비, 실행
//   ```
//
// run 에서 workflowId 가 없으면 "같은 응답(또는 직전)에서 방금 만든 워크플로".
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotAction {
  action:      'run' | 'show'
  workflowId?: string
  inputs?:     Record<string, string>
}

const BLOCK_RE = /```copilot-action\s*\n([\s\S]*?)```/

export function parseCopilotAction(text: string): CopilotAction | null {
  const m = BLOCK_RE.exec(text)
  if (!m) return null
  try {
    const raw = JSON.parse(m[1]) as Record<string, unknown>
    if (raw?.action !== 'run' && raw?.action !== 'show') return null
    // inputs 값은 문자열로 정규화 — test run 의 placeholder 치환은 string 기반.
    const inputs: Record<string, string> = {}
    if (raw.inputs && typeof raw.inputs === 'object') {
      for (const [k, v] of Object.entries(raw.inputs as Record<string, unknown>)) {
        inputs[k] = typeof v === 'string' ? v : JSON.stringify(v)
      }
    }
    return {
      action:     raw.action,
      workflowId: typeof raw.workflowId === 'string' ? raw.workflowId : undefined,
      inputs,
    }
  } catch {
    return null
  }
}

// 응답 prose 에서 액션 블록 제거 — 채팅 버블에 raw JSON 을 노출하지 않는다.
export function stripCopilotActionBlock(text: string): string {
  return text.replace(BLOCK_RE, '').trim()
}
