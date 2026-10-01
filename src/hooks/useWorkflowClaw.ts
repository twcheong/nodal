// ─────────────────────────────────────────────────────────────────────────────
// useWorkflowClaw — Workflow 뷰 우측 빌더 채팅 전용 세션 훅.
//
// useDashboardClaw 패턴 기반이지만, 단발 요청-응답이 아닌 연속 대화를 유지한다.
// 메인 채팅(useOpenClaw) 과 완전히 별도의 WS 세션을 가져, 사용자의 일반 대화에
// 워크플로 빌더 컨텍스트가 섞이지 않는다.
//
// 세션의 첫 사용자 메시지에 WORKFLOW_SOUL 시스템 프롬프트가 자동으로 prepend 된다.
// 어시스턴트는 워크플로 정의를 도와주는 페르소나로 동작.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { getWorkflowSoul } from '../lib/workflowSoul'
import type { ControlUiTransport } from '../lib/gateway/controlUiTransport'
import { createRendererTransport, isElectron } from '../lib/gateway/rendererTransport'
import { createSession, extractText, releaseSessions } from '../lib/gateway/sessionClient'

export interface WorkflowChatMessage {
  id:      string
  role:    'user' | 'assistant' | 'system'
  content: string
  ts:      number
}

// workflowId 가 주어지면 그 워크플로의 builder-chat.jsonl 을 load/append/clear
// 한다 — 채팅이 앱 재시작 후에도, 다른 워크플로로 갔다 와도 살아남는다.
// 단, 게이트웨이 세션 자체는 재시작 시 새로 생기므로 LLM 은 과거 대화를 기억
// 못 한다 (persistence 는 UI scrollback 용). 사용자에게 컨텍스트가 필요하면
// 새 메시지에 직접 적거나 워크플로 snapshot 으로 충분히 전달됨.
export function useWorkflowClaw(workflowId: string | null) {
  const [messages,   setMessages]   = useState<WorkflowChatMessage[]>([])
  const [isThinking, setIsThinking] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const transportRef  = useRef<ControlUiTransport | null>(null)
  const sessionKey    = useRef<string | null>(null)
  const connectLock   = useRef<Promise<void> | null>(null)
  const soulSentRef   = useRef(false)
  // 현재 화면이 가리키는 workflow id — WS event handler 가 메시지를 받았을 때
  // 어느 워크플로 파일에 append 할지 알아야 해서 ref 로도 들고 있음 (state
  // 만 쓰면 closure stale 위험).
  const workflowIdRef = useRef<string | null>(workflowId)

  // transport 는 첫 send 때 lazy 생성 (렌더 중 부작용 없음). 훅 인스턴스당 하나 —
  // 예전처럼 이 훅만의 소켓·세션을 갖는다. 핸드셰이크·RPC 는 transport 가,
  // 세션·SOUL·완료 판정은 여기서.
  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    const t = createRendererTransport('Twixy Workflow Builder', 'Workflow builder WS error')

    // 게이트웨이 세션은 연결에 묶여 있다 — 다음 send 가 새 세션을 만들고 SOUL 을 다시 보낸다.
    t.onClose(() => {
      sessionKey.current  = null
      soulSentRef.current = false
      // 연결이 끊기면 기다리던 답은 오지 않는다 — thinking 을 내린다.
      setIsThinking(false)
    })

    t.onEvent((frame) => {
      // chat 상태 이벤트 — assistant 메시지 도착만 완료 신호로 쓰면, 턴이 에러로 죽어
      // 메시지 없이 끝날 때 "Thinking…" 이 영원히 남는다 (useCopilotChat 이 먼저 고친 버그).
      // 같은 소켓에 다른 세션의 chat 이벤트도 올 수 있어 내 세션 key 만 본다.
      if (frame.event === 'chat') {
        const evtKey = (frame.payload?.sessionKey ?? frame.payload?.key) as string | undefined
        if (!evtKey || evtKey !== sessionKey.current) return
        const state = frame.payload?.state as string | undefined
        if (state === 'final') setIsThinking(false)
        else if (state === 'error') {
          setIsThinking(false)
          setError((frame.payload?.error as { message?: string })?.message ?? 'turn failed')
        }
        return
      }

      if (frame.event === 'session.message') {
        const msg = frame.payload?.message as Record<string, unknown> | undefined
        if (msg?.role === 'assistant') {
          const text = extractText(msg.content)
          if (text) {
            const line: WorkflowChatMessage = {
              id: crypto.randomUUID(), role: 'assistant', content: text, ts: Date.now(),
            }
            setMessages(prev => [...prev, line])
            setIsThinking(false)
            // workflowIdRef 기준 — assistant 응답 도착 시점의 현재 워크플로 에
            // append. 사용자가 응답 기다리는 동안 워크플로를 갈아탔으면 그
            // 새 워크플로에 가는 게 맞음 (UI 도 거기 보여주고 있을 테니).
            const wfId = workflowIdRef.current
            if (wfId) void window.twixy?.workflowChatAppend?.(wfId, line)
          }
        }
      }
    })

    transportRef.current = t
    return t
  }, [])

  // 연결 + 세션 수립 (idempotent). 세션은 핸드셰이크 직후 같은 lock 안에서 만든다 —
  // 동시 send 두 개가 세션을 두 개 만들지 않게.
  const ensureConnected = useCallback(async () => {
    const t = getTransport()
    if (t.isConnected() && sessionKey.current) return
    if (!connectLock.current) {
      connectLock.current = (async () => {
        await t.ensureConnected()
        // agentId 'builder' — tool-less spec-design agent (openclaw.json
        // agents.list, written by ensureWorkspace). The builder LLM can
        // only emit text/workflow-spec JSON; browser/read/write/exec are
        // denied at the gateway's tool-policy layer, so it can never
        // "run the workflow itself" no matter how the prompt reads.
        sessionKey.current = await createSession(t, { agentId: 'builder' })
      })().finally(() => { connectLock.current = null })
    }
    await connectLock.current
  }, [getTransport])

  // `text` is what the LLM receives (may include hidden context like a workflow
  // snapshot). `displayText`, if provided, is what shows in the chat bubble —
  // lets the caller hide internal scaffolding from the user without losing it
  // from the model's input.
  const sendMessage = useCallback(async (text: string, displayText?: string): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!isElectron) {
      setError('Not running inside Twixy')
      return
    }

    const visible = (displayText ?? trimmed).trim() || trimmed
    const userLine: WorkflowChatMessage = {
      id: crypto.randomUUID(), role: 'user', content: visible, ts: Date.now(),
    }
    setMessages(prev => [...prev, userLine])
    setIsThinking(true)
    setError(null)
    // disk append — workflow 가 새로 만들어져서 아직 id 없을 수도 있어 (첫 draft
    // 가 chat 으로 생성되는 흐름) 그땐 skip. 워크플로 생성된 후 메시지부터 persist.
    const wfId = workflowIdRef.current
    if (wfId) void window.twixy?.workflowChatAppend?.(wfId, userLine)

    try {
      await ensureConnected()
      const sid = sessionKey.current!
      // SOUL 은 첫 메시지에만 prepend. getWorkflowSoul() 은 호출 시점의
      // WORKFLOW_TOOLS 카탈로그를 placeholder 에 치환해 — 카탈로그가
      // 업데이트되면 새 세션부터 바로 반영.
      const body = soulSentRef.current
        ? trimmed
        : `${getWorkflowSoul()}\n\n---\n\n${trimmed}`
      soulSentRef.current = true
      await getTransport().rpc('sessions.send', { key: sid, message: body })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setIsThinking(false)
    }
  }, [ensureConnected, getTransport])

  const resetChat = useCallback(() => {
    setMessages([])
    setIsThinking(false)
    setError(null)
    soulSentRef.current = false
    // disk 도 함께 비움. 다음 workflow 로딩 시 이 워크플로는 빈 history 로 시작.
    const wfId = workflowIdRef.current
    if (wfId) void window.twixy?.workflowChatClear?.(wfId)
    // 세션은 끊지 않고 같은 게이트웨이 세션에 새 컨텍스트로 보낸다. 완전한
    // 격리가 필요해질 때 sessions.close + reconnect 로 바꿀 수 있다.
  }, [])

  // workflowId 변경 시: ref 갱신 + 디스크에서 그 워크플로의 채팅 history 로드.
  // 첫 마운트도 같은 effect 가 처리. workflowId 가 null 이면 메시지 비우기만 함.
  // race: 빠르게 두 번 갈아타면 늦은 load 가 이른 load 를 덮을 수 있어 cancelled
  // 플래그로 가드.
  useEffect(() => {
    workflowIdRef.current = workflowId
    if (!workflowId) {
      setMessages([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const lines = await window.twixy?.workflowChatLoad?.(workflowId)
        if (cancelled) return
        setMessages(Array.isArray(lines) ? lines as WorkflowChatMessage[] : [])
      } catch (e) {
        if (!cancelled) {
          console.warn('[workflowClaw] failed to load chat history:', e)
          setMessages([])
        }
      }
    })()
    return () => { cancelled = true }
  }, [workflowId])

  // 언마운트 정리 — 소켓·RPC 타이머를 남기지 않는다. dispose 는 구독자를 먼저 비워서
  // 언마운트 뒤 setState·디스크 append 가 일어나지 않는다. transport 는 다음 send 때 다시
  // lazy 생성되므로 StrictMode 의 mount→unmount→mount 에서도 죽은 인스턴스를 재사용하지 않는다.
  useEffect(() => () => {
    const t = transportRef.current
    if (t && sessionKey.current) releaseSessions(t, [sessionKey.current])
    t?.dispose()
    transportRef.current = null
    sessionKey.current   = null
    soulSentRef.current  = false
  }, [])

  return { messages, isThinking, error, sendMessage, resetChat }
}
