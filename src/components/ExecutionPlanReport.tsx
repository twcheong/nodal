import React from 'react'
import type { Plan, L7Subtask, L8Step, ModuleSpec, ModuleL7 } from './PlanCard'

// SOP-style document view for an imported Execution Plan, modelled on the
// Clovex AI SOP detail view (banner section bands + 2-col field/section rows).
// JSON stays the canonical wire format; this is purely the human review render.
// Shown inside PlanCard when plan.origin === 'execution-plan'.

const COLW = 150  // label column width

function Banner({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      padding: '6px 10px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-base)', fontSize: 11.5, fontWeight: 600,
      color: 'var(--text-primary)',
    }}>
      <span>{children}</span>
      {right != null && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{right}</span>}
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `${COLW}px 1fr`, alignItems: 'start',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        padding: '6px 10px', fontSize: 11, color: 'var(--text-secondary)',
        borderRight: '1px solid var(--border)', background: 'var(--bg-base)',
      }}>{label}</div>
      <div style={{ padding: '6px 10px', fontSize: 11.5, color: 'var(--text-primary)', minWidth: 0, wordBreak: 'break-word' }}>
        {children}
      </div>
    </div>
  )
}

// Map known Execution Plan context keys to friendly labels; fall back to the
// raw key for anything unrecognised.
const CTX_LABELS: Record<string, string> = {
  L2_project:     'L2 Project',
  L3_subProject:  'L3 Sub-Project',
  L4_workPackage: 'L4 Work Package',
  L5_activity:    'L5 Activity',
  notes:          'Notes',
}

function parseContext(executionContext?: string): Array<{ label: string; value: string }> {
  if (!executionContext || !executionContext.trim()) return []
  const txt = executionContext.trim()
  if (txt.startsWith('{')) {
    try {
      const obj = JSON.parse(txt) as Record<string, unknown>
      return Object.entries(obj).map(([k, v]) => ({
        label: CTX_LABELS[k] ?? k,
        value: typeof v === 'string' ? v : JSON.stringify(v),
      }))
    } catch { /* fall through to raw text */ }
  }
  return [{ label: 'Context', value: txt }]
}

function distinctTools(plan: Plan): string[] {
  const set = new Set<string>()
  for (const step of plan.steps) {
    for (const st of step.procedure ?? []) {
      // st.steps may be missing on plans saved before procedure validation.
      for (const ls of st.steps ?? []) {
        if (ls.toolName) set.add(ls.toolName)
      }
    }
  }
  return [...set]
}

function salientValue(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const k of ['url', 'targetUrl', 'path', 'relPath', 'file_path', 'command', 'query']) {
    if (typeof o[k] === 'string') return o[k] as string
  }
  return null
}

function L8Row({ ls }: { ls: L8Step }) {
  const salient = salientValue(ls.input)
  let fullInput = ''
  if (ls.input != null) { try { fullInput = JSON.stringify(ls.input, null, 2) } catch { /* ignore */ } }
  return (
    <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '1px 0' }}>
      <span style={{ color: 'var(--text-muted)' }}>L8</span>{' '}
      {ls.toolName && (
        <code style={{
          fontSize: 10, padding: '0 4px', borderRadius: 4,
          background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)',
        }}>{ls.toolName}</code>
      )}{' '}
      <span style={{ color: 'var(--text-primary)' }}>{ls.title}</span>
      {salient && <span style={{ color: 'var(--text-muted)' }}> — {salient}</span>}
      {fullInput && fullInput !== '{}' && (
        <details style={{ marginLeft: 18 }}>
          <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--text-muted)' }}>input</summary>
          <pre style={{
            margin: '2px 0 0', padding: 6, fontSize: 10, lineHeight: 1.35,
            background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 4,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-secondary)',
          }}>{fullInput}</pre>
        </details>
      )}
    </div>
  )
}

function L7Block({ st }: { st: L7Subtask }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>L7</span> {st.title}
      </div>
      <div style={{ marginLeft: 12, marginTop: 2 }}>
        {/* steps may be missing on plans saved before procedure validation. */}
        {(st.steps ?? []).map((ls, i) => <L8Row key={ls.id ?? i} ls={ls} />)}
      </div>
    </div>
  )
}

// Render a generalized input template, highlighting {{param}} (variable) and
// "<runtime>" (produced at run time) vs fixed verbatim values.
function TemplateLine({ template }: { template: unknown }) {
  let json = ''
  try { json = JSON.stringify(template) } catch { json = String(template) }
  // Split on the two marker kinds so we can colour them.
  const parts = json.split(/("\{\{[^}]+\}\}"|"<runtime>")/g)
  return (
    <span style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all' }}>
      {parts.map((p, i) => {
        if (/^"\{\{.*\}\}"$/.test(p)) return <span key={i} style={{ color: 'var(--accent)' }}>{p}</span>      // param/item
        if (p === '"<runtime>"')      return <span key={i} style={{ color: 'var(--warning)' }}>{p}</span>      // runtime
        return <span key={i} style={{ color: 'var(--text-muted)' }}>{p}</span>                          // fixed
      })}
    </span>
  )
}

