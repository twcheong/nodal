// ─────────────────────────────────────────────────────────────────────────────
// usePresence.ts — org 단위 온라인/상태 표시 (Supabase Realtime Presence).
//
// 앱이 켜져 있는 동안 org 채널에 자기 상태(online/busy/offline)를 track 하고,
// 채널 presence 가 바뀔 때마다 user_id → status 맵을 돌려준다. DB 테이블 없음.
// 채널은 마운트당 1회만 구독하고(재구독 없음), 내 상태가 바뀌면 track 만 갱신한다.
// "offline" = appear-offline(연결돼 있어도 남에겐 오프라인). presence 에 아예
// 없는 유저는 미접속(진짜 오프라인).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export type PresenceStatus = 'online' | 'busy' | 'offline'

export function usePresence(
  orgId: string | null,
  userId: string | undefined,
  name: string | null,
  myStatus: PresenceStatus,
): Map<string, PresenceStatus> {
  const [statuses, setStatuses] = useState<Map<string, PresenceStatus>>(new Map())
  const chRef = useRef<RealtimeChannel | null>(null)
  const statusRef = useRef(myStatus)
  statusRef.current = myStatus

  // 채널 구독 — orgId/userId/name 이 바뀔 때만 재설정.
  useEffect(() => {
    if (!orgId || !userId) {
      setStatuses(new Map())
      return
    }
    const ch = supabase.channel(`presence:org:${orgId}`, {
      config: { presence: { key: userId } },
    })
    chRef.current = ch
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, Array<{ status?: PresenceStatus }>>
      const m = new Map<string, PresenceStatus>()
      for (const [uid, metas] of Object.entries(state)) {
        m.set(uid, metas[0]?.status ?? 'online')
      }
      setStatuses(m)
    })
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        void ch.track({ name, status: statusRef.current, online_at: new Date().toISOString() })
      }
    })
    return () => {
      chRef.current = null
      void supabase.removeChannel(ch)
    }
  }, [orgId, userId, name])

  // 내 상태만 바뀌면 재구독 없이 track 갱신.
  useEffect(() => {
    if (chRef.current) {
      void chRef.current.track({ name, status: myStatus, online_at: new Date().toISOString() })
    }
  }, [myStatus, name])

  return statuses
}
