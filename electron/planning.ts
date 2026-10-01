// Planning Mode — local-only plan storage + human-readable rendering.
//
// Disk layout (inside the project root):
//   user/plans/<plan_id>/plan.json   authoritative machine state
//   user/plans/<plan_id>/plan.md     human-readable draft (regenerated from JSON)
//   user/plans/<plan_id>/run.md      live execution log, appended during runs
//
// The planning loop itself (planner LLM round-trip + step-by-step driving of
// the gateway) lives in the renderer — this file is pure IO. The renderer
// builds a PlanInput, we scaffold the files. As the run progresses the
// renderer calls the step-level IPC handlers which delegate here for disk IO.
//
// Plans are always personal (under user/). Promoting a plan to the team is
// an explicit MR flow and not part of this module.

import * as fs     from 'node:fs'
import * as path   from 'node:path'
import * as crypto from 'node:crypto'
import { safeSegment } from './trustBoundary'

// ── Types ──────────────────────────────────────────────────────────────────
export type PlanStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'done'
  | 'aborted'
  | 'failed'

export type PlanStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped'
  | 'interrupted'
  | 'failed'

export type PlanAuthor = { uid: string; email?: string }

// ── Work breakdown (company hierarchy L6 → L7 → L8) ─────────────────────────
// A PlanStep is treated as an L6 Task. The compactor LLM additionally decomposes
// the step's transcript into L7 Sub-tasks (a logical bundle of work within the
// step) each containing L8 Steps (one mechanical, repeatable action — usually a
// single tool_use). All optional; populated by saveStepCompact. Absence means a
// legacy plan or a step with no tool activity.
export type L8Step = {
  id:          string             // step-local: 's8_1', 's8_2'
  title:       string             // human label for the action (LLM-supplied or derived)
  toolName?:   string             // bash / edit / read / browser / sessions_spawn …
  toolCallId?: string             // links to the tool_use.id in raw.jsonl (replay anchor)
  input?:      unknown            // the actual tool_use arguments (replay payload)
  outcome?:    'ok' | 'failed' | 'skipped'
  detail?:     string
}

export type L7Subtask = {
  id:       string                // step-local: 's7_1', 's7_2'
  title:    string                // ~one line ("Generate JWT signing helper")
  purpose?: string                // why this group exists (one line)
  status:   'done' | 'failed' | 'partial'
  steps:    L8Step[]
}

// ── Module Spec (Activity Log → reusable module) ────────────────────────────
// A deterministic, single-trace generalization of a finished plan's Activity
// Log (steps[].subtasks). It marks what is reusable vs variable so the log can
// seed an SOP / Execution Plan. Always a CANDIDATE — one run cannot prove a
// value is variable; Clovex/human confirms. See generateModuleSpec().
//
// Each L8 input leaf is classified three ways:
//   - fixed:   structural / non-value (action, kind, selector, profile) — kept verbatim
//   - param:   supplied per run (url, output path, query) — replaced by {{paramId}} / {{item}}
//   - runtime: produced during the run (write content, xlsx payload, browser targetId) — "<runtime>"
// Count variability (5 Threads posts vs 1) is expressed as a `repeat` loop over
// a list parameter.
export type ModuleParam = {
  id:         string                              // 'threads_urls'
  kind:       'scalar' | 'list'                   // list = count-variable (loop source)
  valueType:  'url' | 'path' | 'query' | 'text' | 'json' | 'number'
  label:      string
  observed:   unknown                             // this run's value(s)
  confidence: 'low'                               // single-trace ⇒ always candidate
}
export type ModuleL8 = {
  toolName?:     string
  title:         string
  inputTemplate?: unknown                         // leaves: {{paramId}} | {{item}} | "<runtime>" | verbatim
}
export type ModuleL7 = {
  title:   string
  repeat?: { over: string; as: string }           // loop over a list param (count-variable)
  steps:   ModuleL8[]
}
export type ModuleTask = {                          // L6
  title:       string
  detail?:     string
  acceptance?: string
  skillHint?:  string | null
  parameters:  ModuleParam[]                        // L6-scoped variables (per-task, not plan-wide)
  subtasks:    ModuleL7[]
}
export type ModuleSpec = {
  version:    1
  status:     'candidate'
  source:     { planId: string; generatedAt: string; method: 'single-trace-heuristic' }
  tasks:      ModuleTask[]                           // parameters live per task (see ModuleTask)
}

export type PlanStep = {
  id:        string
  title:     string
  detail:    string
  acceptance:string
  skillHint: string | null
  status:    PlanStepStatus
  startedAt?: string
  endedAt?:   string
  summary?:   string
  artifacts?: { path: string; kind: string; note?: string }[]
  // ── Per-step compaction (post-step LLM summary so the gateway session can
  // be reset between steps without losing downstream context). All optional;
  // populated by saveStepCompact after a successful step.
  compactSummary?:    string
  rawToolCallIds?:    string[]   // toolCallIds the compactor flagged for raw retention
  rawTranscriptPath?: string     // path relative to plansRoot, e.g. <planId>/steps/<stepId>/raw.jsonl
  compactedAt?:       string
  // L7 Sub-task → L8 Step decomposition of this step, produced by the compactor
  // LLM. Empty array = compactor ran but the step had no tool activity worth
  // bucketing. undefined = legacy step (created before this feature).
  subtasks?:          L7Subtask[]
  // SOP procedure guidance for this step (L7/L8), supplied by an incoming
  // Execution Plan. This is the PLAN (what the standard procedure says to do);
  // `subtasks` above is the MEASURED record of what actually ran. Only present
  // on origin === 'execution-plan' steps.
  procedure?:         L7Subtask[]
}

export type Plan = {
  version:          1
  id:               string
  projectId:        string
  author:           PlanAuthor
  createdAt:        string
  updatedAt:        string
  title:            string
  sourcePrompt:     string
  priorRunRefs:     string[]          // plan ids referenced when generating this one
  skillsReferenced: string[]
  status:           PlanStatus
  currentStepIdx:   number
  sessionKey?:      string            // openclaw gateway session key during a run
  pauseRequested:   boolean
  steps:            PlanStep[]
  // How this plan was created. 'chat' (or undefined for legacy) = the human
  // chat → planner LLM → PlanCard flow. 'execution-plan' = ingested from an
  // external Execution Plan (API or UI import) for human-free automation.
  origin?:          'chat' | 'execution-plan'
  // Upper-level (L2-L5) context carried by an Execution Plan, injected into the
  // per-step prompt so the run follows the standard procedure tightly. Only on
  // origin === 'execution-plan'.
  executionContext?: string
  // Candidate reusable module generalized from this run's Activity Log
  // (steps[].subtasks). Generated by generateModuleSpec at finalize. Optional —
  // absent on legacy / not-yet-finalized plans.
  moduleSpec?:       ModuleSpec
  // SOP this run executed against (from an Execution Plan). Grouping key for
  // downstream multi-trace module refinement (done outside Twixy, e.g. Clovex).
  sopRef?:           string
  // Skeleton hash of this run's procedure (values/counts ignored). Lets a
  // downstream consumer group runs of the same procedure. Set at finalize.
  procedureFingerprint?: string
}

export type CreatePlanInput = {
  title:             string
  sourcePrompt:      string
  priorRunRefs?:     string[]
  skillsReferenced?: string[]
  steps:             Array<{
    title:      string
    detail?:    string
    acceptance?:string
    skillHint?: string | null
    procedure?: L7Subtask[]   // SOP procedure guidance (execution-plan only)
  }>
  author: PlanAuthor
  projectId: string
  // Set by the Execution Plan ingestion paths; omitted by the chat flow.
  origin?:           'chat' | 'execution-plan'
  executionContext?: string
  sopRef?:           string
}

export type StepEndPayload = {
  status:    'done' | 'failed' | 'interrupted' | 'skipped'
  summary?:  string
  finalText?:string                   // the LLM's final reply, written to run.md
  toolCalls?:Array<{ name: string; detail?: string }>
  artifacts?:PlanStep['artifacts']
}

// Payload written by the per-step compaction round-trip the renderer fires
// between steps. The compactor LLM produces a markdown summary that's
// inlined into the next step's prompt, plus an optional list of toolCallIds
// the orchestrator must keep raw (re-injected verbatim into prompts of any
// downstream step that needs them). The full message slice for the step is
// also persisted so the raw retentions survive process restarts.
export type StepCompactPayload = {
  compactSummary:   string
  rawToolCallIds?:  string[]
  rawMessages?:     unknown[]   // gateway message slice for this step (written verbatim to raw.jsonl)
  subtasks?:        L7Subtask[] // L7/L8 decomposition extracted from the compactor's "## Work breakdown" section
}

// ── Low-level helpers ──────────────────────────────────────────────────────
function plansRoot(userDir: string): string {
  return path.join(userDir, 'plans')
}
function planDir(userDir: string, id: string): string {
  return path.join(plansRoot(userDir), safeSegment(id))
}
function planJsonPath(userDir: string, id: string): string {
  return path.join(planDir(userDir, id), 'plan.json')
}
function planMdPath(userDir: string, id: string): string {
  return path.join(planDir(userDir, id), 'plan.md')
}
function runMdPath(userDir: string, id: string): string {
  return path.join(planDir(userDir, id), 'run.md')
}
function stepRawDir(userDir: string, planId: string, stepId: string): string {
  return path.join(planDir(userDir, planId), 'steps', safeSegment(stepId))
}
function stepRawJsonlPath(userDir: string, planId: string, stepId: string): string {
  return path.join(stepRawDir(userDir, planId, stepId), 'raw.jsonl')
}

function generateId(prefix: string): string {
  const bytes = crypto.randomBytes(8).toString('hex')
  return `${prefix}_${Date.now().toString(36)}${bytes}`
}

function nowIso(): string {
  return new Date().toISOString()
}

// One-line, length-capped rendering of a tool call's input args for run.md.
// The full untruncated args live in plan.json (L8Step.input) and raw.jsonl;
// this is just the human-readable preview.
function summarizeInput(input: unknown): string {
  if (input == null) return ''
  try {
    const json = JSON.stringify(input)
    if (!json || json === '{}' || json === 'null') return ''
    const max = 200
    return '`' + (json.length > max ? json.slice(0, max) + '…' : json) + '`'
  } catch {
    return ''
  }
}

function statusBadge(s: PlanStepStatus): string {
  switch (s) {
    case 'done':        return '✅'
    case 'failed':      return '❌'
    case 'interrupted': return '⏸'
    case 'skipped':     return '⤼'
    case 'running':     return '▶︎'
    case 'pending':     return '·'
  }
}

// ── JSON IO ────────────────────────────────────────────────────────────────
export function readPlan(userDir: string, id: string): Plan | null {
  try {
    const raw  = fs.readFileSync(planJsonPath(userDir, id), 'utf8')
    const plan = JSON.parse(raw) as Plan
    if (plan?.version !== 1 || typeof plan?.id !== 'string') return null
    return plan
  } catch {
    return null
  }
}

function writePlan(userDir: string, plan: Plan): void {
  fs.mkdirSync(planDir(userDir, plan.id), { recursive: true })
  fs.writeFileSync(planJsonPath(userDir, plan.id), JSON.stringify(plan, null, 2), 'utf8')
  fs.writeFileSync(planMdPath(userDir, plan.id), renderPlanMd(plan), 'utf8')
}

export function listPlans(userDir: string, opts?: { status?: PlanStatus }): Plan[] {
  let entries: string[] = []
  try { entries = fs.readdirSync(plansRoot(userDir)) } catch { return [] }
  const out: Plan[] = []
  for (const id of entries) {
    const p = readPlan(userDir, id)
    if (!p) continue
    if (opts?.status && p.status !== opts.status) continue
    out.push(p)
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

export function deletePlan(userDir: string, id: string): void {
  fs.rmSync(planDir(userDir, id), { recursive: true, force: true })
}

// ── Create ─────────────────────────────────────────────────────────────────
export function createPlan(userDir: string, input: CreatePlanInput): Plan {
  if (!input.title.trim()) throw new Error('title required')
  if (!input.steps.length)  throw new Error('at least one step required')

  const id  = generateId('plan')
  const now = nowIso()
  const steps: PlanStep[] = input.steps.map((s, i) => ({
    id:         `s${i + 1}`,
    title:      String(s.title ?? '').trim() || `Step ${i + 1}`,
    detail:     String(s.detail ?? '').trim(),
    acceptance: String(s.acceptance ?? '').trim(),
    skillHint:  s.skillHint ?? null,
    status:     'pending',
    ...(Array.isArray(s.procedure) && s.procedure.length > 0 ? { procedure: s.procedure } : {}),
  }))

  const plan: Plan = {
    version:          1,
    id,
    projectId:        input.projectId,
    author:           input.author,
    createdAt:        now,
    updatedAt:        now,
    title:            input.title.trim(),
    sourcePrompt:     input.sourcePrompt,
    priorRunRefs:     input.priorRunRefs     ?? [],
    skillsReferenced: input.skillsReferenced ?? [],
    status:           'draft',
    currentStepIdx:   0,
    pauseRequested:   false,
    steps,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.executionContext ? { executionContext: input.executionContext } : {}),
    ...(input.sopRef ? { sopRef: input.sopRef } : {}),
  }
  writePlan(userDir, plan)
  return plan
}

// ── Update ────────────────────────────────────────────────────────────────
// Renderer-supplied patch. Edits are allowed on title/steps and some run
// control flags; internal state (status, sessionKey, currentStepIdx) is
// reserved for the server-side lifecycle transitions below.
export type PlanPatch = {
  title?: string
  steps?: Array<{
    id?:        string
    title?:     string
    detail?:    string
    acceptance?:string
    skillHint?: string | null
  }>
  skillsReferenced?: string[]
  priorRunRefs?:     string[]
}

export function updatePlan(userDir: string, id: string, patch: PlanPatch): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  if (plan.status !== 'draft' && plan.status !== 'paused') {
    throw new Error(`plan is ${plan.status} — can only edit in draft or paused`)
  }
  if (typeof patch.title === 'string' && patch.title.trim()) {
    plan.title = patch.title.trim()
  }
  if (Array.isArray(patch.skillsReferenced)) plan.skillsReferenced = patch.skillsReferenced
  if (Array.isArray(patch.priorRunRefs))     plan.priorRunRefs     = patch.priorRunRefs

  if (Array.isArray(patch.steps)) {
    // Merge by step id where provided. Unknown ids are appended as new pending
    // steps. Steps that have already run (done/failed/interrupted) are not
    // overwritten in content — only their trailing siblings can be rewritten.
    const byId = new Map(plan.steps.map(s => [s.id, s]))
    const nextSteps: PlanStep[] = []
    let idx = 1
    for (const ps of patch.steps) {
      const existing = ps.id ? byId.get(ps.id) : undefined
      if (existing) {
        if (existing.status === 'pending') {
          existing.title      = ps.title      ?? existing.title
          existing.detail     = ps.detail     ?? existing.detail
          existing.acceptance = ps.acceptance ?? existing.acceptance
          existing.skillHint  = ps.skillHint  ?? existing.skillHint
        }
        nextSteps.push(existing)
        idx++
      } else {
        nextSteps.push({
          id:         `s${Date.now().toString(36)}${idx++}`,
          title:      String(ps.title ?? '').trim() || `Step ${idx}`,
          detail:     String(ps.detail ?? '').trim(),
          acceptance: String(ps.acceptance ?? '').trim(),
          skillHint:  ps.skillHint ?? null,
          status:     'pending',
        })
      }
    }
    // Keep finalized steps that weren't in the patch (e.g. user only edited
    // remaining steps) at their original position.
    for (const s of plan.steps) {
      if (s.status !== 'pending' && !nextSteps.some(n => n.id === s.id)) {
        nextSteps.unshift(s)
      }
    }
    plan.steps = nextSteps
  }

  plan.updatedAt = nowIso()
  writePlan(userDir, plan)
  return plan
}

// ── Run lifecycle ──────────────────────────────────────────────────────────
export function beginRun(userDir: string, id: string, sessionKey: string): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  if (plan.status === 'running') return plan
  if (plan.status === 'done')    throw new Error('plan already completed')
  plan.status         = 'running'
  plan.sessionKey     = sessionKey
  plan.pauseRequested = false
  plan.updatedAt      = nowIso()
  writePlan(userDir, plan)

  // Initialize run.md if this is a fresh run (no existing file). Fall back
  // to append for any resume — even when currentStepIdx is still 0 (e.g.
  // step 1 failed and the user clicked "Try again" without ever advancing
  // past idx=0). Using existsSync as the gate prevents the previous
  // attempts' record from being wiped on retry.
  const runPath = runMdPath(userDir, id)
  if (!fs.existsSync(runPath)) {
    fs.writeFileSync(runPath, renderRunHeader(plan), 'utf8')
  } else {
    const stepNo = plan.currentStepIdx + 1
    fs.appendFileSync(runPath, `\n---\n\n_Resumed at ${plan.updatedAt} — retrying Step ${stepNo}_\n\n`, 'utf8')
  }
  return plan
}

export function startStep(userDir: string, id: string, stepId: string): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  const idx = plan.steps.findIndex(s => s.id === stepId)
  if (idx < 0) throw new Error(`step not found: ${stepId}`)
  // A step has been attempted before if endedAt was set by a prior endStep —
  // distinguish the retry section in run.md so readers can tell which attempt
  // corresponds to which outcome.
  const isRetry = plan.steps[idx].endedAt != null
  plan.currentStepIdx = idx
  plan.steps[idx].status    = 'running'
  plan.steps[idx].startedAt = nowIso()
  plan.steps[idx].endedAt   = undefined
  plan.updatedAt = nowIso()
  writePlan(userDir, plan)
  const heading = isRetry
    ? `## Step ${idx + 1} — ${plan.steps[idx].title} (재시도)`
    : `## Step ${idx + 1} — ${plan.steps[idx].title}`
  fs.appendFileSync(
    runMdPath(userDir, id),
    `\n${heading}\n\n_started ${plan.steps[idx].startedAt}_\n\n`,
    'utf8',
  )
  return plan
}

