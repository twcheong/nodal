// ─────────────────────────────────────────────────────────────────────────────
// GuardrailSettings.tsx — 가드레일(파일쓰기/삭제·네트워크 Bash 승인) 설정.
//
// 이전엔 Admin 탭 안에 있었으나 Settings 탭으로 이동. AdminPanel 도 이 컴포넌트를
// 재사용한다 (admin 탭은 현재 사이드바에서 숨김).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'

export function GuardrailSettings() {
  const [cfg, setCfg] = useState<GuardrailConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)  // "kind:entry"

  useEffect(() => {
    let alive = true
    window.twixy?.guardrailGetConfig?.().then(c => { if (alive && c) setCfg(c) }).catch(() => {})
    const off = window.twixy?.onGuardrailConfigChanged?.(c => setCfg(c)) ?? (() => {})
    return () => { alive = false; off() }
  }, [])

  const setMode = async (mode: GuardrailMode) => {
    setBusy(true); setErr(null); setSaved(false)
    try {
      const res = await window.twixy?.guardrailSetConfig?.({ mode })
      if (res && !res.ok) setErr(res.error ?? 'save failed')
      else if (res?.config) {
        setCfg(res.config)
        setSaved(true)
        setTimeout(() => setSaved(false), 1800)
      }
    } finally { setBusy(false) }
  }

  const remove = async (kind: 'write' | 'edit' | 'bash', entry: string) => {
    setBusy(true); setErr(null)
    try {
      const res = await window.twixy?.guardrailRemoveAllowlistEntry?.({ tool: kind, entry })
      if (res && !res.ok) setErr(res.error ?? 'remove failed')
      else if (res?.config) setCfg(res.config)
    } finally { setBusy(false); setConfirmRemove(null) }
  }

  if (!cfg) return <Card><div style={muted}>Loading…</div></Card>

  const total = cfg.allowlist.write.length + cfg.allowlist.edit.length + cfg.allowlist.bash.length

  return (
    <Card>
      <Row label="Mode">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <select
            value={cfg.mode}
            disabled={busy}
            onChange={e => setMode(e.target.value as GuardrailMode)}
            style={sel}
          >
            <option value="bypass">Bypass — no prompts (default)</option>
            <option value="standard">Standard — prompt first, remember on approval</option>
            <option value="strict">Strict — prompt every action, no remembering</option>
          </select>
          {saved && <span style={{ fontSize: 11, color: 'var(--accent)' }}>Saved ✓</span>}
        </div>
      </Row>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Intercepts file writes/edits and destructive or network shell commands with an approval modal. Mode changes apply from the next agent action.
      </div>
      {err && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err}</div>}

      <ModeComparison active={cfg.mode} />

      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Permanent allowlist</div>
        {total === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Empty.</div>
        ) : (
          <>
            <AllowlistGroup kind="write" label="Write" entries={cfg.allowlist.write}
              confirmRemove={confirmRemove} setConfirmRemove={setConfirmRemove} onRemove={remove} busy={busy} />
            <AllowlistGroup kind="edit" label="Edit" entries={cfg.allowlist.edit}
              confirmRemove={confirmRemove} setConfirmRemove={setConfirmRemove} onRemove={remove} busy={busy} />
            <AllowlistGroup kind="bash" label="Bash" entries={cfg.allowlist.bash}
              confirmRemove={confirmRemove} setConfirmRemove={setConfirmRemove} onRemove={remove} busy={busy} />
          </>
        )}
      </div>
    </Card>
  )
}

