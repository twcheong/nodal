// ─────────────────────────────────────────────────────────────────────────────
// useOrchestrationGateway — Orchestration 실행용 다중 세션 게이트웨이.
//
// useWorkflowTestSession 은 한 번에 하나의 활성 세션만 다룬다(activeKey 단일).
// Orchestration 의 Parallel/Conductor 패턴은 여러 멤버를 동시에 돌려야 하므로,
// 세션을 key 별 Map 으로 관리하고 chat/tool 이벤트를 sessionKey 로 라우팅한다.
// 메인 채팅·Workflow Test 세션과 완전히 격리된 자체 WS 연결을 쓴다.
//
// 노출:
//   ensureReady()              — WS connect + auth 보장
//   createSession()            — sessions.create + subscribe, sessionKey 반환
//   send(key, text, opts)      — 그 세션에 메시지 전송, assistant final 까지 await
//   abort(key) / abortAll()    — 진행 중 turn 중단 (Stop 버튼)
//   activity                   — key → { thinking, tool } 라이브 표시용 state
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControlUiTransport, GatewayEventFrame, RpcFrame } from '../lib/gateway/controlUiTransport'
import { createRendererTransport, isElectron } from '../lib/gateway/rendererTransport'
import { extractText, releaseSessions } from '../lib/gateway/sessionClient'
import { parseAgentToolFrame, ToolCallTracker, TOOL_EVENTS_CAP } from '../lib/gateway/toolEvents'

export interface MemberActivity { thinking: boolean; tool?: string }

interface TurnAwaiter {
  resolve: (r: { text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }) => void
  reject:  (err: Error) => void
  toolCalls: Array<{ name: string; detail?: string }>
}

export interface OrchestrationGateway {
  status:       'connecting' | 'ready' | 'error'
  ensureReady:  () => Promise<void>
  createSession: () => Promise<string>
  send:         (key: string, text: string, opts?: { timeoutMs?: number; model?: string }) =>
    Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
  abort:        (key: string) => Promise<void>
  abortAll:     () => Promise<void>
  activity:     Record<string, MemberActivity>
}

