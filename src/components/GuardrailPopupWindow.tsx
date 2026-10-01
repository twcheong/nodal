import { useEffect, useState } from 'react'

type Action = 'approve' | 'session' | 'remember' | 'deny' | 'save-as'

// 덮어쓰기 승인(pluginId twixy.overwrite)의 description 에서 대상 경로 파싱.
// useGuardrail.overwritePathFromDescription 과 같은 계약 — 이 창은 별도 번들
// (guardrail.html)이라 로컬 복사본을 둔다.
function overwritePathFromDescription(desc: string): string {
  const m = /OVERWRITE the existing file:\s*(.+)$/.exec(desc)
  return m ? m[1].trim() : ''
}

/** "다른 이름으로 저장" 기본 제안 — useGuardrail.suggestSaveAsName 의 로컬 복사본. */
function suggestSaveAsName(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext  = dot > 0 ? base.slice(dot) : ''
  const m = /^(.*)-v(\d+)$/.exec(stem)
  return m ? `${m[1]}-v${Number(m[2]) + 1}${ext}` : `${stem}-v2${ext}`
}

interface PopupState {
  request: GuardrailApprovalRequest | null
  mode:    GuardrailMode
}

/**
 * Standalone window rendered from `guardrail.html`. The main renderer
 * spawns this window when `useGuardrail.current` becomes non-null and
 * pushes the request via `guardrail-popup-sync`. Decisions go back via
 * `guardrail-popup-decide`, which `App.tsx` forwards into `guardrail.decide`
 * so the allowlist + session cache stay in sync with the modal flow.
 */
