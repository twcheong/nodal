// 침묵 턴이 남의 답장을 삼키지 않는지 — npx tsx scripts/checkSilentTurn.ts
//
// 실사고(2026-09-15): 덱 자동 검증은 앱↔모델 내부 왕복이라 전사에서 빼는데,
// 그 "다음 답장 하나를 삼킨다" 는 플래그가 **소비되지 않고 남을 수 있었다**.
// 침묵 턴이 답장도 에러도 없이 사라지면(세션 LRU evict, 이미지 인라인 실패,
// 90초 타임아웃 뒤 도착) 플래그가 세션 내내 살아남아, 그 다음에 오는 **사용자
// 질문에 대한 진짜 답장**을 삼켰다. 사용자는 메시지를 보내고 아무 답도 받지
// 못했다 — 앱이 버린 것이다.
//
// 그래서 규칙은 이름 있는 함수(consumeSilentTurn)이고, 여기서 검사한다.

import { consumeSilentTurn } from '../src/lib/silentTurns'

let fail = 0
const ok = (c: boolean, m: string) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fail++ }

const T0 = 1_000_000
const TTL = 150_000

// ① 정상: 검증 질문을 보내고 그 답장이 오면 삼킨다.
{
  const f = new Map<string, number>([['c1', T0 + TTL]])
  ok(consumeSilentTurn(f, 'c1', T0 + 5_000) === true, '침묵 턴의 답장은 삼킨다')
  ok(f.size === 0, '플래그는 1회용 — 읽으면 사라진다')
}

// ② 핵심: 같은 대화의 **두 번째** 메시지는 절대 안 삼킨다.
{
  const f = new Map<string, number>([['c1', T0 + TTL]])
  consumeSilentTurn(f, 'c1', T0 + 5_000)
  ok(consumeSilentTurn(f, 'c1', T0 + 6_000) === false, '그 다음 답장은 사용자 것이다 — 삼키지 않는다')
}

// ③ 실사고 그 자체: 답장이 영영 안 와서 플래그가 남은 뒤, 한참 뒤 사용자가
//    질문하고 받은 답장. 만료됐으므로 삼키면 안 된다.
{
  const f = new Map<string, number>([['c1', T0 + TTL]])
  ok(consumeSilentTurn(f, 'c1', T0 + TTL + 1) === false, '만료된 플래그는 없는 것과 같다')
  ok(f.size === 0, '만료돼도 치운다')
}

// ④ 경계: 마감 시각 정각까지는 유효.
{
  const f = new Map<string, number>([['c1', T0 + TTL]])
  ok(consumeSilentTurn(f, 'c1', T0 + TTL) === true, '마감 정각은 아직 유효')
}

// ⑤ 대화 격리: 다른 대화의 플래그가 이 대화 답장을 먹지 않는다.
{
  const f = new Map<string, number>([['c1', T0 + TTL]])
  ok(consumeSilentTurn(f, 'c2', T0 + 1_000) === false, '다른 대화는 영향 없음')
  ok(f.get('c1') === T0 + TTL, '남의 플래그를 지우지도 않는다')
}

// ⑥ 플래그가 아예 없을 때(대부분의 턴)
{
  ok(consumeSilentTurn(new Map(), 'c1', T0) === false, '평범한 턴은 그대로 보인다')
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
