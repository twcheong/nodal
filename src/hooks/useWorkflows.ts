import { useCallback, useEffect, useRef, useState } from 'react'

// ── useWorkflows ──────────────────────────────────────────────────────────
// Thin CRUD hook over window.twixy.workflow*. v1 only loads + mutates the
// JSON authority; the workflow viewer is read-only and execution wiring is
// not in scope yet. Component-level loading/error reporting is kept simple
// (boolean isLoading + error string) — patterns like SWR can come later if
// the list grows.

// 인스턴스 간 mutation 전파 — App / WorkflowView / OrchestrationView 가 각자
// 이 훅을 들고 있어서, 한 인스턴스의 create/update/remove 가 다른 인스턴스에
// 안 보이면 "Workflow 탭에서 지운 워크플로를 Copilot 카탈로그가 계속 매칭"
// 같은 유령이 생긴다 (재시작 전까지). mutation 성공 시 다른 인스턴스들의
// refresh 를 전부 호출한다. (useWorkflowTest 의 resetSubscribers 와 같은 패턴.)
const refreshSubscribers = new Set<() => void>()
function notifyPeers(self: () => void) {
  for (const fn of refreshSubscribers) if (fn !== self) fn()
}

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<TwixyWorkflow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.twixy?.workflowList) return
    setIsLoading(true)
    setError(null)
    try {
      const list = await window.twixy.workflowList()
      setWorkflows(Array.isArray(list) ? list : [])
    } catch (e) {
      setError((e as Error)?.message ?? 'workflow_list_failed')
      setWorkflows([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 이 인스턴스의 구독자 identity — notifyPeers 의 self 제외에 쓰인다.
  const subscriberRef = useRef<() => void>(() => {})
  useEffect(() => {
    refresh().catch(() => { /* surfaced via error state */ })
    // 다른 인스턴스의 mutation 을 받아 이 인스턴스의 목록도 갱신.
    const onPeerMutation = () => { refresh().catch(() => { /* surfaced via error state */ }) }
    subscriberRef.current = onPeerMutation
    refreshSubscribers.add(onPeerMutation)
    return () => { refreshSubscribers.delete(onPeerMutation) }
  }, [refresh])

  // mutation 후 자기 refresh + 피어 전파를 한 번에.
  const refreshAll = useCallback(async () => {
    await refresh()
    notifyPeers(subscriberRef.current)
  }, [refresh])

  // payload 는 title 만 필수. workflow-spec 파서가 만든 정규화 payload(인풋/
  // 노드/프롬프트 포함) 도 그대로 받게 한다 — preload IPC 의 workflowCreate 가
  // 모든 필드를 받아 forward 한다.
  type CreatePayload = {
    title:        string
    description?: string
    prompt?:      string
    inputs?:      TwixyModuleParam[]
    nodes?:       Parameters<typeof window.twixy.workflowCreate>[0]['nodes']
  }
  const create = useCallback(async (payload: CreatePayload): Promise<TwixyWorkflow | null> => {
    if (!window.twixy?.workflowCreate) return null
    try {
      const wf = await window.twixy.workflowCreate(payload)
      await refreshAll()
      return wf
    } catch (e) {
      setError((e as Error)?.message ?? 'workflow_create_failed')
      return null
    }
  }, [refreshAll])

  // 부분 패치 — AI-driven 수정 시 사용. 노드 배열을 보내면 id 기준 merge,
  // 빠진 id 는 삭제(설정에 의함). title/description/prompt/inputs 도 patch 가능.
  type UpdatePayload = {
    title?:       string
    description?: string
    prompt?:      string
    inputs?:      TwixyModuleParam[]
    type?:        WorkflowType
    outputDir?:   string
    tags?:        string[]
    liveId?:      string | null   // 팀 실시간 공동편집 문서 연결 (US-R1-04)
    nodes?:       Parameters<typeof window.twixy.workflowCreate>[0]['nodes']
  }
  const update = useCallback(async (id: string, patch: UpdatePayload): Promise<TwixyWorkflow | null> => {
    if (!window.twixy?.workflowUpdate) return null
    try {
      const wf = await window.twixy.workflowUpdate(id, patch)
      await refreshAll()
      return wf
    } catch (e) {
      setError((e as Error)?.message ?? 'workflow_update_failed')
      return null
    }
  }, [refreshAll])

  // 풀 overwrite 복원 — Undo 가 호출. patch merge 가 못 다루는 케이스
  // (필드 삭제, 노드 제거 등) 까지 정확히 되돌린다.
  const restore = useCallback(async (snapshot: TwixyWorkflow): Promise<TwixyWorkflow | null> => {
    if (!window.twixy?.workflowRestore) return null
    try {
      const wf = await window.twixy.workflowRestore(snapshot)
      await refreshAll()
      return wf
    } catch (e) {
      setError((e as Error)?.message ?? 'workflow_restore_failed')
      return null
    }
  }, [refreshAll])

  const remove = useCallback(async (id: string): Promise<boolean> => {
    if (!window.twixy?.workflowDelete) return false
    try {
      await window.twixy.workflowDelete(id)
      await refreshAll()
      return true
    } catch (e) {
      setError((e as Error)?.message ?? 'workflow_delete_failed')
      return false
    }
  }, [refreshAll])

  return { workflows, isLoading, error, refresh, create, update, restore, remove }
}
