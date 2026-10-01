import { useEffect, useState } from 'react'
import { overwritePathFromDescription, suggestSaveAsName, type GuardrailDecision } from '../hooks/useGuardrail'
import { Button } from './ui'

interface Props {
  config:  GuardrailConfig
  request: GuardrailApprovalRequest | null
  onDecide: (req: GuardrailApprovalRequest, action: GuardrailDecision, opts?: { saveAsName?: string }) => void
}

/**
 * Approval modal for Guardrail Mode. Follows the UpgradeModal pattern
 * (fixed overlay, accent = var(--accent)). Shows tool name + target + a simple
 * diff / command preview, and offers 4 decision buttons (standard) or 2
 * (strict).
 */
export function GuardrailModal({ config, request, onDecide }: Props) {
  const [rememberScope, setRememberScope] = useState<'ask' | null>(null)
  // "다른 이름으로 저장" — 덮어쓰기 승인 전용 서브프롬프트 (파일명 입력).
  const [saveAsName, setSaveAsName] = useState<string | null>(null)

  useEffect(() => { setRememberScope(null); setSaveAsName(null) }, [request?.id])

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // 이름 입력 중이면 Esc 는 서브프롬프트만 닫는다 (승인 거부 아님).
      if (saveAsName !== null) { setSaveAsName(null); return }
      onDecide(request, 'deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, onDecide, saveAsName])

  if (!request) return null

  const preview = buildPreview(request)
  const target  = extractTarget(request)
  const isStrict = config.mode === 'strict'
  const isOverwrite = request.pluginId === 'twixy.overwrite'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '82vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-surface, #ffffff)',
          border: '1px solid var(--border-subtle, #cfdbd3)',
          borderRadius: 'var(--radius, 10px)',
          color: 'var(--text-primary, #14201b)',
          fontFamily: 'system-ui, sans-serif',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--border-subtle, #cfdbd3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 16 }}>🛡</span>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--accent, #0d5c50)',
            }}>Guardrail</span>
            {request.severity && (
              <span style={{
                marginLeft: 'auto',
                fontSize: 10, padding: '2px 8px', borderRadius: 10,
                background: (request.severity === 'critical' || request.severity === 'danger') ? 'rgba(181, 72, 47,0.15)' : 'rgba(176, 125, 24,0.12)',
                color:      (request.severity === 'critical' || request.severity === 'danger') ? 'var(--danger)' : 'var(--warning)',
                textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600,
              }}>{request.severity}</span>
            )}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
            {request.title || toolLabel(request.toolName)}
          </div>
          {target && (
            <div style={{
              fontSize: 12, color: 'var(--text-muted, #8a968d)',
              fontFamily: 'ui-monospace, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{target}</div>
          )}
        </div>

        <div style={{ padding: '14px 24px', flex: 1, overflow: 'auto', minHeight: 80 }}>
          {request.description && (
            <div style={{ fontSize: 12, color: 'var(--text-muted, #8a968d)', marginBottom: 10 }}>
              {request.description}
            </div>
          )}
          <pre style={{
            margin: 0,
            padding: 12,
            background: 'rgba(20, 32, 27,0.03)',
            border: '1px solid var(--border-subtle, #d9e1da)',
            borderRadius: 6,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11.5,
            lineHeight: 1.5,
            color: 'var(--text-primary, #e5e5e5)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 280,
            overflow: 'auto',
          }}>
            {preview.lines.map((l, i) => (
              <span key={i} style={{
                display: 'block',
                color: l.startsWith('+') ? 'var(--accent)'
                     : l.startsWith('-') ? 'var(--danger)'
                     : 'inherit',
              }}>{l || ' '}</span>
            ))}
          </pre>
          {preview.truncated && (
            <div style={{ fontSize: 10, color: 'var(--text-muted, #777)', marginTop: 6, fontStyle: 'italic' }}>
              …truncated
            </div>
          )}
        </div>

        {rememberScope === null && saveAsName === null && (
          <div style={{ padding: '12px 20px 18px', borderTop: '1px solid var(--border-subtle, #cfdbd3)', display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="danger" onClick={() => onDecide(request, 'deny')}>Deny (Esc)</Button>
            {isOverwrite && (
              <Button
                variant="secondary"
                onClick={() => setSaveAsName(suggestSaveAsName(overwritePathFromDescription(request.description)))}
              >Save as…</Button>
            )}
            {!isStrict && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (canScopeRemember(request)) setRememberScope('ask')
                  else onDecide(request, 'remember')
                }}
              >Always allow</Button>
            )}
            {!isStrict && (
              <Button variant="secondary" onClick={() => onDecide(request, 'session')}>Allow for session</Button>
            )}
            <Button variant="primary" onClick={() => onDecide(request, 'approve')}>Approve</Button>
          </div>
        )}

        {saveAsName !== null && (
          <div style={{ padding: '14px 20px 18px', borderTop: '1px solid var(--border-subtle, #cfdbd3)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #8a968d)', marginBottom: 8 }}>
              Keep the existing file and save this output as a new name (same folder).
            </div>
            <input
              autoFocus
              value={saveAsName}
              onChange={e => setSaveAsName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && saveAsName.trim()) { e.preventDefault(); onDecide(request, 'save-as', { saveAsName }) }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSaveAsName(null) }
              }}
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 10,
                background: 'var(--bg-input, #fff)', border: '1px solid var(--border-subtle, #cfdbd3)',
                borderRadius: 'var(--radius-sm, 6px)', color: 'var(--text-primary)',
                fontSize: 12, fontFamily: 'ui-monospace, monospace', padding: '7px 10px', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => setSaveAsName(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => onDecide(request, 'save-as', { saveAsName })}>
                Save as this name
              </Button>
            </div>
          </div>
        )}

        {rememberScope === 'ask' && (
          <div style={{ padding: '14px 20px 18px', borderTop: '1px solid var(--border-subtle, #cfdbd3)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #8a968d)', marginBottom: 10 }}>
              Remember for which scope?
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => setRememberScope(null)}>Cancel</Button>
              <Button variant="secondary" onClick={() => { setRememberScope(null); onDecide(request, 'remember') }}>
                This {rememberScopeKindLabel(request)} only
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setRememberScope(null)
                  onDecide({ ...request, params: wrapParamsForDirScope(request.params) }, 'remember')
                }}
              >
                Entire parent directory
              </Button>
            </div>
          </div>
        )}
      </div>
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

// When user picks "directory scope", rewrite the path param into a `dir/**`
// pattern so the hook's fingerprint() stores the allowlist entry at that scope.
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
  // 덮어쓰기 승인 — 경로가 description 에 실려 온다 (approval 스키마가 params
  // 필드를 안 받음). useGuardrail 의 overwritePathFromDescription 과 같은 계약.
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

  // 덮어쓰기 승인 — 내용 diff 는 없고(경로만 전달됨) 무슨 일이 일어나는지 요약.
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

