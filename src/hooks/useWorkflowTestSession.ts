// ─────────────────────────────────────────────────────────────────────────────
// useWorkflowTestSession — 워크플로 Test 실행 전용 게이트웨이 세션 (메인 채팅 격리).
//
// 왜 별도 hook 인가:
//   기존엔 useOpenClaw 의 main session 을 Test 가 공유했음. 결과:
//     1) Test LLM 메시지가 chat 탭 messages 에 섞임 (혼란)
//     2) chat 탭에서 New Chat 누르면 clearChat → sessions.abort → 진행 중 Test
//        의 awaiter 도 같이 reject 되어 노드 'failed' 마킹
//     3) chat 탭 메시지가 워크플로 LLM context 오염
//   useWorkflowClaw 가 빌더 채팅에 적용한 격리 패턴을 Test 에도 그대로 적용.
//
// 병렬 실행 (여러 워크플로 동시 Test):
//   - 세션은 workflowId 별 1개 (Map<workflowId, sessionKey>) — 원래부터.
//   - awaiter / 마지막 assistant 본문 / messages / toolActivity 전부
//     **sessionKey 별로** 라우팅한다. 예전엔 "활성 세션" 이벤트만 처리하고
//     나머지를 드롭했는데, 그러면 백그라운드 워크플로의 chat.final 이 버려져
//     그 run 의 노드가 영영 완료되지 않았다.
//   - sendAndAwaitFinal 은 이제 workflowId 를 명시적으로 받는다 — 사용자가
//     화면에서 다른 워크플로로 갈아타도 진행 중인 run 은 자기 세션으로 계속.
//   - React state (messages / isThinking / toolActivity / contextUsage) 는
//     "화면에 보이는(활성) 워크플로" 의 버퍼를 미러링한 것. 갈아타면 그
//     워크플로의 버퍼로 교체된다.
//
// 세션 lifecycle (사용자 결정):
//   - 같은 워크플로 여러 번 Test → 같은 sessionKey 재사용 → LLM 이 이전 run
//     기억 (디버깅 / iteration 에 유용)
//   - 앱 재시작 시 게이트웨이 메모리 소멸 — 자연스럽게 세션도 사라짐
//   - resetSession() 호출 시 sessions.reset RPC 로 context 초기화 + 토큰 카운터 0
//
// Context usage:
//   - 각 sessionKey 별 토큰 누적 추적 → ContextChip 이 진행 바로 표시
//   - chat.final 후 sessions.usage RPC 로 현재 세션 토큰 합산 fetch
//   - 주의: usage 는 사용자 전역 합산이라, 두 워크플로가 동시에 돌면 turn delta
//     에 상대 run 의 토큰이 섞여 과대측정될 수 있음 (UI 힌트 용도라 허용).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { getContextWindow } from '../lib/modelPricing'
import type { ControlUiTransport, GatewayEventFrame, RpcFrame } from '../lib/gateway/controlUiTransport'
import { createRendererTransport, isElectron } from '../lib/gateway/rendererTransport'
import { extractText, releaseSessions } from '../lib/gateway/sessionClient'
import { parseAgentToolFrame, ToolCallTracker, TOOL_EVENTS_CAP } from '../lib/gateway/toolEvents'

// 워크플로당 in-memory 메시지 버퍼 상한 — 긴 run 이 메모리를 무한정 먹지 않게.
const MAX_MESSAGES_PER_SESSION = 300

export interface TestSessionMessage {
  id:        string
  role:      'user' | 'assistant' | 'system'
  content:   string
  timestamp: Date
}

export interface ToolActivity {
  name:           string
  detail?:        string
  isSubagent:     boolean
  subagentLabel?: string
}

export interface ContextUsage {
  usedTokens:   number
  windowTokens: number
  pct:          number   // 0..1
  modelId?:     string
}

interface TurnAwaiter {
  resolve:    (r: { text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }) => void
  reject:     (err: Error) => void
  startedAt:  number
  toolCalls:  Array<{ name: string; detail?: string }>
}

