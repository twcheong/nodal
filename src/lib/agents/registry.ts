// ─────────────────────────────────────────────────────────────────────────────
// agents/registry.ts — 좌석 하나짜리 레지스트리 팩토리.
//
// 제품이 `products/<id>/renderer/main.tsx` 에서 App 렌더 전에 채운다. 코어는 등록된
// 것이 무엇인지 모른 채 타입만 따른다 (copilotModes 가 이미 검증한 패턴).
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRegistry<T extends { id: string }> {
  register(agent: T): void
  /** 못 찾으면 undefined — 총(total) 조회가 필요한 좌석은 호출부에서 기본값을 씌운다. */
  get(id: string | null | undefined): T | undefined
  list(): T[]
}

export function createAgentRegistry<T extends { id: string }>(): AgentRegistry<T> {
  const byId = new Map<string, T>()
  return {
    register: (agent) => { byId.set(agent.id, agent) },
    get:      (id) => (id ? byId.get(id) : undefined),
    list:     () => [...byId.values()],
  }
}
