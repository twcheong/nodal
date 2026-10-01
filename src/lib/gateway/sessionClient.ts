// 세션 RPC·메시지 프레임용 얇은 헬퍼. **언제** 부를지는 전적으로 호출자(훅) 결정이다 —
// 핸드셰이크 직후 / 첫 send lazy / 명시 호출이 훅마다 다르고, 그 차이는 보존 대상.

import type { ControlUiTransport } from './controlUiTransport'

/** sessions.create + 그 세션의 메시지 구독. params 는 `{ agentId }` 또는 `{}`(게이트웨이 기본 에이전트). */
export async function createSession(
  transport: Pick<ControlUiTransport, 'rpc'>,
  params: Record<string, unknown>,
): Promise<string> {
  const sess = await transport.rpc('sessions.create', params)
  if (!sess.ok || !sess.payload?.key) throw new Error('Session create failed')
  const key = sess.payload.key as string
  await transport.rpc('sessions.messages.subscribe', { key })
  return key
}

/**
 * 이 훅이 만든 게이트웨이 세션을 반납한다 — 언마운트 정리용, best-effort.
 *
 * 게이트웨이는 소켓이 닫혀도 그 연결이 만든 세션을 회수하지 않는다 (close 핸들러는 구독 해제·presence 뿐).
 * 반납하지 않으면 로그아웃·앱 종료마다 세션이 쌓인다.
 *
 * **반드시 dispose() 전에** 부를 것 — 닫힌 소켓으로는 요청이 나가지 않는다. 응답은 기다리지 않는다
 * (직후 dispose 가 pending RPC 를 reject 한다). 세션에는 LLM 대화 기억이 붙어 있으므로 재연결 경로가
 * 아니라 언마운트에서만 부른다.
 */
export function releaseSessions(
  transport: Pick<ControlUiTransport, 'rpc' | 'isConnected'>,
  keys: Iterable<string>,
): void {
  if (!transport.isConnected()) return
  for (const key of keys) {
    void transport.rpc('sessions.delete', { key }).catch(() => { /* best-effort */ })
  }
}

// OpenClaw 의 content 는 string 이거나 ContentBlock[] (텍스트+툴호출 섞임).
// 텍스트 블록만 이어붙이고 내부 태그(예: [[internal]])를 걷어낸다.
export function extractText(content: unknown): string {
  let raw = ''
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    raw = content
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  return raw.replace(/\[\[[\w_]+\]\]\s*/g, '').trim()
}
