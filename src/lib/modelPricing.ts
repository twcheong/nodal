// ─────────────────────────────────────────────────────────────────────────────
// modelPricing.ts — 모델 카탈로그 조회 + 폴백 raw cost 계산 + raw $ 포맷터.
//
// 이 파일에는 markup 가격 정보가 절대 없음. markup 적용은 IPC
// (`window.twixy.applyDisplayMarkup`) 로만 가능 — Supabase 에서 main process
// 가 multiplier 를 fetch 하고 결과만 renderer 에 돌려줌. multiplier 그 자체는
// renderer 코드/메모리 어디에도 들어오지 않음.
//
// Display 사이트에서는 보통 `useDisplayUsd` hook 또는 `<DisplayCost />`
// 컴포넌트를 쓰면 markup IPC + 포맷팅 + loading/error 상태가 한 번에 해결됨.
// 이 파일의 `formatCostUsd(usd)` 는 markup 이미 적용된 값을 받아 문자열로만
// 만든다 (또는 raw 값을 markup 없이 표시할 때 — 회계 / 디버깅용).
// ─────────────────────────────────────────────────────────────────────────────

import catalog from '../../modelCatalog.json'
// entitlements 가 아니라 planLimits — entitlements 는 supabase 를 끌고 와서 이 모듈을 쓰는 보조 창(test-overlay)에
// Supabase 클라이언트가 하나 더 생긴다. 상수만 필요하다.
import { FREE_PLAN } from './planLimits'

export type ModelCost = {
  input:      number  // $ per million input tokens
  output:     number
  cacheRead:  number
  cacheWrite: number
}

export type ModelCatalogEntry = {
  id:            string
  name:          string
  reasoning:     boolean
  input:         string[]
  cost:          ModelCost
  contextWindow: number
  maxTokens:     number
}

export const MODEL_CATALOG: ModelCatalogEntry[] =
  (catalog as { models: ModelCatalogEntry[] }).models

export function getModelCost(modelId: string | undefined): ModelCost | undefined {
  if (!modelId) return undefined
  return MODEL_CATALOG.find(m => m.id === modelId)?.cost
}

// 모델 contextWindow 조회. 알 수 없는 modelId 면 보수적으로 200k 반환 — 워크
// 플로 Test 의 context 진행 바 표시용. 정확한 값보다 "거의 다 찼다" 시그널이
// 중요하므로 폴백이 있어도 무방.
export function getContextWindow(modelId: string | undefined): number {
  if (!modelId) return 200_000
  const m = MODEL_CATALOG.find(m => m.id === modelId)
  return m?.contextWindow ?? 200_000
}

// 게이트웨이가 cost 를 0 으로 응답하거나 모르는 모델일 때 호출. raw cost 만
// 계산 — markup 무관. recordOpenRouterUsage 같은 회계 경로에서 그대로 사용 OK.
export function computeFallbackCost(args: {
  inputTokens:     number
  cacheReadTokens: number
  outputTokens:    number
  modelId?:        string  // 있으면 카탈로그 단가, 없으면 FREE_PLAN 폴백
}): number {
  const cost = getModelCost(args.modelId)
  if (cost) {
    return (
      (args.inputTokens     * cost.input      / 1_000_000) +
      (args.cacheReadTokens * cost.cacheRead  / 1_000_000) +
      (args.outputTokens    * cost.output     / 1_000_000)
    )
  }
  // FREE_PLAN 폴백 — gpt-5.4-mini 가격으로 추정.
  return (
    (args.inputTokens     * FREE_PLAN.inputPricePerMTok                              / 1_000_000) +
    (args.cacheReadTokens * FREE_PLAN.inputPricePerMTok * FREE_PLAN.cacheReadDiscount / 1_000_000) +
    (args.outputTokens    * FREE_PLAN.outputPricePerMTok                              / 1_000_000)
  )
}

// raw 또는 marked-up usd 값을 사람 읽기 좋은 $ 문자열로 변환. markup 적용은
// 호출 측 책임 — 보통 useDisplayUsd 안에서 IPC 결과를 받은 후 호출.
export function formatCostUsd(usd: number): string {
  if (usd < 0.01) return '$' + usd.toFixed(4)
  return '$' + usd.toFixed(3)
}