export function useOrchestrationGateway(): OrchestrationGateway {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [activity, setActivity] = useState<Record<string, MemberActivity>>({})

  const transportRef = useRef<ControlUiTransport | null>(null)
  // sessionKey → awaiter 큐 (FIFO). chat.final 이 오면 해당 key 의 front 를 resolve.
  const awaitersByKey = useRef<Map<string, TurnAwaiter[]>>(new Map())
  // sessionKey → 가장 최근 assistant 본문 (final 시 awaiter resolve 값).
  const lastTextByKey = useRef<Map<string, { text: string; id: string | null }>>(new Map())
  // 진행 중인 툴 호출 — toolCallId 로 세어 병렬 호출이 서로를 지우지 않게.
  const toolTracker = useRef(new ToolCallTracker())

  const setKeyActivity = useCallback((key: string, a: MemberActivity | null) => {
    setActivity(prev => {
      const next = { ...prev }
      if (a === null) delete next[key]
      else next[key] = a
      return next
    })
  }, [])

  // transport 가 아직 없으면(=연결 전) 예전과 똑같이 'WS not open' 으로 거절한다.
  // send/abort 는 ensureReady 를 거치지 않으므로 이 경로가 실제로 탄다.
  const rpc = useCallback((method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcFrame> => {
    const t = transportRef.current
    return t ? t.rpc(method, params, timeoutMs) : Promise.reject(new Error('WS not open'))
  }, [])

  // 연결이 사라졌을 때의 정리 — transport onClose 와 언마운트가 같이 쓴다.
  const handleClose = useCallback(() => {
    // 모든 awaiter reject.
    for (const queue of awaitersByKey.current.values()) {
      for (const a of queue) { try { a.reject(new Error('ws_closed')) } catch { /* noop */ } }
    }
    awaitersByKey.current.clear()
    toolTracker.current.clearAll()
    setStatus('error')
    setActivity({})
  }, [])

  // 완료 판정·라우팅은 전부 여기서 — transport 는 raw 프레임만 넘긴다.
  const handleEvent = useCallback((frame: GatewayEventFrame) => {
    if (frame.event === 'chat') {
      const state  = frame.payload?.state as string | undefined
      const evtKey = (frame.payload?.sessionKey ?? frame.payload?.key) as string | undefined
      if (!evtKey) return
      if (state === 'start') {
        setKeyActivity(evtKey, { thinking: true })
      } else if (state === 'final') {
        const queue = awaitersByKey.current.get(evtKey)
        const a = queue?.shift()
        const last = lastTextByKey.current.get(evtKey)
        if (a) a.resolve({ text: last?.text ?? '', messageId: last?.id ?? null, toolCalls: a.toolCalls })
        toolTracker.current.clear(evtKey)
        setKeyActivity(evtKey, null)
      } else if (state === 'error') {
        const queue = awaitersByKey.current.get(evtKey)
        const a = queue?.shift()
        if (a) a.reject(new Error((frame.payload?.error as { message?: string })?.message ?? 'chat_error'))
        toolTracker.current.clear(evtKey)
        setKeyActivity(evtKey, null)
      }
      return
    }

    // 툴 활동 — `agent` 의 tool 스트림에서 온다 (session.tool 이 아니다, toolEvents.ts 참고).
    const tool = parseAgentToolFrame(frame)
    if (tool) {
      const { current, started } = toolTracker.current.apply(tool)
      // 진행 중인 호출이 있으면 그 이름을, 다 끝났으면 tool 없이 thinking 만.
      setKeyActivity(tool.sessionKey, current ? { thinking: true, tool: current } : { thinking: true })
      // 호출 단위로 한 번만 센다 — update 프레임마다 밀어넣으면 같은 호출이 여러 번 잡힌다.
      if (started) awaitersByKey.current.get(tool.sessionKey)?.[0]?.toolCalls.push({ name: tool.name })
      return
    }

    if (frame.event === 'session.message') {
      const evtKey = frame.payload?.sessionKey as string | undefined
      if (!evtKey) return
      const msg = frame.payload?.message as Record<string, unknown> | undefined
      if (msg?.role === 'assistant') {
        const text = extractText(msg.content)
        if (text) lastTextByKey.current.set(evtKey, { text, id: (msg.id as string) ?? null })
      }
      return
    }
  }, [setKeyActivity])

  // transport 는 훅 인스턴스당 하나, 첫 ensureReady 때 생성 — 메인 채팅·Workflow Test 와
  // 격리된 자체 소켓이라는 점은 그대로다. 핸드셰이크·RPC 는 transport 가 맡는다.
  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    // tool-events: 툴 활동을 멤버 칩에 그린다 → tool 스트림 agent 프레임이 필요하다.
    const t = createRendererTransport('Twixy Orchestration', 'Orchestration WS error', { caps: [TOOL_EVENTS_CAP] })
    t.onClose(handleClose)
    t.onEvent(handleEvent)
    transportRef.current = t
    return t
  }, [handleClose, handleEvent])

  const ensureReady = useCallback(async () => {
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

  const createSession = useCallback(async (): Promise<string> => {
    await ensureReady()
    // agentId 'workflow-runner' — no sub-agent spawning (see
    // useWorkflowTestSession). Orchestration members run nodes with the same
    // turn-done === work-done requirement as workflow Test.
    const res = await rpc('sessions.create', { agentId: 'workflow-runner' })
    if (!res.ok || !res.payload?.key) throw new Error('sessions.create failed')
    const key = res.payload.key as string
    await rpc('sessions.messages.subscribe', { key })
    awaitersByKey.current.set(key, [])
    return key
  }, [ensureReady, rpc])

  const send = useCallback(async (
    key: string, text: string, opts?: { timeoutMs?: number; model?: string },
  ): Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }> => {
    if (!isElectron) throw new Error('not_electron')
    const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000
    let awaiter!: TurnAwaiter
    const promise = new Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>((resolve, reject) => {
      const a: TurnAwaiter = { resolve, reject, toolCalls: [] }
      awaiter = a
      const queue = awaitersByKey.current.get(key) ?? []
      queue.push(a); awaitersByKey.current.set(key, queue)
      const t = setTimeout(() => {
        const q = awaitersByKey.current.get(key)
        const i = q ? q.indexOf(a) : -1
        if (q && i >= 0) { q.splice(i, 1); reject(new Error('turn_timeout')) }
      }, timeoutMs)
      const oR = a.resolve, oRj = a.reject
      a.resolve = (r) => { clearTimeout(t); oR(r) }
      a.reject  = (e) => { clearTimeout(t); oRj(e) }
    })
    // send RPC 가 실패하면 아래에서 throw 로 끝나 이 promise 는 호출자에게 가지 못한다 —
    // 그때의 거절이 unhandled rejection 으로 새지 않게. (정상 경로의 호출자는 같은 promise 를 받아 그대로 본다.)
    promise.catch(() => { /* 호출자는 throw 된 에러를 받는다 */ })
    setKeyActivity(key, { thinking: true })
    try {
      // model 지정 시 per-turn override (게이트웨이가 미지원이면 무시됨, leaf 실행엔 영향 없음).
      const params: Record<string, unknown> = { key, message: text }
      if (opts?.model) params.model = opts.model
      await rpc('sessions.send', params, timeoutMs)
    } catch (err) {
      // 방금 넣은 **그** awaiter 만 뺀다 (timeout 경로와 같은 identity 기준). 예전 pop() 은 같은 key 에
      // 다른 turn 이 대기 중이면 — 또는 이 awaiter 가 turn timeout 으로 이미 빠졌으면 — 남의 awaiter 를 버렸다.
      const q = awaitersByKey.current.get(key)
      const i = q ? q.indexOf(awaiter) : -1
      if (q && i >= 0) q.splice(i, 1)
      // 같은 key 에 아직 도는 turn 이 있으면 thinking 표시는 그대로 둔다.
      if (!q?.length) setKeyActivity(key, null)
      awaiter.reject(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
    return promise
  }, [rpc, setKeyActivity])

  const abort = useCallback(async (key: string) => {
    try { await rpc('sessions.abort', { key }) } catch { /* non-fatal */ }
    toolTracker.current.clear(key)
    const queue = awaitersByKey.current.get(key)
    if (queue) {
      awaitersByKey.current.set(key, [])
      for (const a of queue) { try { a.reject(new Error('cancelled')) } catch { /* noop */ } }
    }
    setKeyActivity(key, null)
  }, [rpc, setKeyActivity])

  const abortAll = useCallback(async () => {
    const keys = Array.from(awaitersByKey.current.keys())
    await Promise.all(keys.map(k => abort(k)))
  }, [abort])

  useEffect(() => {
    if (!isElectron) return
    // 실패는 status 'error' 가 신호다 — 여기서 받아줄 곳이 없으면 unhandled rejection 이 된다.
    ensureReady().catch(() => { /* status 로 노출됨 */ })
    // 정리 때 읽을 세션 장부. Map 은 재할당되지 않고 제자리 변경만 하므로 내용은 최신이다.
    const ledger = awaitersByKey.current
    return () => {
      // 예전 `ws.close()` → onclose 와 같은 결과: 살아 있던 연결이면 awaiter 를 ws_closed 로 깨운다.
      // transport 는 다음 ensureReady 가 새로 만든다 (StrictMode 의 mount→unmount→mount 포함).
      const t = transportRef.current
      transportRef.current = null
      if (!t) return
      const wasConnected = t.isConnected()
      // createSession 으로 만든 세션을 반납 — 소켓을 닫기 전에.
      releaseSessions(t, ledger.keys())
      t.dispose()
      if (wasConnected) handleClose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { status, ensureReady, createSession, send, abort, abortAll, activity }
}
