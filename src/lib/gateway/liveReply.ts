// ─────────────────────────────────────────────────────────────────────────────
// liveReply — 턴 진행 중에 모델이 쓰는 답장·추론을 실시간으로 보여주기 위한 장부.
//
// 어디서 오는가 (openclaw 번들 확인):
//   · 답장: `chat` 이벤트 state:'delta' — payload.message.content[0].text 에 **이번 run 의
//     누적 텍스트**가 실린다 (게이트웨이가 150ms 단위로 모아 보낸다, dropIfSlow).
//     메시지가 끝나면 따로 `session.message` 가 오고, 턴이 끝나면 state:'final'.
//   · 추론: `agent` 이벤트 stream:'thinking' — data.text 가 누적 추론. 세션 reasoningLevel 이
//     'stream' 일 때만 흐른다 (useCopilotChat 이 세션을 만들 때 켠다 + openclaw 패치).
//
// 한 턴에 어시스턴트 메시지가 여럿일 수 있다 (말 → 툴 → 말). 끝난 메시지는 session.message 로
// 대화에 붙으므로, 라이브 버블에는 그 뒤에 새로 쓰이는 부분만 보여야 한다 — `committed` 가
// 그 경계다. 게이트웨이 버퍼가 새 메시지에서 처음부터 다시 쌓이면(앞부분이 안 겹치면) 통째로 보인다.
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveReply {
  /** 게이트웨이가 보낸 이번 run 의 누적 답장 텍스트. */
  full: string
  /** 이미 session.message 로 대화에 붙은 시점의 full. */
  committed: string
  /** 누적 추론 텍스트 (서식 벗긴 것). */
  thinking: string
}

export const EMPTY_LIVE: LiveReply = { full: '', committed: '', thinking: '' }

/** chat delta 프레임에서 누적 텍스트. 모양이 안 맞으면 null. */
export function deltaText(payload: Record<string, unknown> | undefined): string | null {
  const content = (payload?.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .join('')
  return text || null
}

/** 게이트웨이의 formatReasoningMessage("Reasoning:\n_줄_") 를 되돌린다. */
export function plainReasoning(text: string): string {
  return text
    .replace(/^\s*Reasoning:\s*\n?/, '')
    .split('\n')
    .map((line) => line.replace(/^_(.*)_$/, '$1'))
    .join('\n')
    .trim()
}

export const withDelta = (l: LiveReply, full: string): LiveReply => ({ ...l, full })
export const withThinking = (l: LiveReply, raw: string): LiveReply => ({ ...l, thinking: plainReasoning(raw) })
/** 메시지 하나가 대화에 붙었다 — 지금까지 쓴 것은 라이브 버블에서 뺀다. 추론도 그 메시지 몫이다. */
export const committed = (l: LiveReply): LiveReply => ({ ...l, committed: l.full, thinking: '' })

/** 라이브 버블에 보일 답장 텍스트. */
export function visibleText(l: LiveReply): string {
  if (!l.committed) return l.full
  if (l.full === l.committed) return ''
  return l.full.startsWith(l.committed) ? l.full.slice(l.committed.length).trimStart() : l.full
}
