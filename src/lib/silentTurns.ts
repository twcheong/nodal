// 침묵 턴 — 앱이 모델과 주고받는 내부 왕복을 전사에서 빼는 규칙.
//
// 별도 파일인 이유: 이건 "이 답장을 사용자에게 보여줄 것인가" 를 정하는 한
// 줄이고, 틀리면 **사용자가 보낸 질문에 답이 안 온다**. 훅 안에 두면 React·
// WebSocket·소울 문서까지 끌고 와야 해서 검사할 수가 없었다. 순수 함수 하나만
// 여기 두고 scripts/checkSilentTurn.ts 가 지킨다.

/** 침묵 턴 플래그의 수명. 덱 검증 타임아웃(90초)보다 넉넉히 길게 — 느리지만
 *  살아 있는 답장은 여전히 삼키고, 죽은 턴의 플래그는 스스로 사라진다. */
export const SILENT_TURN_TTL_MS = 150_000
/**
 * 이 대화의 다음 어시스턴트 메시지를 침묵 처리할 것인가 — 그리고 플래그 소비.
 *
 * 규칙이 함수인 이유: 이건 "삼킬까 말까" 를 정하는 한 줄이고, 틀리면 사용자가
 * 보낸 질문에 답이 안 온다(2026-09-15 실사고). 두 호출부(메시지 경로·에러
 * 경로)가 같은 판단을 쓰도록, 그리고 검사가 가능하도록 이름을 붙였다.
 *
 * 만료된 플래그는 **없는 것과 같다**: 침묵 턴이 답장도 에러도 없이 사라지면
 * (세션 evict, 이미지 인라인 실패) 플래그만 남는데, 그게 나중에 오는 진짜
 * 답장을 먹으면 안 된다. 한 번 읽으면 항상 지운다 — 침묵은 1회용이다.
 */
export function consumeSilentTurn(
  flags: Map<string, number>,
  convId: string,
  now: number = Date.now(),
): boolean {
  const until = flags.get(convId)
  flags.delete(convId)
  return until !== undefined && now <= until
}