export function endStep(userDir: string, id: string, stepId: string, payload: StepEndPayload): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  const step = plan.steps.find(s => s.id === stepId)
  if (!step) throw new Error(`step not found: ${stepId}`)
  step.status    = payload.status === 'done' ? 'done'
                  : payload.status === 'failed' ? 'failed'
                  : payload.status === 'skipped' ? 'skipped'
                  : 'interrupted'
  step.endedAt   = nowIso()
  step.summary   = payload.summary
  if (payload.artifacts) step.artifacts = payload.artifacts
  plan.updatedAt = nowIso()
  writePlan(userDir, plan)

  // Append execution details to run.md
  const parts: string[] = []
  parts.push(`**Status:** ${statusBadge(step.status)} ${step.status}`)
  if (step.startedAt && step.endedAt) {
    const ms = Date.parse(step.endedAt) - Date.parse(step.startedAt)
    parts.push(`**Duration:** ${Math.round(ms / 1000)}s`)
  }
  if (step.status === 'failed' && payload.summary) {
    // Surface verifier rejection reason prominently — the same text shows in
    // the "Plan stopped" chat message, so a reader of run.md can see why the
    // step was rejected without cross-referencing the chat log.
    parts.push(`**⚠️ Plan stopped — Reason:** ${payload.summary}`)
  } else if (payload.summary) {
    parts.push(`**Summary:** ${payload.summary}`)
  }
  if (payload.toolCalls?.length) {
    parts.push('**Tool calls:**')
    for (const tc of payload.toolCalls) {
      parts.push(`- \`${tc.name}\`${tc.detail ? ` — ${tc.detail}` : ''}`)
    }
  }
  if (payload.finalText) {
    parts.push('**Assistant reply:**')
    parts.push('')
    parts.push(payload.finalText.trim())
  }
  if (payload.artifacts?.length) {
    parts.push('**Artifacts:**')
    for (const a of payload.artifacts) {
      parts.push(`- \`${a.path}\`${a.note ? ` — ${a.note}` : ''}`)
    }
  }
  fs.appendFileSync(runMdPath(userDir, id), parts.join('\n') + '\n\n', 'utf8')
  return plan
}

// Persist the post-step compaction summary + raw transcript slice. Called by
// the renderer after each successful step's compactor round-trip. The raw
// JSONL is what the orchestrator re-injects verbatim when a downstream step
// needs the un-summarised version of a tool output. run.md gains a "Compact
// summary" block so the human-readable log stays consistent with the disk
// state.
export function saveStepCompact(
  userDir: string,
  id: string,
  stepId: string,
  payload: StepCompactPayload,
): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  const step = plan.steps.find(s => s.id === stepId)
  if (!step) throw new Error(`step not found: ${stepId}`)

  step.compactSummary = String(payload.compactSummary ?? '').trim()
  step.rawToolCallIds = Array.isArray(payload.rawToolCallIds)
    ? payload.rawToolCallIds.filter(x => typeof x === 'string' && x.length > 0)
    : []
  step.subtasks       = Array.isArray(payload.subtasks) ? payload.subtasks : []
  step.compactedAt    = nowIso()

  if (Array.isArray(payload.rawMessages) && payload.rawMessages.length > 0) {
    fs.mkdirSync(stepRawDir(userDir, id, stepId), { recursive: true })
    const rawPath = stepRawJsonlPath(userDir, id, stepId)
    const lines = payload.rawMessages.map(m => {
      try { return JSON.stringify(m) } catch { return JSON.stringify({ skipped: 'unserializable' }) }
    })
    fs.writeFileSync(rawPath, lines.join('\n') + '\n', 'utf8')
    // Store relative to plansRoot so plan dirs can be moved without breaking.
    step.rawTranscriptPath = path.relative(plansRoot(userDir), rawPath)
  }

  plan.updatedAt = nowIso()
  writePlan(userDir, plan)

  // Append to run.md so the human-readable log records the compaction.
  const parts: string[] = []
  parts.push(`**Compact summary:**`)
  parts.push('')
  parts.push(step.compactSummary || '_(empty)_')
  if (step.rawToolCallIds && step.rawToolCallIds.length > 0) {
    parts.push('')
    parts.push(`**Raw retained (toolCallIds):** ${step.rawToolCallIds.map(tc => '`' + tc + '`').join(', ')}`)
  }
  if (step.rawTranscriptPath) {
    parts.push('')
    parts.push(`**Raw transcript:** \`${step.rawTranscriptPath}\``)
  }
  if (step.subtasks && step.subtasks.length > 0) {
    parts.push('')
    parts.push(`**Work breakdown — L6 Task: ${step.title}**`)
    parts.push('')
    for (const st of step.subtasks) {
      parts.push(`- **L7 Sub-task:** ${st.title} — _${st.status}_`)
      if (st.purpose) parts.push(`    - _Purpose:_ ${st.purpose}`)
      for (const ls of st.steps) {
        const meta = [
          ls.toolName   && `tool: \`${ls.toolName}\``,
          ls.toolCallId && `callId: \`${ls.toolCallId}\``,
          ls.outcome    && `_${ls.outcome}_`,
        ].filter(Boolean).join(' · ')
        parts.push(`    - **L8 Step:** ${ls.title}${meta ? ` _(${meta})_` : ''}`)
        const arg = summarizeInput(ls.input)
        if (arg) parts.push(`        - input: ${arg}`)
      }
    }
  }
  fs.appendFileSync(runMdPath(userDir, id), parts.join('\n') + '\n\n', 'utf8')

  return plan
}

// Read the raw gateway-message slice persisted for a step. Returns [] when
// the file is missing (older plans without compaction history, or steps
// where rawMessages was empty).
export function readStepRaw(
  userDir: string,
  id: string,
  stepId: string,
): unknown[] {
  try {
    const raw = fs.readFileSync(stepRawJsonlPath(userDir, id, stepId), 'utf8')
    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0)
    const out: unknown[] = []
    for (const line of lines) {
      try { out.push(JSON.parse(line)) } catch { /* skip malformed line */ }
    }
    return out
  } catch {
    return []
  }
}

export function requestPause(userDir: string, id: string): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  plan.pauseRequested = true
  plan.updatedAt      = nowIso()
  writePlan(userDir, plan)
  return plan
}

export function markPaused(userDir: string, id: string): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  plan.status         = 'paused'
  plan.pauseRequested = false
  plan.updatedAt      = nowIso()
  writePlan(userDir, plan)
  fs.appendFileSync(runMdPath(userDir, id), `\n_Paused at ${plan.updatedAt} (current step: ${plan.currentStepIdx + 1})_\n`, 'utf8')
  return plan
}

export function markAborted(userDir: string, id: string): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  plan.status    = 'aborted'
  plan.updatedAt = nowIso()
  writePlan(userDir, plan)
  fs.appendFileSync(runMdPath(userDir, id), `\n_Aborted at ${plan.updatedAt}_\n`, 'utf8')
  return plan
}

// ── Module Spec generation (Activity Log → reusable module) ─────────────────
// Deterministic, single-trace generalization. See ModuleSpec type for the
// contract. Operates on plan.steps[].subtasks (the measured Activity Log).

// Keys whose values are produced DURING the run (not supplied as parameters).
// NB: `fn` (browser evaluate JS) is intentionally NOT here — it's the reusable
// scraping/automation code (part of the procedure), kept fixed/verbatim so the
// module stays replayable.
const RUNTIME_KEYS = new Set(['targetId', 'content', 'payload', 'html', 'data', 'buffer'])

// Classify one top-level input field → how it should appear in the module.
function classifyLeaf(key: string, value: unknown):
  { cls: 'runtime' } | { cls: 'fixed' } | { cls: 'param'; valueType: ModuleParam['valueType'] } {
  if (RUNTIME_KEYS.has(key)) return { cls: 'runtime' }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || key === 'url' || key === 'targetUrl') return { cls: 'param', valueType: 'url' }
    if (key === 'path' || key === 'relPath' || key === 'file_path') return { cls: 'param', valueType: 'path' }
    if (key === 'query' || key === 'q' || key === 'prompt' || key === 'search') return { cls: 'param', valueType: 'query' }
    // `fn` = browser evaluate JS = reusable procedure code → keep fixed/verbatim
    // even when long (don't mask as runtime). Embedded user numbers are lifted
    // to {{count_N}} params separately (see liftIntentNumbers).
    if (key === 'fn') return { cls: 'fixed' }
    if (value.length > 200) return { cls: 'runtime' }
    return { cls: 'fixed' }
  }
  return { cls: 'fixed' }   // numbers, booleans, nested objects/arrays kept verbatim
}

// Extract integer literals (≥2) from user-intent text. These are the numbers
// the user actually specified (counts/limits), so they're the only numbers we
// lift to parameters — internal timeouts/indices the user never mentioned stay
// fixed.
function intentNumbers(...texts: (string | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(/\d+/g)) {
      const n = Number(m[0])
      if (Number.isFinite(n) && n >= 2) out.add(m[0])
    }
  }
  return out
}

// First "salient" (param-worthy) leaf of a tool input — used as the loop item
// and for list/scalar param values. Returns the key + string value.
function salientLeaf(input: unknown): { key: string; value: string; valueType: ModuleParam['valueType'] } | null {
  if (!input || typeof input !== 'object') return null
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    const c = classifyLeaf(k, v)
    if (c.cls === 'param') return { key: k, value: v, valueType: c.valueType }
  }
  return null
}

// Normalized structural signature of an L7 — used to detect repeated groups
// (count-variable loops). Browser open/navigate → 'nav', other browser actions
// → 'act'; consecutive duplicate tokens collapse so per-iteration count
// differences (one post snapshotted twice) don't break the match.
function l7Signature(l7: L7Subtask): string {
  const toks: string[] = []
  for (const l8 of l7.steps) {
    let tok: string
    if (l8.toolName === 'browser') {
      const action = (l8.input as { action?: unknown } | undefined)?.action
      tok = (action === 'open' || action === 'navigate') ? 'browser:nav' : 'browser:act'
    } else {
      tok = l8.toolName ?? 'unknown'
    }
    if (toks[toks.length - 1] !== tok) toks.push(tok)
  }
  return toks.join('|')
}

// Agent bootstrap noise: every run starts by reading SKILLS.md and the
// relevant <skill>/SKILL.md. These aren't part of the reusable task procedure
// (the agent does them automatically via first-actions), so they're excluded
// from the module — but kept in the full Activity Log (subtasks) for fidelity.
function isBootstrapRead(l8: L8Step): boolean {
  if (l8.toolName !== 'read' && l8.toolName !== 'read_file') return false
  const inp = l8.input as Record<string, unknown> | undefined
  const p = [inp?.path, inp?.file, inp?.file_path, inp?.relPath].find(x => typeof x === 'string') as string | undefined
  if (!p) return false
  return /SKILLS\.md$/i.test(p) || /SKILL\.md$/i.test(p) || /(^|\/)skills\//i.test(p)
}

export function generateModuleSpec(plan: Plan): ModuleSpec {
  // Parameters are scoped PER L6 Task (not plan-wide). A plan ≈ an L5 Activity
  // running several L6 Tasks; collecting params at the plan level mixed L6s'
  // variables together. Recording them per-L6 lets a downstream consumer
  // (Clovex) line up individual L6s and compute commonality cleanly. Param ids
  // are therefore reset/scoped within each task and {{id}} references resolve
  // against that task's `parameters`.
  const tasks: ModuleTask[] = plan.steps.map((step) => {
    const parameters: ModuleParam[] = []
    const scalarIndex = new Map<string, string>()   // `${valueType}:${value}` → id (per task)
    let counter = 0

    const ensureScalar = (valueType: ModuleParam['valueType'], value: string): string => {
      const key = `${valueType}:${value}`
      const hit = scalarIndex.get(key)
      if (hit) return hit
      const id = `${valueType}_${++counter}`
      scalarIndex.set(key, id)
      parameters.push({ id, kind: 'scalar', valueType, label: `${valueType}: ${value.slice(0, 48)}`, observed: value, confidence: 'low' })
      return id
    }
    const addList = (valueType: ModuleParam['valueType'], values: string[]): string => {
      const id = `${valueType}_list_${++counter}`
      parameters.push({ id, kind: 'list', valueType, label: `${valueType} list (×${values.length})`, observed: values, confidence: 'low' })
      return id
    }
    // Numbers the user actually specified (counts/limits) for THIS task. Used to
    // lift hardcoded numbers out of code/values into params so a downstream
    // consumer (Clovex) can see them as leaf tokens.
    const intentNums = intentNumbers(plan.sourcePrompt, plan.executionContext, step.title, step.detail, step.acceptance)
    const numIndex = new Map<string, string>()      // numeric value → id (per task)
    const ensureNumberParam = (value: string): string => {
      const hit = numIndex.get(value)
      if (hit) return hit
      const id = `count_${++counter}`
      numIndex.set(value, id)
      parameters.push({ id, kind: 'scalar', valueType: 'number', label: `number: ${value}`, observed: Number(value), confidence: 'low' })
      return id
    }
    // Replace standalone occurrences of user-intent numbers in a string (e.g.
    // the `fn` JS) with {{count_N}} tokens, registering each as a param.
    const liftIntentNumbers = (s: string): string => {
      let out = s
      for (const n of intentNums) {
        const re = new RegExp(`(?<![\\d.])${n}(?![\\d.])`, 'g')
        if (re.test(out)) {
          const id = ensureNumberParam(n)
          out = out.replace(new RegExp(`(?<![\\d.])${n}(?![\\d.])`, 'g'), `{{${id}}}`)
        }
      }
      return out
    }

    // Generalize one tool input → template (param→{{id}}, runtime→"<runtime>",
    // loop item→{{item}}, fixed→verbatim). Only top-level keys are templated.
    // Fixed string/number leaves also get user-intent numbers lifted to params.
    const generalizeInput = (input: unknown, loopItemKey?: string): unknown => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return input
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (loopItemKey && k === loopItemKey) { out[k] = '{{item}}'; continue }
        const c = classifyLeaf(k, v)
        if (c.cls === 'runtime')      out[k] = '<runtime>'
        else if (c.cls === 'param')   out[k] = `{{${ensureScalar(c.valueType, String(v))}}}`
        else if (typeof v === 'string')                       out[k] = liftIntentNumbers(v)
        else if (typeof v === 'number' && intentNums.has(String(v))) out[k] = `{{${ensureNumberParam(String(v))}}}`
        else                          out[k] = v
      }
      return out
    }

    // Drop bootstrap skill-doc reads from the reusable module (kept in the
    // full Activity Log). Empty L7s after filtering are dropped.
    const subs = (step.subtasks ?? [])
      .map(l7 => ({ ...l7, steps: l7.steps.filter(l8 => !isBootstrapRead(l8)) }))
      .filter(l7 => l7.steps.length > 0)
    const moduleL7s: ModuleL7[] = []
    let i = 0
    while (i < subs.length) {
      // Extend a run of consecutive same-signature L7s.
      const sig = l7Signature(subs[i])
      let j = i + 1
      while (j < subs.length && l7Signature(subs[j]) === sig) j++
      const run = subs.slice(i, j)

      if (run.length >= 2 && salientLeaf(run[0].steps[0]?.input)) {
        // Loop (count-variable): list param = salient value of each iteration.
        const first = run[0]
        const itemSalient = salientLeaf(first.steps[0]?.input)!
        const values = run
          .map(r => salientLeaf(r.steps[0]?.input)?.value)
          .filter((v): v is string => typeof v === 'string')
        const listId = addList(itemSalient.valueType, values)
        moduleL7s.push({
          title: `Repeat over ${listId}`,
          repeat: { over: listId, as: 'item' },
          steps: first.steps.map((l8, idx) => ({
            toolName: l8.toolName,
            title:    l8.title,
            inputTemplate: generalizeInput(l8.input, idx === 0 ? itemSalient.key : undefined),
          })),
        })
      } else {
        // Singleton L7 — generalize each L8 normally.
        for (const l7 of run) {
          moduleL7s.push({
            title: l7.title,
            steps: l7.steps.map(l8 => ({
              toolName: l8.toolName,
              title:    l8.title,
              inputTemplate: generalizeInput(l8.input),
            })),
          })
        }
      }
      i = j
    }

    return {
      title:      step.title,
      detail:     step.detail || undefined,
      acceptance: step.acceptance || undefined,
      skillHint:  step.skillHint,
      parameters,            // ← L6-scoped variables
      subtasks:   moduleL7s,
    }
  })

  return {
    version:    1,
    status:     'candidate',
    source:     { planId: plan.id, generatedAt: nowIso(), method: 'single-trace-heuristic' },
    tasks,
  }
}

// Skeleton hash of a module spec — tools/actions/structure only (values, counts
// ignored). Two runs of the same procedure share this fingerprint, so a
// downstream consumer (e.g. Clovex) can group runs for multi-trace refinement.
//
// Count-agnostic: an N≥2 run arrives here as a single repeat-L7 (loop folding
// in generateModuleSpec) while an N=1 run keeps a singleton L7 — so the repeat
// marker is dropped and consecutive identical L7 skeletons collapse into one
// token. That way runs of the same procedure hash the same regardless of how
// many times the inner loop ran (incl. N=1, where loop folding never fires).
export function procedureFingerprint(spec: ModuleSpec): string {
  const toks: string[] = []
  spec.tasks.forEach((t, ti) => {
    toks.push(`T${ti}`)
    // One skeleton token per L7: its ordered toolName:action sequence.
    const l7Toks = t.subtasks.map((l7) => {
      const steps = l7.steps.map((l8) => {
        const action = (l8.inputTemplate as { action?: unknown } | undefined)?.action
        return `${l8.toolName ?? '?'}:${typeof action === 'string' ? action : ''}`
      })
      return `L7(${steps.join(',')})`
    })
    // Fold consecutive duplicates — iteration count must not affect the hash.
    let prev: string | null = null
    for (const tok of l7Toks) {
      if (tok === prev) continue
      toks.push(tok)
      prev = tok
    }
  })
  return crypto.createHash('sha1').update(toks.join('|')).digest('hex').slice(0, 16)
}

