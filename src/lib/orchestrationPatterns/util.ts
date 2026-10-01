// 패턴 전략 공용 헬퍼.
import type { StrategyCtx } from './types'

export function memberLabel(ctx: StrategyCtx, m: OrchestrationMember): string {
  return m.label || ctx.workflowOf(m)?.title || m.workflowId
}

// LLM 응답에서 첫 JSON 객체/배열을 관대하게 추출. ```json 펜스, 앞뒤 산문 허용.
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    // 첫 { 또는 [ 부터 매칭 시도.
    const start = c.search(/[{[]/)
    if (start < 0) continue
    for (let end = c.length; end > start; end--) {
      const slice = c.slice(start, end)
      try { return JSON.parse(slice) as T } catch { /* shrink */ }
    }
  }
  return null
}

export function firstLine(text: string, max = 200): string {
  return (text || '').trim().split('\n')[0].slice(0, max)
}
