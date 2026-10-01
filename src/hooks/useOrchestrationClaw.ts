// ─────────────────────────────────────────────────────────────────────────────
// useOrchestrationClaw — Orchestration 뷰 우측 빌더 채팅 전용 세션 훅.
// useWorkflowClaw 의 미러 — 격리된 WS 세션, 첫 메시지에 ORCHESTRATION_SOUL
// prepend, orchestration-chat.jsonl 로 persist. 어시스턴트는 orchestration 정의를
// 돕는 페르소나(멤버=기존 Workflow 참조, 5패턴)로 동작.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { getOrchestrationSoul } from '../lib/orchestrationSoul'
import type { ControlUiTransport } from '../lib/gateway/controlUiTransport'
import { createRendererTransport, isElectron } from '../lib/gateway/rendererTransport'
import { createSession, extractText, releaseSessions } from '../lib/gateway/sessionClient'

export interface OrchestrationChatMessage {
  id:      string
  role:    'user' | 'assistant' | 'system'
  content: string
  ts:      number
}

export function useOrchestrationClaw(orchestrationId: string | null, workflows: TwixyWorkflow[], agents: TwixyAiAgent[] = []) {
  const [messages,   setMessages]   = useState<OrchestrationChatMessage[]>([])
  const [isThinking, setIsThinking] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const transportRef = useRef<ControlUiTransport | null>(null)
  const sessionKey  = useRef<string | null>(null)
  const connectLock = useRef<Promise<void> | null>(null)
  const soulSentRef = useRef(false)
  const orchIdRef   = useRef<string | null>(orchestrationId)
  const workflowsRef = useRef<TwixyWorkflow[]>(workflows)
  workflowsRef.current = workflows
  const agentsRef = useRef<TwixyAiAgent[]>(agents)
  agentsRef.current = agents

  // transport 는 첫 send 때 lazy 생성, 훅 인스턴스당 하나 (useWorkflowClaw 와 같은 구조).
  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    const t = createRendererTransport('Twixy Orchestration Builder', 'Orchestration builder WS error')
    // 연결이 끊기면 기다리던 답은 오지 않는다 — thinking 도 내린다.
    t.onClose(() => { sessionKey.current = null; soulSentRef.current = false; setIsThinking(false) })
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
            const line: OrchestrationChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: text, ts: Date.now() }
            setMessages(prev => [...prev, line])
            setIsThinking(false)
            const oid = orchIdRef.current
            if (oid) void window.twixy?.orchestrationChatAppend?.(oid, line)
          }
        }
      }
    })
    transportRef.current = t
    return t
  }, [])

  // 연결 + 세션 수립 (idempotent) — 세션은 핸드셰이크 직후 같은 lock 안에서 만든다.
  const ensureConnected = useCallback(async () => {
    const t = getTransport()
    if (t.isConnected() && sessionKey.current) return
    if (!connectLock.current) {
      connectLock.current = (async () => {
        await t.ensureConnected()
        // agentId 'builder' — tool-less design agent (see useWorkflowClaw).
        // Orchestration builder chat designs specs only; never executes.
        sessionKey.current = await createSession(t, { agentId: 'builder' })
      })().finally(() => { connectLock.current = null })
    }
    await connectLock.current
  }, [getTransport])

  const sendMessage = useCallback(async (text: string, displayText?: string): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!isElectron) { setError('Not running inside Twixy'); return }
    const visible = (displayText ?? trimmed).trim() || trimmed
    const userLine: OrchestrationChatMessage = { id: crypto.randomUUID(), role: 'user', content: visible, ts: Date.now() }
    setMessages(prev => [...prev, userLine])
    setIsThinking(true)
    setError(null)
    const oid = orchIdRef.current
    if (oid) void window.twixy?.orchestrationChatAppend?.(oid, userLine)
    try {
      await ensureConnected()
      const sid = sessionKey.current!
      const body = soulSentRef.current
        ? trimmed
        : `${getOrchestrationSoul(workflowsRef.current, agentsRef.current)}\n\n---\n\n${trimmed}`
      soulSentRef.current = true
      await getTransport().rpc('sessions.send', { key: sid, message: body })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsThinking(false)
    }
  }, [ensureConnected, getTransport])

  const resetChat = useCallback(() => {
    setMessages([]); setIsThinking(false); setError(null); soulSentRef.current = false
    const oid = orchIdRef.current
    if (oid) void window.twixy?.orchestrationChatClear?.(oid)
  }, [])

  useEffect(() => {
    orchIdRef.current = orchestrationId
    if (!orchestrationId) { setMessages([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const lines = await window.twixy?.orchestrationChatLoad?.(orchestrationId)
        if (cancelled) return
        setMessages(Array.isArray(lines) ? lines as OrchestrationChatMessage[] : [])
      } catch (e) {
        if (!cancelled) { console.warn('[orchestrationClaw] load chat failed:', e); setMessages([]) }
      }
    })()
    return () => { cancelled = true }
  }, [orchestrationId])

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