export function finalizePlan(userDir: string, id: string, outcome: string): Plan {
  const plan = readPlan(userDir, id)
  if (!plan) throw new Error(`plan not found: ${id}`)
  const failed = plan.steps.some(s => s.status === 'failed')
  plan.status    = failed ? 'failed' : 'done'
  plan.updatedAt = nowIso()

  // Generalize this run's Activity Log into a candidate reusable module. Pure
  // data transform; never let it block finalization.
  if (!failed) {
    try {
      plan.moduleSpec = generateModuleSpec(plan)
      // Grouping key for downstream multi-trace refinement (done outside Twixy).
      plan.procedureFingerprint = procedureFingerprint(plan.moduleSpec)
      // Hand-off file for Clovex (same pattern as the userData-side
      // execution-plan-api.json discovery file).
      fs.writeFileSync(
        path.join(planDir(userDir, id), 'module.json'),
        JSON.stringify(plan.moduleSpec, null, 2),
        'utf8',
      )
    } catch (err) {
      console.warn('[plan] module spec generation failed:', err)
    }
  }

  writePlan(userDir, plan)
  fs.appendFileSync(
    runMdPath(userDir, id),
    `\n## Outcome\n\n${outcome.trim() || '_(no summary provided)_'}\n\n_Completed ${plan.updatedAt} — status: ${plan.status}_\n`,
    'utf8',
  )
  return plan
}

export function readRunMd(userDir: string, id: string): string {
  try { return fs.readFileSync(runMdPath(userDir, id), 'utf8') } catch { return '' }
}

// ── Markdown rendering ─────────────────────────────────────────────────────
export function renderPlanMd(plan: Plan): string {
  const lines: string[] = []
  lines.push(`# ${plan.title}`)
  lines.push('')
  lines.push(`_Plan \`${plan.id}\` · status: **${plan.status}** · updated ${plan.updatedAt}_`)
  lines.push('')
  if (plan.sourcePrompt) {
    lines.push('## Why')
    lines.push('')
    lines.push(`> ${plan.sourcePrompt.replace(/\n/g, '\n> ')}`)
    lines.push('')
  }
  if (plan.skillsReferenced.length) {
    lines.push(`**Skills referenced:** ${plan.skillsReferenced.map(s => '`' + s + '`').join(', ')}`)
    lines.push('')
  }
  if (plan.priorRunRefs.length) {
    lines.push(`**References prior runs:** ${plan.priorRunRefs.map(s => '`' + s + '`').join(', ')}`)
    lines.push('')
  }
  lines.push('## Steps')
  lines.push('')
  plan.steps.forEach((s, i) => {
    const box = s.status === 'done' ? '[x]' : s.status === 'skipped' ? '[~]' : '[ ]'
    lines.push(`- ${box} **${i + 1}. ${s.title}** ${statusBadge(s.status)}`)
    if (s.detail)     lines.push(`    - ${s.detail.replace(/\n/g, '\n      ')}`)
    if (s.acceptance) lines.push(`    - _Accepts:_ ${s.acceptance}`)
    if (s.skillHint)  lines.push(`    - _Skill:_ \`${s.skillHint}\``)
    if (s.summary)    lines.push(`    - _Result:_ ${s.summary}`)
    if (s.compactSummary) {
      const head = s.compactSummary.split('\n')[0]?.slice(0, 160) ?? ''
      lines.push(`    - _Compacted:_ ${head}${s.compactSummary.length > head.length ? '…' : ''}`)
    }
    if (s.subtasks?.length) {
      for (const st of s.subtasks) {
        lines.push(`    - L7: ${st.title} _(${st.status})_`)
        for (const ls of st.steps) {
          const tool = ls.toolName ? ` \`${ls.toolName}\`` : ''
          lines.push(`        - L8:${tool} ${ls.title}`)
        }
      }
    }
  })
  lines.push('')
  return lines.join('\n')
}

// ── Workflows ─────────────────────────────────────────────────────────────
// A Workflow is a named, ordered chain of L6 nodes the user composes ahead
// of time. v1 is a read-only viewer + CRUD over JSON files; execution is not
// hooked up yet. The on-disk shape mirrors plans/ so the same conventions
// apply (one directory per workflow, JSON authority + optional md sidecar).
//
//   users/<uid>/workflows/<wf_id>/workflow.json   authoritative state
//
// Node-level `requires` reuses the ModuleParam shape from generateModuleSpec
// so the renderer can express what each L6 needs without inventing a new
// schema — when execution is wired up later this maps 1:1 to ModuleTask.

// PDF 0613 정의: 노드 3종 (action/review/validation), Tool/Tool Skills 2계층.
// 데이터 모델은 src/global.d.ts 와 1:1 매칭.
export type WorkflowNodeType = 'action' | 'review' | 'validation'
export type WorkflowTool =
  | 'chrome' | 'web-fetch' | 'read' | 'write' | 'edit'
  | 'api'    | 'app'       | 'mcp'
export type WorkflowScopeField = {
  name:        string
  type:        string
  description?: string
}
export type WorkflowNode = {
  id:          string
  type:        WorkflowNodeType
  title:       string
  detail?:     string
  acceptance?: string
  skillHint?:  string | null
  tool?:       WorkflowTool
  toolSkills?: string[]
  subtasks?:   L7Subtask[]
  inputScope?:  WorkflowScopeField[]
  outputScope?: WorkflowScopeField[]
  requires?:   ModuleParam[]
}

export type WorkflowType = 'research' | 'execution'
export type Workflow = {
  version:      1
  id:           string
  title:        string
  description?: string
  // research = 데이터 생성(write 로 끝/검증-직전-write) / execution = 행동(출력 없음). AI Agent 타입의 근거.
  type?:        WorkflowType
  // 산출물 저장 위치(워크플로 파일 수준). write 노드가 있는 research 워크플로의 파일 저장 폴더.
  // per-run input 이 아니라 워크플로 자체 설정 — 노드 outputScope 에 path 를 두지 않는다.
  outputDir?:   string
  // 로컬 분류 태그(소문자, 최대 8개). WF 리스트 표시/필터용. 팀 공유 태그와 별개.
  tags?:        string[]
  // prompt is the LLM instruction body executed when the user hits "Run"
  // in the WorkflowTab. Variable placeholders use {{input_id}} which the
  // user fills in via chat at run time (LLM asks based on `inputs` below).
  prompt?:      string
  // Workflow-level required inputs. The LLM is told to ask for each of
  // these in the chat before substituting them into `prompt`.
  inputs?:      ModuleParam[]
  // 팀 공유본에서 fork 한 사본의 원본 참조 — stale 감지("원본 업데이트됨" 배지)용.
  // copiedUpdatedAt = 복사 시점의 공유본 updated_at 스냅샷.
  sourceShared?: { sharedId: string; sourceWfId: string; copiedUpdatedAt: string }
  // 팀 실시간 공동편집 문서 id (live_workflows.id). 있으면 "함께 편집" 상태. (US-R1-04)
  liveId?:      string | null
  author:       PlanAuthor
  createdAt:    string
  updatedAt:    string
  nodes:        WorkflowNode[]
}

export type CreateWorkflowInput = {
  title:        string
  description?: string
  prompt?:      string
  inputs?:      ModuleParam[]
  type?:        WorkflowType
  outputDir?:   string
  sourceShared?: { sharedId: string; sourceWfId: string; copiedUpdatedAt: string }
  author:       PlanAuthor
  nodes?:       Array<Partial<WorkflowNode> & { title?: string }>
}

export type WorkflowPatch = {
  title?:       string
  description?: string
  prompt?:      string
  inputs?:      ModuleParam[]
  type?:        WorkflowType
  outputDir?:   string
  tags?:        string[]
  liveId?:      string | null   // 팀 실시간 공동편집 연결/해제 (US-R1-04)
  nodes?:       Array<Partial<WorkflowNode> & { id?: string; title?: string }>
}

// 로컬 태그 정규화 — 소문자·트림·중복 제거·최대 5개(팀 공유 태그 규칙과 동일).
// 로컬 태그는 Team Dashboard(org)에서 write-back 되는 미러라 상한을 팀 측과 맞춘다.
function normalizeWorkflowTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const t = String(raw ?? '').trim().toLowerCase().slice(0, 24)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= 5) break
  }
  return out
}

// 노드로부터 워크플로 타입 자동 도출 — write 로 끝나거나, validation 으로 끝나는데 그 직전이
// write 면 research(데이터 생성), 아니면 execution(행동). review 노드는 무시.
export function deriveWorkflowType(nodes: WorkflowNode[]): WorkflowType {
  const seq = (nodes ?? []).filter(n => n.type !== 'review')
  const last = seq[seq.length - 1]
  if (!last) return 'execution'
  if (last.tool === 'write') return 'research'
  if (last.type === 'validation' && seq[seq.length - 2]?.tool === 'write') return 'research'
  return 'execution'
}

function workflowsRoot(userDir: string): string {
  return path.join(userDir, 'workflows')
}
function workflowDir(userDir: string, id: string): string {
  return path.join(workflowsRoot(userDir), safeSegment(id))
}
function workflowJsonPath(userDir: string, id: string): string {
  return path.join(workflowDir(userDir, id), 'workflow.json')
}

export function readWorkflow(userDir: string, id: string): Workflow | null {
  try {
    const raw = fs.readFileSync(workflowJsonPath(userDir, id), 'utf8')
    const wf  = JSON.parse(raw) as Workflow
    if (wf?.version !== 1 || typeof wf?.id !== 'string') return null
    wf.type = deriveWorkflowType(wf.nodes)  // 타입은 노드에서 자동 도출(수동 토글 없음)
    return wf
  } catch {
    return null
  }
}

function writeWorkflow(userDir: string, wf: Workflow): void {
  fs.mkdirSync(workflowDir(userDir, wf.id), { recursive: true })
  fs.writeFileSync(workflowJsonPath(userDir, wf.id), JSON.stringify(wf, null, 2), 'utf8')
}

