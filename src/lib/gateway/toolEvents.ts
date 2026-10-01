// ─────────────────────────────────────────────────────────────────────────────
// toolEvents — 게이트웨이의 툴 활동 프레임 해석 + 동시 호출 추적.
//
// 어디서 오는가: `agent` 이벤트의 `stream: 'tool'`. **`session.tool` 이 아니다.**
//   · `session.tool` 은 전역 `sessions.subscribe` 를 한 연결에만 간다. 그걸 부르는 건
//     useOpenClaw 뿐이라, 나머지 훅의 session.tool 처리는 프레임이 온 적 없는 죽은 코드였다.
//   · 전역 구독을 붙이면 그 소켓이 **모든 세션의** session.message 까지 받게 돼, 방금 닫은
//     라우팅 위험(키 없는 프레임 drop)이 되살아난다. 그래서 그 길은 택하지 않는다.
//   · tool 스트림 `agent` 프레임은 connect 에서 `caps: ['tool-events']` 를 선언한 연결에만
//     간다 (게이트웨이가 runId 별 수신자로 등록한다). 등록 범위는 그 연결이 보낸 run 과
//     같은 sessionKey 의 활성 run 뿐이라, 남의 세션이 새지 않는다.
//
// 페이로드 (번들 확인 + 패키지 앱 실측):
//   frame.payload = { stream:'tool', runId, seq, sessionKey, data }
//   data.phase 'start'  → { phase, name, toolCallId, args }
//   data.phase 'update' → { phase, name, toolCallId }            (partialResult 는 게이트웨이가 제거)
//   data.phase 'result' → { phase, name, toolCallId, meta, isError }  (result 는 제거)
// 이름 필드는 **`name`** 이다 (`tool_name` 이 아니다 — session.tool 쪽과 다르다).
// 종료 phase 는 **`result`** 다 (`end`/`complete` 가 아니다).
// ─────────────────────────────────────────────────────────────────────────────

/** connect 에서 선언해야 tool 스트림이 온다. */
export const TOOL_EVENTS_CAP = 'tool-events'

export type ToolPhase = 'start' | 'update' | 'result'

export interface ToolEvent {
  /** 어느 세션의 툴인가. 없으면 라우팅할 수 없으므로 파서가 버린다. */
  sessionKey: string
  /** 한 툴 호출의 식별자 — start/update/result 를 잇는 열쇠. 이름으로 묶으면 병렬 호출이 뭉개진다. */
  toolCallId: string
  name:       string
  phase:      ToolPhase
  /** result phase 에만 실린다. 실패한 툴 호출 여부. */
  isError?:   boolean
}

/** `agent` 프레임에서 툴 이벤트를 꺼낸다. 툴 스트림이 아니거나 모양이 안 맞으면 null. */
export function parseAgentToolFrame(frame: {
  event?: string
  payload?: Record<string, unknown>
}): ToolEvent | null {
  if (frame.event !== 'agent') return null
  const payload = frame.payload
  if (!payload || payload.stream !== 'tool') return null
  const data = payload.data as Record<string, unknown> | undefined
  if (!data) return null

  const phase = data.phase as string | undefined
  if (phase !== 'start' && phase !== 'update' && phase !== 'result') return null

  const name = typeof data.name === 'string' ? data.name : ''
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
  // sessionKey 는 프레임 top-level 에 실린다 (게이트웨이가 붙인다).
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : ''
  if (!name || !toolCallId || !sessionKey) return null

  return {
    sessionKey, toolCallId, name, phase,
    ...(phase === 'result' && typeof data.isError === 'boolean' ? { isError: data.isError } : {}),
  }
}

/**
 * 라우팅 키(세션/대화)별로 **진행 중인 툴 호출**을 추적한다.
 *
 * 왜 집합이 필요한가: 한 턴에 툴이 여럿 동시에 돌 수 있다. 이름만 보고 "시작=표시,
 * 끝=지움" 하면 병렬 호출 중 하나가 끝나는 순간 나머지가 도는데도 칩이 사라진다.
 * toolCallId 로 세고, 전부 끝났을 때만 비운다.
 */
export class ToolCallTracker {
  /** key → (toolCallId → tool name). Map 이라 삽입 순서가 유지된다 = 가장 최근 것을 고를 수 있다. */
  private byKey = new Map<string, Map<string, string>>()

  /**
   * 이벤트를 반영하고, 그 키가 지금 보여줘야 할 툴 이름을 돌려준다 (없으면 null).
   * `started` 는 이 이벤트로 **새 호출이 시작됐는지** — 호출 단위 집계(toolCalls)에 쓴다.
   */
  apply(evt: ToolEvent): { current: string | null; started: boolean } {
    let calls = this.byKey.get(evt.sessionKey)
    let started = false
    if (evt.phase === 'result') {
      calls?.delete(evt.toolCallId)
      if (calls && calls.size === 0) this.byKey.delete(evt.sessionKey)
    } else {
      if (!calls) { calls = new Map(); this.byKey.set(evt.sessionKey, calls) }
      started = !calls.has(evt.toolCallId)
      calls.set(evt.toolCallId, evt.name)
    }
    return { current: this.current(evt.sessionKey), started }
  }

  /** 지금 표시할 툴 이름 — 가장 최근에 시작된 미완료 호출. 없으면 null. */
  current(key: string): string | null {
    const calls = this.byKey.get(key)
    if (!calls || calls.size === 0) return null
    let last: string | null = null
    for (const name of calls.values()) last = name
    return last
  }

  /** 그 키의 진행 중 호출을 전부 잊는다 (턴 종료·세션 정리·연결 끊김). */
  clear(key: string): void {
    this.byKey.delete(key)
  }

  clearAll(): void {
    this.byKey.clear()
  }
}
