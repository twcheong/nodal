// ═════════════════════════════════════════════════════════════════════════════
// useOpenClaw.ts — 메인 에이전트 세션 훅.
//
// 앱 챗 UX의 심장. 렌더러에서 OpenClaw 로컬 게이트웨이(ws://127.0.0.1:18789)에
// WebSocket 으로 연결해 하나의 채팅 세션을 유지한다.
//
// 제공하는 기능:
//   · messages / status / isThinking / errorMsg : 채팅 화면 상태
//   · toolActivity / toolStats : "Working: browser.snapshot" 같은 실시간 툴 표시
//   · sendMessage(text)  : 사용자 메시지 전송 + 에이전트 턴 트리거
//   · abortMessage()     : 현재 턴 중단
//   · reconnect()        : 수동 재연결 (최대 3회 빠른 재시도)
//   · clearChat()        : 현재 세션 폐기 + 새 세션 생성
//   · fetchUsageCost / resetUsageBaseline / liveUsage : 토큰/USD 사용량 UI 표시
//
// 주요 플로우:
//   1) connect() : getGatewayToken IPC 로 토큰 받아 WS 접속 → challenge-response 인증
//   2) ensureSession() : sessions.create + sessions.messages.subscribe
//   3) onmessage : session.message / session.tool / sessions.changed 이벤트 처리
//   4) 사용자 메시지마다 sessions.send → isThinking=true → 'final' event → 후처리
//   5) 턴 종료 후 파이프라인: 언어 교정 → OpenRouter 사용량 sync → 세션 요약
//
// 구조 주의점:
//   · RPC id↔응답 매칭과 핸드셰이크는 controlUiTransport 가 소유 (src/lib/gateway)
//   · 서브에이전트가 돈 중에도 root 가 final 을 먼저 쏘는 경합이 있어
//     rootFinaledWhileSubagentBusy + finalFallbackTimer 로 방어
//   · web_search 는 공유 Brave 키 보호 위해 localStorage 일일 캡(100) 적용
// ═════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from 'react'
import { computeFallbackCost } from '../lib/modelPricing'
import { classifyRunError } from '../lib/runErrors'
import { logbookToolStart, logbookToolEnd } from '../lib/logbook'
import type { ControlUiTransport, GatewayError, GatewayEventFrame } from '../lib/gateway/controlUiTransport'
import { createRendererTransport } from '../lib/gateway/rendererTransport'
import { extractText } from '../lib/gateway/sessionClient'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessageAction {
  label:    string
  primary?: boolean
  actionId: string       // handler key dispatched to ChatPanel's onMessageAction
  planId?:  string       // plan context for plan-resume / plan-dismiss
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: Date
  tokens?: number   // total tokens for this message (assistant only, set after usage sync)
  // ── Planning Mode ─────────────────────────────────────────────
  // When `planId` is set on an assistant message, the chat renderer replaces
  // the usual content bubble with a PlanCard for that plan. Used so the
  // planning flow can surface an interactive plan preview inline with the
  // rest of the conversation instead of needing a separate tab.
  planId?: string
  // Observed tool calls during this turn, captured so the plan runner can
  // write them into run.md without re-parsing the session JSONL. Only set
  // for assistant messages that closed out a `sendAndAwaitFinal` call.
  toolCalls?: Array<{ name: string; detail?: string }>
  // Optional inline action buttons — used by system messages (e.g. failure
  // notifications) to offer resume / dismiss actions without a modal.
  actions?: ChatMessageAction[]
}

type GatewayStatus = 'connecting' | 'ready' | 'error' | 'disconnected'

const isElectron = typeof window !== 'undefined' && !!window.twixy

// ── Daily web_search cap — 일일 웹 검색 사용량 상한 ──────────────
// Twixy 호스팅 모드에서는 공유 Brave API 키를 쓰기 때문에, 폭주하는 에이전트나
// 악의적 사용자로부터 키를 보호하기 위해 클라이언트 측 소프트 캡을 둔다.
// UTC 일자 단위로 localStorage 에 카운트를 저장; 100 초과 시 툴 호출 거부.
const DAILY_SEARCH_CAP = 100
const SEARCH_COUNT_KEY = 'twixy-search-count'

function todayKey(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
}
function readSearchCount(): number {
  try {
    const raw = localStorage.getItem(SEARCH_COUNT_KEY)
    if (!raw) return 0
    const { date, count } = JSON.parse(raw) as { date: string; count: number }
    if (date !== todayKey()) return 0
    return typeof count === 'number' ? count : 0
  } catch { return 0 }
}
function bumpSearchCount(): number {
  const next = readSearchCount() + 1
  try {
    localStorage.setItem(SEARCH_COUNT_KEY, JSON.stringify({ date: todayKey(), count: next }))
  } catch { /* ignore */ }
  return next
}