export function listWorkflows(userDir: string): Workflow[] {
  // Demo seed. We use a versioned marker file (`.seeded-v<n>`) so each demo
  // bump appears once for existing users too, while a deliberately-deleted
  // sample is NOT re-seeded on the same version.
  const root = workflowsRoot(userDir)
  const SEED_VERSION = 11  // v11: 히어로 데모 WF 2종 추가 (content calendar / GBP local audit)
  const seedMarker = path.join(root, `.seeded-v${SEED_VERSION}`)
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
    if (!fs.existsSync(seedMarker)) {
      // Clean up obsolete demo samples from earlier versions so users don't
      // see stale entries next to the current one. Only system-authored
      // samples are removed — anything the user created is untouched.
      const OBSOLETE_SAMPLE_IDS = ['wf_sample_marketing', 'wf_sample_seo_audit']
      for (const oldId of OBSOLETE_SAMPLE_IDS) {
        const existing = readWorkflow(userDir, oldId)
        if (existing && existing.author?.uid === 'system') {
          try { deleteWorkflow(userDir, oldId) } catch { /* ignore */ }
        }
      }
      seedSampleWorkflow(userDir)
      seedSampleWorkflowsForTeam(userDir)
      try { fs.writeFileSync(seedMarker, '', 'utf8') } catch { /* ignore */ }
    }
  } catch { /* ignore seed failure — listing still works */ }
  let entries: string[] = []
  try { entries = fs.readdirSync(root) } catch { return [] }
  const out: Workflow[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue  // skip marker files
    const wf = readWorkflow(userDir, id)
    if (wf) out.push(wf)
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

function seedSampleWorkflow(userDir: string): void {
  const now = nowIso()
  const sample: Workflow = {
    version: 1,
    id:      'wf_sample_seo_audit',
    title:   'Technical SEO Audit',
    description: 'Crawl a site, score it across SEO categories, and deliver an interactive HTML report. Click Run to start — the chat will ask for the website URL and a one-line description.',
    author:    { uid: 'system', email: 'sample' },
    createdAt: now,
    updatedAt: now,
    inputs: [
      {
        id:         'website_url',
        kind:       'scalar',
        valueType:  'url',
        label:      'Website URL',
        observed:   '',
        confidence: 'low',
      },
      {
        id:         'site_description',
        kind:       'scalar',
        valueType:  'text',
        label:      'One-line site description',
        observed:   '',
        confidence: 'low',
      },
    ],
    prompt: `You are a technical SEO auditor. Your goal is to perform a comprehensive SEO health check on a website and deliver an interactive HTML report with scores, pass/fail checks, and specific fix recommendations.

Here is the website to audit:

- Website URL: {{website_url}}
- Site description: {{site_description}}

Follow these steps in order. Complete each step fully before moving to the next.

---

STEP 1 — CRAWL THE SITE

Visit the homepage and discover up to 20 internal pages by following links. For each page, collect:

- URL and HTTP status code
- Page title and length (characters)
- Meta description and length
- H1 tag (count and text)
- H2-H6 heading hierarchy
- Word count
- Image count and how many have alt text
- Internal link count
- External link count
- Whether the page has canonical tag, OG tags, and schema markup

Also check these site-wide signals:

- Is the site using HTTPS?
- Does robots.txt exist? How many disallow rules?
- Does an XML sitemap exist? How many URLs?
- What is the server response time (TTFB estimate)?
- Are there redirect chains on any pages?

---

STEP 2 — SCORE EACH CATEGORY

Group your findings into these categories and score each one as Pass, Warning, or Fail:

TECHNICAL HEALTH:
- HTTPS encryption (pass if yes)
- HTTP status codes (pass if all 200)
- Redirect chains (warning if >2 hops, fail if >4)
- Canonical tags (pass if present and matching URL)
- robots.txt (pass if exists)
- XML sitemap (pass if exists with >0 URLs)
- Response time (pass if <1s, warning if 1-3s, fail if >3s)

ON-PAGE SEO (per page):
- Title length (pass if 30-60 chars)
- Meta description (pass if 120-160 chars)
- H1 count (pass if exactly 1)
- H2 count (pass if >=2)
- Image alt text (pass if all images have alt)
- Word count (pass if >=300)
- Internal links (pass if >=3)
- OG title present
- OG image present

CONTENT QUALITY:
- Heading hierarchy (warning if skipping levels, e.g., H1 to H3)
- Duplicate titles across pages
- Duplicate meta descriptions across pages
- Thin content pages (word count <200)
- Missing meta descriptions

STRUCTURED DATA:
- Schema markup present (pass if any JSON-LD found)
- Types of schema found
- Schema validation (warning if fields missing)

---

STEP 3 — GENERATE FIX RECOMMENDATIONS

For every Warning and Fail finding, write a specific, actionable fix recommendation. Not generic advice — reference the exact page, the exact issue, and exactly what to change.

Bad example: "Add meta descriptions to pages that are missing them."
Good example: "Page /pricing is missing a meta description. Add: 'Compare pricing plans. Start with a 3-day free trial and get started for $9/month.' (98 chars)"

Prioritize fixes as:
- Critical (will directly hurt rankings if not fixed)
- Important (best practice, should fix soon)
- Minor (nice to have)

---

STEP 4 — CALCULATE OVERALL SCORE

Compute an overall SEO health score from 0-100:
- Technical Health: 30% weight
- On-Page SEO: 30% weight
- Content Quality: 20% weight
- Structured Data: 10% weight
- Site-wide signals (sitemap, robots, HTTPS): 10% weight

---

STEP 5 — BUILD THE HTML REPORT

Output a single, self-contained HTML file with embedded CSS. The report should include:

1. HEADER: Website name, URL, audit date, overall score displayed as a large circular progress ring (green if >80, yellow if 60-80, red if <60)
2. CATEGORY CARDS: One card per category showing the category score, number of passes/warnings/fails, with a colored indicator
3. SITE CRAWL TABLE: All pages discovered with columns for URL, status, title, H1, word count, images, and issues found. Sortable by clicking column headers.
4. DETAILED FINDINGS: Expandable sections for each category. Each finding shows pass/warning/fail icon, the check name, current value, and the fix recommendation if applicable.
5. HEADING TREE: Visual hierarchy of headings for each page, with issues highlighted (skipped levels, missing H1, multiple H1s, etc.)
6. FIX PRIORITY LIST: All recommendations sorted by priority (Critical first, then Important, then Minor). Each item shows the page, the issue, and the exact fix.

Style the report with:
- Clean white background, subtle gray borders
- Sans-serif font (system font stack)
- Green (#059669) for pass, yellow (#d97706) for warning, red (#dc2626) for fail
- Responsive layout that works on mobile
- Collapsible sections to keep it manageable
- No external dependencies — everything inline`,
    nodes: [
      {
        id:         'n1',
        type:       'action',
        title:      'Crawl the site',
        detail:     'Visit the homepage and discover up to 20 internal pages. Collect URL, status, title, meta, headings, word/image/link counts per page. Check site-wide signals: HTTPS, robots.txt, sitemap, TTFB, redirect chains.',
        acceptance: 'Per-page metrics + site-wide signals captured for ≤20 pages.',
        skillHint:  'web_crawler',
        tool:       'chrome',
        toolSkills: ['seo-crawl'],
        subtasks: [
          { id: 's1', title: 'Discover internal pages',  purpose: 'Follow up to 20 links from the homepage', status: 'done', steps: [] },
          { id: 's2', title: 'Collect per-page metrics', purpose: 'title, meta, headings, counts, OG, schema', status: 'done', steps: [] },
          { id: 's3', title: 'Probe site-wide signals',  purpose: 'HTTPS, robots.txt, sitemap, TTFB, redirects', status: 'done', steps: [] },
        ],
        inputScope: [
          { name: 'website_url',      type: 'url',  description: 'Root URL to start crawling from' },
          { name: 'site_description', type: 'text', description: 'One-line site context for downstream nodes' },
        ],
        outputScope: [
          { name: 'pages',       type: 'json[]', description: 'Per-page metrics array' },
          { name: 'site_signals', type: 'json',   description: 'Site-wide signal bundle (HTTPS/robots/sitemap/TTFB)' },
        ],
      },
      {
        id:         'n2',
        type:       'action',
        title:      'Score each category',
        detail:     'Bucket findings into Technical Health, On-Page SEO, Content Quality, Structured Data — Pass / Warning / Fail per check.',
        acceptance: 'Every check has a verdict and a measured value.',
        skillHint:  'seo_scorer',
        tool:       'read',
        subtasks: [
          { id: 's1', title: 'Technical health checks',  status: 'done', steps: [] },
          { id: 's2', title: 'On-page SEO per-page checks', status: 'done', steps: [] },
          { id: 's3', title: 'Content quality + structured data checks', status: 'done', steps: [] },
        ],
        inputScope: [
          { name: 'pages',        type: 'json[]', description: 'From Crawl node' },
          { name: 'site_signals', type: 'json',   description: 'From Crawl node' },
        ],
        outputScope: [
          { name: 'scored_findings', type: 'json[]', description: 'Each check with verdict + measured value' },
        ],
      },
      {
        id:         'n3',
        type:       'action',
        title:      'Generate fix recommendations',
        detail:     'For every Warning/Fail, write a page-specific, actionable fix with exact change text. Tag each Critical / Important / Minor.',
        acceptance: 'No generic advice — every fix references a real page + concrete edit.',
        skillHint:  'fix_writer',
        tool:       'write',
        toolSkills: ['md'],
        inputScope: [
          { name: 'scored_findings', type: 'json[]' },
        ],
        outputScope: [
          { name: 'fixes', type: 'json[]', description: 'Per-finding {page, issue, fix, priority}' },
        ],
      },
      {
        id:         'n4',
        type:       'action',
        title:      'Calculate overall score',
        detail:     'Weighted 0-100 score: Technical 30%, On-Page 30%, Content 20%, Structured 10%, Site-wide 10%. Aggregate per-category scores from the findings.',
        acceptance: 'Single overall number + per-category breakdown.',
        skillHint:  'scorer',
        tool:       'read',  // 데이터를 읽어 계산만 — 외부 도구 호출 없음
        inputScope: [
          { name: 'scored_findings', type: 'json[]' },
        ],
        outputScope: [
          { name: 'overall_score',     type: 'number', description: '0-100 weighted score' },
          { name: 'category_breakdown', type: 'json',   description: 'Per-category 0-100' },
        ],
      },
      {
        id:         'n5',
        type:       'validation',
        title:      'Validate scoring math',
        detail:     'AI sanity-checks the score calculation: overall_score is 0-100, category_breakdown has all 5 expected categories, per-category weights sum to 1.0, weighted total equals overall_score (±0.5), and no NaN/null values.',
        acceptance: 'is_valid=true and issues is empty. If any check fails, return the offending fields so the user sees them before approving.',
        inputScope: [
          { name: 'overall_score',     type: 'number' },
          { name: 'category_breakdown', type: 'json' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues',   type: 'string[]', description: 'Empty when valid; otherwise human-readable problem list' },
        ],
      },
      {
        id:         'n6',
        type:       'action',
        title:      'Build the HTML report',
        detail:     'Self-contained HTML + inline CSS: header ring, category cards, crawl table, findings, heading tree, prioritized fix list. Mobile responsive, no external deps.',
        acceptance: 'Single .html file saved (in the workflow output folder) with all sections rendered.',
        skillHint:  'report-pack',
        tool:       'write',
        toolSkills: ['md'],
        inputScope: [
          { name: 'fixes',             type: 'json[]' },
          { name: 'overall_score',     type: 'number' },
          { name: 'category_breakdown', type: 'json' },
        ],
        outputScope: [
          { name: 'sections_written', type: 'text[]', description: 'Report sections rendered (e.g. [Header, Categories, Crawl table, Findings, Fixes])' },
          { name: 'overall_score',    type: 'number', description: '0-100 score shown in the report header' },
        ],
      },
    ],
  }
  writeWorkflow(userDir, sample)
}

// Team 예시용 샘플 워크플로 4종(research 3 / execution 1) 보장 — 이미 있으면 건너뜀.
// 구(舊) Influencer Outreach 샘플 — SEO 시나리오로 교체되며 정리(삭제) 대상.
const OBSOLETE_SAMPLE_WF_IDS = ['wf_idol_research', 'wf_local_scout', 'wf_saved_posts_csv', 'wf_instagram_dm']
const OBSOLETE_SAMPLE_AGENT_IDS = ['agent_idol_research', 'agent_market_research', 'agent_dm_outreach']
// 옵션 1개짜리 AI Agent 는 고를 게 없어 의미가 없다(= 그냥 워크플로). 샘플에서 제거하고
// 오케스트레이션에선 워크플로로 직접 배치한다. (재시드 시 기존 파일도 삭제.)
const OBSOLETE_SINGLE_OPTION_AGENT_IDS = ['agent_seo_content', 'agent_seo_offsite', 'agent_seo_keyword', 'agent_seo_planner']
// SEO 샘플 워크플로 — 재시드 시 항상 최신(완전 명세) 노드로 덮어쓰도록 먼저 삭제.
const SEO_SAMPLE_WF_IDS = [
  'wf_seo_technical_audit', 'wf_seo_content_audit', 'wf_seo_backlink_audit', 'wf_seo_keyword_cluster',
  'wf_seo_local_audit', 'wf_seo_ecommerce_audit', 'wf_seo_action_plan', 'wf_seo_onpage_fixes', 'wf_seo_sitemap_submit',
]
// 히어로 데모 워크플로(피치 데모 Build→Run→Reuse→Share→Monitor→Review 용) — 재시드 시 최신으로 갱신.
const HERO_DEMO_WF_IDS = ['wf_content_calendar', 'wf_gbp_local_audit']

function seedSampleWorkflowsForTeam(userDir: string): void {
  // 이전 Influencer 샘플 + 이전 버전 SEO 샘플 + 이전 버전 히어로 데모 제거(샘플 전용, 안전하게 정리/갱신).
  for (const id of [...OBSOLETE_SAMPLE_WF_IDS, ...SEO_SAMPLE_WF_IDS, ...HERO_DEMO_WF_IDS]) { try { deleteWorkflow(userDir, id) } catch { /* already gone */ } }

  const now = nowIso()
  const author: PlanAuthor = { uid: 'system', email: 'sample' }
  const p = (id: string, valueType: ModuleParam['valueType'], label: string): ModuleParam =>
    ({ id, kind: 'scalar', valueType, label, observed: '', confidence: 'low' })
  // L7 subtask — 디자인타임 템플릿이라 status/steps 는 비움(캔버스는 title/purpose 만 렌더).
  const st = (id: string, title: string, purpose: string): L7Subtask => ({ id, title, purpose, status: 'done', steps: [] })
  const mk = (id: string, title: string, description: string, inputs: ModuleParam[], nodes: WorkflowNode[], tags?: string[]) => {
    if (readWorkflow(userDir, id)) return
    // write 노드가 있는(파일 생성) 워크플로면 저장 폴더를 워크플로 수준에서 지정(샘플 기본값).
    const outputDir = nodes.some(n => n.tool === 'write') ? 'data/reports' : undefined
    writeWorkflow(userDir, { version: 1, id, title, description, author, createdAt: now, updatedAt: now, inputs, nodes, outputDir, ...(tags?.length ? { tags: normalizeWorkflowTags(tags) } : {}) })
  }

  // ── Research workflows (write 로 끝 → research) ────────────────────────────
  mk('wf_seo_technical_audit', 'Technical SEO Crawl', 'Crawl a site and audit technical SEO across the core categories, then export the issues to a workbook.',
    [p('site_url', 'url', 'Site URL'), p('max_pages', 'number', 'Max pages to crawl')],
    [
      {
        id: 'n1', type: 'action', title: 'Crawl pages & collect per-page metrics', tool: 'chrome', toolSkills: ['seo-crawl'],
        detail: 'Start at site_url, follow internal links up to max_pages. Per page capture URL, HTTP status, title/meta lengths, heading hierarchy, word/image/link counts, and canonical/OG/schema presence.',
        acceptance: 'Per-page metrics captured for ≤ max_pages pages, each row has a URL + status code.',
        subtasks: [
          st('s1', 'Discover internal pages', 'Follow links from the homepage up to the max_pages cap'),
          st('s2', 'Collect per-page metrics', 'title, meta, headings, counts, canonical/OG/schema flags'),
        ],
        inputScope: [
          { name: 'site_url', type: 'url', description: 'Root URL to start crawling from' },
          { name: 'max_pages', type: 'number', description: 'Upper bound on pages to crawl' },
        ],
        outputScope: [{ name: 'pages', type: 'json[]', description: 'Per-page metrics array' }],
      },
      {
        id: 'n2', type: 'action', title: 'Probe site-wide technical signals', tool: 'chrome', toolSkills: ['seo-crawl'],
        detail: 'Check site-level signals independent of any single page: HTTPS, robots.txt rules, XML sitemap presence + URL count, TTFB estimate, redirect chains, and mobile viewport.',
        acceptance: 'site_signals contains https, robots, sitemap, ttfb, and redirects keys.',
        subtasks: [
          st('s1', 'Check indexability controls', 'HTTPS, robots.txt disallow rules, XML sitemap + URL count'),
          st('s2', 'Measure performance signals', 'TTFB estimate, redirect chains, mobile viewport'),
        ],
        inputScope: [{ name: 'site_url', type: 'url', description: 'Root URL whose site-wide signals to probe' }],
        outputScope: [{ name: 'site_signals', type: 'json', description: 'Site-wide signal bundle (HTTPS/robots/sitemap/TTFB/redirects)' }],
      },
      {
        id: 'n3', type: 'action', title: 'Classify issues by technical category', tool: 'read',
        detail: 'Bucket the crawl output into the core technical categories (indexability, status codes, redirects, canonicals, sitemap/robots, performance, mobile, schema, meta). Give each check a Pass/Warning/Fail verdict with the measured value and a severity.',
        acceptance: 'Every check has a category, verdict, measured value, and severity.',
        subtasks: [
          st('s1', 'Map findings to categories', 'Assign each page/signal finding to a technical category'),
          st('s2', 'Assign verdict + severity', 'Pass/Warning/Fail with the measured value and Critical/Important/Minor'),
        ],
        inputScope: [
          { name: 'pages', type: 'json[]', description: 'Per-page metrics from the crawl' },
          { name: 'site_signals', type: 'json', description: 'Site-wide signals from the probe' },
        ],
        outputScope: [{ name: 'technical_issues', type: 'json[]', description: 'Per-check {category, check, verdict, measured, severity, page?}' }],
      },
      {
        id: 'n4', type: 'validation', title: 'Validate audit coverage',
        detail: 'Sanity-check the classified issues before export: pages array is non-empty, every issue has category + verdict + severity, and there are no null measured values.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [
          { name: 'pages', type: 'json[]' },
          { name: 'technical_issues', type: 'json[]' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid; otherwise the problems found' },
        ],
      },
      {
        id: 'n5', type: 'action', title: 'Export the technical audit to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write the classified issues to data/reports/technical-seo-audit.xlsx: one row per check with columns Page, Category, Check, Verdict, Measured, Severity. Header row first, then every issue row. Also emit a crawl_summary (pages crawled, fail/warn counts).',
        acceptance: 'XLSX saved under data/reports/ with a header row + one row per issue, and crawl_summary populated.',
        subtasks: [
          st('s1', 'Build header + issue rows', 'Map each technical issue to the six columns in order'),
          st('s2', 'Write the workbook', 'Save the sheet to the workspace and capture the path + counts'),
        ],
        inputScope: [{ name: 'technical_issues', type: 'json[]', description: 'Classified issues, one row each' }],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: "Sheet the rows were written to (e.g. 'Issues')" },
          { name: 'row_count', type: 'number', description: 'Data rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns as written: [Page, Category, Check, Verdict, Measured, Severity]' },
          { name: 'technical_issues', type: 'json[]', description: 'The exact issue rows written (mirrors n3)' },
          { name: 'crawl_summary', type: 'json', description: 'Totals: pages crawled, fail/warn counts' },
        ],
      },
    ])
  mk('wf_seo_content_audit', 'Content & E-E-A-T Audit', 'Score landing/blog pages for content quality and E-E-A-T, then export the findings.',
    [p('site_url', 'url', 'Site URL')],
    [
      {
        id: 'n1', type: 'action', title: 'Collect landing & blog page content', tool: 'chrome', toolSkills: ['seo-crawl'],
        detail: 'Discover the key landing and blog pages from site_url. Per page capture title, H1, meta description, body word count, author byline, and published/updated date.',
        acceptance: 'content_pages has ≥1 page, each with title, word_count, and a URL.',
        subtasks: [
          st('s1', 'Discover content pages', 'Identify landing + blog/article URLs to evaluate'),
          st('s2', 'Capture content fields', 'title, H1, meta, word count, author, dates per page'),
        ],
        inputScope: [{ name: 'site_url', type: 'url', description: 'Root URL whose content pages to collect' }],
        outputScope: [{ name: 'content_pages', type: 'json[]', description: 'Per-page content fields' }],
      },
      {
        id: 'n2', type: 'action', title: 'Score E-E-A-T & flag thin content', tool: 'read',
        detail: 'Evaluate each page for Experience/Expertise/Authoritativeness/Trust signals (author bio, citations, freshness, contact/about) and flag thin content (<300 words) and title/H1/meta gaps.',
        acceptance: 'Every page has an eeat_score and a thin flag.',
        subtasks: [
          st('s1', 'Score E-E-A-T signals', 'Rate author/citation/freshness/trust signals per page'),
          st('s2', 'Flag gaps', 'Mark thin content and title/H1/meta gaps'),
        ],
        inputScope: [{ name: 'content_pages', type: 'json[]', description: 'Per-page content fields from n1' }],
        outputScope: [{ name: 'content_findings', type: 'json[]', description: 'Per-page {url, eeat_score, thin, title_gap, meta_gap}' }],
      },
      {
        id: 'n3', type: 'validation', title: 'Validate content findings',
        detail: 'Check the findings are usable: one entry per crawled page, eeat_score within range, boolean flags present, no null URLs.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [{ name: 'content_findings', type: 'json[]' }],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid' },
        ],
      },
      {
        id: 'n4', type: 'action', title: 'Export the content audit to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write the per-page findings to data/reports/content-eeat-audit.xlsx with columns Page, EEAT Score, Thin, Title Gap, Meta Gap. Header row first, then one row per page.',
        acceptance: 'XLSX saved under data/reports/ with a header + one row per page.',
        subtasks: [
          st('s1', 'Build header + rows', 'Map each finding to the five columns in order'),
          st('s2', 'Write the workbook', 'Save to the workspace and capture path + counts'),
        ],
        inputScope: [{ name: 'content_findings', type: 'json[]', description: 'Per-page findings to write' }],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: 'Sheet the rows were written to' },
          { name: 'row_count', type: 'number', description: 'Data rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns: [Page, EEAT Score, Thin, Title Gap, Meta Gap]' },
          { name: 'content_findings', type: 'json[]', description: 'The exact rows written (mirrors n2)' },
        ],
      },
    ])
  mk('wf_seo_backlink_audit', 'Backlink Profile Analysis', 'Pull referring domains, flag toxic links, and export the profile.',
    [p('domain', 'text', 'Domain')],
    [
      {
        id: 'n1', type: 'action', title: 'Pull referring domains & anchors', tool: 'web-fetch',
        detail: 'Fetch the backlink dataset for the domain: referring domains, linking URLs, anchor text, and domain rating per referrer.',
        acceptance: 'referring_domains is non-empty, each row has a referrer + anchor.',
        subtasks: [
          st('s1', 'Fetch referring domains', 'Retrieve the list of domains linking to the target'),
          st('s2', 'Capture anchors + DR', 'Anchor text and domain rating per referring domain'),
        ],
        inputScope: [{ name: 'domain', type: 'text', description: 'Target domain to analyze' }],
        outputScope: [{ name: 'referring_domains', type: 'json[]', description: 'Per-referrer {domain, url, anchor, dr}' }],
      },
      {
        id: 'n2', type: 'action', title: 'Score toxicity & summarize the profile', tool: 'read',
        detail: 'Classify each referring domain by spam signals (PBN patterns, irrelevant TLDs, over-optimized anchors) and roll the results into a profile summary: total backlinks, toxic list, top anchors, DR distribution.',
        acceptance: 'backlink_profile has total, toxic[], top_anchors, and dr_distribution.',
        subtasks: [
          st('s1', 'Flag toxic links', 'Score each referrer for spam/PBN/anchor over-optimization'),
          st('s2', 'Summarize the profile', 'Aggregate totals, top anchors, DR distribution'),
        ],
        inputScope: [{ name: 'referring_domains', type: 'json[]', description: 'Referrers from n1' }],
        outputScope: [{ name: 'backlink_profile', type: 'json', description: '{total, toxic[], top_anchors, dr_distribution}' }],
      },
      {
        id: 'n3', type: 'validation', title: 'Validate backlink data',
        detail: 'Confirm the profile is coherent: toxic list is a subset of referring domains, counts are non-negative, dr_distribution sums to the total.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [
          { name: 'referring_domains', type: 'json[]' },
          { name: 'backlink_profile', type: 'json' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid' },
        ],
      },
      {
        id: 'n4', type: 'action', title: 'Export the backlink profile to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write the referring domains to data/reports/backlink-profile.xlsx with columns Referring Domain, Linking URL, Anchor, DR, Toxic. Header first, then one row per referrer; also surface the profile summary.',
        acceptance: 'XLSX saved with a header + one row per referring domain.',
        subtasks: [
          st('s1', 'Build header + rows', 'Map each referrer to the five columns in order'),
          st('s2', 'Write the workbook', 'Save to the workspace and capture path + counts'),
        ],
        inputScope: [
          { name: 'referring_domains', type: 'json[]', description: 'Referrers to write as rows' },
          { name: 'backlink_profile', type: 'json', description: 'Summary to surface alongside the rows' },
        ],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: 'Sheet the rows were written to' },
          { name: 'row_count', type: 'number', description: 'Referring-domain rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns: [Referring Domain, Linking URL, Anchor, DR, Toxic]' },
          { name: 'backlink_profile', type: 'json', description: 'The profile summary (mirrors n2)' },
        ],
      },
    ])
  mk('wf_seo_keyword_cluster', 'SERP Keyword Clustering', 'Build semantic keyword clusters from live SERPs and export them.',
    [p('seed_keyword', 'query', 'Seed keyword'), p('market', 'text', 'Target market / locale')],
    [
      {
        id: 'n1', type: 'action', title: 'Scrape SERPs for the seed set', tool: 'chrome', toolSkills: ['data-scout'],
        detail: 'Expand seed_keyword into related queries and, for each, capture the top-10 ranking URLs in the given market. This SERP-overlap data is the basis for clustering.',
        acceptance: 'serp_results has the seed + related queries, each with ranking URLs.',
        subtasks: [
          st('s1', 'Expand the seed', 'Generate related queries from the seed keyword'),
          st('s2', 'Capture rankings', 'Top-10 ranking URLs per query for the target market'),
        ],
        inputScope: [
          { name: 'seed_keyword', type: 'query', description: 'Seed keyword to expand' },
          { name: 'market', type: 'text', description: 'Locale/market for the SERP' },
        ],
        outputScope: [{ name: 'serp_results', type: 'json[]', description: 'Per-query {query, ranking_urls[]}' }],
      },
      {
        id: 'n2', type: 'action', title: 'Cluster keywords by SERP overlap', tool: 'read',
        detail: 'Group queries that share ≥3 common ranking URLs into clusters; label each cluster with its dominant search intent (informational/commercial/transactional/navigational).',
        acceptance: 'Every cluster has ≥1 keyword and an intent label.',
        subtasks: [
          st('s1', 'Group by overlap', 'Cluster queries sharing ranking URLs'),
          st('s2', 'Label intent', 'Assign a dominant intent to each cluster'),
        ],
        inputScope: [{ name: 'serp_results', type: 'json[]', description: 'SERP rankings from n1' }],
        outputScope: [{ name: 'keyword_clusters', type: 'json[]', description: 'Per-cluster {label, intent, keywords[]}' }],
      },
      {
        id: 'n3', type: 'validation', title: 'Validate cluster coherence',
        detail: 'Check that every input query landed in exactly one cluster, no cluster is empty, and each has an intent label.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [{ name: 'keyword_clusters', type: 'json[]' }],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid' },
        ],
      },
      {
        id: 'n4', type: 'action', title: 'Export keyword clusters to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write clusters to data/reports/keyword-clusters.xlsx with columns Cluster, Intent, Keyword. One row per keyword, grouped by cluster, header first.',
        acceptance: 'XLSX saved with a header + one row per keyword.',
        subtasks: [
          st('s1', 'Flatten clusters to rows', 'Emit one row per keyword with its cluster + intent'),
          st('s2', 'Write the workbook', 'Save to the workspace and capture path + counts'),
        ],
        inputScope: [{ name: 'keyword_clusters', type: 'json[]', description: 'Clusters to write' }],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: 'Sheet the rows were written to' },
          { name: 'row_count', type: 'number', description: 'Keyword rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns: [Cluster, Intent, Keyword]' },
          { name: 'keyword_clusters', type: 'json[]', description: 'The clusters written (mirrors n2)' },
        ],
      },
    ])
  mk('wf_seo_local_audit', 'Local SEO Audit', 'Audit Google Business Profile, citations and reviews, then export the findings.',
    [p('business_name', 'text', 'Business name'), p('location', 'text', 'City / area')],
    [
      {
        id: 'n1', type: 'action', title: 'Audit Google Business Profile completeness', tool: 'chrome',
        detail: 'Open the GBP for business_name in location and capture completeness: primary/secondary categories, hours, photos, attributes, products/services, and Q&A coverage.',
        acceptance: 'gbp_profile captures categories, hours, photos, and attributes.',
        subtasks: [
          st('s1', 'Locate the profile', 'Find the GBP matching business_name + location'),
          st('s2', 'Score completeness', 'Categories, hours, photos, attributes, Q&A'),
        ],
        inputScope: [
          { name: 'business_name', type: 'text', description: 'Business to audit' },
          { name: 'location', type: 'text', description: 'City/area to disambiguate the listing' },
        ],
        outputScope: [{ name: 'gbp_profile', type: 'json', description: 'GBP completeness fields' }],
      },
      {
        id: 'n2', type: 'action', title: 'Check NAP citation consistency', tool: 'chrome',
        detail: 'Search the major local directories and compare Name/Address/Phone against the GBP, flagging mismatches and missing listings.',
        acceptance: 'citations has one entry per checked directory with a match verdict.',
        subtasks: [
          st('s1', 'Gather directory listings', 'Find the business across major local directories'),
          st('s2', 'Diff NAP', 'Compare Name/Address/Phone vs the GBP and flag mismatches'),
        ],
        inputScope: [
          { name: 'business_name', type: 'text', description: 'Business whose citations to check' },
          { name: 'gbp_profile', type: 'json', description: 'Source of truth NAP from n1' },
        ],
        outputScope: [{ name: 'citations', type: 'json[]', description: 'Per-directory {source, nap_match, issues}' }],
      },
      {
        id: 'n3', type: 'action', title: 'Compile local SEO findings', tool: 'read',
        detail: 'Merge GBP completeness, citation consistency, and review/rating signals into prioritized findings, each with a verdict and a recommended fix.',
        acceptance: 'local_findings summarizes GBP, citations, and reviews with fixes.',
        subtasks: [
          st('s1', 'Summarize reviews', 'Aggregate rating, count, recency, response rate'),
          st('s2', 'Merge into findings', 'Combine GBP + citations + reviews with verdicts + fixes'),
        ],
        inputScope: [
          { name: 'gbp_profile', type: 'json' },
          { name: 'citations', type: 'json[]' },
        ],
        outputScope: [{ name: 'local_findings', type: 'json', description: 'GBP + citation + review findings with fixes' }],
      },
      {
        id: 'n4', type: 'validation', title: 'Validate local findings',
        detail: 'Confirm the findings cover GBP, citations, and reviews, every finding has a verdict + fix, and there are no null fields.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [{ name: 'local_findings', type: 'json' }],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid' },
        ],
      },
      {
        id: 'n5', type: 'action', title: 'Export local SEO findings to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write the findings to data/reports/local-seo-audit.xlsx with columns Area, Finding, Verdict, Fix. Header first, then one row per finding.',
        acceptance: 'XLSX saved with a header + one row per finding.',
        subtasks: [
          st('s1', 'Build header + rows', 'Flatten findings into Area/Finding/Verdict/Fix rows'),
          st('s2', 'Write the workbook', 'Save to the workspace and capture path + counts'),
        ],
        inputScope: [{ name: 'local_findings', type: 'json', description: 'Findings to write' }],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: 'Sheet the rows were written to' },
          { name: 'row_count', type: 'number', description: 'Finding rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns: [Area, Finding, Verdict, Fix]' },
          { name: 'local_findings', type: 'json', description: 'The findings written (mirrors n3)' },
        ],
      },
    ])
  mk('wf_seo_ecommerce_audit', 'E-commerce SEO Audit', 'Audit product/category pages, schema and faceted nav, then export the issues.',
    [p('store_url', 'url', 'Store URL')],
    [
      {
        id: 'n1', type: 'action', title: 'Crawl product & category pages', tool: 'chrome', toolSkills: ['seo-crawl'],
        detail: 'Crawl store_url focusing on product and category templates. Per page capture URL, type (product/category), title, canonical, and indexability.',
        acceptance: 'product_pages has ≥1 page, each tagged product or category.',
        subtasks: [
          st('s1', 'Discover commerce pages', 'Find product + category URLs from the store'),
          st('s2', 'Capture page fields', 'title, type, canonical, indexability per page'),
        ],
        inputScope: [{ name: 'store_url', type: 'url', description: 'Store root URL to crawl' }],
        outputScope: [{ name: 'product_pages', type: 'json[]', description: 'Per-page {url, type, title, canonical, indexable}' }],
      },
      {
        id: 'n2', type: 'action', title: 'Check product schema & faceted-nav indexing', tool: 'read',
        detail: 'Verify Product/Offer/Review schema on product pages and detect faceted-navigation indexing problems (crawlable filter URLs, parameter bloat, missing canonicals).',
        acceptance: 'schema_issues has one entry per page with a schema + faceting verdict.',
        subtasks: [
          st('s1', 'Validate product schema', 'Check Product/Offer/Review markup completeness'),
          st('s2', 'Detect faceting issues', 'Flag indexable filter URLs and parameter bloat'),
        ],
        inputScope: [{ name: 'product_pages', type: 'json[]', description: 'Pages from n1' }],
        outputScope: [{ name: 'schema_issues', type: 'json[]', description: 'Per-page schema + faceting issues' }],
      },
      {
        id: 'n3', type: 'action', title: 'Compile e-commerce issues', tool: 'read',
        detail: 'Detect duplicate/thin product descriptions and merge them with the schema/faceting issues into a single prioritized issue list with severity.',
        acceptance: 'Every issue has a page, type, and severity.',
        subtasks: [
          st('s1', 'Detect duplicate/thin copy', 'Flag product pages with duplicated or <50-word descriptions'),
          st('s2', 'Merge + prioritize', 'Combine with schema/faceting issues and assign severity'),
        ],
        inputScope: [
          { name: 'product_pages', type: 'json[]' },
          { name: 'schema_issues', type: 'json[]' },
        ],
        outputScope: [{ name: 'ecommerce_issues', type: 'json[]', description: 'Per-issue {page, type, detail, severity}' }],
      },
      {
        id: 'n4', type: 'validation', title: 'Validate e-commerce findings',
        detail: 'Confirm the issue list is usable: non-empty, each issue references a crawled page, severity present, no nulls.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [{ name: 'ecommerce_issues', type: 'json[]' }],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid' },
        ],
      },
      {
        id: 'n5', type: 'action', title: 'Export the e-commerce audit to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write the issues to data/reports/ecommerce-seo-audit.xlsx with columns Page, Type, Detail, Severity. Header first, then one row per issue.',
        acceptance: 'XLSX saved with a header + one row per issue.',
        subtasks: [
          st('s1', 'Build header + rows', 'Map each issue to the four columns in order'),
          st('s2', 'Write the workbook', 'Save to the workspace and capture path + counts'),
        ],
        inputScope: [{ name: 'ecommerce_issues', type: 'json[]', description: 'Issues to write' }],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: 'Sheet the rows were written to' },
          { name: 'row_count', type: 'number', description: 'Issue rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns: [Page, Type, Detail, Severity]' },
          { name: 'ecommerce_issues', type: 'json[]', description: 'The issues written (mirrors n3)' },
        ],
      },
    ])
  mk('wf_seo_action_plan', 'SEO Action Plan', 'Consolidate audit findings into a prioritized roadmap and export it.',
    [p('audit_findings', 'json', 'Consolidated audit findings')],
    [
      {
        id: 'n1', type: 'action', title: 'Parse the consolidated audit findings', tool: 'read',
        detail: 'Read audit_findings (the merged output of the upstream audit agents) and normalize every issue into a common shape: {area, issue, severity, source}.',
        acceptance: 'parsed_findings is a non-empty normalized issue list.',
        subtasks: [
          st('s1', 'Normalize issue shape', 'Coerce mixed audit outputs into {area, issue, severity, source}'),
          st('s2', 'Dedupe overlaps', 'Merge findings that describe the same problem'),
        ],
        inputScope: [{ name: 'audit_findings', type: 'json', description: 'Merged findings from the audit agents' }],
        outputScope: [{ name: 'parsed_findings', type: 'json[]', description: 'Normalized {area, issue, severity, source}' }],
      },
      {
        id: 'n2', type: 'action', title: 'Estimate impact vs effort', tool: 'read',
        detail: 'Score each finding for SEO impact and implementation effort, then derive a priority (quick win / major project / backlog).',
        acceptance: 'Every finding has an impact, effort, and priority.',
        subtasks: [
          st('s1', 'Score impact', 'Rate the SEO upside of fixing each finding'),
          st('s2', 'Score effort', 'Rate implementation cost and derive the priority bucket'),
        ],
        inputScope: [{ name: 'parsed_findings', type: 'json[]', description: 'Normalized findings from n1' }],
        outputScope: [{ name: 'prioritized_items', type: 'json[]', description: 'Per-finding {area, issue, impact, effort, priority}' }],
      },
      {
        id: 'n3', type: 'validation', title: 'Validate roadmap completeness',
        detail: 'Confirm every input finding made it into the roadmap, each item has impact/effort/priority, and there is at least one quick win.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [
          { name: 'parsed_findings', type: 'json[]' },
          { name: 'prioritized_items', type: 'json[]' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid' },
        ],
      },
      {
        id: 'n4', type: 'action', title: 'Export the action plan to a workbook', tool: 'write', toolSkills: ['xlsx'],
        detail: 'Write the roadmap to data/reports/seo-action-plan.xlsx with columns Area, Issue, Impact, Effort, Priority. Header first, then one row per item; also surface the top quick wins.',
        acceptance: 'XLSX saved with a header + one row per roadmap item, and priorities populated.',
        subtasks: [
          st('s1', 'Build header + rows', 'Map each roadmap item to the five columns in order'),
          st('s2', 'Write the workbook', 'Save to the workspace and extract the top quick wins'),
        ],
        inputScope: [{ name: 'prioritized_items', type: 'json[]', description: 'Roadmap items to write' }],
        outputScope: [
          { name: 'sheet_name', type: 'text', description: 'Sheet the rows were written to' },
          { name: 'row_count', type: 'number', description: 'Roadmap rows written, excluding the header' },
          { name: 'header_row', type: 'text[]', description: 'Columns: [Area, Issue, Impact, Effort, Priority]' },
          { name: 'action_plan', type: 'json[]', description: 'The roadmap items written (mirrors n2)' },
          { name: 'priorities', type: 'json[]', description: 'Top quick-win items pulled from the roadmap' },
        ],
      },
    ])

  // ── Hero demo workflows (피치 데모: Build→Run→Reuse→Share→Monitor→Review) ──
  // Script A — 소셜/콘텐츠 에이전시용. 클라이언트/경쟁사/트렌드 리서치 → 4주 콘텐츠 캘린더 초안.
  mk('wf_content_calendar', 'Monthly Content Research & Calendar',
    'Research the client\'s own posts, competitors, and niche trends in the browser, then draft a 4-week content calendar for strategist review.',
    [
      p('client_name', 'text', 'Client name'),
      p('industry', 'text', 'Industry / niche'),
      p('platforms', 'text', 'Target platforms'),
      p('competitors', 'text', 'Top 2 competitors'),
      p('brand_voice', 'text', 'Brand voice notes'),
    ],
    [
      {
        id: 'n1', type: 'action', title: "Scan the client's recent posts", tool: 'chrome', toolSkills: ['instagram', 'data-scout'],
        detail: "Open the client's public profiles on each target platform. Capture up to 20 recent posts per platform (last 30 days) — format (reel/carousel/static), hook, caption angle, posting cadence, engagement — and flag the top performers.",
        acceptance: 'client_posts covers every target platform (≤20 posts each) and top_performers is non-empty.',
        subtasks: [
          st('s1', 'Open client profiles', 'Navigate to the client’s public profile on each target platform'),
          st('s2', 'Capture post metrics', 'Format, hook, caption angle, cadence, engagement per post'),
        ],
        inputScope: [
          { name: 'client_name', type: 'text', description: 'Client whose profiles to scan' },
          { name: 'platforms', type: 'text', description: 'Platforms to cover (e.g. Instagram, TikTok)' },
        ],
        outputScope: [
          { name: 'client_posts', type: 'json[]', description: 'Per-post {platform, format, hook, engagement, posted_at}' },
          { name: 'top_performers', type: 'json[]', description: 'Highest-engagement posts with why they worked' },
        ],
      },
      {
        id: 'n2', type: 'action', title: 'Scan competitors & trending formats', tool: 'chrome', toolSkills: ['instagram', 'data-scout'],
        detail: 'For each competitor, capture up to 15 recent posts — posting cadence, and the formats and hooks drawing engagement. Collect trending hashtags and formats in the niche.',
        acceptance: 'competitor_angles has entries for every competitor and trending_formats is non-empty.',
        subtasks: [
          st('s1', 'Scan competitor profiles', 'Recent posts, cadence, formats and hooks per competitor'),
          st('s2', 'Collect trending signals', 'Hashtags and formats currently pulling engagement in the niche'),
        ],
        inputScope: [
          { name: 'competitors', type: 'text', description: 'Competitor accounts to scan' },
          { name: 'platforms', type: 'text', description: 'Platforms to cover' },
        ],
        outputScope: [
          { name: 'competitor_angles', type: 'json[]', description: 'Per-competitor {account, cadence, formats, standout_hooks}' },
          { name: 'trending_formats', type: 'json[]', description: 'Niche hashtags/formats with momentum' },
        ],
      },
      {
        id: 'n3', type: 'action', title: 'Pull topical trends for the niche', tool: 'chrome', toolSkills: ['data-scout'],
        detail: 'Check current topical trends for the industry (e.g. Google Trends, niche news): rising queries, seasonal moments, and upcoming dates worth planning content around.',
        acceptance: 'niche_trends is non-empty and each entry names its source.',
        subtasks: [
          st('s1', 'Check rising queries', 'Rising searches and topics for the industry'),
          st('s2', 'Spot seasonal moments', 'Upcoming dates/events worth planning around'),
        ],
        inputScope: [{ name: 'industry', type: 'text', description: 'Niche whose trends to pull' }],
        outputScope: [{ name: 'niche_trends', type: 'json[]', description: 'Per-trend {topic, signal, source, timing}' }],
      },
      {
        id: 'n4', type: 'action', title: 'Synthesize research into content themes', tool: 'read',
        detail: 'Merge the client’s top performers, competitor angles, and niche trends into 4–6 content themes. Each theme cites its supporting research and respects the brand voice notes.',
        acceptance: 'content_themes has 4–6 entries, each with evidence and a brand-voice fit note.',
        subtasks: [
          st('s1', 'Cluster the research', 'Group findings into candidate themes'),
          st('s2', 'Attach evidence + voice fit', 'Cite sources per theme and check against brand voice'),
        ],
        inputScope: [
          { name: 'top_performers', type: 'json[]' },
          { name: 'competitor_angles', type: 'json[]' },
          { name: 'trending_formats', type: 'json[]' },
          { name: 'niche_trends', type: 'json[]' },
          { name: 'brand_voice', type: 'text' },
        ],
        outputScope: [{ name: 'content_themes', type: 'json[]', description: 'Per-theme {theme, evidence[], voice_fit}' }],
      },
      {
        id: 'n5', type: 'validation', title: 'Validate research coverage',
        detail: 'Check the themes are usable before drafting: every theme cites at least one research source, every target platform is represented, and no theme conflicts with the brand voice notes.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [
          { name: 'content_themes', type: 'json[]' },
          { name: 'platforms', type: 'text' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid; otherwise the gaps found' },
        ],
      },
      {
        id: 'n6', type: 'action', title: 'Draft the 4-week content calendar', tool: 'write', toolSkills: ['md'],
        detail: 'Write the calendar draft to data/reports/: four weekly sections, one row per planned post with hook, format, caption angle, CTA, and target platform. Mark it clearly as a draft for strategist review.',
        acceptance: 'Markdown saved with 4 weekly sections and one row per planned post.',
        subtasks: [
          st('s1', 'Lay out the weekly grid', 'Distribute themes across 4 weeks and the target platforms'),
          st('s2', 'Write the draft', 'Hook, format, caption angle, CTA per post; save to the workspace'),
        ],
        inputScope: [
          { name: 'content_themes', type: 'json[]', description: 'Validated themes to plan from' },
          { name: 'platforms', type: 'text' },
        ],
        outputScope: [
          { name: 'weeks_planned', type: 'number', description: 'Weekly sections written (expected 4)' },
          { name: 'post_count', type: 'number', description: 'Planned posts across the calendar' },
          { name: 'calendar_rows', type: 'json[]', description: 'Per-post {week, platform, hook, format, caption_angle, cta}' },
        ],
      },
    ], ['content'])

  // Script B — 로컬 SEO/평판 에이전시용. GBP·로컬랭킹·경쟁사·리뷰 점검 → 월간 감사 초안. 로그인 불필요(공개 데이터).
  mk('wf_gbp_local_audit', 'Local SEO & GBP Monthly Audit',
    'Audit a local client\'s Google Business Profile, local-pack rankings, competitors, and reviews, then draft the monthly audit with a prioritized action list.',
    [
      p('business_name', 'text', 'Business name'),
      p('category', 'text', 'Primary category'),
      p('city', 'text', 'City / service area'),
      p('keywords', 'text', 'Target keywords'),
      p('competitors', 'text', 'Top 2–3 local competitors'),
    ],
    [
      {
        id: 'n1', type: 'action', title: "Capture the client's GBP state", tool: 'chrome',
        detail: "Find the client's Google Business Profile via local search and record completeness: categories (vs. the expected primary category), hours, services, description, photo count, Q&A activity, and recent posts.",
        acceptance: 'gbp_state has categories, hours, services, photo_count, and recent_posts keys.',
        subtasks: [
          st('s1', 'Locate the profile', 'Find the business in city-localized Google search'),
          st('s2', 'Record completeness', 'Categories vs. expected, hours, services, photos, Q&A, posts'),
        ],
        inputScope: [
          { name: 'business_name', type: 'text', description: 'Business whose GBP to inspect' },
          { name: 'category', type: 'text', description: 'Expected primary category to check against' },
          { name: 'city', type: 'text', description: 'Locale for the search' },
        ],
        outputScope: [{ name: 'gbp_state', type: 'json', description: 'Profile completeness snapshot with gaps flagged' }],
      },
      {
        id: 'n2', type: 'action', title: 'Check local-pack rankings per keyword', tool: 'chrome',
        detail: 'Run each target keyword (up to ~10 per run) in Google localized to the city. Capture whether the client appears in the local pack, at which position, and which businesses rank — a snapshot of the live results at run time.',
        acceptance: 'ranking_table has one row per keyword with a position (or not-ranked) and the pack occupants.',
        subtasks: [
          st('s1', 'Run each keyword', 'City-localized Google search per target keyword'),
          st('s2', 'Capture the local pack', 'Client position + who occupies the pack per keyword'),
        ],
        inputScope: [
          { name: 'keywords', type: 'text', description: 'Keywords to check' },
          { name: 'city', type: 'text' },
        ],
        outputScope: [{ name: 'ranking_table', type: 'json[]', description: 'Per-keyword {keyword, client_position, pack[]}' }],
      },
      {
        id: 'n3', type: 'action', title: 'Scan competitor GBP profiles', tool: 'chrome',
        detail: 'For each local competitor, capture rating, review count, primary categories, photo volume, and posting cadence for comparison against the client.',
        acceptance: 'competitor_profiles has one entry per competitor with rating + review_count.',
        subtasks: [
          st('s1', 'Open competitor GBPs', 'Locate each competitor profile in local search'),
          st('s2', 'Capture comparison fields', 'Rating, reviews, categories, photos, cadence'),
        ],
        inputScope: [
          { name: 'competitors', type: 'text', description: 'Competitors to scan' },
          { name: 'city', type: 'text' },
        ],
        outputScope: [{ name: 'competitor_profiles', type: 'json[]', description: 'Per-competitor {name, rating, review_count, categories, cadence}' }],
      },
      {
        id: 'n4', type: 'action', title: 'Scan the review profile', tool: 'chrome',
        detail: "Scan the client's public reviews: new reviews since the last month, unanswered reviews, and negative reviews to flag for a human response.",
        acceptance: 'review_flags has new, unanswered, and negatives keys (each may be empty).',
        subtasks: [
          st('s1', 'Collect recent reviews', 'New reviews in the audit window'),
          st('s2', 'Flag gaps', 'Unanswered reviews and negatives needing a response'),
        ],
        inputScope: [{ name: 'business_name', type: 'text' }],
        outputScope: [{ name: 'review_flags', type: 'json', description: '{new[], unanswered[], negatives[]}' }],
      },
      {
        id: 'n5', type: 'action', title: 'Compile findings & prioritized actions', tool: 'read',
        detail: 'Merge the GBP gaps, ranking table, competitor comparison, and review flags into audit findings, then derive a prioritized action list (impact-first) as a draft for the specialist.',
        acceptance: 'Every finding has a severity and every action cites the finding it addresses.',
        subtasks: [
          st('s1', 'Consolidate findings', 'GBP gaps, ranking losses, competitor deltas, review issues'),
          st('s2', 'Prioritize actions', 'Impact-first draft action list, one per finding group'),
        ],
        inputScope: [
          { name: 'gbp_state', type: 'json' },
          { name: 'ranking_table', type: 'json[]' },
          { name: 'competitor_profiles', type: 'json[]' },
          { name: 'review_flags', type: 'json' },
        ],
        outputScope: [
          { name: 'audit_findings', type: 'json[]', description: 'Per-finding {area, finding, severity}' },
          { name: 'action_list', type: 'json[]', description: 'Prioritized {action, addresses, impact}' },
        ],
      },
      {
        id: 'n6', type: 'validation', title: 'Validate audit completeness',
        detail: 'Confirm the audit covers all four areas (GBP, rankings, competitors, reviews), every keyword was checked, and each action maps to a finding.',
        acceptance: 'is_valid=true and issues is empty.',
        inputScope: [
          { name: 'audit_findings', type: 'json[]' },
          { name: 'action_list', type: 'json[]' },
          { name: 'keywords', type: 'text' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when valid; otherwise the coverage gaps' },
        ],
      },
      {
        id: 'n7', type: 'action', title: 'Draft the monthly audit report', tool: 'write', toolSkills: ['md'],
        detail: 'Write the audit draft to data/reports/: GBP completeness gaps, ranking table vs. competitors, review flags, and the prioritized action list. Mark it a draft — the specialist decides what to prioritize.',
        acceptance: 'Markdown saved with all four audit sections and the action list populated.',
        subtasks: [
          st('s1', 'Assemble the sections', 'GBP, rankings, competitors, reviews in order'),
          st('s2', 'Write the draft', 'Save to the workspace with the action list on top'),
        ],
        inputScope: [
          { name: 'audit_findings', type: 'json[]' },
          { name: 'action_list', type: 'json[]' },
          { name: 'ranking_table', type: 'json[]' },
        ],
        outputScope: [
          { name: 'sections_written', type: 'text[]', description: 'Sections rendered: [Actions, GBP, Rankings, Competitors, Reviews]' },
          { name: 'action_count', type: 'number', description: 'Prioritized actions in the draft' },
        ],
      },
    ], ['local-seo'])

  // ── Execution workflows (write 없음 → execution) ───────────────────────────
  mk('wf_seo_onpage_fixes', 'On-Page Meta & Schema Fixes', 'Apply title/meta/schema fixes in the CMS and verify they are live (action — no file output).',
    [p('page_urls', 'text', 'Pages to fix'), p('fixes', 'json', 'Fixes to apply per page')],
    [
      {
        id: 'n1', type: 'action', title: 'Resolve target pages & planned edits', tool: 'read',
        detail: 'Pair each URL in page_urls with its planned edits from fixes (title, meta description, schema), producing an ordered fix queue.',
        acceptance: 'fix_queue has one entry per page with at least one planned edit.',
        subtasks: [
          st('s1', 'Match pages to fixes', 'Join page_urls with the fixes payload'),
          st('s2', 'Order the queue', 'Sequence edits so each page is touched once'),
        ],
        inputScope: [
          { name: 'page_urls', type: 'text', description: 'Pages to edit' },
          { name: 'fixes', type: 'json', description: 'Planned edits per page' },
        ],
        outputScope: [{ name: 'fix_queue', type: 'json[]', description: 'Per-page {url, edits[]}' }],
      },
      {
        id: 'n2', type: 'action', title: 'Apply title, meta & schema edits in the CMS', tool: 'chrome',
        detail: 'For each queued page, open its CMS editor and apply the planned title, meta description, and schema changes, then save/publish.',
        acceptance: 'Every queued page is saved with its edits applied.',
        subtasks: [
          st('s1', 'Open the page editor', 'Navigate to each page in the CMS'),
          st('s2', 'Apply + save edits', 'Write the title/meta/schema changes and publish'),
        ],
        inputScope: [{ name: 'fix_queue', type: 'json[]', description: 'Pages + edits to apply' }],
        outputScope: [{ name: 'applied_changes', type: 'json[]', description: 'Per-page {url, applied[], saved}' }],
      },
      {
        id: 'n3', type: 'validation', title: 'Verify fixes are live',
        detail: 'Re-fetch each edited page and confirm the new title/meta/schema match what was applied; report any that did not take.',
        acceptance: 'is_valid=true when every applied edit is confirmed live.',
        inputScope: [{ name: 'applied_changes', type: 'json[]' }],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Pages whose edits did not take; empty when all live' },
        ],
      },
    ])
  mk('wf_seo_sitemap_submit', 'Sitemap Generate & Submit', 'Build an XML sitemap and submit it to Search Console (action — no file output).',
    [p('site_url', 'url', 'Site URL')],
    [
      {
        id: 'n1', type: 'action', title: 'Build the XML sitemap from crawled URLs', tool: 'chrome', toolSkills: ['seo-crawl'],
        detail: 'Crawl site_url for indexable URLs and assemble a valid urlset XML with lastmod where available.',
        acceptance: 'sitemap_xml is valid urlset XML with url_count > 0.',
        subtasks: [
          st('s1', 'Collect indexable URLs', 'Crawl the site for canonical, indexable URLs'),
          st('s2', 'Assemble the urlset', 'Emit valid sitemap XML with lastmod entries'),
        ],
        inputScope: [{ name: 'site_url', type: 'url', description: 'Site to build the sitemap for' }],
        outputScope: [
          { name: 'sitemap_xml', type: 'text', description: 'The assembled sitemap XML' },
          { name: 'url_count', type: 'number', description: 'URLs included in the sitemap' },
        ],
      },
      {
        id: 'n2', type: 'action', title: 'Submit the sitemap to Search Console', tool: 'chrome',
        detail: 'Open Google Search Console for the property and submit the sitemap URL, capturing the submission response.',
        acceptance: 'submission_status reflects an accepted submission.',
        subtasks: [
          st('s1', 'Open the GSC property', 'Navigate to the Sitemaps section for the site'),
          st('s2', 'Submit + capture status', 'Submit the sitemap and record the response'),
        ],
        inputScope: [
          { name: 'site_url', type: 'url', description: 'Property whose sitemap to submit' },
          { name: 'url_count', type: 'number', description: 'Expected URL count for sanity check' },
        ],
        outputScope: [{ name: 'submission_status', type: 'json', description: '{accepted, submitted_at, message}' }],
      },
      {
        id: 'n3', type: 'validation', title: 'Confirm submission & request indexing',
        detail: 'Verify GSC accepted the sitemap and the discovered URL count matches url_count; flag a mismatch or rejection.',
        acceptance: 'is_valid=true when accepted and counts align.',
        inputScope: [
          { name: 'submission_status', type: 'json' },
          { name: 'url_count', type: 'number' },
        ],
        outputScope: [
          { name: 'is_valid', type: 'boolean' },
          { name: 'issues', type: 'string[]', description: 'Empty when accepted and counts align' },
        ],
      },
    ])
}