function ModuleL7Block({ l7 }: { l7: ModuleL7 }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>L7</span> {l7.title}
        {l7.repeat && (
          <span title="count-variable: repeats once per list item" style={{
            marginLeft: 6, fontSize: 9.5, padding: '0 5px', borderRadius: 999,
            background: 'var(--bg-base)', border: '1px solid var(--accent)', color: 'var(--accent)',
          }}>↻ repeat × {`{{${l7.repeat.over}}}`}</span>
        )}
      </div>
      <div style={{ marginLeft: 12, marginTop: 2 }}>
        {l7.steps.map((ls, i) => (
          <div key={i} style={{ fontSize: 10.5, padding: '1px 0' }}>
            {ls.toolName && (
              <code style={{
                fontSize: 10, padding: '0 4px', borderRadius: 4, marginRight: 4,
                background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)',
              }}>{ls.toolName}</code>
            )}
            {ls.inputTemplate != null && <TemplateLine template={ls.inputTemplate} />}
          </div>
        ))}
      </div>
    </div>
  )
}

function ModuleSection({ spec }: { spec: ModuleSpec }) {
  return (
    <>
      <Banner right="candidate">Module — reusable skeleton + variables</Banner>

      <div style={{ padding: '6px 10px', fontSize: 10.5, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--accent)' }}>{'{{param}}'}</span> = variable (supplied per run) ·{' '}
        <span style={{ color: 'var(--warning)' }}>{'<runtime>'}</span> = produced during the run · plain = fixed/reusable
      </div>

      {/* Variables + procedure are recorded PER L6 Task (not plan-wide). */}
      {spec.tasks.map((t, i) => (
        <div key={i} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
            Step {i + 1} (L6) — {t.title}
          </div>

          {t.parameters.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Variables ({t.parameters.length})</div>
              {t.parameters.map(p => (
                <div key={p.id} style={{ fontSize: 10.5, color: 'var(--text-secondary)', padding: '1px 0' }}>
                  <code style={{ color: 'var(--accent)' }}>{`{{${p.id}}}`}</code>{' '}
                  <span style={{ color: 'var(--text-muted)' }}>
                    {p.kind === 'list' ? `list<${p.valueType}>` : p.valueType}
                    {p.kind === 'list' && Array.isArray(p.observed) ? ` ×${(p.observed as unknown[]).length}` : ''}
                  </span>
                  {' — '}
                  {(() => { try { return JSON.stringify(p.observed) } catch { return String(p.observed) } })().slice(0, 90)}
                </div>
              ))}
            </div>
          )}

          {t.subtasks.map((l7, j) => <ModuleL7Block key={j} l7={l7} />)}
        </div>
      ))}
    </>
  )
}

export function ExecutionPlanReport({ plan }: { plan: Plan }) {
  const ctx   = parseContext(plan.executionContext)
  const tools = distinctTools(plan)

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
      overflow: 'hidden', marginTop: 6, marginBottom: 8,
    }}>
      {ctx.length > 0 && (
        <>
          <Banner>Context (L2–L5)</Banner>
          {ctx.map((c, i) => <FieldRow key={i} label={c.label}>{c.value}</FieldRow>)}
        </>
      )}

      {tools.length > 0 && (
        <>
          <Banner>Tools</Banner>
          <div style={{ padding: '6px 10px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {tools.map(t => (
              <code key={t} style={{
                fontSize: 10, padding: '1px 5px', borderRadius: 4,
                background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)',
              }}>{t}</code>
            ))}
          </div>
        </>
      )}

      <Banner right={`${plan.steps.length} task${plan.steps.length === 1 ? '' : 's'}`}>Procedure</Banner>
      {plan.steps.map((step, i) => (
        <div key={step.id} style={{
          display: 'grid', gridTemplateColumns: `${COLW}px 1fr`, alignItems: 'start',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            padding: '8px 10px', borderRight: '1px solid var(--border)', background: 'var(--bg-base)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>Step {i + 1}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>L6 Task</div>
            {step.skillHint && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                skill: <code style={{ fontSize: 10 }}>{step.skillHint}</code>
              </div>
            )}
          </div>
          <div style={{ padding: '8px 10px', minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{step.title}</div>
            {step.detail && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{step.detail}</div>
            )}
            {step.acceptance && (
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>
                Done when: {step.acceptance}
              </div>
            )}
            {step.procedure && step.procedure.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {step.procedure.map((st, j) => <L7Block key={st.id ?? j} st={st} />)}
              </div>
            )}
          </div>
        </div>
      ))}

      {plan.moduleSpec && <ModuleSection spec={plan.moduleSpec} />}
    </div>
  )
}
