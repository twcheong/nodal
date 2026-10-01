import React, { useEffect, useState } from 'react'
import { ExecutionPlanReport } from './ExecutionPlanReport'

// Shape mirrors electron/planning.ts Plan type. Duplicated here to avoid a
// renderer-side import of Node-only code.
export type PlanStepStatus =
  | 'pending' | 'running' | 'done' | 'skipped' | 'interrupted' | 'failed'

export type PlanStatus =
  | 'draft' | 'running' | 'paused' | 'done' | 'aborted' | 'failed'

// Work breakdown (company hierarchy L6 Task → L7 Sub-task → L8 Step).
export interface L8Step {
  id: string
  title: string
  toolName?: string
  toolCallId?: string
  input?: unknown
  outcome?: 'ok' | 'failed' | 'skipped'
  detail?: string
}

export interface L7Subtask {
  id: string
  title: string
  purpose?: string
  status: 'done' | 'failed' | 'partial'
  steps: L8Step[]
}

// Module Spec — reusable-module generalization of the Activity Log (mirrors
// electron/planning.ts). Candidate: Twixy proposes, Clovex/human confirms.
export interface ModuleParam {
  id: string
  kind: 'scalar' | 'list'
  valueType: 'url' | 'path' | 'query' | 'text' | 'json' | 'number'
  label: string
  observed: unknown
  confidence: 'low'
}
export interface ModuleL8 { toolName?: string; title: string; inputTemplate?: unknown }
export interface ModuleL7 { title: string; repeat?: { over: string; as: string }; steps: ModuleL8[] }
export interface ModuleTask { title: string; detail?: string; acceptance?: string; skillHint?: string | null; parameters: ModuleParam[]; subtasks: ModuleL7[] }
export interface ModuleSpec {
  version: 1
  status: 'candidate'
  source: { planId: string; generatedAt: string; method: 'single-trace-heuristic' }
  tasks: ModuleTask[]
}

export interface PlanStep {
  id: string
  title: string
  detail: string
  acceptance: string
  skillHint: string | null
  status: PlanStepStatus
  startedAt?: string
  endedAt?: string
  summary?: string
  artifacts?: { path: string; kind: string; note?: string }[]
  // Per-step compaction (post-step LLM summary so the gateway session can
  // be reset between steps without losing downstream context).
  compactSummary?:    string
  rawToolCallIds?:    string[]
  rawTranscriptPath?: string
  compactedAt?:       string
  subtasks?:          L7Subtask[]
  procedure?:         L7Subtask[]
}

export interface Plan {
  version: 1
  id: string
  projectId: string
  createdAt: string
  updatedAt: string
  title: string
  sourcePrompt: string
  priorRunRefs: string[]
  skillsReferenced: string[]
  status: PlanStatus
  currentStepIdx: number
  sessionKey?: string
  pauseRequested: boolean
  steps: PlanStep[]
  origin?: 'chat' | 'execution-plan'
  executionContext?: string
  moduleSpec?: ModuleSpec
}

interface Props {
  planId: string
  generating?: boolean
  onBuild:  (planId: string) => void
  onPause:  (planId: string) => void
  onResume: (planId: string) => void
  onDelete: (planId: string) => void
  onRevealRun: (planId: string) => void
}

function stepIcon(s: PlanStepStatus): string {
  switch (s) {
    case 'done':        return '✅'
    case 'failed':      return '❌'
    case 'interrupted': return '⏸'
    case 'skipped':     return '⤼'
    case 'running':     return '▶'
    case 'pending':     return '·'
  }
}

function statusColor(s: PlanStatus): string {
  switch (s) {
    case 'done':    return 'var(--accent)'
    case 'failed':
    case 'aborted': return 'var(--danger)'
    case 'running': return 'var(--accent)'
    case 'paused':  return 'var(--warning)'
    default:        return 'var(--text-muted)'
  }
}

