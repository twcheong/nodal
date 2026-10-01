import { describe, it, expect } from 'vitest'
import {
  getModelCost, getContextWindow, computeFallbackCost, formatCostUsd, MODEL_CATALOG,
} from './modelPricing'
import { FREE_PLAN } from './entitlements'

// Smoke test proving the vitest harness resolves TS + '@' alias + runs.
describe('formatCostUsd', () => {
  it('uses 4 decimals under 1 cent', () => {
    expect(formatCostUsd(0.0012)).toBe('$0.0012')
  })
  it('uses 3 decimals at or above 1 cent', () => {
    expect(formatCostUsd(1.2345)).toBe('$1.234')
  })
  it('formats exactly one cent with 3 decimals', () => {
    expect(formatCostUsd(0.01)).toBe('$0.010')
  })
})

describe('getModelCost', () => {
  it('returns the cost for a known model', () => {
    expect(getModelCost('minimax/minimax-m3')).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 })
  })
  it('returns undefined for an unknown model', () => {
    expect(getModelCost('made/up')).toBeUndefined()
  })
  it('returns undefined for undefined input', () => {
    expect(getModelCost(undefined)).toBeUndefined()
  })
})

describe('getContextWindow', () => {
  it('returns the catalog context window', () => {
    const known = MODEL_CATALOG[0]
    expect(getContextWindow(known.id)).toBe(known.contextWindow)
  })
  it('falls back to 200k for unknown or missing model', () => {
    expect(getContextWindow('nope')).toBe(200_000)
    expect(getContextWindow(undefined)).toBe(200_000)
  })
})

describe('computeFallbackCost', () => {
  it('uses catalog per-token prices when the model is known', () => {
    // minimax: input 0.3, cacheRead 0.06, output 1.2 (per M tokens)
    const cost = computeFallbackCost({
      modelId: 'minimax/minimax-m3',
      inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.3 + 0.06 + 1.2, 6)
  })
  it('falls back to FREE_PLAN pricing when no modelId', () => {
    const cost = computeFallbackCost({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 })
    expect(cost).toBeCloseTo(FREE_PLAN.inputPricePerMTok, 6)
  })
  it('applies the cache-read discount in the FREE_PLAN path', () => {
    const cost = computeFallbackCost({ inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 })
    expect(cost).toBeCloseTo(FREE_PLAN.inputPricePerMTok * FREE_PLAN.cacheReadDiscount, 6)
  })
  it('is zero for a zero-priced model', () => {
    expect(computeFallbackCost({ modelId: 'openai/gpt-5.4-mini', inputTokens: 5000, cacheReadTokens: 5000, outputTokens: 5000 })).toBe(0)
  })
})