// ── OpenClaw RPC frame types — 게이트웨이 응답 프레임 타입 ───────
// WS 위에서 주고받는 JSON 프레임 중 "응답(res)" 프레임 구조.
// 이벤트 프레임(event)과 요청 프레임(req)은 별도로 처리.
interface ResponseFrame {
  id: string
  ok: boolean
  payload?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

export type LiveUsage = { tokensIn: number; tokensOut: number; usdToday: number }

// Cron 'every' 입력 → 밀리초. 숫자만 오면 ms 로 간주, "10m"/"2h"/"30s"/"1d" 도 허용.
function parseEveryMs(input: string): number {
  const raw = (input ?? '').trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const m = raw.match(/^(\d+)\s*(ms|s|m|h|d)$/i)
  if (!m) return Number(raw) || 0
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return n * mult
}

// ── Tool detail formatter — 툴 호출 설명 문자열 생성 ─────────────
// 원시 tool_use 인자를 사람이 읽기 쉬운 한 줄 설명으로 변환한다.
// "Working: browser.act (click)" 보다 "Clicking element on page" 가 훨씬 친절.
// ChatPanel 의 thinking 인디케이터와 세션 히스토리 뷰에서 사용.

/** Infer what a browser `evaluate` fn is trying to read from the page. */
function inferEvaluateIntent(fn: string): string {
  const f = fn.toLowerCase()
  if (f.includes('ytinitialdata') || f.includes('ytinitialplayerresponse')) return 'Reading page data'
  if (f.includes('interactioncount') || (f.includes('view') && (f.includes('count') || f.includes('text')))) return 'Reading view count'
  if (f.includes('subscriber')) return 'Reading subscriber count'
  if (f.includes('likecount') || (f.includes('like') && f.includes('button'))) return 'Reading like count'
  if (f.includes('comment')) return 'Reading comments'
  if (f.includes('date') || f.includes('info-string') || f.includes('published')) return 'Reading publish date'
  if (f.includes('description')) return 'Reading description'
  if ((f.includes('/@') || f.includes('/channel/')) && f.includes('href')) return 'Finding channel link'
  if (f.includes('channel') && f.includes('href')) return 'Finding channel link'
  if (f.includes('channel')) return 'Reading channel info'
  if (f.includes('follower')) return 'Reading follower count'
  if (f.includes('h1') || (f.includes('title') && !f.includes('titlewrapper'))) return 'Reading page title'
  if (f.includes('href') || (f.includes('queryselectorall') && f.includes('"a"'))) return 'Reading page links'
  if (f.includes('src') || f.includes('img')) return 'Reading images'
  // Fallback: extract first selector for a hint
  const m = fn.match(/querySelector(?:All)?\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/)
  if (m) return `Reading ${m[1].replace(/[#.\[\]"=*]+/g, ' ').trim().slice(0, 40)}`
  return 'Evaluating page'
}

/** Turn a CSS selector into a short readable label. */
function humanizeSelector(sel: string): string {
  if (!sel) return ''
  const s = sel.toLowerCase()
  if (s.includes('title') || s === 'h1') return 'title'
  if (s.includes('channel-header') || s.includes('channel-name')) return 'channel info'
  if (s.includes('below') || s.includes('secondary')) return 'related content'
  if (s.includes('watch-header') || s.includes('video-primary')) return 'video header'
  if (s.includes('ytinitial')) return 'page data'
  if (s.includes('description')) return 'description'
  if (s.includes('comment')) return 'comments'
  if (s.includes('subscriber')) return 'subscribers'
  if (s.includes('meta')) return 'page metadata'
  if (s.includes('like')) return 'like button'
  // Clean up and abbreviate
  return sel.replace(/[#\[\]"=*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 36)
}

export function formatToolDetail(toolName: string, args: Record<string, unknown>): string | undefined {
  const action   = args.action   as string | undefined
  const kind     = args.kind     as string | undefined
  const url      = (args.url ?? args.targetUrl) as string | undefined
  const selector = (args.selector ?? args.element) as string | undefined
  const text     = args.text     as string | undefined
  const query    = (args.query ?? args.q) as string | undefined
  const fn       = args.fn       as string | undefined

  if (toolName === 'browser') {
    if (action === 'open' || action === 'navigate') {
      if (!url) return 'Opening page'
      try {
        const host = new URL(url).hostname.replace(/^www\./, '')
        const path = new URL(url).pathname
        return `Opening ${host}${path.length > 1 ? path.slice(0, 40) : ''}`
      } catch { return `Opening ${url.slice(0, 60)}` }
    }
    if (action === 'act') {
      if (kind === 'evaluate') return fn ? inferEvaluateIntent(fn) : 'Evaluating page'
      if (kind === 'click')    return 'Clicking element on page'
      if (kind === 'type')     return text ? `Typing "${text.slice(0, 50)}"` : 'Typing'
      if (kind === 'wait')     return `Waiting${args.timeMs ? ` ${args.timeMs}ms` : '…'}`
      if (kind === 'scroll')   return 'Scrolling'
      if (kind === 'key')      return text ? `Pressing ${text}` : 'Pressing key'
      return kind ?? 'Performing action'
    }
    if (action === 'snapshot') {
      const label = selector ? humanizeSelector(selector) : ''
      return label ? `Reading ${label}` : 'Reading page'
    }
    if (action === 'screenshot') return 'Taking screenshot'
    if (action === 'close')      return 'Closing tab'
    return action ?? undefined
  }
  if (toolName === 'web_fetch') {
    if (!url) return undefined
    try { return `Fetching ${new URL(url).hostname.replace(/^www\./,'')}` } catch { return `Fetching ${url.slice(0,60)}` }
  }
  if (toolName === 'web_search')    return query ? `Searching "${query.slice(0, 60)}"` : undefined
  if (toolName === 'memory_search') return query ? `Recalling "${query.slice(0, 60)}"` : 'Searching memory'
  if (toolName === 'exec' || toolName === 'bash') {
    const cmd = (args.command ?? args.cmd) as string | undefined
    return cmd ? cmd.slice(0, 70) : undefined
  }

  const filePath = (args.path ?? args.file ?? args.filePath) as string | undefined
  const shortPath = filePath ? filePath.split('/').slice(-2).join('/') : undefined

  if (toolName === 'read')  return shortPath ? `Reading ${shortPath}` : 'Reading file'
  if (toolName === 'write') return shortPath ? `Writing ${shortPath}` : 'Writing file'
  if (toolName === 'edit')  return shortPath ? `Editing ${shortPath}` : 'Editing file'
  if (toolName === 'glob')  return args.pattern ? `Searching ${args.pattern}` : 'Searching files'
  if (toolName === 'grep')  return args.pattern ? `Searching for "${String(args.pattern).slice(0, 50)}"` : 'Searching content'

  if (toolName === 'sessions_spawn') {
    const task = (args.task ?? args.prompt) as string | undefined
    return task ? `Spawning sub-agent: ${task.slice(0, 60)}` : 'Spawning sub-agent'
  }
  if (toolName === 'sessions_yield') return 'Returning to parent agent'

  return undefined
}

export function useOpenClaw() {
  const [messages, setMessages]     = useState<ChatMessage[]>([])
  const [status, setStatus]         = useState<GatewayStatus>(isElectron ? 'connecting' : 'disconnected')
  const [errorMsg, setErrorMsg]     = useState<string | undefined>()
  const [isThinking, setIsThinking] = useState(false)
  // ── Post-turn pipeline — 턴 종료 직후 후처리 ────────────────────
  // 언어 교정 → 교정 비용 기록 → 세션 요약. 턴 1개당 1회 실행.
  // (isThinking 이 true→false 로 바뀌는 edge 에서 트리거)
  // 순서가 중요:
  //   1) correctLanguage 로 마지막 어시스턴트 메시지를 사용자 언어로 재작성
  //   2) 교정 호출이 쓴 토큰을 usage 에 기록 (주모델과 같은 키/쿼터)
  //   3) 세션 요약 생성은 800ms 지연 → 로그 파일 flush 된 뒤에 읽도록
  const prevThinkingRef = useRef(false)
  useEffect(() => {
    const wasThinking = prevThinkingRef.current
    prevThinkingRef.current = isThinking
    if (!isThinking && wasThinking && isElectron) {
      const sid = sessionKey.current

      // Snapshot messages synchronously so the async chain below works on a
      // stable reference even if new messages arrive before it resolves.
      setMessages(prev => {
        const lastAssistant = [...prev].reverse().find(m => m.role === 'assistant')
        const lastUser      = [...prev].reverse().find(m => m.role === 'user')

        // Resolve any pending plan-turn awaiters with the most recent
        // assistant message that appeared after each awaiter's startedAt.
        // We do this BEFORE language correction so the planner sees the
        // raw JSON the model emitted, not a post-edit paraphrase.
        if (turnAwaitersRef.current.length > 0) {
          const pending = turnAwaitersRef.current
          turnAwaitersRef.current = []
          for (const a of pending) {
            const hit = [...prev].reverse().find(m =>
              m.role === 'assistant' && m.timestamp.getTime() >= a.startedAt,
            )
            a.resolve({ text: hit?.content ?? '', messageId: hit?.id ?? null, toolCalls: a.toolCalls })
          }
        }

        // Persist assistant messages once the turn has ended. Assistant
        // bubbles stream in-place (content updated by msgId), so we wait for
        // the turn boundary to capture stable content. persistMessage is
        // idempotent per id, so each assistant message is written exactly once.
        // NOTE: append-only — a later in-place edit (language correction at
        // :298, token patch at syncUsageDelta) is intentionally NOT re-written
        // to disk in this MVP; the originally-written text is what survives.
        for (const m of prev) {
          if (m.role === 'assistant') persistMessage(m)
        }

        const runPostPipeline = (correctionDone: boolean) => {
          // 2. Token tracking for the correction call is handled inside the
          //    correction branch below. Nothing extra needed here.

          // 3. Session summary — 800ms delay so JSONL log flushes first.
          if (sid) {
            setTimeout(() => {
              window.twixy.generateSessionSummary(sid).catch(() => { /* non-critical */ })
            }, 800)
          }
          void correctionDone  // suppress unused-variable lint
        }

        if (!lastAssistant || !lastUser || localStorage.getItem('twixy-lang-correction') === 'false') {
          runPostPipeline(false)
          return prev
        }

        // 1. Language correction
        window.twixy.correctLanguage({ text: lastAssistant.content, userSample: lastUser.content })
          .then(res => {
            // 1a. Apply corrected text in-place
            if (res.ok && res.text && res.text !== lastAssistant.content) {
              setMessages(cur => cur.map(m =>
                m.id === lastAssistant.id ? { ...m, content: res.text! } : m
              ))
              // 1b. Append corrected version to session log so both original
              //     (written by the gateway) and corrected are preserved.
              if (sid) {
                window.twixy.appendSessionLog({
                  sessionId: sid,
                  line: JSON.stringify({
                    type: 'event',
                    event: 'session.message',
                    payload: {
                      messageId: lastAssistant.id,
                      message: { role: 'assistant', content: res.text },
                      _langCorrected: true,
                    },
                  }),
                }).catch(() => { /* non-critical */ })
              }
            }
            // 1c. Track correction token cost (same key/quota as main model)
            if (res.ok && (res.tokensIn || res.tokensOut)) {
              window.twixy.recordOpenRouterUsage({
                tokensIn:  res.tokensIn  ?? 0,
                tokensOut: res.tokensOut ?? 0,
                usdDelta:  0,
              }).catch(() => { /* non-critical */ })
            }
            runPostPipeline(true)
          })
          .catch(() => runPostPipeline(false))

        return prev  // don't block render while correction is in-flight
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThinking])
  // Live token/USD usage updated after each message — shown immediately in
  // the UI without waiting for a Supabase round-trip.
  const [liveUsage, setLiveUsage]   = useState<LiveUsage>({ tokensIn: 0, tokensOut: 0, usdToday: 0 })

  // Live tool activity surfaced from session.tool events. Lets the chat panel
  // show "Working: subagents.spawn" / "Working: browser.snapshot" instead of
  // a silent thinking spinner — especially important once heavy work is
  // delegated to sub-agents and the main session goes quiet for ~30s+.
  type ToolActivity = { name: string; sessionKey?: string; isSubagent: boolean; subagentLabel?: string; detail?: string; callId?: string }
  const [toolActivity, setToolActivity] = useState<ToolActivity | null>(null)
  const activeToolsRef = useRef<Map<string, ToolActivity>>(new Map())
  // Aggregate progress so the UI can show "12 tool calls · 47s" even between
  // individual tool starts/ends. Without this the spinner blinks back to a
  // bare "..." every time a tool finishes, which makes long runs (60s+) feel
  // frozen even though the agent is actively working.
  type ToolStats = { count: number; startedAt: number | null; lastName: string | null; lastIsSubagent: boolean }
  const [toolStats, setToolStats] = useState<ToolStats>({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
  // Track active sub-agent child sessions: childKey -> displayLabel.
  // Driven by `sessions.changed` reason='subagent_spawned'/'subagent_ended'
  // (broadcast by the gateway whenever a sub-agent run begins/ends), so the
  // chat UI can show a persistent "🤖 Sub-agent: <label>…" pill for the
  // entire duration of the delegated run — even when the parent session is
  // idle and emits no `session.tool` events of its own.
  const subagentSessionsRef = useRef<Map<string, string>>(new Map())
  // Parallel ref dedicated to kill bookkeeping. `subagentSessionsRef` is
  // cleared the moment a subagent emits `phase:"end"` (so the UI can flip
  // back to idle), but that happens BEFORE the gateway's
  // `runSubagentAnnounceFlow` has actually delivered its announce. If we
  // cleared our kill list on the same event, step-end `killActiveSubagents`
  // would find nothing to sessions.delete and the announce would slip
  // through. This ref holds session keys until we have explicitly deleted
  // them (or the whole chat is torn down).
  const subagentKillRef = useRef<Set<string>>(new Set())
  // Set to true when the root session emits chat 'final' WHILE a sub-agent is
  // still running. We can't kill isThinking yet (sub-agent is still doing
  // browser/exec work), but we need to remember that the root is logically
  // done so the LAST sub-agent's completion can flip thinking off.
  const rootFinaledWhileSubagentBusy = useRef(false)
  // When true, any subagent-announce-triggered LLM run on the main session is
  // immediately aborted. Set after a plan fails to prevent late-arriving
  // subagent results from autonomously restarting plan execution.
  const rejectNewRunsRef = useRef(false)
  // Safety-net timer: if rootFinaledWhileSubagentBusy is set but tool/subagent
  // end events are dropped, force-clear isThinking after this grace period.
  const finalFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 핸드셰이크·RPC·프레임 demux 는 transport 가 맡는다. 재연결·세션·완료 판정은 이 훅 몫.
  const transportRef    = useRef<ControlUiTransport | null>(null)
  // ── Planning Mode turn awaiters ─────────────────────────────────
  // Each awaiter resolves with the last assistant message seen after its
  // `startedAt` timestamp, at the moment the root session's chat.final
  // transitions isThinking back to false. Used by the planner to extract
  // the JSON plan and by the step runner to capture the assistant's final
  // reply for run.md without having to re-parse the session JSONL.
  type TurnAwaiter = {
    resolve: (r: { text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }) => void
    reject:  (err: Error) => void
    startedAt: number
    toolCalls: Array<{ name: string; detail?: string }>
  }
  const turnAwaitersRef = useRef<TurnAwaiter[]>([])
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCount      = useRef(0)
  const isManualRetry   = useRef(false)   // true after user clicks Reconnect
  const sessionKey      = useRef<string | null>(null)
  // Which key we've actually subscribed to on the gateway. Distinct from
  // sessionKey.current, which after hydrate may hold a resumed-but-not-yet-
  // subscribed key. ensureSession compares the two to decide whether to
  // (re)open + subscribe vs. no-op.
  const sessionSubscribedKey = useRef<string | null>(null)
  const seenMsgIds      = useRef<Set<string>>(new Set())

  // ── Main chat persistence — 메인 채팅 영속 ──────────────────────
  // hydratingRef: 디스크에서 복원하는 동안 true. setMessages 로 채워넣은 메시지를
  //   다시 디스크에 append 하지 않도록(무한 중복) 가드한다 — 복원은 setMessages
  //   직접, append 경로(persistMessage)는 건너뛴다.
  // persistedIds: 이미 디스크에 1회 기록한 메시지 id 집합. 어시스턴트 메시지는
  //   스트리밍 중 in-place 갱신되므로 턴 종료 시점에 1회만 기록하고, 중복 기록을
  //   막기 위해 여기에 기록한다. (append-only — 이후 in-place 수정은 미반영)
  const hydratingRef    = useRef(false)
  const persistedIds    = useRef<Set<string>>(new Set())
  // Serialize a ChatMessage and append to the workspace main-chat.jsonl.
  // Fire-and-forget; failures are swallowed (chat already rendered in memory).
  // No-op during hydration or for ids already written.
  const persistMessage = useCallback((msg: ChatMessage) => {
    if (!isElectron) return
    if (hydratingRef.current) return
    if (persistedIds.current.has(msg.id)) return
    persistedIds.current.add(msg.id)
    window.twixy.mainChatAppend({
      id:        msg.id,
      role:      msg.role,
      content:   msg.content,
      timestamp: msg.timestamp.getTime(),
      tokens:    msg.tokens,
      planId:    msg.planId,
      toolCalls: msg.toolCalls,
      actions:   msg.actions,
    }).catch(() => { /* non-critical, never throw */ })
  }, [])

  // Per-model usage totals from the last sessions.usage call.
  // Used to compute delta after each new assistant message.
  // newInputTokens  = sessions.usage 'input'     — non-cached, billed at full price
  // cacheReadTokens = sessions.usage 'cacheRead' — cache hits, billed at 25% of input price
  // Both are summed for the token-count display (= native_tokens_prompt on OpenRouter).
  type ModelTotals = { newInputTokens: number; cacheReadTokens: number; outputTokens: number; inputCost: number; outputCost: number }
  const prevUsageRef = useRef<ModelTotals>({ newInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0 })
  const usageSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const MAX_AUTO_RETRIES   = 8   // initial launch — gateway may take a few seconds to start
  const MAX_MANUAL_RETRIES = 3   // after user clicks Reconnect — 3 quick attempts (~4s total)

  const addMessage = useCallback((role: MessageRole, content: string, extra?: Partial<ChatMessage>) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: new Date(),
      ...extra,
    }
    setMessages(prev => [...prev, msg])
    // user / system bubbles are created once with final content (never streamed),
    // so persist immediately. Assistant messages arrive via the session.message
    // handler and are persisted at turn-end instead (see post-turn pipeline).
    persistMessage(msg)
  }, [persistMessage])

  // 프로바이더가 턴을 죽인 이유를 채팅에 시스템 메시지로 남긴다.
  // 같은 실패가 session.message(빈 content + errorMessage)와 chat.error 두 경로로
  // 들어올 수 있어 5초 내 동일 요약은 한 번만 표시한다.
  const lastRunErrorRef = useRef<{ summary: string; at: number }>({ summary: '', at: 0 })
  const surfaceRunError = useCallback((raw: unknown) => {
    const info = classifyRunError(raw)
    if (info.kind === 'aborted') return
    const now = Date.now()
    const prev = lastRunErrorRef.current
    if (prev.summary === info.summary && now - prev.at < 5_000) return
    lastRunErrorRef.current = { summary: info.summary, at: now }
    setMessages(p => [...p, {
      id:        crypto.randomUUID(),
      role:      'system' as const,
      content:   info.hint ? `${info.summary}\n\n${info.hint}` : info.summary,
      timestamp: new Date(),
    }])
  }, [])

  // ── Send raw RPC request — 범용 RPC 송신기 ──────────────────────
  // 기본 timeoutMs 는 15초 (빠른 제어 호출용: sessions.create / usage.cost 등).
  // 단 sessions.send 는 훨씬 긴 타임아웃이 필요하다 — 게이트웨이는 "에이전트가
  // 실행을 시작한 뒤에야" ACK 를 보내기 때문에, 사용자가 URL 을 붙여넣은 직후
  // 같은 상황에서 web_fetch 같은 느린 툴이 먼저 돌면 ACK 가 15초를 쉽게 넘긴다.
  // 그대로 끊으면 턴 도중에 타임아웃 → thinking 스피너가 영원히 걸려버린다.
  const rpc = useCallback((
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = 15_000,
  ): Promise<ResponseFrame> => {
    const t = transportRef.current
    if (!t) return Promise.reject(new Error('WebSocket not open'))
    return t.rpc(method, params, timeoutMs).catch((err: GatewayError) => {
      // 소켓이 죽어서 난 거절은 **에러 프레임으로 resolve** 한다 — 예전 onclose 가 하던 일이다.
      // 이 훅의 rpc 호출부 29곳은 throw 가 아니라 res.ok 로 분기한다. 타임아웃·미연결 거절은
      // 예전처럼 그대로 throw (transport 가 code 로 구분해준다).
      if (err?.code === 'ws_closed') {
        return { id: '', ok: false, error: { code: 'ws_closed', message: 'WebSocket closed' } } as ResponseFrame
      }
      throw err
    })
  }, [])

  // ── Per-message usage tracking — 메시지별 사용량 동기화 ─────────
  // 어시스턴트 응답이 끝날 때마다 호출.
  //   1) sessions.usage 로 오늘자 OpenRouter 사용량을 총합으로 조회
  //   2) 이전 스냅샷과 diff 하여 "이번 턴이 추가로 쓴 토큰/비용" 델타 계산
  //      (cacheRead 는 입력가의 25% 로 별도 계산 — 가격 식이 다름)
  //   3) 델타를 IPC(recordOpenRouterUsage) 로 Supabase 에 upsert
  //   4) liveUsage 상태 업데이트해 상태바에 즉시 반영 (라운드트립 없이)
  const syncUsageDelta = useCallback(async () => {
    if (!isElectron) return
    try {
      const today = new Date().toISOString().slice(0, 10)
      const res = await rpc('sessions.usage', { startDate: today, endDate: today, limit: 9999 }, 10_000)
      if (!res.ok) {
        console.warn('[twixy/syncUsage] sessions.usage failed:', res)
        return
      }
      const byModel = (res.payload as { aggregates?: { byModel?: Array<{ provider?: string; totals?: Record<string, number> }> } } | null)
        ?.aggregates?.byModel ?? []

      console.log('[twixy/syncUsage] byModel[0] totals:', byModel[0]?.totals, 'all entries:', byModel.map(e => ({ provider: e.provider, model: (e as Record<string,unknown>).model, totals: e.totals })))

      // Sum ALL providers — in Twixy-hosted mode everything routes through
      // OpenRouter. Provider name in OpenClaw session data may be 'openai'
      // (from the model string 'openai/gpt-5.4-mini') not 'openrouter', so
      // filtering by provider would silently miss all usage. The IPC handler
      // in main.ts already skips recording when mode !== 'twixy'.
      const cur: ModelTotals = { newInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0 }
      for (const e of byModel) {
        const t = e.totals ?? {}
        // Track new (non-cached) and cache-read tokens separately so we can
        // apply the correct price to each — cached tokens cost 25% of input.
        cur.newInputTokens  += (t.input     as number) || 0
        cur.cacheReadTokens += (t.cacheRead as number) || 0
        cur.outputTokens    += (t.output    as number) || 0
        cur.inputCost       += (t.inputCost as number) || 0
        cur.outputCost      += (t.outputCost as number) || 0
      }

      const prev = prevUsageRef.current
      const dNewIn   = Math.max(0, cur.newInputTokens   - prev.newInputTokens)
      const dCacheIn = Math.max(0, cur.cacheReadTokens  - prev.cacheReadTokens)
      const dOut     = Math.max(0, cur.outputTokens     - prev.outputTokens)
      // Prefer OpenClaw's own cost fields (inputCost + outputCost from
      // sessions.usage), computed from the per-model prices in openclaw.json
      // (themselves sourced from modelCatalog.json). When those are 0 (free
      // model like gpt-5.4-mini, or unrecognized model), fall back to
      // computeFallbackCost — same modelPricing.ts module the renderer cost
      // utilities use. This is RAW cost — markup is never applied here; the
      // delta flows straight to Supabase for accurate accounting.
      const dCost = Math.max(0, (cur.inputCost + cur.outputCost) - (prev.inputCost + prev.outputCost))
      const usdDelta = dCost > 0
        ? dCost
        : computeFallbackCost({ inputTokens: dNewIn, cacheReadTokens: dCacheIn, outputTokens: dOut })
      const delta = { tokensIn: dNewIn, tokensCacheIn: dCacheIn, tokensOut: dOut, usdDelta }
      prevUsageRef.current = cur

      // Attach token count to the last assistant message so the user can see
      // how many tokens each response used.
      const msgTokens = dNewIn + dCacheIn + dOut
      if (msgTokens > 0) {
        setMessages(prev => {
          const lastAssistantIdx = [...prev].reverse().findIndex(m => m.role === 'assistant')
          if (lastAssistantIdx === -1) return prev
          const idx = prev.length - 1 - lastAssistantIdx
          return prev.map((m, i) => i === idx ? { ...m, tokens: (m.tokens ?? 0) + msgTokens } : m)
        })
      }

      const result = await window.twixy?.recordOpenRouterUsage(delta)
      // Update live usage immediately from IPC response (includes usdActual
      // fetched directly from OpenRouter — no Supabase round-trip needed).
      setLiveUsage({
        tokensIn:  cur.newInputTokens + cur.cacheReadTokens,
        tokensOut: cur.outputTokens,
        usdToday:  typeof result?.usdActual === 'number' ? result.usdActual : usdDelta,
      })
    } catch (err) {
      console.warn('[twixy/syncUsage] error:', err)
    }
  }, [rpc])

  // ── Ensure a chat session + subscribe to its messages ──────────
  // 세션이 없으면 sessions.create 로 새로 만들고 key 를 ref 에 저장한다.
  // 이미 (구독까지 끝난) 세션이 있으면 no-op. session-level 이벤트(session.tool,
  // sessions.changed)도 함께 구독하여 툴 실행 상태와 서브에이전트 spawn/end 를
  // UI 에 표시할 수 있게 한다.
  // prevUsageRef 를 오늘치 현재 총합으로 시드해 이전 세션 사용량이 중복 계상되는 것을 방지.
  //
  // Best-effort 세션 재개: hydrate 가 디스크의 저장 키를 sessionKey.current 에
  // 미리 세팅해 둔다. 이때 sessions.create({ key }) 로 그 키를 넘겨 게이트웨이가
  // 과거 디스크 세션을 재개하도록 시도한다. 게이트웨이가 그 키를 모르면 새 세션을
  // 만들 뿐이며(컨텍스트는 못 살림), 스크롤백은 이미 복원돼 있으므로 graceful.
  // 어느 쪽이든 최종 확정 키를 mainSessionSet 으로 다시 저장한다.
  const ensureSession = useCallback(async () => {
    // Already subscribed to the live key — nothing to do. (sessionKey.current
    // may hold a *resumed* key from hydrate that has NOT been subscribed yet;
    // in that case fall through so we open + subscribe it on the gateway.)
    if (sessionKey.current && sessionSubscribedKey.current === sessionKey.current) {
      return sessionKey.current
    }
    try {
      // Pass the resumed key (if any) so the gateway reopens that disk session.
      const resumeKey = sessionKey.current
      const res = await rpc('sessions.create', resumeKey ? { key: resumeKey } : {})
      if (res.ok && res.payload?.key) {
        const key = res.payload.key as string
        sessionKey.current = key
        sessionSubscribedKey.current = key
        // Persist the confirmed key so the next launch resumes the same session.
        window.twixy.mainSessionSet({ sessionKey: key }).catch(() => { /* non-critical */ })
        // Subscribe so the gateway sends session.message events to us
        await rpc('sessions.messages.subscribe', { key })
        // Also subscribe to session-level events (session.tool, sessions.changed)
        // so we can surface tool activity (incl. subagent spawns) in the UI.
        try { await rpc('sessions.subscribe', {}) } catch { /* non-fatal */ }

        // Seed prevUsageRef with today's current totals so that the first
        // syncUsageDelta call only records the NEW delta for this session,
        // not the entire day's accumulated total (which would double-count
        // usage from previous sessions today).
        try {
          const today = new Date().toISOString().slice(0, 10)
          const su = await rpc('sessions.usage', { startDate: today, endDate: today, limit: 9999 }, 10_000)
          if (su.ok) {
            const byModel = (su.payload as { aggregates?: { byModel?: Array<{ provider?: string; totals?: Record<string, number> }> } } | null)
              ?.aggregates?.byModel ?? []
            const seed = { newInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0 }
            for (const e of byModel) {
              const t = e.totals ?? {}
              seed.newInputTokens  += (t.input     as number) || 0
              seed.cacheReadTokens += (t.cacheRead as number) || 0
              seed.outputTokens    += (t.output    as number) || 0
              seed.inputCost       += (t.inputCost as number) || 0
              seed.outputCost      += (t.outputCost as number) || 0
            }
            prevUsageRef.current = seed
          }
        } catch { /* non-fatal */ }

        return key
      }
    } catch (err) {
      console.warn('sessions.create failed:', err)
    }
    return null
  }, [rpc])

  // ── Connect handshake — WS 연결 + 게이트웨이 인증 ───────────────
  // 1) IPC 로 게이트웨이 토큰 획득
  // 2) WebSocket 오픈 후 게이트웨이가 connect.challenge 이벤트 발사
  // 3) connect RPC 로 client 정보/토큰/role=operator 로 응답 → 인증 성공 시 ready
  // 4) onmessage 핸들러에서 세션 메시지/툴 이벤트/서브에이전트 이벤트 라우팅
  //    (아래 블록이 이 훅에서 가장 긴 로직 — 400줄 가까이 된다)
  // ── 이벤트 라우팅 — transport 가 넘긴 raw 프레임을 이 훅이 해석한다 ──
  // (challenge 와 RPC 응답은 transport 가 먼저 처리하므로 여기 오지 않는다.)
  const handleEvent = useCallback((frame: GatewayEventFrame & Record<string, unknown>, raw: string) => {
    // ── Twixy session logging ─────────────────────────────────
    // Log all gateway event frames (not RPC responses) to the Twixy
    // workspace so session history is preserved independently of OpenClaw.
    if (isElectron && frame.type !== 'res' && sessionKey.current) {
      window.twixy.appendSessionLog({
        sessionId: sessionKey.current,
        line: raw,
      }).catch(() => { /* non-critical, never throw */ })
    }

    // ── Twixy Guardrail: forward plugin approval broadcasts ──
    // Dispatched as DOM events so useGuardrail can listen without
    // opening a second gateway WebSocket (which fails handshake
    // because the challenge-response is already consumed here).
    if (frame.event === 'plugin.approval.requested' || frame.event === 'plugin.approval.resolved') {
      try { window.dispatchEvent(new CustomEvent(`twixy:${frame.event}`, { detail: frame.payload })) } catch { /* ignore */ }
      return
    }

    // ── Sub-agent run tracking via agent lifecycle events ──
    // OpenClaw emits { event: 'agent', payload: { stream: 'lifecycle',
    // data: { phase: 'start'|'end'|'error' }, runId: '...' } } for every
    // LLM run. Sub-agent runs carry 'subagent' in their runId (e.g.
    // 'announce:v1:agent:main:subagent:...'). We track active sub-agent
    // runs so chat.final deferral works even when sessions.changed events
    // for sub-agent spawn arrive late or out of order.
    if (frame.event === 'agent') {
      const agentPayload = frame.payload as Record<string, unknown> | undefined
      const agentRunId   = agentPayload?.runId as string | undefined
      const agentStream  = agentPayload?.stream as string | undefined
      const agentData    = agentPayload?.data as Record<string, unknown> | undefined
      const agentSessionKey = agentPayload?.sessionKey as string | undefined
      if (
        agentStream === 'lifecycle' &&
        agentRunId  &&
        agentSessionKey === sessionKey.current
      ) {
        const phase = agentData?.phase as string | undefined
        // When a plan has been aborted, intercept any autonomous LLM run
        // (one not awaited by our code) and abort it immediately. This prevents
        // late subagent results from autonomously restarting plan execution.
        // We check turnAwaitersRef.length === 0 to distinguish autonomous runs
        // from runs we intentionally triggered (e.g. PLAN_ABORTED injection or
        // verifyAcceptance), which always push an awaiter before the run starts.
        if (phase === 'start' && rejectNewRunsRef.current && turnAwaitersRef.current.length === 0) {
          rpc('sessions.abort', { key: agentSessionKey }).catch(() => {})
          return
        }
        if (agentRunId.includes('subagent')) {
          if (phase === 'start') {
            subagentSessionsRef.current.set(agentRunId, agentRunId)
          } else if (phase === 'end' || phase === 'error') {
            subagentSessionsRef.current.delete(agentRunId)
            // If root already finaled while this sub-agent was busy and
            // it's now the last one, flip isThinking off immediately.
            if (
              rootFinaledWhileSubagentBusy.current &&
              subagentSessionsRef.current.size === 0
            ) {
              if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
              rootFinaledWhileSubagentBusy.current = false
              activeToolsRef.current.clear()
              setIsThinking(false)
              setToolActivity(null)
              setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
            }
          }
        }
      }
      return
    }

    // ── Run complete — AI has finished its turn ──
    // OpenClaw broadcasts { event: 'chat', payload: { state: 'final' | 'error', ... } }
    // when a run ends. We only treat this as terminal when:
    //   (a) the final belongs to OUR root session — sub-agent child sessions
    //       also emit their own 'chat' final, and if we react to those the
    //       UI snaps to "done" while the parent is still working (this is
    //       what makes the spinner/searching pill disappear mid-browser run)
    //   (b) no sub-agent sessions are still active — even if root says final,
    //       a delegated browser/exec sub-agent may still have minutes of work
    //       left, and the user-facing reply will only land after that
    //       finishes. Killing isThinking here would re-create the old "...
    //       cuts off" bug.
    if (frame.event === 'chat') {
      const state = frame.payload?.state as string | undefined
      const evtSessionKey = (frame.payload?.sessionKey ?? frame.payload?.key) as string | undefined
      const isRootFinal = !evtSessionKey || evtSessionKey === sessionKey.current
      // chat.error — 게이트웨이가 턴을 실패로 닫은 경우. 여기를 안 잡으면
      // (403 처럼 assistant 메시지 없이 죽는 실패에서) isThinking 이 영원히
      // true 로 남고 유저는 원인도 못 본다.
      if (state === 'error' && isRootFinal) {
        const errMsg = (frame.payload?.error as { message?: string } | undefined)?.message
          ?? (frame.payload?.message as string | undefined)
        if (errMsg) surfaceRunError(errMsg)
        if (turnAwaitersRef.current.length > 0) {
          const pending = turnAwaitersRef.current
          turnAwaitersRef.current = []
          for (const a of pending) a.reject(new Error(errMsg || 'chat_error'))
        }
        if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
        rootFinaledWhileSubagentBusy.current = false
        activeToolsRef.current.clear()
        setIsThinking(false)
        setToolActivity(null)
        setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
        return
      }
      if (state === 'final' && isRootFinal) {
        if (rootFinaledWhileSubagentBusy.current) {
          // Second chat.final — sub-agent has returned its result and the
          // main agent has generated its final answer. This is definitively
          // done regardless of subagentSessions state.
          if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
          rootFinaledWhileSubagentBusy.current = false
          activeToolsRef.current.clear()
          // Do NOT bulk-clear subagentSessionsRef here: announces can
          // spawn NEW subagents (announce #1 → sub #2) whose create event
          // already populated the ref, but the announce's own chat.final
          // lands *before* those new subagents finish. Clearing here
          // erases them, so the plan's step-end killActiveSubagents finds
          // an empty ref and dispatches no sessions.delete — leaving the
          // new subagent's announce to autonomously wake the main LLM.
          // Entries are removed via sessions.changed phase:"end"/"error"
          // on their own keys instead.
          setIsThinking(false)
          setToolActivity(null)
          setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
          return
        }
        // session.tool events are sent with dropIfSlow:true by the gateway,
        // so tool-end events can be silently dropped. activeToolsRef may have
        // stale entries even though all tools are done — the model already
        // incorporated their results before emitting chat.final.
        // We only need to defer when a real sub-agent SESSION is still running
        // (subagentSessionsRef tracks those via sessions.changed events).
        activeToolsRef.current.clear()
        if (subagentSessionsRef.current.size > 0) {
          // A sub-agent is still running in its own session. The root will
          // emit a second chat.final once the sub-agent finishes and the
          // main model generates its final answer. Defer until then.
          rootFinaledWhileSubagentBusy.current = true
          // Safety-net: if the subagent-complete event is also dropped,
          // force-clear after 15s so the UI doesn't stay stuck forever.
          if (finalFallbackTimer.current) clearTimeout(finalFallbackTimer.current)
          finalFallbackTimer.current = setTimeout(() => {
            finalFallbackTimer.current = null
            if (!rootFinaledWhileSubagentBusy.current) return
            rootFinaledWhileSubagentBusy.current = false
            subagentSessionsRef.current.clear()
            setIsThinking(false)
            setToolActivity(null)
            setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
          }, 15_000)
          return
        }
        // Grace window: a sub-agent `create` event may be buffered behind
        // this chat.final. If we clear isThinking immediately, the stop
        // button and tool activity vanish even though a child session is
        // about to spawn. Wait ~400ms, then re-check subagentSessionsRef.
        if (finalFallbackTimer.current) clearTimeout(finalFallbackTimer.current)
        finalFallbackTimer.current = setTimeout(() => {
          finalFallbackTimer.current = null
          if (subagentSessionsRef.current.size > 0) {
            // A sub-agent spawn arrived during the grace window. Transition
            // into deferred mode and install the 15s safety-net.
            rootFinaledWhileSubagentBusy.current = true
            finalFallbackTimer.current = setTimeout(() => {
              finalFallbackTimer.current = null
              if (!rootFinaledWhileSubagentBusy.current) return
              rootFinaledWhileSubagentBusy.current = false
              subagentSessionsRef.current.clear()
              setIsThinking(false)
              setToolActivity(null)
              setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
            }, 15_000)
            return
          }
          subagentSessionsRef.current.clear()
          setIsThinking(false)
          setToolActivity(null)
          setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
        }, 400)
      }
      return
    }

    // ── Tool activity (incl. sub-agent spawns) ──
    // session.tool events fire on every tool start/end. We track in-flight
    // tools by callId and surface the most recent one as `toolActivity`
    // so the chat panel can show "Working: subagents.spawn" instead of a
    // silent spinner. Subagent calls are flagged so the UI can render a
    // distinct label like "Sub-agent working...".
    if (frame.event === 'session.tool') {
      const data    = (frame.payload?.data ?? frame.payload) as Record<string, unknown> | undefined
      const phase   = data?.phase as string | undefined
      const toolRaw = (data?.tool_name ?? data?.toolName ?? data?.name ?? data?.function_name ?? data?.functionName) as string | undefined
      const callId  = (data?.call_id ?? data?.callId ?? data?.toolCallId ?? data?.toolUseId ?? data?.id ?? data?.tool_call_id) as string | undefined
      const evtSessionKey = (frame.payload?.sessionKey ?? data?.sessionKey) as string | undefined
      const toolName = (toolRaw ?? '').toString()
      const args = (data?.args ?? data?.arguments ?? data?.input ?? {}) as Record<string, unknown>
      if (!toolName || !callId) return
      // Two ways a tool call counts as "sub-agent activity":
      //  (a) the tool itself is the `subagents` orchestration tool, or
      //  (b) the event's sessionKey belongs to a known sub-agent child
      //      session (i.e. not our root key) — this is how we surface
      //      browser/exec/etc. work happening *inside* the sub-agent.
      const isSubagentTool = /^subagents?(\.|$)/i.test(toolName) || toolName === 'subagent'
      const isChildSession = !!evtSessionKey && evtSessionKey !== sessionKey.current
      const isSubagent = isSubagentTool || isChildSession
      const subagentLabel = isChildSession && evtSessionKey ? subagentSessionsRef.current.get(evtSessionKey) : undefined
      if (phase === 'start' || phase === 'tool_use' || phase === 'update') {
        // Local fast-fail cap (UX only). The authoritative search quota
        // now lives in the Tavily proxy on the web app:
        // /api/tavily-proxy increments user_subscriptions.searches_today
        // server-side on every successful Tavily call and returns 429
        // when the user is over limit. We keep this localStorage
        // counter purely as an offline UX hint so the chat can warn
        // the user before the proxy starts refusing.
        if (toolName === 'web_search' && !activeToolsRef.current.has(callId)) {
          const used = bumpSearchCount()
          if (used === DAILY_SEARCH_CAP) {
            addMessage('system', `⚠️ Daily web search limit reached (${DAILY_SEARCH_CAP}/day). Further searches will be blocked until tomorrow.`)
          }
        }
        const detail = formatToolDetail(toolName, args)
        const entry: ToolActivity = {
          name: toolName,
          sessionKey: evtSessionKey,
          isSubagent,
          subagentLabel,
          detail,
          callId,
        }
        // Bump aggregate stats only on the FIRST observation of a callId
        // so retried 'tool_use' frames don't double-count.
        if (!activeToolsRef.current.has(callId)) {
          // logbook L8 마커: plan step 실행(L7 창) 중에 시작된 도구 호출만
          // 발사된다 — 일반 채팅/플래너/컴팩션 턴은 src/lib/logbook.ts 의
          // 창 게이트에서 걸러진다. fire-and-forget, 실패 무해.
          logbookToolStart(callId, toolName)
          setToolStats(prev => ({
            count: prev.count + 1,
            startedAt: prev.startedAt ?? Date.now(),
            lastName: toolName,
            lastIsSubagent: isSubagent,
          }))
          // Also record the tool call into any in-flight plan-turn
          // awaiters so the plan runner can surface it in run.md.
          for (const a of turnAwaitersRef.current) {
            a.toolCalls.push({ name: toolName, detail: detail ?? undefined })
          }
        }
        activeToolsRef.current.set(callId, entry)
        setToolActivity(entry)
      } else if (phase === 'end' || phase === 'tool_result' || phase === 'error') {
        // logbook L8 end — 이 창에서 start 를 발사한 callId 에 대해서만.
        logbookToolEnd(callId)
        activeToolsRef.current.delete(callId)
        const remaining = [...activeToolsRef.current.values()]
        setToolActivity(remaining[remaining.length - 1] ?? null)
        // If root already final-ed while tools were in-flight, check now.
        if (rootFinaledWhileSubagentBusy.current
            && activeToolsRef.current.size === 0
            && subagentSessionsRef.current.size === 0) {
          if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
          rootFinaledWhileSubagentBusy.current = false
          setIsThinking(false)
          setToolActivity(null)
          setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
        }
      }
      return
    }


    // ── Session message event (assistant reply) ──
    // NOTE: do NOT setIsThinking(false) here — the AI may send intermediate
    // messages ("let me check…") and keep working. Wait for the 'chat' final event.
    // ── Sub-agent lifecycle (sessions.changed) ──
    // Gateway broadcasts sessions.changed with reason='subagent_spawned'
    // / 'subagent_ended' whenever a child session starts/ends. We use it
    // to drive a persistent "🤖 Sub-agent: <label>…" pill so the UI
    // doesn't go silent during long delegated runs.
    if (frame.event === 'sessions.changed') {
      const reason       = frame.payload?.reason as string | undefined
      const childKey     = frame.payload?.sessionKey as string | undefined
      const parentKey    = frame.payload?.parentSessionKey as string | undefined
      const kind         = frame.payload?.kind as string | undefined
      const label        = (frame.payload?.label ?? frame.payload?.displayName ?? 'sub-agent') as string
      // Real reason strings emitted by OpenClaw (see pi-embedded ~L22879):
      //   spawn  → reason: 'create'
      //   status → reason: 'subagent-status'  (periodic update while running)
      //   end    → reason: 'subagent-complete' | 'subagent-error' | 'subagent-killed'
      // We previously used 'subagent_spawned'/'subagent_ended' which never matched.
      const isSpawnReason  = reason === 'create'
      const isStatusReason = reason === 'subagent-status'
      // The gateway actually never emits reason:"subagent-complete/error/killed"
      // in sessions.changed — those reason strings were a documentation
      // mismatch. End signal is `phase:"end"` on the subagent sessionKey
      // (no `reason` field). We key off phase here too so subagents get
      // removed from the ref when they genuinely finish.
      const phaseVal       = frame.payload?.phase as string | undefined
      const isEndReason    = reason === 'subagent-complete' || reason === 'subagent-error' || reason === 'subagent-killed' || phaseVal === 'end' || phaseVal === 'error'
      // Only react to children of OUR root session. Detection is by the
      // key path — the gateway marks subagent sessions as kind:"direct"
      // (not "subagent"), so filtering by `kind` drops every real spawn
      // (confirmed in session log: create events carry kind:"direct"
      // with sessionKey="agent:main:subagent:<uuid>"). Without this fix,
      // subagentSessionsRef stayed empty and killActiveSubagents became a
      // no-op, leaving late subagent_announce to autonomously restart the
      // main LLM after plan failure.
      const childIsSubagent = typeof childKey === 'string' && childKey.includes(':subagent:')
      if (childKey && parentKey && parentKey === sessionKey.current && childIsSubagent) {
        if (isSpawnReason) {
          subagentSessionsRef.current.set(childKey, label)
          // Track for kill too. subagentSessionsRef gets .delete(childKey)
          // on phase:"end" (so UI flips back to idle), but the gateway's
          // runSubagentAnnounceFlow is still live after that event until
          // the announce is delivered. killActiveSubagents uses this ref
          // instead so sessions.delete actually reaches the registry and
          // our pi-embedded patch can set suppressAnnounceReason="killed".
          subagentKillRef.current.add(childKey)
          setToolActivity({ name: 'subagents', sessionKey: childKey, isSubagent: true, subagentLabel: label })
        } else if (isStatusReason) {
          // Only refresh label if already tracked — never re-add after subagent-complete.
          if (subagentSessionsRef.current.has(childKey)) {
            subagentSessionsRef.current.set(childKey, label)
            setToolActivity({ name: 'subagents', sessionKey: childKey, isSubagent: true, subagentLabel: label })
          }
        } else if (isEndReason) {
          subagentSessionsRef.current.delete(childKey)
          // Drop any in-flight tool entries belonging to this child.
          for (const [cid, entry] of activeToolsRef.current) {
            if (entry.sessionKey === childKey) activeToolsRef.current.delete(cid)
          }
          if (subagentSessionsRef.current.size === 0) {
            // Last sub-agent just wrapped. If the root session had
            // already final-ed earlier (and we deferred isThinking=false
            // because a child was still busy), now is the time to
            // actually flip the UI back to idle.
            if (rootFinaledWhileSubagentBusy.current) {
              if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
              rootFinaledWhileSubagentBusy.current = false
              setIsThinking(false)
              activeToolsRef.current.clear()
              setToolActivity(null)
              setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
              return
            }
            const remaining = [...activeToolsRef.current.values()]
            setToolActivity(remaining[remaining.length - 1] ?? null)
          } else {
            const [firstKey, firstLabel] = subagentSessionsRef.current.entries().next().value as [string, string]
            setToolActivity({ name: 'subagents', sessionKey: firstKey, isSubagent: true, subagentLabel: firstLabel })
          }
        }
      }
      return
    }

    if (frame.event === 'session.message') {
      const msg   = frame.payload?.message as Record<string, unknown> | undefined
      const msgId = frame.payload?.messageId as string | undefined
      const msgSessionKey = frame.payload?.sessionKey as string | undefined
      // CRITICAL: only render messages belonging to our root session.
      // Sub-agent child sessions also broadcast session.message events,
      // and without this filter their assistant replies would get dumped
      // straight into the user-facing chat alongside the parent's own
      // final message ("두 개 뜸" bug).
      if (msgSessionKey && sessionKey.current && msgSessionKey !== sessionKey.current) return
      // Exec-approval messages carry channelData.execApproval and are
      // meant for a native approval UI (buttons), not for the chat.
      // Without this guard the raw "/approve <id> allow-once" text
      // leaks into the conversation as a plain assistant bubble.
      const channelData = msg?.channelData as Record<string, unknown> | undefined
      const isApprovalMsg = Boolean(channelData?.execApproval)
      if (msg?.role === 'assistant' && !isApprovalMsg) {
        const text = extractText(msg.content)
        // Aborted runs land here as `content: []` + `stopReason: "aborted"`
        // (or `errorMessage` set). extractText returns "" so the normal
        // append branch below would silently drop the message — leaving
        // the awaiter unresolved and isThinking=true forever (the
        // infinite-thinking bug). Treat as terminal: reject pending
        // awaiters and flip UI back to idle.
        //
        // BUT: when the main agent calls sessions_yield to wait for a
        // sub-agent, the gateway may emit a transient session.message
        // with empty content + abort-like fields before the sub-agent
        // completes and autonomously wakes the main session. If we
        // reject here, the plan runner sees `interrupted=true` and marks
        // the step interrupted even though the sub-agent's work is still
        // pending. Skip when a sub-agent is still in flight (or root has
        // already deferred final waiting on one).
        const stopReason = msg.stopReason as string | undefined
        const errorMessage = msg.errorMessage as string | undefined
        const looksAborted = !text && (stopReason === 'aborted' || stopReason === 'error' || errorMessage)
        const subagentInFlight = subagentSessionsRef.current.size > 0 || rootFinaledWhileSubagentBusy.current
        if (looksAborted && !subagentInFlight) {
          const reason = errorMessage || stopReason || 'aborted'
          // 프로바이더가 턴을 죽인 경우(크레딧 소진, 레이트리밋, 키 무효)
          // 지금까지는 빈 assistant 메시지가 조용히 버려져 유저에게는
          // "스피너가 멈추고 아무 말도 없음" 으로만 보였다. 원인을 시스템
          // 메시지로 채팅에 남긴다. 사용자 Stop 은 제외 (errorMessage 없음).
          if (errorMessage) surfaceRunError(errorMessage)
          if (turnAwaitersRef.current.length > 0) {
            const pending = turnAwaitersRef.current
            turnAwaitersRef.current = []
            for (const a of pending) a.reject(new Error(`run_${reason}`))
          }
          if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
          rootFinaledWhileSubagentBusy.current = false
          setIsThinking(false)
          setToolActivity(null)
          setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
          return
        }
        if (looksAborted && subagentInFlight) {
          // Skip: sub-agent will wake us later. Don't drop the message
          // in a way that hides the lifecycle, but do nothing else.
          return
        }
        // NO_REPLY is an internal signal the model emits when it spawns a
        // sub-agent and has nothing to say to the user directly. Drop it
        // before it enters state so it never reaches the UI.
        if (text && text.trim() !== 'NO_REPLY') {
          if (msgId) {
            if (seenMsgIds.current.has(msgId)) {
              // Already exists — update content in-place (streaming)
              setMessages(prev => {
                const idx = prev.findIndex(m => m.id === msgId)
                if (idx < 0) return prev
                const next = [...prev]
                next[idx] = { ...next[idx], content: text }
                return next
              })
            } else {
              // New message — register first (sync), then append
              seenMsgIds.current.add(msgId)
              setMessages(prev => [...prev, {
                id: msgId,
                role: 'assistant' as MessageRole,
                content: text,
                timestamp: new Date(),
              }])
              // Debounce usage sync: wait 2s for any trailing streaming
              // updates before sampling sessions.usage.
              if (usageSyncTimer.current) clearTimeout(usageSyncTimer.current)
              usageSyncTimer.current = setTimeout(() => void syncUsageDelta(), 2_000)
            }
          } else {
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'assistant' as MessageRole,
              content: text,
              timestamp: new Date(),
            }])
          }
        }
      }
      return
    }

    // Generic/unhandled events — ignore
  }, [rpc, ensureSession, surfaceRunError])

  // ── 연결이 사라졌을 때 — 자동 재연결 포함 (transport 는 재연결하지 않는다) ──
  // dispose() 로 우리가 끊을 때는 호출되지 않는다 → 언마운트/수동 재연결이 재연결 타이머를
  // 다시 걸던 문제(계약표 #5)가 구조적으로 사라진다.
  // handleClose 가 거는 재연결 — connect 는 아래에서 정의되므로 최신 참조를 ref 로 받는다.
  const connectRef = useRef<() => void>(() => { /* connect 정의 전 */ })

  const handleClose = useCallback(() => {
    sessionKey.current = null
    sessionSubscribedKey.current = null
    for (const a of turnAwaitersRef.current) a.reject(new Error('ws_closed'))
    turnAwaitersRef.current = []
    if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
    rootFinaledWhileSubagentBusy.current = false
    activeToolsRef.current.clear()
    subagentSessionsRef.current.clear()
    subagentKillRef.current.clear()
    setToolActivity(null)
    setIsThinking(false)
    retryCount.current += 1
    const maxRetries = isManualRetry.current ? MAX_MANUAL_RETRIES : MAX_AUTO_RETRIES
    if (retryCount.current < maxRetries) {
      setStatus('connecting')
      const delay = Math.min(1500 * Math.pow(2, retryCount.current - 1), 12_000)
      reconnectTimer.current = setTimeout(() => connectRef.current(), delay)
    } else {
      setStatus('disconnected')
    }
  }, [])

  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    const t = createRendererTransport('Twixy', 'OpenClaw WS error')
    t.onClose(handleClose)
    t.onEvent(handleEvent)
    transportRef.current = t
    return t
  }, [handleClose, handleEvent])

  // ── Connect — WS 연결 + 게이트웨이 인증 ─────────────────────────
  // 토큰 조회·challenge 응답은 transport 가 한다. 여기서는 재시도 한도와 상태만 다룬다.
  const connect = useCallback(async () => {
    if (!isElectron) return
    const t = getTransport()
    if (t.isConnected()) return
    const maxRetries = isManualRetry.current ? MAX_MANUAL_RETRIES : MAX_AUTO_RETRIES
    if (retryCount.current >= maxRetries) { setStatus('error'); return }

    try {
      await t.ensureConnected()
      retryCount.current    = 0
      isManualRetry.current = false   // reset on successful connect
      setStatus('ready')
      // 세션(sessions.create)은 여기서 만들지 않는다 — 첫 실제 전송
      // (sendMessage / sendAndAwaitFinal 의 ensureSession)에서 lazy 생성.
      // 콜드 게이트웨이에서 sessions.create 가 1.6s+ 걸려 시작 부하에 얹히던 걸 없앤다.
    } catch (err) {
      // 게이트웨이가 핸드셰이크를 거절한 경우에만 사유를 표면화한다 (예: 1008 device identity).
      // 그 밖의 실패는 소켓이 끊긴 것이고, 상태(재연결 중 / 포기)는 handleClose 가 이미 정했다 —
      // 여기서 덮어쓰면 재시도를 다 쓴 뒤의 'disconnected' 가 'error' 로 바뀐다.
      const code = (err as GatewayError)?.code
      if (code === 'auth_rejected') setErrorMsg(err instanceof Error ? err.message : String(err))
      // 소켓 정리는 transport 가 이미 했다. 재연결 타이머는 handleClose 가 건다.
    }
  }, [getTransport])

  useEffect(() => { connectRef.current = connect }, [connect])

  // ── Hydrate — 디스크에서 메인 채팅 복원 (마운트 1회) ─────────────
  // 1) 저장된 게이트웨이 세션키를 ref 에 미리 세팅 → ensureSession 이 재개 시도.
  //    (connect 는 setTimeout(800ms) 으로 지연되므로 이 비동기 로드가 거의 항상
  //     먼저 끝나 sessionKey.current 가 세팅된 채로 ensureSession 이 호출된다.)
  // 2) main-chat.jsonl 을 읽어 messages 를 직접 채운다. hydratingRef 로 가드해
  //    복원된 메시지가 다시 디스크로 append 되는 무한 중복을 막는다.
  // 3) 복원된 어시스턴트 메시지의 planId 가 디스크에 더 이상 없는 plan 을 가리키면
  //    planId 를 떼어 일반 텍스트 버블로 폴백(PlanCard 의 "Plan unavailable" 빈
  //    카드가 원문을 가리는 것 방지). 원래 content 는 그대로 유지.
  useEffect(() => {
    if (!isElectron) return
    let cancelled = false
    ;(async () => {
      // 1) session key
      try {
        const r = await window.twixy.mainSessionGet()
        if (!cancelled && r?.sessionKey) sessionKey.current = r.sessionKey
      } catch { /* best-effort */ }

      // 2) scrollback
      let lines: Awaited<ReturnType<typeof window.twixy.mainChatLoad>> = []
      try { lines = await window.twixy.mainChatLoad() } catch { lines = [] }
      if (cancelled || lines.length === 0) return

      // 3) planId fallback — drop planIds whose plan no longer exists on disk.
      const planIds = [...new Set(lines.map(l => l.planId).filter((p): p is string => !!p))]
      const alivePlans = new Set<string>()
      await Promise.all(planIds.map(async pid => {
        try {
          const p = await window.twixy.planGet(pid)
          if (p) alivePlans.add(pid)
        } catch { /* treat as missing */ }
      }))
      if (cancelled) return

      const restored: ChatMessage[] = lines.map(l => ({
        id:        l.id,
        role:      l.role as MessageRole,
        content:   l.content,
        timestamp: new Date(l.timestamp),
        tokens:    l.tokens,
        planId:    l.planId && alivePlans.has(l.planId) ? l.planId : undefined,
        toolCalls: l.toolCalls,
        actions:   l.actions as ChatMessage['actions'],
      }))
      // Mark every restored id as already persisted so the post-turn pipeline
      // (and any other append path) never re-writes them.
      for (const m of restored) persistedIds.current.add(m.id)
      hydratingRef.current = true
      setMessages(restored)
      // Release the guard on the next tick — setMessages is synchronous for
      // our purposes here, and no append path fires synchronously within it.
      hydratingRef.current = false
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Lifecycle — 훅 마운트/언마운트 + 게이트웨이 이벤트 구독 ─────
  // 마운트 시: openclaw-ready 이벤트를 구독해 게이트웨이가 올라오면 connect 재시도.
  // 언마운트 시: WS/타이머/워처 정리. 중복 연결 방지용 guard 포함.
  useEffect(() => {
    if (!isElectron) return

    const offReady = window.twixy.onOpenClawReady(() => {
      // Gateway just (re)started — fully tear down any stale socket/timers
      // before reconnecting. We detach onclose so the auto-reconnect path
      // doesn't race with the manual one — but that means we have to do
      // the close-side cleanup (thinking spinner, pending RPCs, etc.) by
      // hand here, otherwise the chat stays stuck on "loading" forever.
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      // dispose 는 onClose 를 부르지 않는다 — 자동 재연결 경로와 경합하지 않게 우리가 직접 정리하고
      // 다시 연결한다 (예전에 onclose 를 떼어내고 close() 하던 것과 같은 의도).
      // 떠 있던 RPC 는 dispose 가 ws_closed 로 거절하고, 위의 rpc 래퍼가 에러 프레임으로 바꿔
      // 호출자를 깨운다 — per-call 타임아웃까지 매달려 있지 않는다.
      transportRef.current?.dispose()
      transportRef.current = null
      if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
      rootFinaledWhileSubagentBusy.current = false
      activeToolsRef.current.clear()
      subagentSessionsRef.current.clear()
      subagentKillRef.current.clear()
      setToolActivity(null)
      sessionKey.current     = null
      sessionSubscribedKey.current = null
      seenMsgIds.current.clear()
      retryCount.current     = 0
      isManualRetry.current  = false
      setIsThinking(false)
      setErrorMsg(undefined)
      setStatus('connecting')
      connect()
    })

    const offError = window.twixy.onOpenClawError((err) => {
      setStatus('error')
      setErrorMsg(err)
      addMessage('system', `⚠️ OpenClaw failed to start: ${err}`)
    })

    // 키 없이 뜬 경우. 예전엔 아무 표시가 없어서 "보내면 3분 뒤 타임아웃" 만
    // 반복됐다 — 원인을 알 수가 없다. 자동 복구(auth-save-session → 키 재발급
    // → 게이트웨이 재시작)가 대개 몇 초 안에 걸리므로 그 사실도 같이 알린다.
    const offKeyMissing = window.twixy.onOpenRouterKeyMissing?.(() => {
      addMessage('system', '⚠️ 로그인 세션이 만료된 채로 앱이 시작돼 AI 키를 받지 못했습니다. 자동으로 복구를 시도합니다 — 몇 초 뒤에도 응답이 없으면 앱을 재시작해 주세요.')
    })

    const offLimitExceeded = window.twixy.onOpenRouterLimitExceeded?.(() => {
      // Stop the thinking spinner and show a clear message.
      setIsThinking(false)
      addMessage('system', "You've reached your daily AI usage limit. It resets automatically at midnight UTC. Upgrade to Pro for more messages.")
    })

    const t = setTimeout(connect, 800)
    return () => {
      clearTimeout(t)
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
      // 턴이 걸어둔 타이머도 정리한다 (계약표 #7) — 안 지우면 언마운트 뒤에 깨어나
      // 언마운트된 컴포넌트에 setState 하거나 usage RPC 를 죽은 소켓으로 쏜다.
      if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
      if (usageSyncTimer.current) { clearTimeout(usageSyncTimer.current); usageSyncTimer.current = null }
      // dispose 는 onClose 를 부르지 않으므로 재연결 타이머가 다시 걸리지 않는다 (계약표 #5).
      // 메인 채팅 세션은 **반납하지 않는다** — 세션 키를 디스크에 저장해 다음 실행에서
      // 그대로 재개하는 게 이 훅의 설계다 (다른 훅들과 다른 점).
      transportRef.current?.dispose()
      transportRef.current = null
      offReady?.()
      offError?.()
      offKeyMissing?.()
      offLimitExceeded?.()
    }
  }, [connect, addMessage])

  // ── Send chat message — 사용자 메시지 전송 ──────────────────────
  // 1) messages 배열에 user 메시지 append (즉시 UI 반영)
  // 2) ensureSession 으로 세션 보장
  // 3) sessions.send RPC — 90초 타임아웃 (느린 툴 실행 케이스 고려)
  // 4) isThinking=true 로 놓고, 응답은 onmessage 의 session.message 이벤트로 수신
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return

    if (!isElectron) {
      addMessage('system', 'Please run inside the Electron app (npm run dev)')
      return
    }
    if (status !== 'ready') {
      addMessage('system', 'Connecting to gateway... please try again in a moment.')
      return
    }

    addMessage('user', text)

    // A user-typed send always clears any sticky plan-level rejectNewRuns lock.
    // The lock can persist across chats when a plan was stopped without Resume
    // / Try-again (the only paths that clear it). Without this, the lifecycle
    // 'start' guard self-aborts the new run with stopReason:"rpc" before the
    // model is ever invoked.
    rejectNewRunsRef.current = false

    // Warn (but don't block) if the daily search quota is already exhausted.
    // The agent can still answer from its own knowledge / other tools, so we
    // just surface a notice and let the turn proceed.
    const usedToday = readSearchCount()
    if (usedToday >= DAILY_SEARCH_CAP) {
      addMessage('system', `⚠️ Daily web search limit reached (${usedToday}/${DAILY_SEARCH_CAP}). Web search is disabled until ${todayKey()} UTC rolls over.`)
    }

    setIsThinking(true)
    // Reset progress counters at the start of each turn so the UI shows
    // a fresh "0 calls · 0s" baseline rather than stale counts from the
    // previous turn.
    setToolStats({ count: 0, startedAt: Date.now(), lastName: null, lastIsSubagent: false })

    const sid = await ensureSession()
    if (!sid) {
      setIsThinking(false)
      addMessage('system', 'Failed to create session. Please restart the app.')
      return
    }

    // Auto-unfreeze before sending — any new user input implicitly lifts the
    // requester-level announce freeze that plan-mode set on failure. Fire and
    // forget; the gateway call is idempotent.
    rpc('twixy.freezeRequesterAnnounce', { key: sid, frozen: false }, 5_000).catch(() => {})

    try {
      // 10-minute timeout: sessions.send only resolves once the gateway has
      // accepted the run, which can block on a slow first tool call (e.g.
      // web_fetch on a pasted URL hitting a redirect loop). The actual
      // assistant reply arrives separately via session.message events, so
      // this long timeout only protects us from the WS genuinely dying.
      // Workaround: openclaw gateway hangs (no model invocation, infinite
      // spinner) when a user message's first non-whitespace token looks like
      // a URL. Cause is somewhere inside openclaw's user-message preprocess
      // path — likely an auto link enrichment that blocks. Tested matrix:
      //   "https://x ..."        → hang
      //   " https://x ..."       → hang  (leading space doesn't help)
      //   ".https://x ..."       → hang  (leading punct doesn't help)
      //   "테스트 https://x ..."  → works (any non-URL leading token works)
      // So if the first token is URL-shaped, prepend a longer dummy preamble
      // that (a) is plain ASCII so it doesn't bias the reply language and
      // (b) explicitly tells the model to ignore the preamble itself, so it
      // doesn't echo "Ref" or get confused. Single-word "Ref" turned out to
      // be insufficient — some URL-leading messages still hung the gateway,
      // suggesting the link-understanding preprocessor needs a more
      // substantial non-URL prefix before it bails out.
      const firstToken = text.trimStart().split(/\s+/, 1)[0] ?? ''
      const safeText = /^https?:\/\//i.test(firstToken)
        ? `[system: the following line is internal padding, ignore it and do not mention it to the user]\nplaceholder placeholder placeholder\n\n${text}`
        : text
      await rpc('sessions.send', {
        key: sid,
        message: safeText,
      }, 10 * 60 * 1000)
    } catch (err) {
      setIsThinking(false)
      addMessage('system', `Send failed: ${String(err)}`)
    }
  }, [status, rpc, ensureSession, addMessage])

  // ── Abort — 현재 실행중인 턴 중단 ───────────────────────────────
  // 게이트웨이의 sessions.abort 를 호출해 내부의 chat.abort 까지 전달되어
  // 실행중이던 툴/모델 스트림이 취소된다. 실패해도 UI 의 thinking 은 반드시 내린다.
  const abortMessage = useCallback(async () => {
    const sid = sessionKey.current
    if (!sid) {
      setIsThinking(false)
      return
    }
    try {
      await rpc('sessions.abort', { key: sid })
    } catch {
      // Even if the RPC fails, drop the local thinking state so the UI
      // doesn't get stuck.
    } finally {
      setIsThinking(false)
      setToolActivity(null)
      addMessage('system', 'Stopped.')
    }
  }, [rpc, addMessage])

  // ── cancelActiveTurn — 호출자가 await 중인 sendAndAwaitFinal 들을 즉시 reject ─
  // abortMessage 와 다른 점: abortMessage 는 게이트웨이만 stop 시키고 awaiter 는
  // chat.final / chat.abort 이벤트가 오기를 기다리거나 turn_timeout 까지 갇혀
  // 있을 수 있음. 이건 sessions.abort 호출 + 모든 in-flight TurnAwaiter 를
  // 동기적으로 reject('cancelled') 해 호출자가 즉시 catch 로 빠지게 만든다.
  // workflow Test 의 Stop 버튼이 chrome 노드 진행 중에도 즉시 효과 보게 하기 위함.
  const cancelActiveTurn = useCallback(async () => {
    // 1) 게이트웨이 측 turn 중단 (best-effort) — 실패해도 다음 단계 진행.
    const sid = sessionKey.current
    if (sid) {
      try { await rpc('sessions.abort', { key: sid }) } catch { /* non-fatal */ }
    }
    // 2) Renderer 측 awaiter 들 즉시 reject — for 루프 await 가 throw 로 빠짐.
    const pending = turnAwaitersRef.current
    turnAwaitersRef.current = []
    for (const a of pending) {
      try { a.reject(new Error('cancelled')) } catch { /* ignore */ }
    }
    setIsThinking(false)
    setToolActivity(null)
  }, [rpc])

  // ── Manual reconnect — 사용자가 누르는 재연결 버튼 ──────────────
  // 자동 재시도(최대 8회) 를 다 쓴 뒤에도 status='error' 일 때 사용자가 누르는 경로.
  // 즉시 3회 빠른 재시도 후에도 실패하면 "앱 재시작 권장" 문구를 보여준다.
  const reconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    // dispose → onClose 없음 → 자동 재연결 타이머가 끼어들지 않는다. 바로 아래서 우리가 연결한다.
    transportRef.current?.dispose()
    transportRef.current = null
    sessionKey.current = null
    sessionSubscribedKey.current = null
    retryCount.current = 0
    isManualRetry.current = true   // switch to strict 1-attempt mode
    setStatus('connecting')
    setErrorMsg(undefined)
    connect()
  }, [connect])

  // ── fetchUsageCost — 사용량 합계 + 모델별 분포 조회 ──────────────
  // Settings 패널의 파이차트/누적 비용 표시용. usage.cost 는 총합만 주므로
  // 모델별 분포는 sessions.usage 를 별도로 호출해 aggregates.byModel 을 쓴다.
  // "baseline" 은 최초 호출 시점의 스냅샷(추적 시작점) — 실제 표시값은 현재-baseline 델타.
  const fetchUsageCost = useCallback(async () => {
    try {
      const res = await rpc('usage.cost', { days: 365 })
      if (!res.ok) return null
      const payload = res.payload as { totals?: Record<string, number> } | null
      const totals = payload?.totals
      if (!totals) return null

      // `usage.cost` only returns totals + daily, NOT a per-model breakdown.
      // For the model pie chart we additionally call `sessions.usage` which
      // discovers all transcripts and aggregates byModel/byProvider/byAgent.
      let byModel: Array<{ provider?: string; model?: string; totals?: Record<string, number> }> = []
      try {
        const su = await (async () => {
          const d = new Date()
          const end = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
          const past = new Date(d.getTime() - 365 * 86400_000)
          const start = `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, '0')}-${String(past.getUTCDate()).padStart(2, '0')}`
          return rpc('sessions.usage', { startDate: start, endDate: end, limit: 9999 })
        })()
        console.log('[twixy/sessions.usage] ok:', su.ok, 'payload keys:', Object.keys((su.payload ?? {}) as object), 'full:', su.payload)
        if (su.ok) {
          const sp = su.payload as { aggregates?: { byModel?: typeof byModel } } | null
          byModel = sp?.aggregates?.byModel ?? []
          console.log('[twixy/sessions.usage] byModel len:', byModel.length, 'sample:', byModel[0])
        }
      } catch (err) {
        console.warn('[twixy/sessions.usage] threw:', err)
      }

      const savedBaseline = localStorage.getItem('twixy-usage-baseline')
      const savedByModelBaseline = localStorage.getItem('twixy-usage-baseline-bymodel')

      // Snapshot byModel as a flat map keyed by "provider::model" for diffing.
      const byModelToMap = (arr: typeof byModel): Record<string, Record<string, number>> => {
        const m: Record<string, Record<string, number>> = {}
        for (const e of arr) {
          const key = `${e.provider ?? 'unknown'}::${e.model ?? 'unknown'}`
          m[key] = { ...(e.totals ?? {}) }
        }
        return m
      }
      const currentByModelMap = byModelToMap(byModel)

      if (!savedBaseline) {
        // First ever call — save current state as baseline, show 0
        localStorage.setItem('twixy-usage-baseline', JSON.stringify(totals))
        localStorage.setItem('twixy-usage-baseline-bymodel', JSON.stringify(currentByModelMap))
        localStorage.setItem('twixy-tracking-start', String(Date.now()))
        const zero: Record<string, number> = {}
        for (const key of Object.keys(totals)) zero[key] = 0
        return { totals: zero, byModel: [] }
      }

      const baseline: Record<string, number> = JSON.parse(savedBaseline)
      const delta: Record<string, number> = {}
      for (const key of Object.keys(totals)) {
        const cur  = typeof totals[key]    === 'number' ? totals[key]    : 0
        const base = typeof baseline[key]  === 'number' ? baseline[key]  : 0
        delta[key] = Math.max(0, cur - base)
      }

      // Diff byModel against its baseline (or zero if first time we see it).
      const baselineByModel: Record<string, Record<string, number>> = savedByModelBaseline
        ? JSON.parse(savedByModelBaseline)
        : {}
      const deltaByModel = byModel.map(e => {
        const key = `${e.provider ?? 'unknown'}::${e.model ?? 'unknown'}`
        const cur = e.totals ?? {}
        const base = baselineByModel[key] ?? {}
        const d: Record<string, number> = {}
        for (const k of Object.keys(cur)) {
          const c = typeof cur[k]  === 'number' ? cur[k]  : 0
          const b = typeof base[k] === 'number' ? base[k] : 0
          d[k] = Math.max(0, c - b)
        }
        return { provider: e.provider, model: e.model, totals: d }
      }).filter(e => (e.totals.totalTokens ?? 0) > 0 || (e.totals.totalCost ?? 0) > 0)

      return { totals: delta, byModel: deltaByModel }
    } catch {
      return null
    }
  }, [rpc])

  // ── resetUsageBaseline — 누적 사용량 "0 으로 리셋" ──────────────
  // Settings 의 "Reset" 버튼. 지금 시점의 총합을 새 baseline 으로 저장해
  // 이후 표시 델타가 0 부터 시작하도록 한다 (실제 OpenRouter 사용량은 건드리지 않음).
  const resetUsageBaseline = useCallback(async () => {
    try {
      const res = await rpc('usage.cost', { days: 365 })
      if (!res.ok) return
      const totals = (res.payload as { totals?: Record<string, number> } | null)?.totals
      if (!totals) return
      localStorage.setItem('twixy-usage-baseline', JSON.stringify(totals))
      // Also reset the per-model baseline so the pie chart starts fresh.
      let byModel: Array<{ provider?: string; model?: string; totals?: Record<string, number> }> = []
      try {
        const su = await (async () => {
          const d = new Date()
          const end = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
          const past = new Date(d.getTime() - 365 * 86400_000)
          const start = `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, '0')}-${String(past.getUTCDate()).padStart(2, '0')}`
          return rpc('sessions.usage', { startDate: start, endDate: end, limit: 9999 })
        })()
        if (su.ok) {
          byModel = (su.payload as { aggregates?: { byModel?: typeof byModel } } | null)?.aggregates?.byModel ?? []
        }
      } catch { /* ignore */ }
      const byModelMap: Record<string, Record<string, number>> = {}
      for (const e of byModel) {
        const key = `${e.provider ?? 'unknown'}::${e.model ?? 'unknown'}`
        byModelMap[key] = { ...(e.totals ?? {}) }
      }
      localStorage.setItem('twixy-usage-baseline-bymodel', JSON.stringify(byModelMap))
      localStorage.setItem('twixy-tracking-start', String(Date.now()))
    } catch { /* ignore */ }
  }, [rpc])

  // ── Planning Mode primitives ────────────────────────────────────
  // Planning Mode drives multi-step execution on top of the same gateway
  // session the chat uses. The helpers below let an external orchestrator
  // (src/hooks/usePlans.ts) send a raw prompt, await the root session's
  // chat.final, and manipulate the message list to render PlanCard bubbles.

  // ── clearChat 와 plan helper 들에 대한 노트 ──────────────────────
  // 아래 helper 들은 plan orchestrator(src/hooks/usePlans.ts) 가 사용한다.
  // clearChat 은 새 대화(새 세션) 시작 시 모든 ref/state 를 초기화한다 —
  // 다음 sendMessage 호출 시 ensureSession 이 새 세션 key 를 만들어 준다.

  // Add a user bubble without sending to the gateway. Used so the plan
  // flow can echo the user's original intent even when the message we
  // actually send to the LLM is a wrapped planner prompt.
  const addUserMessage = useCallback((text: string): string => {
    const id = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id, role: 'user' as MessageRole, content: text, timestamp: new Date(),
    }])
    return id
  }, [])

  // Insert a synthetic assistant message that renders as a PlanCard rather
  // than a text bubble. Returns the message id so the caller can later
  // update it (e.g. to swap in a different plan).
  const insertPlanMessage = useCallback((planId: string): string => {
    const id = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id, role: 'assistant' as MessageRole, content: '', planId, timestamp: new Date(),
    }])
    return id
  }, [])

  // Patch an existing message in place — used to replace a streaming
  // planner JSON response with a PlanCard once the plan is saved.
  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
  }, [])

  // Remove a message by id — used by the plan edit flow to drop the raw
  // planner JSON bubble once the edit has been applied to the existing
  // PlanCard (otherwise the chat shows the JSON twice: once as text, once
  // as the re-rendered card).
  const removeMessage = useCallback((id: string) => {
    setMessages(prev => prev.filter(m => m.id !== id))
  }, [])

  // Send a raw message on the current session without adding a user bubble,
  // and return the assistant's final reply text + message id + observed tool
  // calls. Timeout default matches sendMessage (10 min) so the gateway has
  // room to run long tools before the awaiter rejects.
  const sendAndAwaitFinal = useCallback(async (
    text: string, opts?: { timeoutMs?: number },
  ): Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }> => {
    if (!isElectron) throw new Error('not_electron')
    if (status !== 'ready') throw new Error('gateway_not_ready')
    const sid = await ensureSession()
    if (!sid) throw new Error('session_create_failed')

    const awaiterPromise = new Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>(
      (resolve, reject) => {
        const awaiter: TurnAwaiter = {
          resolve, reject,
          startedAt: Date.now(),
          toolCalls: [],
        }
        turnAwaitersRef.current.push(awaiter)
        // Safety timeout — if no chat.final arrives, reject so the caller
        // doesn't hang forever. The gateway's own run timeout is 10min.
        const t = setTimeout(() => {
          const i = turnAwaitersRef.current.indexOf(awaiter)
          if (i >= 0) {
            turnAwaitersRef.current.splice(i, 1)
            reject(new Error('turn_timeout'))
          }
        }, opts?.timeoutMs ?? 10 * 60 * 1000)
        // Wrap resolve/reject to clear timer on completion.
        const origResolve = awaiter.resolve
        const origReject  = awaiter.reject
        awaiter.resolve = (r) => { clearTimeout(t); origResolve(r) }
        awaiter.reject  = (e) => { clearTimeout(t); origReject(e) }
      },
    )

    setIsThinking(true)
    setToolStats({ count: 0, startedAt: Date.now(), lastName: null, lastIsSubagent: false })
    try {
      await rpc('sessions.send', { key: sid, message: text }, opts?.timeoutMs ?? 10 * 60 * 1000)
    } catch (err) {
      // Drop the awaiter we just registered — chat.final won't come.
      const last = turnAwaitersRef.current.pop()
      setIsThinking(false)
      if (last) last.reject(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
    return awaiterPromise
  }, [status, rpc, ensureSession])

  // Expose the current root session key so the plan runner can persist it
  // on the plan and reuse it across pause/resume cycles.
  const getSessionKey = useCallback((): string | null => sessionKey.current, [])

  const clearChat = useCallback(() => {
    const sid = sessionKey.current
    if (sid) {
      rpc('sessions.abort', { key: sid }).catch(() => { /* non-fatal */ })
    }
    if (finalFallbackTimer.current) { clearTimeout(finalFallbackTimer.current); finalFallbackTimer.current = null }
    rootFinaledWhileSubagentBusy.current = false
    activeToolsRef.current.clear()
    subagentSessionsRef.current.clear()
    subagentKillRef.current.clear()
    // Reject any pending plan-turn awaiters so callers can unwind cleanly.
    for (const a of turnAwaitersRef.current) a.reject(new Error('chat_cleared'))
    turnAwaitersRef.current = []
    setIsThinking(false)
    setToolActivity(null)
    setToolStats({ count: 0, startedAt: null, lastName: null, lastIsSubagent: false })
    setMessages([])
    sessionKey.current = null
    sessionSubscribedKey.current = null
    // New Chat — wipe the persisted scrollback + session key so a restart
    // starts fresh rather than re-hydrating the just-cleared conversation.
    persistedIds.current.clear()
    seenMsgIds.current.clear()
    if (isElectron) {
      window.twixy.mainChatClear().catch(() => { /* non-critical */ })
      window.twixy.mainSessionSet({ sessionKey: null }).catch(() => { /* non-critical */ })
    }
  }, [rpc])

  // Add a system/notice bubble without touching the gateway — used by the
  // plan orchestrator to surface local errors (parse failures, IPC
  // rejections) in the chat transcript.
  const addSystemMessage = useCallback(
    (text: string, extra?: Partial<ChatMessage>) => addMessage('system', text, extra),
    [addMessage],
  )

  // Allow the plan runner to block subagent-triggered LLM runs after a plan
  // failure. Pass true after a run ends due to failure; false at run start.
  const setRejectNewRuns = useCallback((v: boolean) => { rejectNewRunsRef.current = v }, [])

  // Abort every currently tracked sub-agent session. Plan runner calls this
  // when a step fails so late subagent completions don't fire subagent_announce
  // and autonomously restart LLM work on the main session after the plan has
  // already stopped. The gateway marks killed subagents so their announce path
  // is suppressed (see pi-embedded: reason === 'subagent-killed' → no announce).
  const killActiveSubagents = useCallback(async () => {
    // sessions.abort on its own does NOT mark the subagent as killed — it only
    // aborts the active LLM run, leaving endedReason free to resolve as
    // "subagent-complete" or "subagent-error", which STILL fires
    // subagent_announce on the main session and autonomously restarts the
    // plan's LLM. The gateway only suppresses announce when
    // suppressAnnounceReason === "killed", which is set inside
    // markSubagentRunTerminated (reached via sessions.delete →
    // cleanupSessionBeforeMutation → ensureSessionRuntimeCleanup →
    // stopSubagentsForRequester). So we call sessions.delete here — it also
    // internally calls abortEmbeddedPiRun, so no separate abort RPC needed.
    //
    // The ref is populated by two different code paths (sessions.changed and
    // the 'agent' lifecycle handler) storing DIFFERENT key shapes:
    //   - session keys:  "agent:main:subagent:<uuid>"         (targetable)
    //   - run ids:       "announce:v1:agent:main:subagent:..." (NOT a session key)
    // Filter to real session keys only; run ids would no-op against sessions.delete.
    // Pull from subagentKillRef — it retains subagent session keys even after
    // phase:"end" (subagentSessionsRef is cleared immediately on that event
    // for UI idle tracking). Ended-but-not-yet-announced subagents only show
    // up here, and that is exactly the race we need to cover: the patched
    // pi-embedded markSubagentRunTerminated sets
    // suppressAnnounceReason="killed" on those entries so the in-flight
    // runSubagentAnnounceFlow bails at its delivery gate.
    const sessionKeys = [...subagentKillRef.current].filter(k => k.startsWith('agent:') && k.includes(':subagent:'))
    console.warn('[killActiveSubagents] kill-ref size:', subagentKillRef.current.size, 'session keys to delete:', sessionKeys.length, sessionKeys)
    if (sessionKeys.length === 0) { subagentKillRef.current.clear(); subagentSessionsRef.current.clear(); return }
    await Promise.all(sessionKeys.map(key =>
      // deleteTranscript: false keeps the subagent's transcript on disk for
      // postmortem debugging. We only need the side-effect of the kill path.
      rpc('sessions.delete', { key, deleteTranscript: false })
        .then(res => console.warn('[killActiveSubagents] deleted', key, res))
        .catch(err => console.warn('[killActiveSubagents] delete failed', key, err)),
    ))
    subagentKillRef.current.clear()
    subagentSessionsRef.current.clear()
  }, [rpc])

  // Requester-level announce freeze. Orthogonal to kill flow — the gateway
  // drops ANY subagent announce targeting a frozen requester regardless of
  // subagent lifecycle state (natural-complete, killed, provider-error). Used
  // by plan mode on failure so pending / future announces from detached
  // subagents don't autonomously wake the main session LLM. Auto-unfrozen at
  // the top of sendMessage / sendAndAwaitFinal so the next user message flows
  // through normally.
  const setRequesterAnnounceFrozen = useCallback(async (frozen: boolean): Promise<void> => {
    const sid = sessionKey.current
    if (!sid) return
    try {
      await rpc('twixy.freezeRequesterAnnounce', { key: sid, frozen }, 5_000)
    } catch (err) {
      console.warn('[freezeRequesterAnnounce] rpc failed', frozen, err)
    }
  }, [rpc])

  // 게이트웨이 세션을 비워 다음 sendAndAwaitFinal 이 새 transcript 로 시작하게 한다.
  // 플랜 모드가 step 사이에 호출 — 각 step LLM 입력을 bounded 하게 유지하기 위해
  // 이전 step 의 tool 결과/내레이션은 게이트웨이 쪽에서 drop 되고, 다음 step 이
  // 필요로 하는 컨텍스트는 runner 가 step prompt 로 재주입한다(이전 step
  // compactSummaries + retained raw blocks). 디스크의 transcript 파일은 OpenClaw
  // 가 보존하며, 세션 키만 새 sessionId/sessionFile 로 가리킨다.
  const resetSession = useCallback(async (): Promise<void> => {
    const sid = sessionKey.current
    if (!sid) return
    try {
      await rpc('sessions.reset', { key: sid, reason: 'reset' }, 10_000)
    } catch (err) {
      console.warn('[twixy/resetSession] failed', err)
    }
  }, [rpc])

  // 현재 게이트웨이 세션의 전체 메시지 리스트(tool use / tool result 포함)를 읽는다.
  // 플랜 모드가 각 step 종료 후 호출 — compaction + raw 보존을 위해 raw transcript
  // slice 를 캡처한다.
  const getSessionMessages = useCallback(async (limit = 9999): Promise<unknown[]> => {
    const sid = sessionKey.current
    if (!sid) return []
    try {
      const res = await rpc('sessions.get', { key: sid, limit }, 10_000)
      if (!res.ok) return []
      const payload = res.payload as { messages?: unknown[] } | null
      return Array.isArray(payload?.messages) ? payload!.messages! : []
    } catch (err) {
      console.warn('[twixy/getSessionMessages] failed', err)
      return []
    }
  }, [rpc])

  // Twixy Guardrail: 대기 중인 plugin-approval 요청을 기존 게이트웨이 WS 로 해결한다.
  // 별도 WebSocket 을 열지 않고, 이미 인증된 세션을 piggy-back 한다.
  const resolveGuardrail = useCallback(async (id: string, decision: 'allow-once' | 'allow-always' | 'deny'): Promise<void> => {
    try {
      await rpc('plugin.approval.resolve', { id, decision }, 5_000)
    } catch (err) {
      console.warn('[guardrail] resolve rpc failed', err)
    }
  }, [rpc])

  // ── Cron 예약 작업 — 게이트웨이 WS RPC 직접 호출 ─────────────────
  // 기존엔 main.ts 가 `openclaw cron …` CLI 를 별도 loopback 프로세스로 띄웠는데,
  // 그 클라이언트(client.id:"cli")가 게이트웨이의 페어링 미승인으로 1008 거부됐다.
  // 렌더러는 이미 client.id:'openclaw-control-ui' + operator.admin/write/read 스코프로
  // 인증 연결돼 있으므로, 그 연결로 cron.* RPC 를 직접 호출하면 페어링 문제가 없다.
  // (enable/disable 전용 메서드는 없음 → cron.update { id, patch:{ enabled } } 로 처리.)
  const cronList    = useCallback(() => rpc('cron.list', { includeDisabled: true }), [rpc])
  const cronStatus  = useCallback(() => rpc('cron.status', {}), [rpc])
  const cronAdd     = useCallback((job: Record<string, unknown>) => rpc('cron.add', job), [rpc])
  const cronUpdate  = useCallback((id: string, patch: Record<string, unknown>) => rpc('cron.update', { id, patch }), [rpc])
  const cronRemove  = useCallback((id: string) => rpc('cron.remove', { id }), [rpc])
  const cronRun     = useCallback((id: string, mode?: 'due' | 'force') => rpc('cron.run', mode ? { id, mode } : { id }), [rpc])
  const cronRuns    = useCallback((id?: string) => rpc('cron.runs', id ? { id } : {}), [rpc])
  const cronEnable  = useCallback((id: string) => cronUpdate(id, { enabled: true }), [cronUpdate])
  const cronDisable = useCallback((id: string) => cronUpdate(id, { enabled: false }), [cronUpdate])

  // UI 친화 어댑터 — SettingsPanel 의 폼 입력을 게이트웨이 CronJobObjectSchema 로 매핑.
  //   scheduleKind 'cron'  + schedule(expr)   → schedule:{kind:'cron',  expr,    tz}
  //   scheduleKind 'every' + schedule(everyMs)→ schedule:{kind:'every', everyMs, tz}
  //   delivery 'in-app'(기본) → sessionTarget:'main', payload:{kind:'systemEvent',text:prompt},
  //                              wakeMode:'now', delivery:{mode:'none'} — 결과가 메인 채팅에 표시.
  //   delivery 'channel'      → sessionTarget:'isolated', payload:{kind:'agentTurn',message:prompt},
  //                              delivery:{mode:'announce', channel, to}
  // NOTE: 게이트웨이 검증 규칙 — main 세션 잡은 payload.kind="systemEvent" 필수,
  //       agentTurn 페이로드는 isolated 세션에서만 허용. (E2E로 확인된 제약.)
  type CronAddForm = {
    name: string
    description?: string
    scheduleKind: 'cron' | 'every'
    schedule: string                     // cron expr, or every-interval (ms 또는 "10m"/"1h")
    tz?: string
    prompt: string
    delivery: 'in-app' | 'channel'
    channel?: string
    to?: string
  }
  const cronAddFromForm = useCallback((form: CronAddForm) => {
    const tz = form.tz?.trim() || 'Asia/Seoul'
    const schedule: Record<string, unknown> = form.scheduleKind === 'every'
      ? { kind: 'every', everyMs: parseEveryMs(form.schedule), tz }
      : { kind: 'cron', expr: form.schedule.trim(), tz }
    const prompt = form.prompt.trim()
    const toChannel = form.delivery === 'channel' && !!form.channel?.trim()
    // main 세션은 systemEvent 만, isolated 세션은 agentTurn 만 허용 (게이트웨이 검증).
    const job: Record<string, unknown> = toChannel
      ? {
          name: form.name.trim(),
          ...(form.description?.trim() ? { description: form.description.trim() } : {}),
          schedule,
          sessionTarget: 'isolated',
          payload: { kind: 'agentTurn', message: prompt },
          delivery: { mode: 'announce', channel: form.channel!.trim(), ...(form.to?.trim() ? { to: form.to.trim() } : {}) },
        }
      : {
          name: form.name.trim(),
          ...(form.description?.trim() ? { description: form.description.trim() } : {}),
          schedule,
          sessionTarget: 'main',
          wakeMode: 'now',
          payload: { kind: 'systemEvent', text: prompt },
          delivery: { mode: 'none' },
        }
    return cronAdd(job)
  }, [cronAdd])

  // 훅 외부로 노출되는 API. App.tsx 가 이 값을 ChatPanel/StatusBar 등에 분배한다.
  return {
    messages, status, errorMsg, isThinking, toolActivity, toolStats,
    sendMessage, abortMessage, reconnect, fetchUsageCost, resetUsageBaseline,
    liveUsage, clearChat,
    // Planning Mode primitives
    addUserMessage, insertPlanMessage, patchMessage, removeMessage, sendAndAwaitFinal, cancelActiveTurn, getSessionKey, addSystemMessage, setRejectNewRuns, killActiveSubagents,
    setRequesterAnnounceFrozen,
    resetSession, getSessionMessages,
    resolveGuardrail,
    // Cron 예약 작업 — 게이트웨이 WS RPC
    cronList, cronStatus, cronAdd, cronUpdate, cronRemove, cronRun, cronRuns,
    cronEnable, cronDisable, cronAddFromForm,
  }
}
