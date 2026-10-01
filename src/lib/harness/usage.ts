// ─────────────────────────────────────────────────────────────────────────────
// harness/usage — 노드 한 개가 쓴 비용/토큰을 원장 스냅샷의 차이로 구한다.
//
// 이 파일이 생긴 이유: 똑같은 헬퍼가 두 벌 있었고, 한쪽 주석이 스스로
// "useWorkflowTest 와 동일 로직" 이라고 적고 있었다 (runWorkflowNodes.ts).
// 키 이름 후보 목록 같은 건 한 곳에만 있어야 한다 — 게이트웨이가 키를 하나
// 바꾸면 한쪽만 0 을 보고하기 시작하고, 그건 아무도 눈치채지 못한다.
//
// 순수 함수 + 주입된 UsagePort 만 쓴다. React·window.twixy·PRODUCT 없음.
// ─────────────────────────────────────────────────────────────────────────────
import type { UsagePort } from './ports'

export interface UsageTotals {
  usd?:       number
  tokensIn?:  number
  tokensOut?: number
}

/**
 * 게이트웨이가 돌려주는 자유 형식 totals 에서 우리가 아는 키를 골라낸다.
 * 후보를 여럿 두는 건 openclaw 버전마다 키 이름이 달랐기 때문 — 못 찾으면 undefined
 * 이고, 그건 "0" 이 아니라 "모름" 으로 취급된다 (nonNegDelta 참고).
 */
export function extractTotals(t: Record<string, number> | undefined): UsageTotals {
  if (!t) return {}
  return {
    usd:       pickNum(t, ['usd', 'cost', 'totalCost', 'cost_usd', 'usdCost']),
    tokensIn:  pickNum(t, ['tokensIn', 'inputTokens', 'tokens_in', 'in', 'tokensInputs']),
    tokensOut: pickNum(t, ['tokensOut', 'outputTokens', 'tokens_out', 'out', 'tokensOutputs']),
  }
}

function pickNum(t: Record<string, number>, keys: string[]): number | undefined {
  for (const k of keys) if (typeof t[k] === 'number') return t[k]
  return undefined
}

/**
 * 두 스냅샷의 차이. 음수는 0 으로 — 원장이 리셋되거나 병렬 run 이 섞이면
 * 음수가 나올 수 있는데, 노드 비용이 음수로 표시되는 것보다 0 이 낫다.
 * prev 를 모르면 cur 전체를 이번 노드가 쓴 것으로 본다(최초 노드).
 */
export function nonNegDelta(cur: number | undefined, prev: number | undefined): number {
  if (typeof cur !== 'number') return 0
  if (typeof prev !== 'number') return cur
  return Math.max(0, cur - prev)
}

/** prev 대비 delta 세 개를 한 번에. */
export function usageDelta(prev: UsageTotals, cur: UsageTotals) {
  return {
    costUsd:   nonNegDelta(cur.usd,       prev.usd),
    tokensIn:  nonNegDelta(cur.tokensIn,  prev.tokensIn),
    tokensOut: nonNegDelta(cur.tokensOut, prev.tokensOut),
  }
}

/**
 * 게이트웨이 원장은 LLM 응답 직후가 아니라 ~2s 뒤에 갱신된다. 값이 움직일
 * 때까지 짧게 폴링하고, 끝내 안 움직이면 마지막으로 읽은 값을 준다
 * (실패해도 run 을 죽이지 않는다 — 비용 표시는 부수 정보다).
 */
export async function settledUsage(
  getUsage: () => Promise<UsageTotals>,
  prev: UsageTotals,
  attempts = 6,
  intervalMs = 500,
): Promise<UsageTotals> {
  let last: UsageTotals = prev
  for (let i = 0; i < attempts; i++) {
    try {
      const cur = await getUsage()
      last = cur
      const moved =
        (typeof cur.usd       === 'number' && (typeof prev.usd       !== 'number' || cur.usd       > prev.usd))      ||
        (typeof cur.tokensIn  === 'number' && (typeof prev.tokensIn  !== 'number' || cur.tokensIn  > prev.tokensIn)) ||
        (typeof cur.tokensOut === 'number' && (typeof prev.tokensOut !== 'number' || cur.tokensOut > prev.tokensOut))
      if (moved) return cur
    } catch { /* 한 번 실패해도 재시도 — 마지막 값으로 fallback */ }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs))
  }
  return last
}

/** UsagePort(원시 응답) → UsageTotals 로 읽는 어댑터. */
export function totalsFromPort(usage: UsagePort): () => Promise<UsageTotals> {
  return async () => extractTotals((await usage())?.totals)
}