export function deleteWorkflow(userDir: string, id: string): void {
  fs.rmSync(workflowDir(userDir, id), { recursive: true, force: true })
}

// ── Builder chat persistence ────────────────────────────────────────────────
// Per-workflow jsonl: users/<uid>/workflows/<id>/builder-chat.jsonl
// Each line = { id, role, content, ts } — matches WorkflowChatMessage in
// useWorkflowClaw.ts. Append-only at runtime; cleared on user reset.
// Survives app restart, lives next to the workflow it's about, follows the
// workflow when copied / shared via the workspace dir.

export type BuilderChatLine = {
  id:      string
  role:    'user' | 'assistant' | 'system'
  content: string
  ts:      number
}

function builderChatPath(userDir: string, id: string): string {
  return path.join(workflowDir(userDir, id), 'builder-chat.jsonl')
}

export function readBuilderChat(userDir: string, id: string): BuilderChatLine[] {
  const p = builderChatPath(userDir, id)
  if (!fs.existsSync(p)) return []
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const out: BuilderChatLine[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t) as BuilderChatLine
        if (obj && typeof obj.id === 'string' && typeof obj.content === 'string') out.push(obj)
      } catch { /* skip corrupt line — partial write etc. */ }
    }
    return out
  } catch { return [] }
}

