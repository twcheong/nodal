// ── Execution Plan API (loopback HTTP) ────────────────────────────────
// Inbound entry point for an EXTERNAL program (Clovex AI) to hand Twixy an
// "Execution Plan" — a standard procedure (L6-L8 skeleton) + upper-level
// (L2-L5) context — and have it run with no human in the loop.
//
// This is SEPARATE from the human chat → planner → PlanCard flow. Plans created
// here are tagged origin='execution-plan'. The API path AUTO-RUNS (the caller
// expects automation); the UI-import path (electron/main.ts IPC) does NOT —
// there a human reviews the draft and presses Start.
//
// Security model mirrors agent-tool-bridge.ts:
//   - Bound strictly to 127.0.0.1 (loopback only). Same-machine Clovex only.
//   - Per-launch random Bearer token. Port chosen dynamically on bind.
//   Both are logged so the local Clovex process can read them.
//
// Execution is renderer-side (runFromCurrent uses the WebSocket session), so
// this module does NOT execute anything itself — it creates the plan (via the
// injected onSubmit callback, which lives in main.ts) and that callback signals
// the renderer to start the run.

import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import type { CreatePlanInput, L7Subtask } from './planning'

// What an Execution Plan maps to internally: a CreatePlanInput minus the
// server-owned author/projectId, always tagged as execution-plan.
export type ParsedExecutionPlan =
  Omit<CreatePlanInput, 'author' | 'projectId'> & { origin: 'execution-plan' }

// Validate + normalise a step's SOP `procedure` (L7/L8 skeleton). The renderer
// indexes straight into `st.steps` / `ls.title`, so a malformed procedure must
// be rejected here (HTTP 400 / visible import error) rather than cast through.
// Missing ids/status are filled with the same conventions buildWorkBreakdown
// uses ('s7_N' / 's8_N_M', status 'done').
function parseProcedure(
  raw: unknown,
  stepNo: number,
): { ok: true; value: L7Subtask[] } | { ok: false; error: string } {
  const out: L7Subtask[] = []
  const list = raw as unknown[]
  for (let i = 0; i < list.length; i++) {
    const where = `step ${stepNo} procedure[${i}]`
    const l7 = list[i] as Record<string, unknown> | null
    if (!l7 || typeof l7 !== 'object' || Array.isArray(l7)) {
      return { ok: false, error: `${where} must be an object` }
    }
    const title = typeof l7.title === 'string' ? l7.title.trim() : ''
    if (!title) return { ok: false, error: `${where} requires a title (string)` }
    if (!Array.isArray(l7.steps)) return { ok: false, error: `${where} requires steps (array)` }

    const steps: L7Subtask['steps'] = []
    for (let j = 0; j < l7.steps.length; j++) {
      const l8 = l7.steps[j] as Record<string, unknown> | null
      if (!l8 || typeof l8 !== 'object' || Array.isArray(l8)) {
        return { ok: false, error: `${where}.steps[${j}] must be an object` }
      }
      const l8Title = typeof l8.title === 'string' ? l8.title.trim() : ''
      if (!l8Title) return { ok: false, error: `${where}.steps[${j}] requires a title (string)` }
      if (l8.toolName !== undefined && typeof l8.toolName !== 'string') {
        return { ok: false, error: `${where}.steps[${j}].toolName must be a string` }
      }
      steps.push({
        id:    typeof l8.id === 'string' && l8.id ? l8.id : `s8_${i + 1}_${j + 1}`,
        title: l8Title,
        ...(typeof l8.toolName === 'string' ? { toolName: l8.toolName } : {}),
        ...(l8.input !== undefined ? { input: l8.input } : {}),
      })
    }
    out.push({
      id:     typeof l7.id === 'string' && l7.id ? l7.id : `s7_${i + 1}`,
      title,
      status: l7.status === 'failed' || l7.status === 'partial' ? l7.status : 'done',
      steps,
    })
  }
  return { ok: true, value: out }
}

// ── Parse / validate the v1 Execution Plan contract ───────────────────
export function parseExecutionPlan(
  raw: unknown,
): { ok: true; value: ParsedExecutionPlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'execution plan must be an object' }
  const o = raw as Record<string, unknown>

  const title = typeof o.title === 'string' ? o.title.trim() : ''
  if (!title) return { ok: false, error: 'title required' }

  if (!Array.isArray(o.steps) || o.steps.length === 0) {
    return { ok: false, error: 'at least one step required' }
  }

  const steps: ParsedExecutionPlan['steps'] = []
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i] as Record<string, unknown> | null
    if (!s || typeof s !== 'object') return { ok: false, error: `step ${i + 1} must be an object` }
    const stTitle = typeof s.title === 'string' ? s.title.trim() : ''
    if (!stTitle) return { ok: false, error: `step ${i + 1} requires a title` }
    // procedure is optional, but when present each L7/L8 item must be
    // well-formed — the renderer and the step prompt walk it directly.
    let procedure: L7Subtask[] | undefined
    if (s.procedure !== undefined) {
      if (!Array.isArray(s.procedure)) {
        return { ok: false, error: `step ${i + 1} procedure must be an array` }
      }
      const p = parseProcedure(s.procedure, i + 1)
      if (!p.ok) return p
      procedure = p.value
    }
    steps.push({
      title:      stTitle,
      detail:     typeof s.detail === 'string' ? s.detail : undefined,
      acceptance: typeof s.acceptance === 'string' ? s.acceptance : undefined,
      skillHint:  typeof s.skillHint === 'string' ? s.skillHint : null,
      ...(procedure ? { procedure } : {}),
    })
  }

  // context may be a free-text string or a structured object; normalise to text.
  let executionContext: string | undefined
  if (typeof o.context === 'string' && o.context.trim()) {
    executionContext = o.context.trim()
  } else if (o.context && typeof o.context === 'object') {
    try { executionContext = JSON.stringify(o.context, null, 2) } catch { /* ignore */ }
  }

  const sourcePrompt = executionContext
    ? `[Execution Plan] ${title}\n\n${executionContext}`
    : `[Execution Plan] ${title}`

  const sopRef = typeof o.sopRef === 'string' && o.sopRef.trim() ? o.sopRef.trim() : undefined

  return {
    ok: true,
    value: {
      title,
      sourcePrompt,
      steps,
      origin: 'execution-plan',
      ...(executionContext ? { executionContext } : {}),
      ...(sopRef ? { sopRef } : {}),
    },
  }
}

export interface ExecutionPlanApiHandle {
  port:  number
  token: string
  close: () => Promise<void>
}

export interface ExecutionPlanApiDeps {
  // Create the plan + kick off the auto-run. Returns the new plan id (or error).
  // Implemented in main.ts (createPlan + webContents.send('execution-plan-run')).
  onSubmit: (plan: ParsedExecutionPlan) => { ok: boolean; planId?: string; error?: string }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export async function startExecutionPlanApi(deps: ExecutionPlanApiDeps): Promise<ExecutionPlanApiHandle> {
  const token = randomBytes(32).toString('hex')

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const auth = req.headers['authorization']
        if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), token)) {
          res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return
        }
        if (req.method !== 'POST' || (req.url ?? '') !== '/execution-plan') {
          res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'unknown route' })); return
        }

        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const rawBody = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        if (rawBody) {
          try { body = JSON.parse(rawBody) }
          catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid json body' })); return }
        }

        const parsed = parseExecutionPlan(body)
        if (!parsed.ok) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: parsed.error }))
          return
        }

        const result = deps.onSubmit(parsed.value)
        res.statusCode = result.ok ? 200 : 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('execution-plan-api: failed to bind')

  return {
    port:  addr.port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
