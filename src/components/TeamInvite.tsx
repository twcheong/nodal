// ─────────────────────────────────────────────────────────────────────────────
// TeamInvite.tsx — 팀 초대(코드 방식) UI. (US-R1-01)
//  · InviteManager: admin 이 초대 코드 발급 + 대기 목록 + 취소.
//  · JoinTeamBox:   초대 코드 입력해 팀 가입 (무팀 유저용).
// 백엔드 = supabase/org_invites.sql (DEFINER RPC). 렌더러-직접.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { createOrgInvite, sendInviteEmail, listOrgInvites, revokeOrgInvite, acceptOrgInvite, type OrgInviteRow } from '../lib/orgInvites'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const box: React.CSSProperties = {
  border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 10, margin: '8px 6px', fontSize: 12,
}
const btn: React.CSSProperties = {
  border: 'none', background: 'var(--accent, #4ea1ff)', color: '#fff', borderRadius: 6,
  padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
}

// ── admin: 초대 발급 + 대기 목록 ──────────────────────────────────────────────
export function InviteManager({ orgId, onChanged }: { orgId: string; onChanged?: () => void }) {
  const [invites, setInvites] = useState<OrgInviteRow[]>([])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastCode, setLastCode] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const reload = () => { listOrgInvites(orgId).then(setInvites).catch(() => {}) }
  useEffect(reload, [orgId])

  async function invite() {
    setBusy(true); setErr(null); setSent(null)
    try {
      const target = email.trim()
      const row = await createOrgInvite(orgId, target || undefined)
      setLastCode(row.code); reload(); onChanged?.()
      // 이메일 입력됐으면 자동 발송(실패해도 코드는 유효 — 폴백).
      if (EMAIL_RE.test(target)) {
        const r = await sendInviteEmail(target, row.code)
        setSent(r.ok ? `${target} 로 이메일 발송됨 ✓` : `이메일 발송 실패(코드는 유효): ${r.error ?? ''}`)
      }
      setEmail('')
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }
  async function revoke(id: string) {
    try { await revokeOrgInvite(id); reload() } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div style={box}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>팀원 초대</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4, marginBottom: 8 }}>
        이메일 입력 시 초대 메일 자동 발송. 비우면 코드만 만들어 직접 전달.
      </div>
      <input
        value={email} onChange={e => setEmail(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void invite() }}
        placeholder="받는 사람 이메일 (선택)"
        style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 8px', borderRadius: 6,
                 border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text)', marginBottom: 6 }}
      />
      <button onClick={invite} disabled={busy} style={{ ...btn, width: '100%' }}>
        {busy ? '…' : (EMAIL_RE.test(email.trim()) ? '초대 메일 보내기' : '초대 코드 만들기')}
      </button>
      {sent && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>{sent}</div>}
      {lastCode && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 3 }}>이 코드를 전달하세요 (클릭하면 복사):</div>
          <code
            onClick={() => { void navigator.clipboard?.writeText(lastCode).catch(() => {}) }}
            title="클릭해 복사"
            style={{ fontWeight: 700, fontSize: 14, cursor: 'pointer', color: 'var(--accent, #4ea1ff)', wordBreak: 'break-all' }}>
            {lastCode}
          </code>
        </div>
      )}
      {err && <div style={{ color: '#e5534b', marginBottom: 6 }}>{err}</div>}
      {invites.length > 0 && (
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Pending — {invites.length}
          </div>
          {invites.map(iv => (
            <div key={iv.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <code style={{ fontWeight: 600 }}>{iv.code}</code>
              <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {iv.email || iv.role}
              </span>
              <button onClick={() => revoke(iv.id)}
                style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
                revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 초대받은 사람: 코드 입력해 가입 ────────────────────────────────────────────
export function JoinTeamBox({ onJoined }: { onJoined?: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function join() {
    if (!code.trim()) return
    setBusy(true); setErr(null); setMsg(null)
    try {
      await acceptOrgInvite(code)
      setMsg('Joined! Your team should appear shortly.'); setCode(''); onJoined?.()
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ ...box, maxWidth: 420 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Join a team</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={code} onChange={e => setCode(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void join() }}
          placeholder="Paste invite code"
          style={{ flex: 1, fontSize: 12, padding: '4px 6px', borderRadius: 6,
                   border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text)' }}
        />
        <button onClick={join} disabled={busy} style={btn}>{busy ? '…' : 'Join'}</button>
      </div>
      {msg && <div style={{ color: 'var(--accent, #4ea1ff)', marginTop: 6 }}>{msg}</div>}
      {err && <div style={{ color: '#e5534b', marginTop: 6 }}>{err}</div>}
    </div>
  )
}