export function appendBuilderChat(userDir: string, id: string, line: BuilderChatLine): void {
  // Workflow dir must exist — but ensure (e.g., fresh workflow created in same
  // session, chat starts before any update saves the json).
  fs.mkdirSync(workflowDir(userDir, id), { recursive: true })
  fs.appendFileSync(builderChatPath(userDir, id), JSON.stringify(line) + '\n', 'utf8')
}

export function clearBuilderChat(userDir: string, id: string): void {
  const p = builderChatPath(userDir, id)
  try { fs.unlinkSync(p) } catch { /* already gone */ }
}

// ── Main chat persistence ───────────────────────────────────────────────────
// Workspace-level jsonl: <workspace>/chat/main-chat.jsonl
// Each line = a ChatMessage serialized with timestamp as epoch ms (number) so
// the whole record is plain JSON. Append-only at runtime; cleared on New Chat.
// Survives app restart — the main chat scrollback is reconstructed from this
// file on hook mount. Unlike builder chat (per-workflow), there is exactly one
// main chat per workspace, so no id parameter.
//
// We intentionally store the full ChatMessage shape (planId, toolCalls,
// actions, tokens) rather than a trimmed line, so restored assistant messages
// keep their plan cards / token counts when the referenced plan still exists.

export type MainChatLine = {
  id:        string
  role:      'user' | 'assistant' | 'system'
  content:   string
  timestamp: number   // epoch ms — Date is rehydrated in the renderer
  tokens?:   number
  planId?:   string
  toolCalls?: Array<{ name: string; detail?: string }>
  actions?:  unknown[]
}

function mainChatPath(userDir: string): string {
  return path.join(userDir, 'chat', 'main-chat.jsonl')
}

export function readMainChat(userDir: string): MainChatLine[] {
  const p = mainChatPath(userDir)
  if (!fs.existsSync(p)) return []
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const out: MainChatLine[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t) as MainChatLine
        if (obj && typeof obj.id === 'string' && typeof obj.content === 'string') out.push(obj)
      } catch { /* skip corrupt line — partial write etc. */ }
    }
    return out
  } catch { return [] }
}

export function appendMainChat(userDir: string, line: MainChatLine): void {
  fs.mkdirSync(path.join(userDir, 'chat'), { recursive: true })
  fs.appendFileSync(mainChatPath(userDir), JSON.stringify(line) + '\n', 'utf8')
}

export function clearMainChat(userDir: string): void {
  try { fs.unlinkSync(mainChatPath(userDir)) } catch { /* already gone */ }
}

// ── Main chat gateway-session key persistence ────────────────────────────────
// <workspace>/chat/main-session.json — { sessionKey: string | null }.
// Best-effort gateway-session resume: on next launch the renderer reads this
// key and asks the gateway to reopen that session via sessions.create({ key }).
// If the gateway no longer has it, a fresh session is created and its new key
// is written back here. The scrollback is restored independently (from
// main-chat.jsonl), so a failed resume is graceful — the chat still renders.

export type MainSessionState = { sessionKey: string | null }

function mainSessionPath(userDir: string): string {
  return path.join(userDir, 'chat', 'main-session.json')
}

export function readMainSession(userDir: string): MainSessionState {
  const p = mainSessionPath(userDir)
  if (!fs.existsSync(p)) return { sessionKey: null }
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<MainSessionState>
    return { sessionKey: typeof obj?.sessionKey === 'string' ? obj.sessionKey : null }
  } catch { return { sessionKey: null } }
}

export function writeMainSession(userDir: string, state: MainSessionState): void {
  fs.mkdirSync(path.join(userDir, 'chat'), { recursive: true })
  fs.writeFileSync(mainSessionPath(userDir), JSON.stringify(state), 'utf8')
}

// ── Last test run persistence ──────────────────────────────────────────────
// Per-workflow JSON: users/<uid>/workflows/<id>/last-test-run.json
// Saved at run-end so canvas can restore node statuses/cost/duration after
// app restart. We don't persist live in-progress state (only final snapshots);
// resumption of an interrupted run is out of scope. Shape mirrors the renderer
// WorkflowTestState — stored as opaque blob (renderer parses).

function lastTestRunPath(userDir: string, id: string): string {
  return path.join(workflowDir(userDir, id), 'last-test-run.json')
}