export interface WorkflowTestSession {
  status:           'connecting' | 'ready' | 'error'
  messages:         TestSessionMessage[]
  isThinking:       boolean
  toolActivity:     ToolActivity | null
  contextUsage:     ContextUsage | null
  /** 지정한 워크플로의 세션으로 보내고 그 세션의 chat.final 까지 대기.
   *  화면의 활성 워크플로와 무관 — 병렬 run 이 자기 세션을 계속 쓴다. */
  sendAndAwaitFinal: (workflowId: string, text: string, opts?: { timeoutMs?: number; displayText?: string }) =>
    Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
  /** 지정한 워크플로의 진행 중 turn 중단 (해당 세션 abort + awaiter reject). */
  cancelTurn:       (workflowId: string) => Promise<void>
  /** 워크플로 run 의 브라우저 슬롯(wf-1..3) 등록/해제 — 세션 확보 후 main 에
   *  sessionKey→profile 매핑을 전달하면 openclaw 훅 패치가 그 세션의 모든
   *  browser 툴 호출에 profile 을 강제한다. profile=null 이면 해제. */
  assignBrowserProfile: (workflowId: string, profile: string | null) => Promise<void>
  /** 특정 워크플로 세션 하나만의 누적 usage — 병렬 run 의 노드별 비용 오염 방지. */
  fetchSessionUsage: (workflowId: string) => Promise<{ usd?: number; tokensIn?: number; tokensOut?: number } | null>
  resetSession:     () => Promise<void>
  /** 스코프 접두사(예: `${convId}::`)로 시작하는 모든 러너 세션을 게이트웨이
   *  에서 삭제하고 내부 맵을 비운다. 탭(대화)을 닫을 때 그 탭의 러너 기억을
   *  완전히 없애는 용도 — 같은 워크플로를 다른 탭에서 열어도 기억이 안 샌다. */
  destroyScope:     (scopePrefix: string) => Promise<void>
}