function AllowlistGroup({
  kind, label, entries, confirmRemove, setConfirmRemove, onRemove, busy,
}: {
  kind: 'write' | 'edit' | 'bash'
  label: string
  entries: string[]
  confirmRemove: string | null
  setConfirmRemove: (v: string | null) => void
  onRemove: (kind: 'write' | 'edit' | 'bash', entry: string) => void
  busy: boolean
}) {
  if (entries.length === 0) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        {label}
      </div>
      {entries.map(entry => {
        const key = `${kind}:${entry}`
        const isConfirming = confirmRemove === key
        return (
          <div key={key} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '5px 0', fontSize: 12, borderBottom: '1px solid var(--border-subtle)',
          }}>
            <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry}
            </code>
            <button
              onClick={() => isConfirming ? onRemove(kind, entry) : setConfirmRemove(key)}
              onBlur={() => isConfirming && setConfirmRemove(null)}
              disabled={busy}
              style={{
                ...secondaryBtn,
                color: isConfirming ? 'var(--danger)' : 'var(--text-muted)',
                borderColor: isConfirming ? 'rgba(181, 72, 47,0.5)' : 'var(--border-subtle)',
              }}
            >
              {isConfirming ? 'Confirm?' : 'Remove'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function ModeComparison({ active }: { active: GuardrailMode }) {
  const rows: Array<{ label: string; bypass: string; standard: string; strict: string }> = [
    { label: 'Approval modal', bypass: 'Never', standard: 'First time per file/command', strict: 'Every action, every time' },
    { label: 'Session memory', bypass: 'N/A', standard: 'Yes — "Allow for session"', strict: 'Disabled' },
    { label: 'Permanent allowlist', bypass: 'N/A', standard: 'Yes — "Always allow"', strict: 'Disabled' },
    { label: 'Intercepts', bypass: 'Nothing', standard: 'Write / Edit / destructive & network Bash', strict: 'Write / Edit / destructive & network Bash' },
    { label: 'Safe Bash (ls, cat, etc.)', bypass: 'Pass-through', standard: 'Pass-through', strict: 'Pass-through' },
    { label: 'Best for', bypass: 'Solo dev, fast iteration', standard: 'Daily work with safety net', strict: 'Audit / compliance / shared envs' },
  ]
  const cols: Array<{ key: GuardrailMode; label: string }> = [
    { key: 'bypass',   label: 'Bypass' },
    { key: 'standard', label: 'Standard' },
    { key: 'strict',   label: 'Strict' },
  ]
  const cellBase: React.CSSProperties = {
    padding: '6px 8px', fontSize: 11, color: 'var(--text-primary)',
    borderTop: '1px solid var(--border-subtle)', verticalAlign: 'top', lineHeight: 1.5,
  }
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>What each mode does</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ ...cellBase, borderTop: 'none', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, width: '28%' }}>Aspect</th>
              {cols.map(c => (
                <th key={c.key} style={{
                  ...cellBase, borderTop: 'none', textAlign: 'left', fontWeight: 600,
                  color: c.key === active ? 'var(--accent)' : 'var(--text-muted)',
                  background: c.key === active ? 'rgba(13, 92, 80,0.08)' : 'transparent',
                }}>
                  {c.label}{c.key === active ? ' • current' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td style={{ ...cellBase, color: 'var(--text-muted)' }}>{r.label}</td>
                {cols.map(c => (
                  <td key={c.key} style={{ ...cellBase, background: c.key === active ? 'rgba(13, 92, 80,0.06)' : 'transparent' }}>
                    {r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
        Destructive Bash = <code>rm</code>, <code>mv</code>, <code>chmod</code>, <code>git reset --hard</code>, redirects (<code>&gt;</code>), etc.
        Network Bash = <code>git push</code>, <code>npm install</code>, <code>curl -X POST</code>, etc.
      </div>
    </div>
  )
}

// ── local style helpers (AdminPanel 과 동일한 소형 프리미티브 복제) ──
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {children}
    </div>
  )
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 140 }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}
const muted: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' }
const input: React.CSSProperties = {
  background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)', fontSize: 12, padding: '6px 10px', outline: 'none',
}
const sel: React.CSSProperties = { ...input, minWidth: 260 }
const secondaryBtn: React.CSSProperties = {
  padding: '4px 10px', background: 'transparent', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
}