export function readLastTestRun(userDir: string, id: string): unknown {
  const p = lastTestRunPath(userDir, id)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

export function writeLastTestRun(userDir: string, id: string, state: unknown): void {
  fs.mkdirSync(workflowDir(userDir, id), { recursive: true })
  fs.writeFileSync(lastTestRunPath(userDir, id), JSON.stringify(state, null, 2), 'utf8')
}

export function clearLastTestRun(userDir: string, id: string): void {
  const p = lastTestRunPath(userDir, id)
  try { fs.unlinkSync(p) } catch { /* already gone */ }
}

// ── run 히스토리 (runs.jsonl) ────────────────────────────────────────────────
// last-test-run.json 이 "최신 1건"이라면 runs.jsonl 은 append-only 전체 이력 —
// Runs 대시보드의 필터/통계(성공률·평균시간·CSV)의 로컬 데이터 기반.

export type RunHistoryEntry = {
  runId:      string
  wfId:       string
  wfTitle:    string
  status:     'done' | 'failed' | 'aborted'
  startedAt:  number
  endedAt:    number
  durationMs: number
  costUsd:    number
  failReason?: string
  nodeTotal:  number
  nodeDone:   number
  harness?:   'v1' | 'v2' | 'v3' | 'off'   // 이 run 의 실행 하네스: v3=기본 추론 하네스 ON, off=baseline (과거 v1/v2 는 이전 A/B 기록)
}

function runHistoryPath(userDir: string, id: string): string {
  return path.join(workflowDir(userDir, id), 'runs.jsonl')
}

export function appendRunHistory(userDir: string, id: string, entry: RunHistoryEntry): void {
  fs.mkdirSync(workflowDir(userDir, id), { recursive: true })
  fs.appendFileSync(runHistoryPath(userDir, id), JSON.stringify(entry) + '\n', 'utf8')
}

// ── run 상세 로그 (runs/<startedAt>.json) ──────────────────────────────────
// runs.jsonl 이 요약 인덱스라면 이 파일은 노드별 전체 기록 — prompt(클립)/output/
// toolCalls(브라우저 액션)/에러까지. 실행 로그 뷰어(Epic 3)의 데이터 소스.

export type RunDetailNode = {
  nodeId:     string
  title:      string
  type?:      string
  tool?:      string
  status:     string
  startedAt?: number
  endedAt?:   number
  durationMs?: number
  costUsd?:   number
  tokensIn?:  number
  tokensOut?: number
  reason?:    string
  prompt?:    string
  output?:    string
  toolCalls?: Array<{ name: string; detail?: string }>
}

export type RunDetail = {
  runId:     string
  wfId:      string
  wfTitle:   string
  status:    'done' | 'failed' | 'aborted'
  startedAt: number
  endedAt:   number
  totals:    { ms: number; usd: number; tokensIn: number; tokensOut: number }
  nodes:     RunDetailNode[]
}

// 로그 보존 기간 — AC(90일). 쓰기 시점에 지난 파일을 정리한다 (별도 스케줄러 불필요).
const RUN_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

function runDetailDir(userDir: string, id: string): string {
  return path.join(workflowDir(userDir, id), 'runs')
}

export function writeRunDetail(userDir: string, id: string, detail: RunDetail): void {
  const dir = runDetailDir(userDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, safeSegment(`${detail.startedAt}.json`)), JSON.stringify(detail, null, 2), 'utf8')
  // 90일 초과 로그 정리 — 파일명이 startedAt(ms) 라 stat 없이 판별 가능.
  const cutoff = Date.now() - RUN_LOG_RETENTION_MS
  try {
    for (const f of fs.readdirSync(dir)) {
      const ts = Number(f.replace(/\.json$/, ''))
      if (Number.isFinite(ts) && ts > 0 && ts < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)) } catch { /* 이미 없음 */ }
      }
    }
  } catch { /* prune 실패는 무해 */ }
}

export function readRunDetail(userDir: string, id: string, startedAt: number): RunDetail | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDetailDir(userDir, id), safeSegment(`${startedAt}.json`)), 'utf8')) as RunDetail
  } catch {
    return null
  }
}

// 모든 워크플로 dir 의 runs.jsonl 을 병합해 최신순으로 반환.
// 파싱 실패 줄은 건너뛴다 (손상 1줄이 전체 이력을 죽이지 않게).
export function listRunHistory(userDir: string, limit = 500): RunHistoryEntry[] {
  const root = workflowsRoot(userDir)
  const out: RunHistoryEntry[] = []
  let dirs: string[] = []
  try { dirs = fs.readdirSync(root) } catch { return [] }
  for (const d of dirs) {
    const p = path.join(root, d, 'runs.jsonl')
    let raw = ''
    try { raw = fs.readFileSync(p, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as RunHistoryEntry
        if (e && typeof e.startedAt === 'number' && e.wfId) out.push(e)
      } catch { /* skip corrupt line */ }
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt)
  return out.slice(0, limit)
}

// Full overwrite — used by Undo to restore a previous snapshot byte-for-byte.
// updateWorkflow() merges fields per-id which is not what we want for rollback
// (AI-added fields would persist). restoreWorkflow takes a complete Workflow
// and writes it verbatim, preserving the same id.
export function restoreWorkflow(userDir: string, wf: Workflow): Workflow {
  if (!wf || typeof wf.id !== 'string' || wf.version !== 1) {
    throw new Error('restoreWorkflow: invalid workflow shape')
  }
  const snapshot: Workflow = { ...wf, updatedAt: nowIso() }
  writeWorkflow(userDir, snapshot)
  return snapshot
}

export function createWorkflow(userDir: string, input: CreateWorkflowInput): Workflow {
  if (!input.title.trim()) throw new Error('title required')
  const id  = generateId('wf')
  const now = nowIso()
  // id 중복 방지 — 위치 기반 fallback(`n${i+1}`)은 명시 id 와 충돌할 수 있고
  // (리뷰 노드가 사이에 끼면 정확히 그렇게 됨), 런 상태·캔버스가 전부 id 로
  // 키잉되므로 중복 id 는 두 노드가 상태 한 칸을 공유하는 유령을 만든다.
  // 명시 id 든 fallback 이든 이미 쓴 id 면 유일해질 때까지 접미사를 붙인다.
  const seenIds = new Set<string>()
  const uniqueId = (want: string): string => {
    let id = want
    for (let k = 2; seenIds.has(id); k++) id = `${want}_${k}`
    seenIds.add(id)
    return id
  }
  const nodes: WorkflowNode[] = (input.nodes ?? []).map((n, i) => ({
    id:          uniqueId(n.id ?? `n${i + 1}`),
    type:        (n as Partial<WorkflowNode>).type ?? 'action',
    title:       String(n.title ?? '').trim() || `Step ${i + 1}`,
    detail:      n.detail,
    acceptance:  n.acceptance,
    skillHint:   n.skillHint ?? null,
    tool:        (n as Partial<WorkflowNode>).tool,
    toolSkills:  (n as Partial<WorkflowNode>).toolSkills,
    subtasks:    (n as Partial<WorkflowNode>).subtasks,
    inputScope:  (n as Partial<WorkflowNode>).inputScope,
    outputScope: (n as Partial<WorkflowNode>).outputScope,
    requires:    Array.isArray(n.requires) ? n.requires : undefined,
  }))
  const wf: Workflow = {
    version:     1,
    id,
    title:       input.title.trim(),
    description: input.description?.trim() || undefined,
    prompt:      typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : undefined,
    inputs:      Array.isArray(input.inputs) ? input.inputs : undefined,
    type:        input.type ?? deriveWorkflowType(nodes),
    outputDir:   typeof input.outputDir === 'string' && input.outputDir.trim() ? input.outputDir.trim() : undefined,
    sourceShared: input.sourceShared && typeof input.sourceShared.sharedId === 'string'
      ? { sharedId: input.sourceShared.sharedId, sourceWfId: input.sourceShared.sourceWfId, copiedUpdatedAt: input.sourceShared.copiedUpdatedAt }
      : undefined,
    author:      input.author,
    createdAt:   now,
    updatedAt:   now,
    nodes,
  }
  writeWorkflow(userDir, wf)
  return wf
}

export function updateWorkflow(userDir: string, id: string, patch: WorkflowPatch): Workflow {
  const wf = readWorkflow(userDir, id)
  if (!wf) throw new Error(`workflow not found: ${id}`)
  if (typeof patch.title === 'string' && patch.title.trim()) wf.title = patch.title.trim()
  if (typeof patch.description === 'string') wf.description = patch.description.trim() || undefined
  if (typeof patch.prompt === 'string') wf.prompt = patch.prompt.trim() || undefined
  if (Array.isArray(patch.inputs))      wf.inputs = patch.inputs
  if (patch.type === 'research' || patch.type === 'execution') wf.type = patch.type
  if (typeof patch.outputDir === 'string') wf.outputDir = patch.outputDir.trim() || undefined
  if (Array.isArray(patch.tags)) {
    const t = normalizeWorkflowTags(patch.tags)
    wf.tags = t.length ? t : undefined
  }
  // liveId: 문자열이면 라이브 연결, null 이면 해제. (US-R1-04)
  if ('liveId' in patch) wf.liveId = typeof patch.liveId === 'string' ? patch.liveId : undefined
  if (Array.isArray(patch.nodes)) {
    const byId = new Map(wf.nodes.map(n => [n.id, n]))
    const next: WorkflowNode[] = []
    // 같은 patch 안에서의 id 중복 방지 — createWorkflow 와 동일한 이유
    // (중복 id = 런 상태/캔버스가 한 칸을 공유하는 유령).
    const seenIds = new Set<string>()
    const uniqueId = (want: string): string => {
      let id = want
      for (let k = 2; seenIds.has(id); k++) id = `${want}_${k}`
      seenIds.add(id)
      return id
    }
    let idx = 1
    for (const pn of patch.nodes) {
      // 이미 이번 patch 에서 소비된 id 로 또 매칭하려 들면 (patch 안 중복)
      // 기존 노드 업데이트가 아니라 새 노드로 취급한다.
      const existing = pn.id && !seenIds.has(pn.id) ? byId.get(pn.id) : undefined
      const pnFull = pn as Partial<WorkflowNode>
      if (existing) {
        existing.title      = pn.title      ?? existing.title
        existing.detail     = pn.detail     ?? existing.detail
        existing.acceptance = pn.acceptance ?? existing.acceptance
        existing.skillHint  = pn.skillHint  ?? existing.skillHint
        if (pnFull.type)        existing.type        = pnFull.type
        if (pnFull.tool)        existing.tool        = pnFull.tool
        if (pnFull.toolSkills)  existing.toolSkills  = pnFull.toolSkills
        if (pnFull.subtasks)    existing.subtasks    = pnFull.subtasks
        if (pnFull.inputScope)  existing.inputScope  = pnFull.inputScope
        if (pnFull.outputScope) existing.outputScope = pnFull.outputScope
        if (Array.isArray(pn.requires)) existing.requires = pn.requires
        seenIds.add(existing.id)
        next.push(existing)
        idx++
      } else {
        next.push({
          id:          uniqueId(pn.id ?? `n${Date.now().toString(36)}${idx++}`),
          type:        pnFull.type ?? 'action',
          title:       String(pn.title ?? '').trim() || `Step ${idx}`,
          detail:      pn.detail,
          acceptance:  pn.acceptance,
          skillHint:   pn.skillHint ?? null,
          tool:        pnFull.tool,
          toolSkills:  pnFull.toolSkills,
          subtasks:    pnFull.subtasks,
          inputScope:  pnFull.inputScope,
          outputScope: pnFull.outputScope,
          requires:    Array.isArray(pn.requires) ? pn.requires : undefined,
        })
      }
    }
    wf.nodes = next
  }
  wf.updatedAt = nowIso()
  writeWorkflow(userDir, wf)
  return wf
}

// ── Orchestrations (L4 Work Package) ────────────────────────────────────────
// 여러 Workflow(L5)를 멤버로 참조해 5가지 패턴으로 조율하는 L4 레코드.
// 저장: users/<uid>/orchestrations/<id>/orchestration.json. workflow* 미러.
// 멤버는 workflowId 참조만 — 디스크에 없는 workflowId 는 validateMembers 가 드롭.

export type OrchestrationPatternRec = 'pipeline' | 'parallel' | 'research' | 'roundtable' | 'relay' | 'conductor'
export interface OrchestrationMemberRec {
  id:         string
  workflowId: string                   // leaf: workflow id. group(children 보유)/agent leaf: '' 가능
  agentId?:   string                   // Team leaf: AI Agent id (Orchestration 멤버는 agent 참조)
  label?:     string
  order?:     number
  role?:      'maker' | 'checker' | 'participant' | 'manager'
  handoffTo?: string[]
  subPattern?: OrchestrationPatternRec
  children?:  OrchestrationMemberRec[]  // 재귀: 자식은 leaf 또는 그룹 (임의 깊이)
  width?:     number
  outputScope?: Array<{ name: string; type: string; description?: string }>  // 그룹의 명시적 output 정의
  outputFrom?: string[]              // Parallel 그룹 output 으로 쓸 멤버 id 들
  managerInstructions?: string
  managerModel?:        string
}
export interface OrchestrationConfigRec {
  aggregation?: 'concat' | 'vote' | 'synthesize'
  maxRounds?:   number
  maxHandoffs?: number
  managerInstructions?: string
  managerModel?:        string
}
export interface Orchestration {
  version:      1
  id:           string
  title:        string
  description?: string
  pattern:      OrchestrationPatternRec
  prompt?:      string
  inputs?:      ModuleParam[]
  members:      OrchestrationMemberRec[]
  config?:      OrchestrationConfigRec
  author:       PlanAuthor
  createdAt:    string
  updatedAt:    string
}
export type CreateOrchestrationInput = {
  title:        string
  description?: string
  pattern?:     OrchestrationPatternRec
  prompt?:      string
  inputs?:      ModuleParam[]
  members?:     Array<Partial<OrchestrationMemberRec> & { workflowId: string }>
  config?:      OrchestrationConfigRec
  author:       PlanAuthor
}
export type OrchestrationPatch = {
  title?:       string
  description?: string
  pattern?:     OrchestrationPatternRec
  prompt?:      string
  inputs?:      ModuleParam[]
  members?:     Array<Partial<OrchestrationMemberRec> & { id?: string; workflowId?: string }>
  config?:      OrchestrationConfigRec
}

const ORCH_PATTERNS: OrchestrationPatternRec[] = ['pipeline', 'parallel', 'research', 'roundtable', 'relay', 'conductor']
function normalizePattern(p: unknown): OrchestrationPatternRec {
  return ORCH_PATTERNS.includes(p as OrchestrationPatternRec) ? (p as OrchestrationPatternRec) : 'pipeline'
}

// 그룹 outputScope 정규화 — {name, type, description?} 형태만, name 있는 행만 유지.
function normalizeScopeFields(raw: unknown): Array<{ name: string; type: string; description?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .filter((f): f is { name: unknown; type?: unknown; description?: unknown } => !!f && typeof f === 'object')
    .map(f => ({
      name: String((f as { name?: unknown }).name ?? '').trim(),
      type: String((f as { type?: unknown }).type ?? '').trim(),
      description: typeof (f as { description?: unknown }).description === 'string' ? (f as { description: string }).description.trim() || undefined : undefined,
    }))
    .filter(f => f.name)
  return out.length ? out : undefined
}

function orchestrationsRoot(userDir: string): string {
  return path.join(userDir, 'orchestrations')
}
function orchestrationDir(userDir: string, id: string): string {
  return path.join(orchestrationsRoot(userDir), safeSegment(id))
}
function orchestrationJsonPath(userDir: string, id: string): string {
  return path.join(orchestrationDir(userDir, id), 'orchestration.json')
}

// Drop members whose workflowId no longer exists on disk (analogous to the
// workflow tool/skill gatekeeping). Keeps an orchestration self-consistent
// even after a referenced workflow is deleted.
// 재귀 검증 — 그룹(children 보유)은 임의 깊이로 자식을 검증, leaf 는 실존 workflowId 필요.
// 빈 그룹(유효 자식 0)은 드롭. depth 가드(>=8)로 악성/순환 입력만 차단.
function validateMembers(userDir: string, members: OrchestrationMemberRec[], depth = 0): OrchestrationMemberRec[] {
  const out: OrchestrationMemberRec[] = []
  if (depth > 8) return out
  for (const m of members) {
    if (!m || typeof m.id !== 'string') continue
    // 그룹 멤버 (children 보유) — 자식을 재귀 검증.
    if (Array.isArray(m.children) && m.children.length > 0) {
      const children = validateMembers(userDir, m.children, depth + 1)
      if (children.length === 0) continue   // 유효 자식 없으면 그룹 자체 드롭
      out.push({ ...m, children, subPattern: normalizePattern(m.subPattern) })
      continue
    }
    // agent leaf (Team 멤버) — 실존 agentId 필요.
    if (m.agentId) {
      if (!readAiAgent(userDir, m.agentId)) { console.warn(`[orchestration] dropping member → missing agent ${m.agentId}`); continue }
      out.push({ ...m, workflowId: '', children: undefined, subPattern: undefined, outputScope: undefined, outputFrom: undefined })
      continue
    }
    // workflow leaf — 실존 workflowId 필요.
    if (typeof m.workflowId !== 'string' || !readWorkflow(userDir, m.workflowId)) {
      console.warn(`[orchestration] dropping member → missing workflow ${m.workflowId}`)
      continue
    }
    out.push({ ...m, agentId: undefined, children: undefined, subPattern: undefined, outputScope: undefined, outputFrom: undefined })  // leaf 는 그룹 필드 제거
  }
  return out
}

export function readOrchestration(userDir: string, id: string): Orchestration | null {
  try {
    const raw = fs.readFileSync(orchestrationJsonPath(userDir, id), 'utf8')
    const o   = JSON.parse(raw) as Orchestration
    if (o?.version !== 1 || typeof o?.id !== 'string') return null
    if (!Array.isArray(o.members)) o.members = []
    return o
  } catch {
    return null
  }
}

function writeOrchestration(userDir: string, o: Orchestration): void {
  fs.mkdirSync(orchestrationDir(userDir, o.id), { recursive: true })
  fs.writeFileSync(orchestrationJsonPath(userDir, o.id), JSON.stringify(o, null, 2), 'utf8')
}

export function listOrchestrations(userDir: string): Orchestration[] {
  const root = orchestrationsRoot(userDir)
  const SEED_VERSION = 5   // v5: 단일옵션 agent → 워크플로 직접 배치(혼합 멤버)
  const seedMarker = path.join(root, `.seeded-v${SEED_VERSION}`)
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
    if (!fs.existsSync(seedMarker)) {
      seedSampleOrchestration(userDir)
      try { fs.writeFileSync(seedMarker, '', 'utf8') } catch { /* ignore */ }
    }
  } catch { /* ignore seed failure */ }
  let entries: string[] = []
  try { entries = fs.readdirSync(root) } catch { return [] }
  const out: Orchestration[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue
    const o = readOrchestration(userDir, id)
    if (o) { o.members = validateMembers(userDir, o.members); out.push(o) }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

function seedSampleOrchestration(userDir: string): void {
  // 멤버 = 워크플로 + AI agent(옵션 2개↑) 혼합. 샘플 agent 가 없으면 먼저 시드.
  if (!readAiAgent(userDir, 'agent_seo_implementer')) { try { seedSampleAiAgents(userDir) } catch { /* ignore */ } }
  const has = ['agent_seo_site_audit', 'agent_seo_implementer'].every(id => !!readAiAgent(userDir, id))
  const now = nowIso()
  const sample: Orchestration = {
    version: 1,
    id:      'orch_sample_pipeline',
    title:   'SEO Client Onboarding Team',
    description: 'Manager runs four SEO audits in parallel, synthesizes one dossier, drafts a prioritized roadmap, then ships the on-page fixes.',
    pattern: 'pipeline',
    author:    { uid: 'system', email: 'sample' },
    createdAt: now,
    updatedAt: now,
    members: has ? [
      // 1) 감사 4종 동시 실행 → 하나의 audit dossier 로 합성(research).
      //    Site 감사는 업종에 따라 1개를 고르는 Specialist(AI Agent), 나머지는 단일 워크플로.
      { id: 'g1', workflowId: '', subPattern: 'research', order: 0,
        managerInstructions: 'Merge the technical, content, off-site and keyword findings into one consolidated audit dossier.',
        children: [
          { id: 'm1', workflowId: '',                     agentId: 'agent_seo_site_audit', order: 0 },
          { id: 'm2', workflowId: 'wf_seo_content_audit',  order: 1 },
          { id: 'm3', workflowId: 'wf_seo_backlink_audit', order: 2 },
          { id: 'm4', workflowId: 'wf_seo_keyword_cluster', order: 3 },
        ] },
      // 2) 합성된 감사 → 우선순위 로드맵(단일 워크플로).
      { id: 'm5', workflowId: 'wf_seo_action_plan', order: 1 },
      // 3) 로드맵의 우선 항목 실행 — 작업 종류에 맞는 워크플로를 고르는 Specialist(AI Agent).
      { id: 'm6', workflowId: '', agentId: 'agent_seo_implementer', order: 2 },
    ] : [],
    config: {
      aggregation: 'synthesize',
      managerInstructions: 'Send the client URL to all four audit agents in parallel, synthesize their findings into one audit dossier, hand it to the planner for a prioritized roadmap, then pass the top quick wins to the on-page implementer.',
      maxRounds: 6, maxHandoffs: 6,
    },
  }
  writeOrchestration(userDir, sample)
}

export function deleteOrchestration(userDir: string, id: string): void {
  fs.rmSync(orchestrationDir(userDir, id), { recursive: true, force: true })
}

// 부분 멤버 입력 → rec 정규화 (children 은 1단계 재귀).
function mapMemberInput(m: Partial<OrchestrationMemberRec> & { workflowId?: string }, i: number): OrchestrationMemberRec {
  return {
    id:         m.id ?? `m${i + 1}`,
    workflowId: String(m.workflowId ?? ''),
    agentId:    typeof m.agentId === 'string' && m.agentId ? m.agentId : undefined,
    label:      m.label,
    order:      typeof m.order === 'number' ? m.order : i,
    role:       m.role,
    handoffTo:  Array.isArray(m.handoffTo) ? m.handoffTo : undefined,
    subPattern: m.subPattern,
    children:   Array.isArray(m.children) ? m.children.map((c, j) => mapMemberInput(c, j)) : undefined,
    width:      typeof m.width === 'number' ? m.width : undefined,
    outputScope: normalizeScopeFields(m.outputScope),
    outputFrom: Array.isArray(m.outputFrom) ? m.outputFrom.filter((x): x is string => typeof x === 'string') : undefined,
    managerInstructions: typeof m.managerInstructions === 'string' ? m.managerInstructions : undefined,
    managerModel:        typeof m.managerModel === 'string' ? m.managerModel : undefined,
  }
}

export function createOrchestration(userDir: string, input: CreateOrchestrationInput): Orchestration {
  if (!input.title.trim()) throw new Error('title required')
  const id  = generateId('orch')
  const now = nowIso()
  const members: OrchestrationMemberRec[] = validateMembers(userDir, (input.members ?? []).map(mapMemberInput))
  const o: Orchestration = {
    version:     1,
    id,
    title:       input.title.trim(),
    description: input.description?.trim() || undefined,
    pattern:     normalizePattern(input.pattern),
    prompt:      typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : undefined,
    inputs:      Array.isArray(input.inputs) ? input.inputs : undefined,
    members,
    config:      input.config,
    author:      input.author,
    createdAt:   now,
    updatedAt:   now,
  }
  writeOrchestration(userDir, o)
  return o
}

export function updateOrchestration(userDir: string, id: string, patch: OrchestrationPatch): Orchestration {
  const o = readOrchestration(userDir, id)
  if (!o) throw new Error(`orchestration not found: ${id}`)
  if (typeof patch.title === 'string' && patch.title.trim()) o.title = patch.title.trim()
  if (typeof patch.description === 'string') o.description = patch.description.trim() || undefined
  if (typeof patch.prompt === 'string')      o.prompt = patch.prompt.trim() || undefined
  if (patch.pattern)                         o.pattern = normalizePattern(patch.pattern)
  if (Array.isArray(patch.inputs))           o.inputs = patch.inputs
  if (patch.config)                          o.config = { ...o.config, ...patch.config }
  if (Array.isArray(patch.members)) {
    // 호출자(View·빌더)는 항상 전체 멤버 배열을 보낸다 → 전체 정규화로 교체.
    // (children 중첩까지 정확히 반영. 부분 merge 보다 단순·정확.)
    o.members = validateMembers(userDir, patch.members.map(mapMemberInput))
  }
  o.updatedAt = nowIso()
  writeOrchestration(userDir, o)
  return o
}

export function restoreOrchestration(userDir: string, o: Orchestration): Orchestration {
  if (!o || typeof o.id !== 'string' || o.version !== 1) {
    throw new Error('restoreOrchestration: invalid orchestration shape')
  }
  const snapshot: Orchestration = { ...o, members: validateMembers(userDir, o.members ?? []), updatedAt: nowIso() }
  writeOrchestration(userDir, snapshot)
  return snapshot
}

// Builder chat — orchestrations/<id>/orch-builder-chat.jsonl (workflow mirror).
function orchBuilderChatPath(userDir: string, id: string): string {
  return path.join(orchestrationDir(userDir, id), 'orch-builder-chat.jsonl')
}
export function readOrchBuilderChat(userDir: string, id: string): BuilderChatLine[] {
  const p = orchBuilderChatPath(userDir, id)
  if (!fs.existsSync(p)) return []
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const out: BuilderChatLine[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t) as BuilderChatLine
        if (obj && typeof obj.id === 'string' && typeof obj.content === 'string') out.push(obj)
      } catch { /* skip corrupt line */ }
    }
    return out
  } catch { return [] }
}
export function appendOrchBuilderChat(userDir: string, id: string, line: BuilderChatLine): void {
  fs.mkdirSync(orchestrationDir(userDir, id), { recursive: true })
  fs.appendFileSync(orchBuilderChatPath(userDir, id), JSON.stringify(line) + '\n', 'utf8')
}
export function clearOrchBuilderChat(userDir: string, id: string): void {
  try { fs.unlinkSync(orchBuilderChatPath(userDir, id)) } catch { /* already gone */ }
}