export function PlanCard({ planId, generating, onBuild, onPause, onResume, onDelete, onRevealRun }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const w = window as unknown as { twixy?: { planGet?: (id: string) => Promise<Plan | null> } }
        const p = await w.twixy?.planGet?.(planId)
        if (!cancelled) {
          setPlan(p ?? null)
          if (!p && !generating) setLoadError('plan not found')
        }
      } catch (err) {
        if (!cancelled) setLoadError(String(err))
      }
    }
    void load()
    const w = window as unknown as {
      twixy?: { onPlanChanged?: (cb: (e: { id: string; kind: string }) => void) => (() => void) }
    }
    const off = w.twixy?.onPlanChanged?.(e => {
      if (e.id === planId) void load()
    })
    return () => { cancelled = true; off?.() }
  }, [planId, generating])

  if (generating && !plan) {
    return (
      <div style={shellStyle}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          📝 Drafting plan…
        </div>
      </div>
    )
  }

  if (loadError || !plan) {
    return (
      <div style={shellStyle}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Plan unavailable{loadError ? ` — ${loadError}` : ''}
        </div>
      </div>
    )
  }

  const isRunning = plan.status === 'running'
  const isPaused  = plan.status === 'paused'
  const isDone    = plan.status === 'done' || plan.status === 'failed' || plan.status === 'aborted'
  const canBuild  = plan.status === 'draft'
  const total     = plan.steps.length
  const completed = plan.steps.filter(s => s.status === 'done').length

  return (
    <div style={shellStyle}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          📋 {plan.title}
        </span>
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 999,
          background: 'var(--bg-base)', color: statusColor(plan.status),
          border: `1px solid ${statusColor(plan.status)}`,
        }}>
          {plan.status}
        </span>
        {plan.origin === 'execution-plan' && (
          <span title="Created from an Execution Plan (automation)" style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 999,
            background: 'var(--bg-base)', color: 'var(--accent)', border: '1px solid var(--accent)',
          }}>
            ⚙ Execution Plan
          </span>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {completed}/{total}
        </span>
      </div>

      {plan.skillsReferenced.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>
          Skills: {plan.skillsReferenced.map(s => (
            <span key={s} style={{
              display: 'inline-block', marginRight: 4, padding: '1px 5px',
              border: '1px solid var(--border-subtle)', borderRadius: 4,
            }}>{s}</span>
          ))}
        </div>
      )}

      {/* Body: SOP-style report for Execution Plans, simple step list otherwise */}
      {plan.origin === 'execution-plan' ? (
        <ExecutionPlanReport plan={plan} />
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {plan.steps.map((s, i) => {
          const isCurrent = isRunning && i === plan.currentStepIdx
          return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '6px 8px', borderRadius: 6,
              background: isCurrent ? 'var(--bg-base)' : 'transparent',
              border: isCurrent ? '1px solid var(--accent, #0d5c50)' : '1px solid transparent',
            }}>
              <span style={{
                fontSize: 12, width: 18, textAlign: 'center',
                color: s.status === 'done' ? 'var(--accent)' : s.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
              }}>
                {stepIcon(s.status)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  <strong>{i + 1}.</strong> {s.title}
                </div>
                {s.detail && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {s.detail}
                  </div>
                )}
                {s.acceptance && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>
                    Accepts: {s.acceptance}
                  </div>
                )}
                {s.summary && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    → {s.summary}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      )}

      {/* Action bar */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {canBuild && (
          <button style={primaryBtn} onClick={() => onBuild(planId)}>
            ▶ Start
          </button>
        )}
        {isRunning && (
          <button style={secondaryBtn} onClick={() => onPause(planId)}>
            ⏸ Pause
          </button>
        )}
        {isPaused && (
          <>
            <button style={primaryBtn} onClick={() => onResume(planId)}>
              ▶ Resume
            </button>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)', alignSelf: 'center' }}>
              Send a message to edit remaining steps.
            </span>
          </>
        )}
        {isDone && (
          <button style={secondaryBtn} onClick={() => onRevealRun(planId)}>
            📄 View run log
          </button>
        )}
        {(canBuild || isDone) && (
          <button style={ghostBtn} onClick={() => onDelete(planId)}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

const shellStyle: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-surface)',
  borderRadius: 10,
  padding: '12px 14px',
  margin: '4px 0',
  fontFamily: 'system-ui, sans-serif',
}

const primaryBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11.5,
  background: 'var(--accent, #0d5c50)', color: '#0b0b0b',
  border: 'none', borderRadius: 6, cursor: 'pointer',
  fontWeight: 600,
}

const secondaryBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11.5,
  background: 'var(--bg-base)', color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)', borderRadius: 6, cursor: 'pointer',
}

const ghostBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11.5,
  background: 'transparent', color: 'var(--text-muted)',
  border: '1px solid var(--border-subtle)', borderRadius: 6, cursor: 'pointer',
}
