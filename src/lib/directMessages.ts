// ─────────────────────────────────────────────────────────────────────────────
// directMessages.ts — 팀원 간 1:1 DM (Supabase `org_direct_messages`).
//
// RLS: 참여자만 읽기, 발신자만 쓰기(같은 org 강제), 수신자만 read_at 갱신.
// 실시간 수신은 postgres_changes INSERT 구독 — realtime 도 RLS 를 지키므로
// 내 대화만 흘러온다.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface DirectMessageRow {
  id:           string
  org_id:       string
  sender_id:    string
  recipient_id: string
  body:         string
  created_at:   string
  read_at:      string | null
}

export async function sendDM(orgId: string, senderId: string, recipientId: string, body: string): Promise<DirectMessageRow> {
  const text = body.trim()
  if (!text) throw new Error('empty_message')
  const { data, error } = await supabase
    .from('org_direct_messages')
    .insert({ org_id: orgId, sender_id: senderId, recipient_id: recipientId, body: text.slice(0, 4000) })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as DirectMessageRow
}

// 특정 상대와의 대화 (양방향), 오래된 것부터.
export async function listConversation(userId: string, peerId: string, limit = 200): Promise<DirectMessageRow[]> {
  const { data, error } = await supabase
    .from('org_direct_messages')
    .select('*')
    .or(`and(sender_id.eq.${userId},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${userId})`)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return ((data ?? []) as DirectMessageRow[]).reverse()
}

// 내 안읽음을 발신자별로 집계 — 친구 패널의 unread 배지.
export async function unreadCounts(userId: string): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('org_direct_messages')
    .select('sender_id')
    .eq('recipient_id', userId)
    .is('read_at', null)
  if (error) throw new Error(error.message)
  const out: Record<string, number> = {}
  for (const r of (data ?? []) as Array<{ sender_id: string }>) {
    out[r.sender_id] = (out[r.sender_id] ?? 0) + 1
  }
  return out
}

// 특정 상대가 보낸 안읽음을 전부 읽음 처리 (대화창 열람 시).
export async function markConversationRead(userId: string, peerId: string): Promise<void> {
  await supabase
    .from('org_direct_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', userId)
    .eq('sender_id', peerId)
    .is('read_at', null)
}

// 내 앞으로 오는 새 DM 실시간 구독. 반환된 channel 은 소비자가 removeChannel 로 정리.
export function subscribeIncomingDMs(userId: string, onMessage: (m: DirectMessageRow) => void): RealtimeChannel {
  const ch = supabase
    .channel(`dm:inbox:${userId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'org_direct_messages',
      filter: `recipient_id=eq.${userId}`,
    }, (payload) => {
      onMessage(payload.new as DirectMessageRow)
    })
    .subscribe()
  return ch
}

export function unsubscribeChannel(ch: RealtimeChannel): void {
  void supabase.removeChannel(ch)
}