// Last run — orchestrations/<id>/last-run.json (opaque renderer blob).
function orchRunPath(userDir: string, id: string): string {
  return path.join(orchestrationDir(userDir, id), 'last-run.json')
}
export function readOrchLastRun(userDir: string, id: string): unknown {
  const p = orchRunPath(userDir, id)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
export function writeOrchLastRun(userDir: string, id: string, state: unknown): void {
  fs.mkdirSync(orchestrationDir(userDir, id), { recursive: true })
  fs.writeFileSync(orchRunPath(userDir, id), JSON.stringify(state, null, 2), 'utf8')
}
export function clearOrchLastRun(userDir: string, id: string): void {
  try { fs.unlinkSync(orchRunPath(userDir, id)) } catch { /* already gone */ }
}

// ── AI Agents (Specialist 단위) ─────────────────────────────────────────────
// AI Agent = criteria + 옵션(workflow leaf 또는 pipeline 서브체인) 목록. 입력에 가장 적합한
// 옵션 1개를 골라 실행하는 Specialist. 저장: users/<uid>/aiagents/<id>/aiagent.json (orch* 미러).
export type AiAgentType = 'research' | 'execution'
export interface AiAgentRec {
  version:     1
  id:          string
  title:       string
  description?: string
  criteria?:   string                       // 선택 기준 (criteria 노드 텍스트)
  agentType:   AiAgentType                   // 옵션 워크플로 타입에서 도출
  options:     OrchestrationMemberRec[]      // relay 멤버 = 옵션들 (각 옵션 = workflow leaf 또는 pipeline 서브체인)
  author:      PlanAuthor
  createdAt:   string
  updatedAt:   string
}
export type CreateAiAgentInput = {
  title:       string
  description?: string
  criteria?:   string
  options?:    Array<Partial<OrchestrationMemberRec> & { workflowId?: string }>
  author:      PlanAuthor
}
export type AiAgentPatch = {
  title?:      string
  description?: string
  criteria?:   string
  options?:    Array<Partial<OrchestrationMemberRec> & { id?: string; workflowId?: string }>
}

function aiAgentsRoot(userDir: string): string { return path.join(userDir, 'aiagents') }
function aiAgentDir(userDir: string, id: string): string { return path.join(aiAgentsRoot(userDir), safeSegment(id)) }
function aiAgentJsonPath(userDir: string, id: string): string { return path.join(aiAgentDir(userDir, id), 'aiagent.json') }

// 옵션들의 "마지막" 워크플로 id 수집(pipeline 서브체인이면 마지막 자식). agentType 도출용.
function terminalWorkflowIds(members: OrchestrationMemberRec[]): string[] {
  const out: string[] = []
  for (const m of members) {
    if (Array.isArray(m.children) && m.children.length) {
      const ordered = [...m.children].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const last = ordered[ordered.length - 1]
      if (last) out.push(...terminalWorkflowIds([last]))
    } else if (m.workflowId) out.push(m.workflowId)
  }
  return out
}
// 옵션 중 하나라도 research 워크플로로 끝나면 agent 는 research(출력 생성 가능), 아니면 execution.
function deriveAgentType(userDir: string, options: OrchestrationMemberRec[]): AiAgentType {
  for (const id of terminalWorkflowIds(options)) {
    const wf = readWorkflow(userDir, id)
    if (wf && (wf.type ?? deriveWorkflowType(wf.nodes)) === 'research') return 'research'
  }
  return 'execution'
}

export function readAiAgent(userDir: string, id: string): AiAgentRec | null {
  try {
    const raw = fs.readFileSync(aiAgentJsonPath(userDir, id), 'utf8')
    const a = JSON.parse(raw) as AiAgentRec
    if (a?.version !== 1 || typeof a?.id !== 'string') return null
    if (!Array.isArray(a.options)) a.options = []
    return a
  } catch { return null }
}
function writeAiAgent(userDir: string, a: AiAgentRec): void {
  fs.mkdirSync(aiAgentDir(userDir, a.id), { recursive: true })
  fs.writeFileSync(aiAgentJsonPath(userDir, a.id), JSON.stringify(a, null, 2), 'utf8')
}
export function listAiAgents(userDir: string): AiAgentRec[] {
  const root = aiAgentsRoot(userDir)
  const SEED_VERSION = 4   // v4: 옵션 2개↑ agent 2종만(단일옵션 제거)
  const seedMarker = path.join(root, `.seeded-v${SEED_VERSION}`)
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
    if (!fs.existsSync(seedMarker)) {
      seedSampleAiAgents(userDir)
      try { fs.writeFileSync(seedMarker, '', 'utf8') } catch { /* ignore */ }
    }
  } catch { /* ignore seed failure */ }
  let entries: string[] = []
  try { entries = fs.readdirSync(root) } catch { return [] }
  const out: AiAgentRec[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue
    const a = readAiAgent(userDir, id)
    if (a) { a.options = validateMembers(userDir, a.options); a.agentType = deriveAgentType(userDir, a.options); out.push(a) }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}
export function createAiAgent(userDir: string, input: CreateAiAgentInput): AiAgentRec {
  if (!input.title.trim()) throw new Error('title required')
  const id = generateId('agent')
  const now = nowIso()
  const options = validateMembers(userDir, (input.options ?? []).map(mapMemberInput))
  const a: AiAgentRec = {
    version: 1, id,
    title:       input.title.trim(),
    description: input.description?.trim() || undefined,
    criteria:    typeof input.criteria === 'string' && input.criteria.trim() ? input.criteria.trim() : undefined,
    agentType:   deriveAgentType(userDir, options),
    options,
    author:      input.author,
    createdAt:   now, updatedAt: now,
  }
  writeAiAgent(userDir, a)
  return a
}
export function updateAiAgent(userDir: string, id: string, patch: AiAgentPatch): AiAgentRec {
  const a = readAiAgent(userDir, id)
  if (!a) throw new Error(`ai agent not found: ${id}`)
  if (typeof patch.title === 'string' && patch.title.trim()) a.title = patch.title.trim()
  if (typeof patch.description === 'string') a.description = patch.description.trim() || undefined
  if (typeof patch.criteria === 'string')    a.criteria = patch.criteria.trim() || undefined
  if (Array.isArray(patch.options))          a.options = validateMembers(userDir, patch.options.map(mapMemberInput))
  a.agentType = deriveAgentType(userDir, a.options)
  a.updatedAt = nowIso()
  writeAiAgent(userDir, a)
  return a
}
export function deleteAiAgent(userDir: string, id: string): void {
  fs.rmSync(aiAgentDir(userDir, id), { recursive: true, force: true })
}
export function restoreAiAgent(userDir: string, a: AiAgentRec): AiAgentRec {
  if (!a || typeof a.id !== 'string' || a.version !== 1) throw new Error('restoreAiAgent: invalid shape')
  const snap: AiAgentRec = { ...a, options: validateMembers(userDir, a.options ?? []), updatedAt: nowIso() }
  snap.agentType = deriveAgentType(userDir, snap.options)
  writeAiAgent(userDir, snap)
  return snap
}
// Last run — aiagents/<id>/last-run.json
function aiAgentRunPath(userDir: string, id: string): string { return path.join(aiAgentDir(userDir, id), 'last-run.json') }
export function readAiAgentLastRun(userDir: string, id: string): unknown {
  const p = aiAgentRunPath(userDir, id); if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
export function writeAiAgentLastRun(userDir: string, id: string, state: unknown): void {
  fs.mkdirSync(aiAgentDir(userDir, id), { recursive: true })
  fs.writeFileSync(aiAgentRunPath(userDir, id), JSON.stringify(state, null, 2), 'utf8')
}
export function clearAiAgentLastRun(userDir: string, id: string): void {
  try { fs.unlinkSync(aiAgentRunPath(userDir, id)) } catch { /* already gone */ }
}
// 샘플 AI Agent — Team 예시용 research 2개 + execution 1개. 옵션 워크플로 먼저 보장.
function seedSampleAiAgents(userDir: string): void {
  seedSampleWorkflowsForTeam(userDir)
  // 이전 Influencer 샘플 + 옵션 1개짜리(의미 없는) SEO agent 제거.
  for (const id of [...OBSOLETE_SAMPLE_AGENT_IDS, ...OBSOLETE_SINGLE_OPTION_AGENT_IDS]) { try { deleteAiAgent(userDir, id) } catch { /* already gone */ } }

  const now = nowIso()
  const author: PlanAuthor = { uid: 'system', email: 'sample' }
  const mk = (id: string, title: string, description: string, criteria: string, optionWfIds: string[]) => {
    if (readAiAgent(userDir, id)) return
    const options: OrchestrationMemberRec[] = optionWfIds.map((wid, i) => ({ id: `o${i + 1}`, workflowId: wid, order: i }))
    writeAiAgent(userDir, { version: 1, id, title, description, criteria, agentType: deriveAgentType(userDir, options), options, author, createdAt: now, updatedAt: now })
  }
  // 옵션 2개 이상(진짜 Specialist)만 AI Agent 로 둔다. 단일옵션은 워크플로로 직접 배치.
  // Research Specialist — 클라이언트 업종에 맞는 감사 1개만 선택.
  mk('agent_seo_site_audit', 'Site Audit Specialist', 'Runs the audit that fits the client’s site type.',
    'Pick the audit matching the client: an online store → e-commerce audit; a local/physical business → local SEO audit; otherwise → the general technical crawl.',
    ['wf_seo_technical_audit', 'wf_seo_local_audit', 'wf_seo_ecommerce_audit'])
  // Execution Specialist — 작업 종류에 맞는 실행 워크플로 1개 선택.
  mk('agent_seo_implementer', 'On-Page Implementer', 'Executes the prioritized fixes.',
    'If the task is page-level meta/schema edits → on-page fixes; if it is sitemap/indexing → sitemap generate & submit.',
    ['wf_seo_onpage_fixes', 'wf_seo_sitemap_submit'])
}

function renderRunHeader(plan: Plan): string {
  const lines: string[] = []
  lines.push(`# Run — ${plan.title}`)
  lines.push('')
  lines.push(`_Plan \`${plan.id}\`_`)
  lines.push(`_Author: ${plan.author.email ?? plan.author.uid}_`)
  lines.push(`_Started: ${plan.updatedAt}_`)
  lines.push('')
  lines.push('## Context')
  lines.push('')
  lines.push(`> ${plan.sourcePrompt.replace(/\n/g, '\n> ')}`)
  lines.push('')
  return lines.join('\n')
}
