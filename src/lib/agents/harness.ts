// ─────────────────────────────────────────────────────────────────────────────
// agents/harness.ts — 러너 하네스 프리앰블 (순수).
//
// 변종 선택을 **인자로 받는다**. 예전엔 이 결정이 localStorage 읽기로 모듈 안에 박혀 있어서
// 렌더러 밖에서는 이 텍스트를 만들 수가 없었다. 플래그를 읽는 일은 렌더러 관심사라
// src/lib/runnerHarness.ts 에 남기고, 여기는 "어떤 변종이면 어떤 문구" 만 안다.
//
// 이게 좌석(agents/**)에 있는 이유: scripts/wf-eval.mjs 같은 순수 node 소비자가
// 제품과 **같은** 하네스 문구를 쓸 수 있어야 하기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────

import { WORKFLOW_RUNNER_V3_SOUL_MD } from './generated/soulText'

/**
 * 러너 하네스 변종.
 *  · v3  — "추론·철저" 하네스(WORKFLOW_RUNNER_V3_SOUL.md). 기본값.
 *          A/B(SEO Action Plan, n=5): 품질 8.3 vs baseline 6.95 (+19%), 비용도 저렴.
 *  · off — 붙이지 않는다 (디버깅 / baseline 비교용).
 * 과거 v2 "툴 절약" 하네스는 조기 종료를 유도해 품질을 해쳐(A/B 1~3점) 폐기했다.
 */
export type HarnessVariant = 'v3' | 'off'

export const DEFAULT_HARNESS_VARIANT: HarnessVariant = 'v3'

/**
 * 임의의 하네스 본문을 첫 노드용 블록으로 감싼다.
 *
 * 따로 열어 둔 이유: A/B 러너(scripts/wf-eval.mjs)는 제품이 안 쓰는 변종(v2 등)도 비교한다.
 * 그 래퍼 문구를 거기서 다시 적으면 프롬프트 문자열 사본이 또 하나 생긴다 — 지금 없애고 있는 바로 그것.
 */
export function formatHarnessBlock(soulText: string): string {
  return `[Runner Harness — follow this before executing the node below]\n${soulText.trim()}\n`
}

/** 첫 노드에 prepend 할 블록. off 면 ''. */
export function harnessPreambleFor(variant: HarnessVariant): string {
  if (variant === 'off') return ''
  return formatHarnessBlock(WORKFLOW_RUNNER_V3_SOUL_MD)
}

/** 실행 기록(RunHistoryEntry.harness)용 라벨. */
export function harnessLabelFor(variant: HarnessVariant): HarnessVariant {
  return variant
}
