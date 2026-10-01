// ═════════════════════════════════════════════════════════════════════════════
// useDashboardClaw — DashboardPanel 전용 독립 세션 훅.
//
// useOpenClaw 와 달리 "순수 차트 생성" 만을 위한 별도 WS 세션을 유지한다.
// 챗 패널의 대화 히스토리를 오염시키지 않고, 응답은 반드시 고정 JSON 스키마(widget-spec) 로
// 강제되므로 파싱/그리기가 결정적이다.
//
// 동작:
//   1) requestWidget(자연어 프롬프트) 호출
//   2) DASHBOARD_PREFIX(스펙 + 파일접근 제한) 를 앞에 붙여 sessions.send
//   3) session.message 이벤트의 어시스턴트 텍스트를 Promise 로 resolve
//   4) 호출자는 반환 문자열에서 ```widget-spec … ``` 블록을 파싱해 차트 렌더
// ═════════════════════════════════════════════════════════════════════════════

import { useRef, useState, useCallback, useEffect } from 'react'
import type { ControlUiTransport } from '../lib/gateway/controlUiTransport'
import { createRendererTransport, isElectron } from '../lib/gateway/rendererTransport'
import { createSession, extractText, releaseSessions } from '../lib/gateway/sessionClient'

/**
 * 대시보드 프롬프트 앞에 자동 주입되는 시스템 프리픽스.
 * AI 가 파싱 가능한 widget-spec 블록 한 개만 내도록 구속하고,
 * 파일 접근을 Twixy 워크스페이스 내부로만 제한한다 (시스템 파일 읽기 차단).
 */
const DASHBOARD_PREFIX = `[TWIXY DASHBOARD — VISUALIZATION REQUEST]

FILE ACCESS RESTRICTION: You may ONLY read files from ~/.openclaw/workspace/twixy/.
Never access system files, home directory dotfiles, app bundles, or any path outside the twixy workspace.
If the data you need doesn't exist in the workspace, say so — do not substitute with system files.

Respond with a single \`\`\`widget-spec JSON block matching this schema exactly:
{
  "type": "bar" | "line" | "pie" | "donut" | "number",
  "title": string,
  "subtitle"?: string,
  "labels": string[],
  "series": [ { "name": string, "data": number[], "color"?: string } ],
  "unit"?: string
}

Constraints:
- "bar" / "line": labels.length === series[i].data.length, max 30 labels
- "pie" / "donut": one series, max 8 labels
- "number": one series with exactly one data value, labels can be []
- All "data" values must be plain numbers (no nulls, strings, or NaN)
- Keep "title" under 60 chars

After the block, write one concise sentence summarising the insight.

Visualisation request: `

