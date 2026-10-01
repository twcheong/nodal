import { useCallback, useEffect, useState } from 'react'

// ── useAiAgents ─────────────────────────────────────────────────────────────
// Thin CRUD hook over window.twixy.aiAgent* — mirrors useOrchestrations.
// An AI Agent = a Specialist over workflow options (criteria + options); it picks
// the single best-fit option for the input. Persisted as local JSON via IPC.

export function useAiAgents() {
  const [agents, setAgents] = useState<TwixyAiAgent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.twixy?.aiAgentList) return
    setIsLoading(true)
    setError(null)
    try {
      const list = await window.twixy.aiAgentList()
      setAgents(Array.isArray(list) ? list : [])
    } catch (e) {
      setError((e as Error)?.message ?? 'aiagent_list_failed')
      setAgents([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => { /* surfaced via error state */ })
  }, [refresh])

  type CreatePayload = {
    title:        string
    description?: string
    criteria?:    string
    options?:     OrchestrationMemberInput[]
  }
  const create = useCallback(async (payload: CreatePayload): Promise<TwixyAiAgent | null> => {
    if (!window.twixy?.aiAgentCreate) return null
    try {
      const a = await window.twixy.aiAgentCreate(payload)
      await refresh()
      return a
    } catch (e) {
      setError((e as Error)?.message ?? 'aiagent_create_failed')
      return null
    }
  }, [refresh])

  type UpdatePayload = {
    title?:       string
    description?: string
    criteria?:    string
    options?:     OrchestrationMemberInput[]
  }
  const update = useCallback(async (id: string, patch: UpdatePayload): Promise<TwixyAiAgent | null> => {
    if (!window.twixy?.aiAgentUpdate) return null
    try {
      const a = await window.twixy.aiAgentUpdate(id, patch)
      await refresh()
      return a
    } catch (e) {
      setError((e as Error)?.message ?? 'aiagent_update_failed')
      return null
    }
  }, [refresh])

  const remove = useCallback(async (id: string): Promise<boolean> => {
    if (!window.twixy?.aiAgentDelete) return false
    try {
      await window.twixy.aiAgentDelete(id)
      await refresh()
      return true
    } catch (e) {
      setError((e as Error)?.message ?? 'aiagent_delete_failed')
      return false
    }
  }, [refresh])

  return { agents, isLoading, error, refresh, create, update, remove }
}