export function useWorkflowTestSession(activeWorkflowId: string | null): WorkflowTestSession {
  const [status,         setStatus]         = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [messages,       setMessages]       = useState<TestSessionMessage[]>([])
  const [isThinking,     setIsThinking]     = useState(false)
  const [toolActivity,   setToolActivity]   = useState<ToolActivity | null>(null)
  const [contextUsage,   setContextUsage]   = useState<ContextUsage | null>(null)

  // WS + RPC infra — 핸드셰이크·RPC 는 transport 가 맡는다 (훅 인스턴스당 하나, lazy 생성).
  const transportRef  = useRef<ControlUiTransport | null>(null)
  // 현재 활성 workflowId — closure-staleness 방지용 ref.
  const activeWorkflowIdRef = useRef<string | null>(activeWorkflowId)
  // workflowId → gateway sessionKey (살아 있는 세션들).
  const sessionKeys   = useRef<Map<string, string>>(new Map())
  // workflowId → 진행 중인 sessions.create promise. ensureSessionForWorkflow 가
  // 동시에 두 곳(활성 전환 effect + run 시작 경로)에서 불리면 각자 세션을 만들어
  // 중복 세션이 생긴다 — 그러면 슬롯 강제(browser profile)가 A 세션에, 실제
  // run 이 B 세션에 붙어 "프리뷰가 보는 Chrome ≠ run 이 모는 Chrome" 이 되고
  // live activity 미러도 빈 세션을 본다. 생성을 workflowId 별로 직렬화한다.
  const sessionCreateLocks = useRef<Map<string, Promise<string>>>(new Map())
  // sessionKey → workflowId 역참조 — WS 이벤트 라우팅용.
  const keyToWorkflowId = useRef<Map<string, string>>(new Map())
  // workflowId → 직전 turn 시작 직전의 user-wide totals 스냅샷 (context delta 용).
  const sessionPreTurnTotals = useRef<Map<string, { input: number; cacheRead: number; output: number }>>(new Map())
  // workflowId → 마지막으로 계산된 contextUsage 캐시.
  const contextUsageCache = useRef<Map<string, ContextUsage>>(new Map())
  // 현재 활성(화면 표시 중) sessionKey.
  const activeKeyRef  = useRef<string | null>(null)
  // ── per-sessionKey 상태 (병렬 run 의 심장) ────────────────────────────────
  // sessionKey → 그 세션의 진행 중 awaiter 큐 (노드 실행은 세션당 1개씩 순차라
  // 보통 길이 0..1이지만, note 주입 같은 케이스를 위해 큐로 유지).
  const awaitersByKey = useRef<Map<string, TurnAwaiter[]>>(new Map())
  // sessionKey → 마지막 assistant 본문/ID (chat.final 의 resolve 값).
  const lastAssistantByKey = useRef<Map<string, { text: string; id: string | null }>>(new Map())
  // sessionKey → 메시지 버퍼 (활성 워크플로 갈아탈 때 화면 복원용).
  const messagesByKey = useRef<Map<string, TestSessionMessage[]>>(new Map())
  // sessionKey → 현재 tool activity.
  const toolActivityByKey = useRef<Map<string, ToolActivity | null>>(new Map())
  // 지금 LLM turn 이 돌고 있는 sessionKey 집합 (활성 워크플로의 isThinking 표시).
  const busyKeys = useRef<Set<string>>(new Set())
  // sessions.usage 응답에서 가장 자주 본 모델 id — contextWindow 조회용.
  const lastSeenModelRef = useRef<string | undefined>(undefined)
  // 진행 중인 툴 호출 — toolCallId 로 세어 병렬 호출이 서로를 지우지 않게.
  const toolTracker = useRef(new ToolCallTracker())

  // transport 가 아직 없으면(=연결 전) 예전과 똑같이 'WS not open' 으로 거절한다.
  const rpc = useCallback((method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcFrame> => {
    const t = transportRef.current
    return t ? t.rpc(method, params, timeoutMs) : Promise.reject(new Error('WS not open'))
  }, [])

  // 버퍼에 메시지 추가 + 활성 세션이면 화면에도 반영.
  const pushMessage = useCallback((key: string, msg: TestSessionMessage) => {
    const buf = messagesByKey.current.get(key) ?? []
    buf.push(msg)
    if (buf.length > MAX_MESSAGES_PER_SESSION) buf.splice(0, buf.length - MAX_MESSAGES_PER_SESSION)
    messagesByKey.current.set(key, buf)
    if (key === activeKeyRef.current) setMessages([...buf])
  }, [])

  // 게이트웨이 전역 totals 를 한 번 fetch — 컬럼별 (input/cacheRead/output) 분해.
  const fetchUserTotalTokens = useCallback(async (): Promise<{ input: number; cacheRead: number; output: number; dominantModel?: string }> => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await rpc('sessions.usage', { startDate: today, endDate: today, limit: 9999 }, 10_000)
    if (!res.ok) throw new Error('sessions.usage failed')
    const byModel = (res.payload as { aggregates?: { byModel?: Array<{ provider?: string; model?: string; totals?: Record<string, number> }> } } | null)
      ?.aggregates?.byModel ?? []
    let input = 0, cacheRead = 0, output = 0
    let dominantModel: string | undefined
    let dominantCount = 0
    for (const e of byModel) {
      const t = e.totals ?? {}
      const tIn = (t.input     as number) || 0
      const tCa = (t.cacheRead as number) || 0
      const tOu = (t.output    as number) || 0
      input += tIn; cacheRead += tCa; output += tOu
      const tok = tIn + tCa + tOu
      if (tok > dominantCount) {
        dominantCount = tok
        dominantModel = e.model ?? e.provider
      }
    }
    return { input, cacheRead, output, dominantModel }
  }, [rpc])

  // 특정 워크플로 세션 **하나만의** 누적 usage — sessions.usage 에 key 를 주면
  // 그 세션 transcript 만 집계한다. 병렬 run 이 돌아도 자기 세션 델타만 보므로
  // 노드별 비용/토큰 귀속이 오염되지 않는다 (전역 usage.cost 를 쓸 때의 한계 해소).
  const fetchSessionUsage = useCallback(async (
    workflowId: string,
  ): Promise<{ usd?: number; tokensIn?: number; tokensOut?: number } | null> => {
    const key = sessionKeys.current.get(workflowId)
    if (!key) return null                              // 세션 미확보 — 델타 계산 스킵
    const today = new Date().toISOString().slice(0, 10)
    const res = await rpc('sessions.usage', { key, startDate: today, endDate: today, limit: 1 }, 10_000)
    if (!res.ok) return null
    const totals = (res.payload as { totals?: Record<string, number> } | null)?.totals
    if (!totals) return null
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    return {
      usd:       num(totals.totalCost),
      tokensIn:  num(totals.input) + num(totals.cacheRead),
      tokensOut: num(totals.output),
    }
  }, [rpc])

  // chat.final 이후 호출 — 직전 turn 의 pre-totals 스냅샷과 비교해 그 turn 의
  // input + cacheRead + output 합을 contextSize 로 표시.
  const refreshContextUsage = useCallback(async (workflowId: string) => {
    try {
      const cur = await fetchUserTotalTokens()
      if (cur.dominantModel) lastSeenModelRef.current = cur.dominantModel
      const pre = sessionPreTurnTotals.current.get(workflowId)
      const modelId = lastSeenModelRef.current
      const win = getContextWindow(modelId)
      if (!pre) {
        const usage: ContextUsage = { usedTokens: 0, windowTokens: win, pct: 0, modelId }
        contextUsageCache.current.set(workflowId, usage)
        if (workflowId === activeWorkflowIdRef.current) setContextUsage(usage)
        return
      }
      const dIn = Math.max(0, cur.input     - pre.input)
      const dCa = Math.max(0, cur.cacheRead - pre.cacheRead)
      const dOu = Math.max(0, cur.output    - pre.output)
      const used = dIn + dCa + dOu
      const usage: ContextUsage = {
        usedTokens:   used,
        windowTokens: win,
        pct:          win > 0 ? Math.min(1, used / win) : 0,
        modelId,
      }
      contextUsageCache.current.set(workflowId, usage)
      if (workflowId === activeWorkflowIdRef.current) setContextUsage(usage)
    } catch { /* non-fatal */ }
  }, [fetchUserTotalTokens])

  // turn 시작 직전 호출 — user-wide totals 를 스냅샷.
  const snapshotPreTurn = useCallback(async (workflowId: string) => {
    try {
      const cur = await fetchUserTotalTokens()
      sessionPreTurnTotals.current.set(workflowId, {
        input: cur.input, cacheRead: cur.cacheRead, output: cur.output,
      })
    } catch { /* non-fatal — 다음 chat.final 의 delta 가 부정확할 뿐 앱은 정상 */ }
  }, [fetchUserTotalTokens])

  // 활성 세션의 화면 상태(isThinking/toolActivity)를 버퍼에서 다시 미러링.
  const mirrorActiveUiState = useCallback(() => {
    const key = activeKeyRef.current
    if (!key) {
      setIsThinking(false)
      setToolActivity(null)
      return
    }
    setIsThinking(busyKeys.current.has(key))
    setToolActivity(toolActivityByKey.current.get(key) ?? null)
  }, [])

  // 연결이 사라졌을 때의 정리 — transport onClose 와 언마운트가 같이 쓴다.
  // 게이트웨이 세션은 연결에 묶여 있으므로 장부를 전부 비운다.
  const handleClose = useCallback(() => {
    sessionKeys.current.clear()
    keyToWorkflowId.current.clear()
    activeKeyRef.current = null
    // 살아 있던 모든 세션의 awaiter 를 깨움 — 연결 끊김 = 응답 못 받음.
    for (const [, queue] of awaitersByKey.current) {
      for (const a of queue) { try { a.reject(new Error('ws_closed')) } catch { /* noop */ } }
    }
    awaitersByKey.current.clear()
    busyKeys.current.clear()
    toolTracker.current.clearAll()
    toolActivityByKey.current.clear()
    setStatus('error')
    setIsThinking(false)
    setToolActivity(null)
  }, [])

  // 완료 판정·라우팅은 전부 여기서 — transport 는 raw 프레임만 넘긴다.
  const handleEvent = useCallback((frame: GatewayEventFrame) => {
    // chat.start / chat.final / chat.error — sessionKey 로 라우팅.
    // 우리가 구독한 세션(keyToWorkflowId 에 있는 키)의 이벤트만 처리.
    // 예전처럼 활성 세션만 처리하면 백그라운드 run 의 final 이 버려짐.
    // 반대로 key 없는 프레임을 활성 세션으로 폴백하지도 않는다 — chat 은 모든 소켓으로
    // 브로드캐스트되므로(번들 확인) 폴백은 남의 턴으로 내 노드를 끝내는 쪽으로 틀린다.
    if (frame.event === 'chat') {
      const state = frame.payload?.state as string | undefined
      const evtKey = (frame.payload?.sessionKey ?? frame.payload?.key) as string | undefined
      if (!evtKey || !keyToWorkflowId.current.has(evtKey)) return
      const isActive = evtKey === activeKeyRef.current
      if (state === 'start') {
        busyKeys.current.add(evtKey)
        if (isActive) setIsThinking(true)
      } else if (state === 'final') {
        const queue = awaitersByKey.current.get(evtKey)
        const a = queue?.shift()
        if (a) {
          const last = lastAssistantByKey.current.get(evtKey)
          a.resolve({
            text:      last?.text ?? '',
            messageId: last?.id ?? null,
            toolCalls: a.toolCalls,
          })
        }
        busyKeys.current.delete(evtKey)
        toolTracker.current.clear(evtKey)
        toolActivityByKey.current.set(evtKey, null)
        if (isActive) { setIsThinking(false); setToolActivity(null) }
        const wfId = keyToWorkflowId.current.get(evtKey)
        if (wfId) void refreshContextUsage(wfId)
      } else if (state === 'error') {
        const queue = awaitersByKey.current.get(evtKey)
        const a = queue?.shift()
        if (a) {
          const msg = (frame.payload?.error as { message?: string })?.message ?? 'chat_error'
          a.reject(new Error(msg))
        }
        busyKeys.current.delete(evtKey)
        toolTracker.current.clear(evtKey)
        toolActivityByKey.current.set(evtKey, null)
        if (isActive) { setIsThinking(false); setToolActivity(null) }
      }
      return
    }

    // 툴 활동 — `agent` 의 tool 스트림에서 온다 (session.tool 이 아니다, toolEvents.ts 참고).
    const tool = parseAgentToolFrame(frame)
    if (tool) {
      // 우리가 만든 세션의 것만. (cap 은 우리가 보낸 run 에만 걸리지만 방어적으로 확인한다.)
      if (!keyToWorkflowId.current.has(tool.sessionKey)) return
      const { current, started } = toolTracker.current.apply(tool)
      const act: ToolActivity | null = current ? { name: current, isSubagent: false } : null
      toolActivityByKey.current.set(tool.sessionKey, act)
      if (tool.sessionKey === activeKeyRef.current) setToolActivity(act)
      // 호출 단위로 한 번만 센다 — update 프레임마다 밀어넣으면 같은 호출이 여러 번 잡힌다.
      if (started) awaitersByKey.current.get(tool.sessionKey)?.[0]?.toolCalls.push({ name: tool.name })
      return
    }

    // session.message — assistant 본문을 그 세션의 버퍼 + last ref 에.
    if (frame.event === 'session.message') {
      const evtKey = frame.payload?.sessionKey as string | undefined
      if (!evtKey || !keyToWorkflowId.current.has(evtKey)) return
      const msg = frame.payload?.message as Record<string, unknown> | undefined
      if (msg?.role === 'assistant') {
        const text = extractText(msg.content)
        if (text) {
          const id = crypto.randomUUID()
          lastAssistantByKey.current.set(evtKey, { text, id: (msg.id as string) ?? id })
          pushMessage(evtKey, { id, role: 'assistant', content: text, timestamp: new Date() })
        }
      }
    }
  }, [refreshContextUsage, pushMessage])

  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    // tool-events: Live activity 에 실행 중인 툴을 그린다 → tool 스트림 agent 프레임이 필요하다.
    const t = createRendererTransport('Twixy Workflow Test', 'Workflow test WS error', { caps: [TOOL_EVENTS_CAP] })
    t.onClose(handleClose)
    t.onEvent(handleEvent)
    transportRef.current = t
    return t
  }, [handleClose, handleEvent])

  // WS 연결 + 핸드셰이크. 세션은 sendAndAwaitFinal 시점에 lazy 생성.
  const ensureConnected = useCallback(async () => {
    const t = getTransport()
    if (t.isConnected()) return
    try {
      await t.ensureConnected()
      setStatus('ready')
    } catch (err) {
      // 이미 교체된(언마운트로 dispose 된) transport 의 실패는 현재 상태를 덮지 않는다.
      if (transportRef.current === t) setStatus('error')
      throw err
    }
  }, [getTransport])

  // workflowId 에 대응하는 sessionKey 보장. 없으면 sessions.create.
  // NOTE: 활성 키 전환은 여기서 하지 않는다 — 백그라운드 run 이 자기 세션을
  // ensure 할 때 화면(활성 워크플로)을 뺏으면 안 되기 때문. 활성 전환은
  // activeWorkflowId effect 가 담당.
  const ensureSessionForWorkflow = useCallback(async (workflowId: string): Promise<string> => {
    await ensureConnected()
    const existing = sessionKeys.current.get(workflowId)
    if (existing) return existing
    // 동시 호출 직렬화 — 활성 전환 effect 와 run 시작 경로가 같은 틱에 이 함수를
    // 부르면(Copilot 의 "매칭 즉시 실행" 흐름) 락 없이는 세션이 2개 생긴다.
    let lock = sessionCreateLocks.current.get(workflowId)
    if (!lock) {
      lock = (async () => {
        // agentId 'workflow-runner' — full tools EXCEPT sub-agent spawning
        // (openclaw.json agents.list, written by ensureWorkspace). A node's
        // completion is judged by sendAndAwaitFinal returning; a spawned child
        // session would outlive the turn and the runner would advance to the
        // next node while its work is still running. Denying spawn tools makes
        // the LLM do the work inline, so "turn done" === "node work done".
        const res = await rpc('sessions.create', { agentId: 'workflow-runner' })
        if (!res.ok || !res.payload?.key) throw new Error('sessions.create failed')
        const key = res.payload.key as string
        sessionKeys.current.set(workflowId, key)
        keyToWorkflowId.current.set(key, workflowId)
        await rpc('sessions.messages.subscribe', { key })
        // 이 워크플로가 지금 화면에 떠 있는(활성) 워크플로면 새 세션 키를 활성
        // 키로 바인딩한다. activeWorkflowId effect 는 peek-only 라 세션이 없을 때
        // activeKeyRef=null 로 두는데, run 이 그 세션을 여기서 만들면 이 바인딩
        // 없이는 도착 메시지/toolActivity 가 UI(Live activity)에 미러되지 않는다.
        // 백그라운드 run(활성 아님)은 activeKeyRef 를 뺏지 않는다 (화면 유지).
        if (workflowId === activeWorkflowIdRef.current) {
          activeKeyRef.current = key
          setMessages([...(messagesByKey.current.get(key) ?? [])])
          setContextUsage(contextUsageCache.current.get(workflowId) ?? null)
          mirrorActiveUiState()
        }
        return key
      })()
      sessionCreateLocks.current.set(workflowId, lock)
      // 성공/실패 무관하게 락 해제 — 실패 시 다음 호출이 재시도.
      void lock.catch(() => { /* propagate to awaiters below */ }).finally(() => {
        sessionCreateLocks.current.delete(workflowId)
      })
    }
    return lock
  }, [ensureConnected, rpc, mirrorActiveUiState])

  const sendAndAwaitFinal = useCallback(async (
    workflowId: string, text: string, opts?: { timeoutMs?: number; displayText?: string },
  ): Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }> => {
    if (!isElectron) throw new Error('not_electron')
    if (!workflowId) throw new Error('no workflow id')
    const sid = await ensureSessionForWorkflow(workflowId)
    // Turn 직전 user-wide totals 스냅샷 — chat.final 후 delta 계산용.
    await snapshotPreTurn(workflowId)

    const queue = awaitersByKey.current.get(sid) ?? []
    awaitersByKey.current.set(sid, queue)

    let awaiter!: TurnAwaiter
    const awaiterPromise = new Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>((resolve, reject) => {
      const a: TurnAwaiter = {
        resolve, reject, startedAt: Date.now(), toolCalls: [],
      }
      awaiter = a
      queue.push(a)
      // 안전 타임아웃 — chat.final 안 오면 reject.
      const t = setTimeout(() => {
        const i = queue.indexOf(a)
        if (i >= 0) {
          queue.splice(i, 1)
          reject(new Error('turn_timeout'))
        }
      }, opts?.timeoutMs ?? 10 * 60 * 1000)
      // resolve/reject wrap 으로 timer 해제.
      const oR = a.resolve, oRj = a.reject
      a.resolve = (r) => { clearTimeout(t); oR(r) }
      a.reject  = (e) => { clearTimeout(t); oRj(e) }
    })
    // send RPC 가 실패하면 아래에서 throw 로 끝나 이 promise 는 호출자에게 가지 못한다 —
    // 그때의 거절이 unhandled rejection 으로 새지 않게. (정상 경로의 호출자는 같은 promise 를 받아 그대로 본다.)
    awaiterPromise.catch(() => { /* 호출자는 throw 된 에러를 받는다 */ })

    // 보내는 메시지도 그 세션의 버퍼에 추가 (활성이면 화면 표시).
    // displayText 가 있으면 그걸 표시 — 내부 노드 지시문(prompt)이 UI 로 새는 걸 막는다.
    pushMessage(sid, { id: crypto.randomUUID(), role: 'user', content: opts?.displayText ?? text, timestamp: new Date() })
    busyKeys.current.add(sid)
    if (sid === activeKeyRef.current) setIsThinking(true)
    try {
      await rpc('sessions.send', { key: sid, message: text }, opts?.timeoutMs ?? 10 * 60 * 1000)
    } catch (err) {
      // RPC 실패 → 방금 push 한 **그** awaiter 만 제거 + reject (timeout 경로와 같은 identity 기준).
      // 예전 pop() 은 같은 세션에 다른 turn 이 대기 중이면 — 또는 이 awaiter 가 turn timeout 으로
      // 이미 빠졌으면 — 남의 awaiter 를 버려 멀쩡한 노드를 실패시켰다.
      const i = queue.indexOf(awaiter)
      if (i >= 0) queue.splice(i, 1)
      // 같은 세션에 아직 도는 turn 이 있으면 busy/thinking 은 그대로 둔다.
      if (queue.length === 0) {
        busyKeys.current.delete(sid)
        if (sid === activeKeyRef.current) setIsThinking(false)
      }
      awaiter.reject(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
    return awaiterPromise
  }, [ensureSessionForWorkflow, snapshotPreTurn, rpc, pushMessage])

  // 워크플로 run 의 브라우저 슬롯 등록/해제. 세션이 아직 없으면 만들어서라도
  // sessionKey 를 확보 — 매핑은 첫 browser 툴 호출 전에 파일에 있어야 한다.
  const assignBrowserProfile = useCallback(async (workflowId: string, profile: string | null) => {
    try {
      const key = profile
        ? await ensureSessionForWorkflow(workflowId)          // lease: 세션 보장
        : sessionKeys.current.get(workflowId)                 // release: 있으면만
      if (!key) return
      await window.twixy?.browserSlotSet?.({ sessionKey: key, profile })
    } catch (e) {
      // non-fatal — 매핑 실패 시 그 run 은 default 프로필로 돌 뿐 (간섭 가능성만).
      console.warn('[workflowTestSession] browser slot assign failed:', e)
    }
  }, [ensureSessionForWorkflow])

  // 지정 워크플로의 진행 중 turn 즉시 중단 — 그 세션만 abort + awaiter reject.
  // 다른 워크플로의 병렬 run 은 건드리지 않는다.
  const cancelTurn = useCallback(async (workflowId: string) => {
    const sid = sessionKeys.current.get(workflowId)
    if (!sid) return
    try { await rpc('sessions.abort', { key: sid }) } catch { /* non-fatal */ }
    const queue = awaitersByKey.current.get(sid) ?? []
    awaitersByKey.current.set(sid, [])
    for (const a of queue) {
      try { a.reject(new Error('cancelled')) } catch { /* noop */ }
    }
    busyKeys.current.delete(sid)
    toolActivityByKey.current.set(sid, null)
    if (sid === activeKeyRef.current) { setIsThinking(false); setToolActivity(null) }
  }, [rpc])

  // 활성 세션의 transcript 초기화 — Cursor 의 "Reset Context" 같은 동작.
  const resetSession = useCallback(async () => {
    const sid = activeKeyRef.current
    const wfId = activeWorkflowIdRef.current
    if (!sid) return
    try {
      await rpc('sessions.reset', { key: sid, reason: 'reset' }, 10_000)
    } catch { /* non-fatal */ }
    messagesByKey.current.set(sid, [])
    lastAssistantByKey.current.delete(sid)
    setMessages([])
    if (wfId) {
      // pre-turn 스냅샷 비움 — 다음 sendAndAwaitFinal 호출이 새로 snapshot.
      sessionPreTurnTotals.current.delete(wfId)
      const win = getContextWindow(lastSeenModelRef.current)
      const zero: ContextUsage = { usedTokens: 0, windowTokens: win, pct: 0, modelId: lastSeenModelRef.current }
      contextUsageCache.current.set(wfId, zero)
      setContextUsage(zero)
    }
  }, [rpc])

  // 스코프 접두사로 시작하는 모든 러너 세션을 파괴 — 탭 닫기 훅.
  const destroyScope = useCallback(async (scopePrefix: string) => {
    if (!scopePrefix) return
    // sessionKeys 는 sendAndAwaitFinal 이 넘긴 id(=스코프)로 키잉된다.
    const ids = [...sessionKeys.current.keys()].filter(id => id.startsWith(scopePrefix))
    for (const id of ids) {
      const key = sessionKeys.current.get(id)
      sessionKeys.current.delete(id)
      sessionCreateLocks.current.delete(id)
      sessionPreTurnTotals.current.delete(id)
      contextUsageCache.current.delete(id)
      if (!key) continue
      // 이 세션의 진행 중 awaiter 를 정리 (닫는 순간 돌던 turn 이 있으면).
      const queue = awaitersByKey.current.get(key) ?? []
      awaitersByKey.current.set(key, [])
      for (const a of queue) { try { a.reject(new Error('cancelled')) } catch { /* noop */ } }
      keyToWorkflowId.current.delete(key)
      awaitersByKey.current.delete(key)
      lastAssistantByKey.current.delete(key)
      messagesByKey.current.delete(key)
      toolActivityByKey.current.delete(key)
      busyKeys.current.delete(key)
      if (key === activeKeyRef.current) {
        activeKeyRef.current = null
        setMessages([]); setIsThinking(false); setToolActivity(null); setContextUsage(null)
      }
      try { await rpc('sessions.delete', { key }) } catch { /* best-effort */ }
    }
  }, [rpc])

  // 마운트 시엔 WS 를 열지 않는다 — 첫 run 전송(sendAndAwaitFinal →
  // ensureSessionForWorkflow → ensureConnected)에서 lazy 로 연결된다. 로딩
  // 직후 아무 run 도 없는데 WS 핸드셰이크로 대기시간이 생기는 것을 없앤다.
  useEffect(() => {
    if (!isElectron) return
    // 정리 때 읽을 세션 장부. Map 은 재할당되지 않고 제자리 변경만 하므로 내용은 최신이다.
    const ledger = sessionKeys.current
    return () => {
      // 예전 ws.close() → onclose 와 같은 결과: 살아 있던 연결이면 장부를 비우고 awaiter 를
      // ws_closed 로 깨운다. transport 는 다음 send 가 새로 만든다 (StrictMode 이중 마운트 포함).
      const t = transportRef.current
      transportRef.current = null
      if (!t) return
      const wasConnected = t.isConnected()
      // 워크플로별 러너 세션을 반납 — 소켓을 닫기 전에. (handleClose 가 장부를 비우기 전이기도 하다.)
      releaseSessions(t, ledger.values())
      t.dispose()
      if (wasConnected) handleClose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 활성 워크플로 전환: 세션이 **이미 있으면** 그 버퍼로 화면 복원. 없으면
  // 만들지 않는다 — 워크플로를 열어보는 것만으로 게이트웨이 세션이 생겨
  // 로딩/전환 대기시간이 나던 걸 없앤다. 세션은 첫 run 전송에서 lazy 생성.
  useEffect(() => {
    activeWorkflowIdRef.current = activeWorkflowId
    if (!activeWorkflowId) {
      activeKeyRef.current = null
      setMessages([])
      setContextUsage(null)
      mirrorActiveUiState()
      return
    }
    // peek — sessions.create 안 함. 진행 중 run 이 있었으면 그 버퍼가 보인다.
    const key = sessionKeys.current.get(activeWorkflowId) ?? null
    activeKeyRef.current = key
    setContextUsage(contextUsageCache.current.get(activeWorkflowId) ?? null)
    setMessages(key ? [...(messagesByKey.current.get(key) ?? [])] : [])
    mirrorActiveUiState()
  }, [activeWorkflowId, mirrorActiveUiState])

  return {
    status, messages, isThinking, toolActivity, contextUsage,
    sendAndAwaitFinal, cancelTurn, assignBrowserProfile, resetSession,
    fetchSessionUsage, destroyScope,
  }
}
