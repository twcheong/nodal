// ─────────────────────────────────────────────────────────────────────────────
// logbook-bridge.ts — Twixy → logbook 작업 컨텍스트 마커 송신 클라이언트.
//
// logbook 은 로컬 화면 기록 도구로, 127.0.0.1:8765 에서 FastAPI 로 돌며
// `POST /context` 로 작업 마커({event:'start'|'end', task_id, level, ...})를
// 받아 활성 작업 스택에 push/pop 하고 이후 캡처 프레임/입력 이벤트에
// task_id/actor 를 스탬프한다.
//
// 설계 원칙: 절대 방해 금지(fire-and-forget).
//   · 타임아웃 1초 — logbook 이 안 떠 있으면 즉시 포기.
//   · 실패 시 60초간 시도 자체를 멈추는 백오프 — logbook 이 안 떠 있는 것이
//     일반적인 상태이므로, plan 실행마다 마커 수십 발이 connection refused 로
//     낭비되지 않게 한다.
//   · 어떤 실패도 호출자(plan 실행)로 전파하지 않는다. 로그는 디버그 한 줄.
// ─────────────────────────────────────────────────────────────────────────────

const LOGBOOK_URL_DEFAULT = 'http://127.0.0.1:8765'
const REQUEST_TIMEOUT_MS  = 1_000
const FAILURE_BACKOFF_MS  = 60_000

// 환경변수로 엔드포인트 오버라이드 가능 (예: 다른 포트에서 logbook 실행 시).
function baseUrl(): string {
  const env = process.env.TWIXY_LOGBOOK_URL?.trim()
  return (env || LOGBOOK_URL_DEFAULT).replace(/\/+$/, '')
}

// logbook 의 ContextMarkerModel 과 1:1 — logbook/api/server.py 참고.
export interface LogbookMarker {
  event:      'start' | 'end'
  task_id:    string
  level?:     'L6' | 'L7' | 'L8'
  title?:     string
  actor?:     'AI' | 'HUMAN'
  parent_id?: string
  plan_id?:   string
  ts?:        number   // epoch 초 (생략 시 여기서 채움)
}

// 실패 백오프: 이 시각 전까지는 fetch 시도 자체를 건너뜀.
let suspendedUntil = 0

/**
 * 마커 1건을 logbook 으로 송신. 항상 resolve 하며(절대 reject 하지 않음),
 * logbook 미연결/타임아웃/HTTP 에러는 조용히 무시하고 백오프만 갱신한다.
 */
export async function postContextMarker(marker: LogbookMarker): Promise<void> {
  if (!marker || (marker.event !== 'start' && marker.event !== 'end')) return
  if (typeof marker.task_id !== 'string' || !marker.task_id.trim()) return
  if (Date.now() < suspendedUntil) return

  const body = JSON.stringify({ ...marker, ts: marker.ts ?? Date.now() / 1000 })
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    // Node 18+ 글로벌 fetch. 응답의 `matched:false`(end 가 스택에 매칭 안 됨)는
    // 정보성일 뿐이므로 디버그 로그 외에는 사용하지 않는다.
    const res = await fetch(`${baseUrl()}/context`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal:  ctrl.signal,
    })
    if (!res.ok) throw new Error(`http_${res.status}`)
    suspendedUntil = 0
  } catch (err) {
    suspendedUntil = Date.now() + FAILURE_BACKOFF_MS
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[logbook] marker drop (${marker.event} ${marker.task_id}): ${String(err)} — backing off ${FAILURE_BACKOFF_MS / 1000}s`)
    }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 카카오톡 OCR 읽기 — postContextMarker 와 달리 결과/에러를 호출자에게 돌려준다.
//
// logbook 의 `GET /ocr?app=kakao&window=카카오톡&since=&until=&limit=` 를 호출해
// 화면에서 OCR 로 캡처된 최근 카카오톡 대화 텍스트를 가져온다. 이 함수는
// fire-and-forget 이 아니라 실제 데이터를 반환해야 하므로, 미연결/타임아웃/HTTP
// 에러를 삼키지 않고 {ok:false, error} 로 명시한다. (백오프도 적용하지 않음 —
// 사용자가 명시적으로 요청한 읽기 동작이라 매번 시도해야 한다.)
// ─────────────────────────────────────────────────────────────────────────────

export interface KakaoOcrLine {
  ts:            number
  text:          string
  window_title?: string
  app?:          string
}

export interface ReadKakaoResult {
  ok:     boolean
  lines?: KakaoOcrLine[]
  error?: string
}

export async function readKakaoOcr(opts: {
  since: number
  until: number
  limit?: number
}): Promise<ReadKakaoResult> {
  const limit = opts.limit ?? 50
  const params = new URLSearchParams({
    app:    'kakao',
    window: '카카오톡',
    since:  String(opts.since),
    until:  String(opts.until),
    limit:  String(limit),
  })

  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl()}/ocr?${params.toString()}`, {
      method: 'GET',
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, error: `logbook_http_${res.status}` }
    const data = (await res.json()) as Array<{
      ts: number; text: string; window_title?: string | null; app?: string | null
    }>
    const lines: KakaoOcrLine[] = (Array.isArray(data) ? data : []).map((r) => ({
      ts:           r.ts,
      text:         r.text,
      window_title: r.window_title ?? undefined,
      app:          r.app ?? undefined,
    }))
    return { ok: true, lines }
  } catch (err) {
    // 연결 거부/타임아웃 등 — logbook 이 안 떠 있는 경우.
    return { ok: false, error: 'logbook_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}
