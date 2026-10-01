import { useCallback, useEffect, useState } from 'react'

// ── useOrchestrations ───────────────────────────────────────────────────────
// Thin CRUD hook over window.twixy.orchestration* — the L4 sibling of
// useWorkflows. An orchestration references existing Workflows (L5) as members
// and coordinates them under one of 5 patterns. Same loading/error shape as
// useWorkflows; persistence is local JSON via IPC (no Supabase).

export function useOrchestrations() {
  const [orchestrations, setOrchestrations] = useState<TwixyOrchestration[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.twixy?.orchestrationList) return
    setIsLoading(true)
    setError(null)
    try {
      const list = await window.twixy.orchestrationList()
      setOrchestrations(Array.isArray(list) ? list : [])
    } catch (e) {
      setError((e as Error)?.message ?? 'orchestration_list_failed')
      setOrchestrations([])
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
    pattern?:     OrchestrationPattern
    prompt?:      string
    inputs?:      TwixyModuleParam[]
    members?:     Parameters<typeof window.twixy.orchestrationCreate>[0]['members']
    config?:      OrchestrationConfig
  }
  const create = useCallback(async (payload: CreatePayload): Promise<TwixyOrchestration | null> => {
    if (!window.twixy?.orchestrationCreate) return null
    try {
      const o = await window.twixy.orchestrationCreate(payload)
      await refresh()
      return o
    } catch (e) {
      setError((e as Error)?.message ?? 'orchestration_create_failed')
      return null
    }
  }, [refresh])

  type UpdatePayload = {
    title?:       string
    description?: string
    pattern?:     OrchestrationPattern
    prompt?:      string
    inputs?:      TwixyModuleParam[]
    members?:     Parameters<typeof window.twixy.orchestrationCreate>[0]['members'] & Array<{ id?: string }>
    config?:      OrchestrationConfig
  }
  const update = useCallback(async (id: string, patch: UpdatePayload): Promise<TwixyOrchestration | null> => {
    if (!window.twixy?.orchestrationUpdate) return null
    try {
      const o = await window.twixy.orchestrationUpdate(id, patch)
      await refresh()
      return o
    } catch (e) {
      setError((e as Error)?.message ?? 'orchestration_update_failed')
      return null
    }
  }, [refresh])

  const restore = useCallback(async (snapshot: TwixyOrchestration): Promise<TwixyOrchestration | null> => {
    if (!window.twixy?.orchestrationRestore) return null
    try {
      const o = await window.twixy.orchestrationRestore(snapshot)
      await refresh()
      return o
    } catch (e) {
      setError((e as Error)?.message ?? 'orchestration_restore_failed')
      return null
    }
  }, [refresh])

  const remove = useCallback(async (id: string): Promise<boolean> => {
    if (!window.twixy?.orchestrationDelete) return false
    try {
      await window.twixy.orchestrationDelete(id)
      await refresh()
      return true
    } catch (e) {
      setError((e as Error)?.message ?? 'orchestration_delete_failed')
      return false
    }
  }, [refresh])

  return { orchestrations, isLoading, error, refresh, create, update, restore, remove }
}
