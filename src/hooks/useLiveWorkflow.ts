// ─────────────────────────────────────────────────────────────────────────────
// useLiveWorkflow.ts — 라이브 문서 구독 + 노드별 편집 presence. (US-R1-04)
//
// · postgres_changes(UPDATE) 로 원격 저장 수신 → onRemote(wf) (자기 에코 제외).
// · Realtime Presence 로 "누가 어느 노드 편집 중" 브로드캐스트.
// usePresence.ts 패턴 미러. 로컬 편집→서버 push 는 호출부(WorkflowView)에서 담당.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { LiveWorkflowRow } from '../lib/liveWorkflows'

export interface NodeEditor { userId: string; name: string; nodeId: string | null }

export function useLiveWorkflow(
  liveId:   string | null,
  userId:   string | undefined,
  userName: string | null,
  myNodeId: string | null,
  onRemote: (wf: TwixyWorkflow, updatedBy: string | null) => void,
) {
  const [editors, setEditors] = useState<NodeEditor[]>([])
  const presenceRef = useRef<RealtimeChannel | null>(null)
  const onRemoteRef = useRef(onRemote)
  onRemoteRef.current = onRemote

  // 원격 저장 수신 (postgres_changes).
  useEffect(() => {
    if (!liveId) return
    const ch = supabase
      .channel(`live-doc:${liveId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_workflows', filter: `id=eq.${liveId}` },
        (payload) => {
          const row = payload.new as LiveWorkflowRow
          if (row.updated_by === userId) return   // 내가 쓴 건 무시(에코)
          onRemoteRef.current(row.workflow_json, row.updated_by)
        },
      )
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [liveId, userId])

  // 노드별 편집 presence.
  useEffect(() => {
    if (!liveId || !userId) { setEditors([]); return }
    const ch = supabase.channel(`live-presence:${liveId}`, { config: { presence: { key: userId } } })
    presenceRef.current = ch
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, Array<{ name?: string; nodeId?: string | null }>>
      const list: NodeEditor[] = []
      for (const [uid, metas] of Object.entries(state)) {
        list.push({ userId: uid, name: metas[0]?.name ?? '', nodeId: metas[0]?.nodeId ?? null })
      }
      setEditors(list)
    })
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') void ch.track({ name: userName ?? '', nodeId: myNodeId })
    })
    return () => { presenceRef.current = null; void supabase.removeChannel(ch) }
    // myNodeId 는 재구독 없이 아래 effect 에서 갱신 (채널 churn 방지).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveId, userId, userName])

  // 내 편집 노드 바뀌면 재track (재구독 없이).
  useEffect(() => {
    if (presenceRef.current) void presenceRef.current.track({ name: userName ?? '', nodeId: myNodeId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myNodeId, userName])

  return { editors }
}
