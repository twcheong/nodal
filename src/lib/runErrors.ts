// ─────────────────────────────────────────────────────────────────────────────
// runErrors.ts — 게이트웨이/프로바이더 에러 문자열 → 사람이 읽는 원인 분류.
//
// OpenClaw 는 프로바이더 에러를 그대로 올려보낸다. 예:
//   "403 Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/..."
// 이 raw 문자열이 노드 실패 사유나 채팅 침묵으로 그대로 새면 유저는 "워크플로가
// 그냥 죽었다" 로만 인식한다 (관측: Validation 노드 FAILED 로만 보임). 여기서
// 한 곳에 모아 분류하고, 실제로 유저가 취할 수 있는 행동을 문장으로 준다.
//
// 중요: 크레딧 소진은 코드 버그가 아니라 계정 상태다 — 재시도해도 100% 다시
// 실패하므로 "재시도" 대신 "한도" 를 말해야 한다.
// ─────────────────────────────────────────────────────────────────────────────

export type RunErrorKind =
  | 'credit_limit'    // 월/일 예산 소진 — 재시도 무의미
  | 'rate_limit'      // 순간 초과 — 잠시 후 재시도 가능
  | 'auth'            // 키 자체가 무효/만료
  | 'no_image_input'  // 모델이 이미지 입력 미지원 (스크린샷 툴콜로 턴 사망)
  | 'network'         // 게이트웨이/프로바이더 연결 실패
  | 'aborted'         // 사용자 중단
  | 'unknown'

export interface RunErrorInfo {
  kind:    RunErrorKind
  /** 한 줄 요약 — 노드 실패 사유 배지/런 로그용. */
  summary: string
  /** 유저가 다음에 뭘 해야 하는지. 없으면 표시 생략. */
  hint?:   string
  /** 원본 문자열 — 디버깅용으로 항상 보존. */
  raw:     string
  /** true 면 같은 조건에서 재시도해도 반드시 다시 실패한다. */
  terminal: boolean
}

// 프로바이더별 문구가 제각각이라 코드보다 문자열 매칭이 실질적이다.
// (OpenRouter: "Key limit exceeded", "Insufficient credits";
//  OpenAI: "insufficient_quota"; Anthropic: "credit balance is too low")
const CREDIT_RE  = /key limit exceeded|monthly limit|insufficient[_ ]credits?|insufficient[_ ]quota|credit balance is too low|requires more credits|exceeded your current quota|billing[_ ]hard[_ ]limit/i
const RATE_RE    = /\b429\b|rate[- ]?limit|too many requests|temporarily rate[- ]?limited/i
const AUTH_RE    = /\b401\b|invalid api key|no auth credentials|unauthorized|api key not valid|authentication[_ ]error/i
const IMAGE_RE   = /no endpoints found that support image input|does not support image/i
const NETWORK_RE = /econnrefused|enotfound|etimedout|socket hang up|fetch failed|network error|websocket.*clos/i
const ABORT_RE   = /^(run_)?(aborted|cancelled|canceled)$|stopped by user/i

export function classifyRunError(rawInput: unknown): RunErrorInfo {
  const raw = rawInput instanceof Error ? rawInput.message : String(rawInput ?? '')
  const base = { raw }

  if (ABORT_RE.test(raw.trim())) {
    return { ...base, kind: 'aborted', summary: 'Stopped by user', terminal: true }
  }
  // 크레딧을 rate limit 보다 먼저 본다 — 일부 프로바이더는 예산 소진도 429 로
  // 내려주면서 본문에만 "credits" 를 적는다.
  if (CREDIT_RE.test(raw)) {
    return {
      ...base,
      kind:     'credit_limit',
      summary:  'AI credit limit reached',
      hint:     'Your monthly AI budget is used up. Upgrade your plan or add your own API key in Settings, then run again.',
      terminal: true,
    }
  }
  if (RATE_RE.test(raw)) {
    return {
      ...base,
      kind:     'rate_limit',
      summary:  'Rate limited by the AI provider',
      hint:     'Too many requests in a short window. Wait a minute and retry this step.',
      terminal: false,
    }
  }
  if (AUTH_RE.test(raw)) {
    return {
      ...base,
      kind:     'auth',
      summary:  'AI provider rejected the API key',
      hint:     'The key is missing, expired, or invalid. Re-sign in, or re-enter your API key in Settings.',
      terminal: true,
    }
  }
  if (IMAGE_RE.test(raw)) {
    return {
      ...base,
      kind:     'no_image_input',
      summary:  'This model cannot read screenshots',
      hint:     'The step tried to send an image. Switch to a vision-capable model, or have the step use text snapshots instead.',
      terminal: true,
    }
  }
  if (NETWORK_RE.test(raw)) {
    return {
      ...base,
      kind:     'network',
      summary:  'Could not reach the AI service',
      hint:     'Check your internet connection, then retry.',
      terminal: false,
    }
  }
  return { ...base, kind: 'unknown', summary: raw || 'Unknown error', terminal: false }
}

/**
 * 노드 실패 사유 한 줄. 분류되면 사람 문장 + 힌트, 아니면 원본 그대로.
 * (원본을 통째로 버리지 않는다 — unknown 케이스는 그게 유일한 단서다.)
 */
export function friendlyRunError(rawInput: unknown): string {
  const info = classifyRunError(rawInput)
  if (info.kind === 'unknown') return info.summary
  return info.hint ? `${info.summary} — ${info.hint}` : info.summary
}

/** 크레딧 소진 여부 — 배너/모달 트리거용. */
export function isCreditLimitError(rawInput: unknown): boolean {
  return classifyRunError(rawInput).kind === 'credit_limit'
}
