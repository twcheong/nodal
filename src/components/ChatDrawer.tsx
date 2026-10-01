// ─────────────────────────────────────────────────────────────────────────────
// ChatDrawer.tsx — 팀원 1:1 DM 드로어 (우측 슬라이드-인).
//
// 열릴 때 대화 로드 + 상대가 보낸 안읽음을 읽음 처리. 새 수신 메시지는 부모
// (TeamDashboardPanel)의 인박스 구독이 넘겨준다 — 드로어가 열려 있는 상대의
// 메시지면 즉시 append + 읽음 처리.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrgMemberRow } from '../lib/orgMembers'
import type { PresenceStatus } from '../hooks/usePresence'
import {
  sendDM,
  listConversation,
  markConversationRead,
  type DirectMessageRow,
} from '../lib/directMessages'

interface Props {
  userId: string
  peer:   OrgMemberRow
  status: PresenceStatus
  // 부모의 인박스 구독이 이 상대로부터 받은 새 메시지를 흘려준다.
  incoming: DirectMessageRow | null
  onClose: () => void
}

const STATUS_UI: Record<PresenceStatus, { color: string; label: string }> = {
  online:  { color: 'var(--green, #0d5c50)', label: 'Online' },
  busy:    { color: '#e0a11b', label: 'Busy' },
  offline: { color: 'var(--border)', label: 'Offline' },
}

export function ChatDrawer({ userId, peer, status, incoming, onClose }: Props) {
  const [messages, setMessages] = useState<DirectMessageRow[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const peerLabel = peer.display_name || peer.email || 'Member'

  const load = useCallback(async () => {
    try {
      setMessages(await listConversation(userId, peer.user_id))
      void markConversationRead(userId, peer.user_id).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [userId, peer.user_id])

  useEffect(() => { void load() }, [load])

  // 부모 인박스에서 이 상대의 새 메시지가 흘러오면 append + 읽음 처리.
  useEffect(() => {
    if (!incoming || incoming.sender_id !== peer.user_id) return
    setMessages(prev => prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming])
    void markConversationRead(userId, peer.user_id).catch(() => {})
  }, [incoming, peer.user_id, userId])

  // 새 메시지마다 맨 아래로.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function send() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const row = await sendDM(peer.org_id, userId, peer.user_id, text)
      setMessages(prev => [...prev, row])
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 340, zIndex: 55,
      background: 'var(--bg-base)', borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 24px rgba(0,0,0,0.25)',
    }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: STATUS_UI[status].color,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {peerLabel}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{STATUS_UI[status].label}</div>
        </div>
        <button onClick={onClose} style={{
          border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)',
          borderRadius: 7, padding: '3px 9px', fontSize: 11, cursor: 'pointer',
        }}>✕</button>
      </div>

      {/* 메시지 */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 24 }}>
            Say hi to {peerLabel} 👋
          </div>
        )}
        {messages.map((m) => {
          const mine = m.sender_id === userId
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div
                title={new Date(m.created_at).toLocaleString()}
                style={{
                  maxWidth: '78%', padding: '7px 11px', borderRadius: 12,
                  borderBottomRightRadius: mine ? 4 : 12,
                  borderBottomLeftRadius: mine ? 12 : 4,
                  background: mine ? 'var(--accent, #0d5c50)' : 'var(--bg-surface)',
                  border: mine ? 'none' : '1px solid var(--border)',
                  color: mine ? '#fff' : 'var(--text)',
                  fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {m.body}
              </div>
            </div>
          )
        })}
      </div>

      {/* 입력 */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
        {error && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 6 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send() }}
            placeholder={`Message ${peerLabel}…`}
            autoFocus
            style={{
              flex: 1, border: '1px solid var(--border)', background: 'var(--bg-surface)',
              color: 'var(--text)', borderRadius: 8, padding: '8px 11px', fontSize: 12.5, outline: 'none',
            }}
          />
          <button
            onClick={() => void send()}
            disabled={busy || !draft.trim()}
            style={{
              border: 'none', background: 'var(--accent, #0d5c50)', color: '#fff',
              borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', opacity: busy || !draft.trim() ? 0.5 : 1,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