export function useDashboardClaw() {
  const [busy,  setBusy]  = useState(false)    // 요청 중 상태 — UI 에서 스피너 표시용
  const [error, setError] = useState<string | null>(null)

  const transportRef    = useRef<ControlUiTransport | null>(null)
  const sessionKey      = useRef<string | null>(null)
  // 현재 진행 중인 requestWidget 의 resolve/reject 핸들.
  // session.message 이벤트가 도착하면 이걸로 Promise 완결.
  const pendingResponse = useRef<{ resolve: (text: string) => void; reject: (e: Error) => void } | null>(null)
  // 동시에 여러 requestWidget 이 connect 를 시도해 경합하지 않도록 락.
  const connectLock     = useRef<Promise<void> | null>(null)
  // 요청 직렬화 큐. 완료 판정이 "첫 assistant 메시지" 라서 한 세션에 턴이 둘 떠 있으면
  // 어느 답이 누구 것인지 가릴 수 없다 — 앞 요청이 끝난(resolve/reject/timeout) 뒤에야
  // 다음 메시지를 보낸다. 응답 슬롯이 하나인 것과 짝을 이루는 불변식.
  const requestQueue    = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight        = useRef(0)
  // 언마운트 여부. "마운트됨" 이 아니라 "언마운트됨" 을 기록한다 — 자식 effect 가 이 훅의
  // mount effect 보다 먼저 requestWidget 을 부를 수 있어서, 초기값이 통과 상태여야 한다.
  const unmountedRef    = useRef(false)

  // ── Transport — 첫 request 때 lazy 생성, 훅 인스턴스당 하나 ──────────────
  // 핸드셰이크·RPC 는 transport 가, 세션·응답 슬롯·완료 판정은 여기서.
  const getTransport = useCallback((): ControlUiTransport => {
    if (transportRef.current) return transportRef.current
    const t = createRendererTransport('Twixy Dashboard', 'Dashboard WS error')

    t.onClose(() => {
      sessionKey.current = null
      if (pendingResponse.current) {
        pendingResponse.current.reject(new Error('Connection closed'))
        pendingResponse.current = null
      }
    })

    // Assistant reply — resolve the pending widget request
    t.onEvent((frame) => {
      if (frame.event === 'session.message') {
        const msg = frame.payload?.message as Record<string, unknown> | undefined
        if (msg?.role === 'assistant') {
          const text = extractText(msg.content)
          if (text && pendingResponse.current) {
            pendingResponse.current.resolve(text)
            pendingResponse.current = null
          }
        }
      }
    })

    transportRef.current = t
    return t
  }, [])

  // ── Connect + 핸드셰이크 + 세션 생성 (idempotent) ────────────────────────
  // 이미 세션이 살아있으면 즉시 return. 처음이라면 transport 핸드셰이크 직후 같은 lock
  // 안에서 sessions.create + sessions.messages.subscribe 로 세션 수립.
  // agentId 를 주지 않는다 — 게이트웨이 기본 에이전트.
  const ensureConnected = useCallback(async () => {
    const t = getTransport()
    if (t.isConnected() && sessionKey.current) return
    if (!connectLock.current) {
      connectLock.current = (async () => {
        await t.ensureConnected()
        sessionKey.current = await createSession(t, {})
      })().finally(() => { connectLock.current = null })
    }
    await connectLock.current
  }, [getTransport])

  // ── Public API — 외부에 노출되는 함수 ────────────────────────────────────
  /**
   * 자연어 차트 요청을 보낸다.
   * 반환: AI 응답 원문 텍스트. 호출 측이 ```widget-spec``` 블록을 파싱해 차트를 그림.
   * 타임아웃: 큰 데이터셋 추론 여유를 주기 위해 45초.
   * 겹쳐 호출하면 직렬화된다 — 호출 순서대로 하나씩 보내고 각자의 답을 돌려준다.
   */
  const requestWidget = useCallback(async (prompt: string): Promise<string> => {
    if (!isElectron) throw new Error('Not running inside Twixy')

    inFlight.current += 1
    setBusy(true)
    setError(null)

    const run = requestQueue.current.then(async () => {
      // 큐에서 기다리는 사이 언마운트됐으면 transport 를 새로 만들어 소켓을 열지 않는다.
      if (unmountedRef.current) throw new Error('Connection closed')
      await ensureConnected()
      const sid = sessionKey.current!

      return await new Promise<string>((resolve, reject) => {
        // 45-second timeout for large dataset reasoning — 큐 대기 시간은 빼고, 실제로
        // 메시지를 보낸 시점부터 잰다. 슬롯은 identity 로만 비운다: 이미 끝난 요청의
        // 늦은 타이머·send 실패가 다음 요청의 핸들을 지우면 그 요청은 영영 hang.
        const timer = setTimeout(() => {
          if (pendingResponse.current === slot) {
            pendingResponse.current = null
            reject(new Error('AI response timed out (45s)'))
          }
        }, 45_000)

        const slot = {
          resolve: (text: string) => { clearTimeout(timer); resolve(text) },
          reject:  (err: Error)   => { clearTimeout(timer); reject(err)  },
        }
        pendingResponse.current = slot

        getTransport().rpc('sessions.send', {
          key:     sid,
          message: DASHBOARD_PREFIX + prompt,
        }).catch(err => {
          clearTimeout(timer)
          if (pendingResponse.current === slot) pendingResponse.current = null
          reject(err)
        })
      })
    })
    // 앞 요청이 실패해도 뒤 요청은 진행한다.
    requestQueue.current = run.catch(() => { /* 실패는 호출자에게 전달됨 */ })

    try {
      return await run
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      throw err
    } finally {
      inFlight.current -= 1
      if (inFlight.current === 0) setBusy(false)
    }
  }, [ensureConnected, getTransport])

  // 언마운트 정리 — 소켓·타이머를 남기지 않는다. dispose 는 onClose 를 부르지 않으므로
  // 기다리던 요청은 여기서 직접 reject 한다 (45s 타이머도 같이 풀린다). transport 는 다음
  // request 때 다시 lazy 생성되므로 StrictMode 이중 마운트에서도 안전하다.
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      const t = transportRef.current
      if (t && sessionKey.current) releaseSessions(t, [sessionKey.current])
      t?.dispose()
      transportRef.current = null
      sessionKey.current   = null
      if (pendingResponse.current) {
        pendingResponse.current.reject(new Error('Connection closed'))
        pendingResponse.current = null
      }
    }
  }, [])

  return { requestWidget, busy, error }
}
