// ── 렌더러로 내보내는 비밀값의 마스킹 규칙 ───────────────────────────────────
//
// main 이 쥐고 있는 비밀(메신저 봇 토큰, BYOK API 키)을 설정 화면에 보여 주려고 **평문 그대로**
// IPC 로 넘기던 자리가 있었다. 렌더러는 LLM 출력·스크랩한 페이지를 그리는 곳이라, 거기 평문이
// 한 번 도착하면 XSS 한 방에 전부 샌다. 그래서 내보낼 때 끝 4자만 남기고 가린다.
//
// 그런데 가린 값을 그대로 돌려받아 저장하면 진짜 키가 마스크로 덮인다 — 이 규칙이 풀어야 하는
// 진짜 문제는 그쪽이다. 그래서 마스크는 "값" 이 아니라 **"안 바꿨다" 는 신호**로 쓴다:
//
//   저장 요청에 들어온 값이  마스크  → 기존 값 유지
//                            빈 문자열 → 삭제 (기존 동작)
//                            그 외     → 새 값으로 교체
//
// 접두사를 U+2022(•)로 두는 이유: API 키·봇 토큰은 전부 ASCII 라서 진짜 값과 절대 겹치지 않는다.
// 양쪽(main·렌더러)이 같은 판정을 해야 하므로 규칙은 여기 한 곳에만 둔다.

/** 마스크임을 알아보는 표식. 진짜 비밀값에는 나올 수 없는 문자. */
export const SECRET_MASK_PREFIX = '••••'

/**
 * 비밀값 → 화면에 보여 줄 마스크. 어느 키인지 알아볼 수 있게 끝 4자만 남긴다.
 * 짧은 값은 끝자리도 남기지 않는다 (4자 이하면 그게 곧 값 전체다).
 */
export function maskSecret(value: string): string {
  if (typeof value !== 'string' || !value) return ''
  return value.length > 4 ? SECRET_MASK_PREFIX + value.slice(-4) : SECRET_MASK_PREFIX
}

/** 이 값이 우리가 내보낸 마스크인가 (= "안 바꿨다"). */
export function isMaskedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_MASK_PREFIX)
}

/**
 * 저장 시점의 병합 — 위 표의 세 줄을 그대로 구현한 것.
 * `incoming` 이 마스크면 `existing` 을 지키고, 아니면 들어온 값을 쓴다.
 */
export function mergeSecret(incoming: unknown, existing: string | undefined): string | undefined {
  if (isMaskedSecret(incoming)) return existing
  return typeof incoming === 'string' ? incoming : undefined
}