export function GuardrailPopupWindow() {
  const [state, setState] = useState<PopupState>({ request: null, mode: 'standard' })
  const [rememberScope, setRememberScope] = useState<'ask' | null>(null)
  // 덮어쓰기 승인 전용 — "다른 이름으로 저장" 파일명 입력.
  const [saveAsName, setSaveAsName] = useState<string | null>(null)

  useEffect(() => {
    void window.twixy.guardrailPopupRequestSync().then(s => {
      if (s) setState(s)
    })
    const off = window.twixy.onGuardrailPopupSync(s => setState(s))
    return off
  }, [])

  // Reset the "remember scope?" sub-prompt whenever a new request arrives.
  useEffect(() => { setRememberScope(null); setSaveAsName(null) }, [state.request?.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !state.request) return
      e.preventDefault()
      // 이름 입력 중이면 Esc 는 그 입력만 취소한다 (승인 거부 아님).
      if (saveAsName !== null) { setSaveAsName(null); return }
      decide('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function decide(action: Action, params?: Record<string, unknown>, saveAs?: string) {
    if (!state.request) return
    void window.twixy.guardrailPopupDecide({
      id:     state.request.id,
      action,
      params,
      ...(saveAs ? { saveAsName: saveAs } : {}),
    })
  }

  if (!state.request) {
    return (
      <div style={emptyShellStyle}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Waiting…</div>
      </div>
    )
  }

  const req = state.request
  const preview = buildPreview(req)
  const target  = extractTarget(req)
  const isStrict = state.mode === 'strict'
  const isOverwrite = req.pluginId === 'twixy.overwrite'
  const isCritical = req.severity === 'critical' || req.severity === 'danger'

  return (
    <div style={shellStyle}>
      <div style={dragBarStyle}>
        <span style={{ fontSize: 13 }}>🛡</span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--accent)',
        }}>Guardrail</span>
        {req.severity && (
          <span style={{
            fontSize: 9.5, padding: '2px 7px', borderRadius: 999,
            background: isCritical ? 'rgba(181, 72, 47,0.15)' : 'rgba(176, 125, 24,0.12)',
            color:      isCritical ? 'var(--danger)' : 'var(--warning)',
            textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600,
          }}>{req.severity}</span>
        )}
        <div style={{ flex: 1 }} />
      </div>

      <div style={headerStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
          {req.title || toolLabel(req.toolName)}
        </div>
        {target && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-secondary)',
            fontFamily: 'ui-monospace, monospace',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{target}</div>
        )}
      </div>

      <div style={bodyStyle}>
        {req.description && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            {req.description}
          </div>
        )}
        <pre style={previewStyle}>
          {preview.lines.map((l, i) => (
            <span key={i} style={{
              display: 'block',
              color: l.startsWith('+') ? 'var(--accent)'
                   : l.startsWith('-') ? 'var(--danger)'
                   : 'var(--text-secondary)',
            }}>{l || ' '}</span>
          ))}
        </pre>
        {preview.truncated && (
          <div style={{ fontSize: 10, color: '#777', marginTop: 6, fontStyle: 'italic' }}>
            …truncated
          </div>
        )}
      </div>

      {rememberScope === null && saveAsName === null && (
        <div style={footerStyle}>
          <button onClick={() => decide('deny')} style={btnDanger}>Deny (Esc)</button>
          {isOverwrite && (
            <button
              onClick={() => setSaveAsName(suggestSaveAsName(overwritePathFromDescription(req.description)))}
              style={btnGhost}
            >Save as…</button>
          )}
          {!isStrict && (
            <button
              onClick={() => {
                if (canScopeRemember(req)) setRememberScope('ask')
                else decide('remember')
              }}
              style={btnGhost}
            >Always allow</button>
          )}
          {!isStrict && (
            <button onClick={() => decide('session')} style={btnGhost}>Allow for session</button>
          )}
          <button onClick={() => decide('approve')} style={btnPrimary}>Approve</button>
        </div>
      )}

      {saveAsName !== null && (
        <div style={{ ...footerStyle, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Keep the existing file — save this output as a new name (same folder).
          </div>
          <input
            autoFocus
            value={saveAsName}
            onChange={e => setSaveAsName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && saveAsName.trim()) { e.preventDefault(); decide('save-as', undefined, saveAsName) }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSaveAsName(null) }
            }}
            style={saveAsInput}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setSaveAsName(null)} style={btnGhost}>Cancel</button>
            <button
              onClick={() => decide('save-as', undefined, saveAsName)}
              disabled={!saveAsName.trim()}
              style={btnPrimary}
            >Save as this name</button>
          </div>
        </div>
      )}

      {rememberScope === 'ask' && (
        <div style={{ ...footerStyle, flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Remember for which scope?
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setRememberScope(null)} style={btnGhost}>Cancel</button>
            <button onClick={() => { setRememberScope(null); decide('remember') }} style={btnGhost}>
              This {rememberScopeKindLabel(req)} only
            </button>
            <button
              onClick={() => {
                setRememberScope(null)
                decide('remember', wrapParamsForDirScope(req.params))
              }}
              style={btnPrimary}
            >
              Entire parent directory
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function canScopeRemember(req: GuardrailApprovalRequest): boolean {
  const tn = req.toolName
  const params = (req.params ?? {}) as Record<string, unknown>
  if (tn === 'Write' || tn === 'write' || tn === 'Edit' || tn === 'edit' || tn === 'NotebookEdit') {
    const p = String(params.path ?? params.file_path ?? '')
    return Boolean(p && p.includes('/'))
  }
  return false
}

function rememberScopeKindLabel(req: GuardrailApprovalRequest): string {
  const tn = req.toolName
  if (tn === 'Bash' || tn === 'bash' || tn === 'exec') return 'command'
  return 'file'
}

function wrapParamsForDirScope(params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  const raw = String(p.path ?? p.file_path ?? '')
  if (!raw.includes('/')) return p
  const dir = raw.slice(0, raw.lastIndexOf('/'))
  return { ...p, path: `${dir}/**`, file_path: `${dir}/**` }
}

function toolLabel(tn: string): string {
  const t = tn.toLowerCase()
  if (t === 'write') return 'Write file'
  if (t === 'edit' || t === 'notebookedit') return 'Edit file'
  if (t === 'bash' || t === 'exec') return 'Run shell command'
  return tn
}

function extractTarget(req: GuardrailApprovalRequest): string {
  const params = (req.params ?? {}) as Record<string, unknown>
  const tn = req.toolName
  // 덮어쓰기 승인 — 경로는 description 으로만 온다 (useGuardrail 파서와 계약).
  if (req.pluginId === 'twixy.overwrite') {
    return overwritePathFromDescription(req.description)
  }
  if (tn === 'Write' || tn === 'write' || tn === 'Edit' || tn === 'edit' || tn === 'NotebookEdit') {
    return String(params.path ?? params.file_path ?? '')
  }
  if (tn === 'Bash' || tn === 'bash' || tn === 'exec') {
    return String(params.command ?? '')
  }
  return ''
}

function buildPreview(req: GuardrailApprovalRequest): { lines: string[]; truncated: boolean } {
  const params = (req.params ?? {}) as Record<string, unknown>
  const tn = req.toolName
  const MAX = 200

  // 덮어쓰기 승인 — diff 없음(경로만 전달), 무슨 일이 일어나는지 요약.
  if (req.pluginId === 'twixy.overwrite') {
    const p = overwritePathFromDescription(req.description)
    return { lines: [
      `! The file already exists and will be REPLACED:`,
      `  ${p}`,
      '',
      '# Save as… = keep this file, write the new output under a name you pick.',
      '# Deny     = block the write; the agent is told to pick a new name itself.',
    ], truncated: false }
  }

  if (tn === 'Edit' || tn === 'edit') {
    const oldStr = String(params.old_string ?? '')
    const newStr = String(params.new_string ?? '')
    const lines: string[] = []
    oldStr.split('\n').forEach(l => lines.push(`-${l}`))
    newStr.split('\n').forEach(l => lines.push(`+${l}`))
    return truncate(lines, MAX)
  }
  if (tn === 'Write' || tn === 'write') {
    const content = String(params.content ?? '')
    return truncate(content.split('\n').map(l => `+${l}`), MAX)
  }
  if (tn === 'NotebookEdit') {
    const oldSrc = String(params.old_string ?? '')
    const newSrc = String(params.new_source ?? params.new_string ?? '')
    const lines = [
      ...oldSrc.split('\n').map(l => `-${l}`),
      ...newSrc.split('\n').map(l => `+${l}`),
    ]
    return truncate(lines, MAX)
  }
  if (tn === 'Bash' || tn === 'bash' || tn === 'exec') {
    const cmd = String(params.command ?? '')
    const cwd = String(params.cwd ?? '')
    const desc = String(params.description ?? '')
    const out: string[] = []
    if (desc) { out.push(`# ${desc}`); out.push('') }
    if (cwd)  out.push(`$ cd ${cwd}`)
    cmd.split('\n').forEach(l => out.push(`$ ${l}`))
    return truncate(out, MAX)
  }
  try {
    return truncate(JSON.stringify(params, null, 2).split('\n'), MAX)
  } catch {
    return { lines: ['(no preview)'], truncated: false }
  }
}

function truncate(lines: string[], max: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false }
  return { lines: lines.slice(0, max), truncated: true }
}

// ── styles ────────────────────────────────────────────────────────
const shellStyle: React.CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(15,15,15,0.92)',
  backdropFilter: 'saturate(140%) blur(18px)',
  WebkitBackdropFilter: 'saturate(140%) blur(18px)',
  border: '1px solid rgba(13, 92, 80,0.35)',
  borderRadius: 12,
  overflow: 'hidden',
  color: 'var(--text-secondary)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
}

const emptyShellStyle: React.CSSProperties = {
  ...shellStyle,
  alignItems: 'center', justifyContent: 'center',
}

const dragBarStyle: React.CSSProperties = {
  height: 30,
  display: 'flex', alignItems: 'center',
  padding: '0 12px', gap: 8,
  borderBottom: '1px solid rgba(20, 32, 27,0.06)',
  WebkitAppRegion: 'drag',
} as React.CSSProperties

const headerStyle: React.CSSProperties = {
  padding: '14px 18px 10px',
  borderBottom: '1px solid rgba(20, 32, 27,0.06)',
}

const bodyStyle: React.CSSProperties = {
  flex: 1,
  padding: '12px 18px',
  overflow: 'auto',
  minHeight: 80,
}

const previewStyle: React.CSSProperties = {
  margin: 0,
  padding: 10,
  background: 'rgba(20, 32, 27,0.03)',
  border: '1px solid rgba(20, 32, 27,0.06)',
  borderRadius: 6,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: '100%',
  overflow: 'auto',
}

const footerStyle: React.CSSProperties = {
  padding: '12px 16px 14px',
  borderTop: '1px solid rgba(20, 32, 27,0.06)',
  display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end',
}

const saveAsInput: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'var(--bg-input, #fff)', border: '1px solid var(--border-subtle)',
  borderRadius: 6, color: 'var(--text-primary)',
  fontSize: 11.5, fontFamily: 'ui-monospace, monospace', padding: '6px 9px', outline: 'none',
}
const btnGhost: React.CSSProperties = {
  padding: '7px 12px',
  background: 'transparent',
  border: '1px solid rgba(20, 32, 27,0.15)',
  borderRadius: 6,
  color: 'var(--text-secondary)',
  fontSize: 11.5,
  cursor: 'pointer',
}

const btnPrimary: React.CSSProperties = {
  padding: '7px 14px',
  background: 'var(--accent)',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
}

const btnDanger: React.CSSProperties = {
  padding: '7px 12px',
  background: 'transparent',
  border: '1px solid var(--danger)',
  borderRadius: 6,
  color: 'var(--danger)',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
}
