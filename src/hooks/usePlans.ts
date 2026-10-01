import { useCallback, useRef } from 'react'
import type { Plan, PlanStep, PlanStepStatus, L7Subtask, L8Step } from '../components/PlanCard'
import type { ChatMessage } from './useOpenClaw'
import { l6TaskId, l7TaskId, logbookMark, beginL8Window, endL8Window } from '../lib/logbook'

// ── Planner prompt contract ───────────────────────────────────────
// The planner round-trip asks the LLM to reply with one fenced JSON
// block tagged `twixy:plan`. We don't tolerate extra code blocks or
// chatter — the extractor takes the first matching fence and ignores
// everything else so that accidental prose above/below is harmless.

type PlannedStep = {
  title:      string
  detail?:    string
  acceptance?:string
  skillHint?: string | null
}
type PlannedPayload = {
  title: string
  steps: PlannedStep[]
  skillsReferenced?: string[]
  priorRunRefs?:     string[]
}

// Skill descriptor returned by window.twixy.listSkills().
type SkillBrief = {
  name:        string
  displayName: string
  description: string
  tags?:       string[]
  stages?:     string[]
}

// ── Primitives we need from useOpenClaw ───────────────────────────
// Typed narrowly so swapping the backing hook is easy.
export interface PlanRunnerDeps {
  addUserMessage:    (text: string) => string
  insertPlanMessage: (planId: string) => string
  patchMessage:      (id: string, patch: { content?: string; planId?: string }) => void
  removeMessage:     (id: string) => void
  sendAndAwaitFinal: (text: string, opts?: { timeoutMs?: number }) =>
    Promise<{ text: string; messageId: string | null; toolCalls: Array<{ name: string; detail?: string }> }>
  abortMessage:      () => Promise<void>
  addSystemMessage:  (text: string, extra?: Partial<ChatMessage>) => void
  getSessionKey:     () => string | null
  setRejectNewRuns:  (v: boolean) => void
  killActiveSubagents: () => Promise<void>
  // Gateway-level requester freeze. Unconditionally drops all pending/future
  // subagent announces targeting the main session until cleared — unaffected
  // by subagent lifecycle races that defeat setRejectNewRuns + kill alone.
  setRequesterAnnounceFrozen: (frozen: boolean) => Promise<void>
  // Per-step compaction primitives — see runFromCurrent for usage.
  resetSession:        () => Promise<void>
  getSessionMessages:  (limit?: number) => Promise<unknown[]>
}

// ── JSON extraction ───────────────────────────────────────────────
// Pulls the first fenced `twixy:plan` JSON block out of a raw LLM
// reply. Falls back to the first generic fenced block and finally a
// bare JSON object regex so a slightly-off-spec reply doesn't abort
// the whole planning flow.
function extractPlanJson(text: string): PlannedPayload | null {
  const tagged = text.match(/```(?:twixy:plan|json\s+twixy:plan|plan)\s*\n([\s\S]+?)\n```/i)
  const generic = !tagged ? text.match(/```(?:json)?\s*\n([\s\S]+?)\n```/i) : null
  const body = tagged?.[1] ?? generic?.[1] ?? text.match(/\{[\s\S]+\}/)?.[0]
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as PlannedPayload
    if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.steps)) return null
    return parsed
  } catch {
    return null
  }
}

// Run the planner output through the same Flash 2.5 language-correction pass
// that chat assistant messages use. Planners frequently hallucinate CJK
// characters mid-token ("biography 형식의散文에서曲명 mentions만抽出한다"), and
// once those land in plan.json they feed straight back into every step
// prompt. We correct before saving so execution runs on clean text.
//
// The corrector preserves code blocks / markdown structure, so a fenced
// twixy:plan block should survive intact — but we defensively re-parse the
// corrected output and fall back to the raw text if JSON extraction fails.
async function correctPlannerText(raw: string, userSample: string): Promise<string> {
  try {
    const w = window as unknown as {
      twixy?: { correctLanguage?: (payload: { text: string; userSample: string })
        => Promise<{ ok: boolean; text?: string }> }
    }
    const fn = w.twixy?.correctLanguage
    if (!fn) return raw
    const res = await fn({ text: raw, userSample })
    if (!res?.ok || !res.text) return raw
    if (!extractPlanJson(res.text)) return raw
    return res.text
  } catch {
    return raw
  }
}

function parseStepMarker(text: string): { kind: 'done' | 'failed'; summary: string } | null {
  const doneMatch   = text.match(/\[step-done\]\s*([\s\S]*?)(?:\n|$)/i)
  if (doneMatch) return { kind: 'done', summary: doneMatch[1].trim() }
  const failedMatch = text.match(/\[step-failed\]\s*([\s\S]*?)(?:\n|$)/i)
  if (failedMatch) return { kind: 'failed', summary: failedMatch[1].trim() }
  return null
}

// Asks the LLM to verify whether the acceptance criterion was actually met,
// and if not, provides a detailed failure explanation in one round-trip.
// The response message is always removed from the chat UI (internal check).
// Returns { failed: true, reason: "<detail>" } or { failed: false, reason: "" }.
async function verifyAndExplain(
  deps: PlanRunnerDeps,
  acceptance: string,
  finalText: string,
  stepContext?: { title: string; detail?: string; markerSummary?: string },
): Promise<{ failed: boolean; reason: string }> {
  try {
    const contextBlock = stepContext
      ? `Step goal: ${stepContext.title}\nStep instructions: ${stepContext.detail ?? '(none)'}\n\n`
      : ''
    const markerBlock = stepContext?.markerSummary
      ? `Agent's own [step-done] summary: ${stepContext.markerSummary}\n\n`
      : ''
    const res = await deps.sendAndAwaitFinal(
      `${contextBlock}${markerBlock}Success criterion that must be met: ${acceptance}\n\nWhat actually happened this turn (full final reply, may contain intermediate retries):\n${finalText.slice(-2000)}\n\nJudge ONLY the final state at the end of this turn. Important rules:\n- A tool that failed earlier in this same turn but was retried successfully on the same target is NOT a failure. Intermediate retries, transient tool errors, or self-corrections within one turn do not count against success.\n- A sub-agent that was merely dispatched without its result being confirmed IS a failure.\n- "(no output)", silent sub-agent termination, or missing artifacts after the marker IS a failure.\n- A clear [step-done] marker plus concrete evidence (file created, data returned, result confirmed) IS a success even if earlier attempts in the same turn errored.\n\nIdentify the specific root cause ONLY if the final state is genuinely incomplete — missing tools, missing files, environment limitations, incorrect assumptions, or unconfirmed sub-agent dispatch.\n\nReply in EXACTLY this format:\nRESULT: YES\n\nOR:\n\nRESULT: NO\nREASON: <2-3 sentences with the specific root cause and what needs to be fixed to make this work>`,
      { timeoutMs: 60_000 },
    )
    if (res.messageId) deps.removeMessage(res.messageId)
    const text = res.text.trim()
    // Scan for the LAST `RESULT: YES|NO` line in the response. Anchoring at
    // start (`^RESULT:`) was too strict — some models prefix the verdict with
    // a hallucinated plan block, thinking output, or restated context, which
    // forced a spurious "failed" verdict and stopped the plan even though the
    // step actually succeeded.
    const matches = [...text.matchAll(/RESULT:\s*(YES|NO)\b/gi)]
    const verdict = matches[matches.length - 1]?.[1]?.toUpperCase()
    if (verdict === 'YES') return { failed: false, reason: '' }
    const reasonMatch = text.match(/REASON:\s*([\s\S]+)/i)
    const reason = reasonMatch?.[1]?.trim() ?? `acceptance criterion not met: ${acceptance}`
    return { failed: true, reason }
  } catch {
    return { failed: false, reason: '' }
  }
}

// Load the most recent completed plans so the planner can reuse them
// as "work templates". Pulls their run.md bodies inline so the LLM
// sees the whole precedent, not just titles.
async function loadPriorRunSamples(limit = 3): Promise<{ ids: string[]; bundle: string }> {
  try {
    const plans: Plan[] = await window.twixy.planList({ status: 'done' }) ?? []
    const picks = plans.slice(0, limit)
    const ids:  string[] = []
    const body: string[] = []
    for (const p of picks) {
      const run = await window.twixy.planReadRun(p.id)
      if (!run) continue
      ids.push(p.id)
      body.push(`### Prior plan: ${p.title} (id=${p.id})\n\n${run.trim()}`)
    }
    return { ids, bundle: body.join('\n\n---\n\n') }
  } catch {
    return { ids: [], bundle: '' }
  }
}

async function loadInstalledSkills(): Promise<{ skills: SkillBrief[]; bundle: string }> {
  try {
    const raw = (await window.twixy.listSkills()) as SkillBrief[] | undefined
    const skills = (raw ?? []).slice(0, 40)
    const bundle = skills.map(s => {
      const tags = (s.tags ?? []).join(', ') || '(no tags)'
      const stages = (s.stages ?? []).join('→') || '(no stages)'
      return `- \`${s.name}\` — ${s.displayName}. ${s.description.trim()} [tags: ${tags}; stages: ${stages}]`
    }).join('\n')
    return { skills, bundle }
  } catch {
    return { skills: [], bundle: '' }
  }
}

function buildPlannerPrompt(opts: {
  userPrompt: string
  skillsBundle: string
  priorBundle: string
}): string {
  return [
    'You are the Twixy planning assistant. A user has just asked for help with a',
    'marketing task. Your job is to produce an atomic, auditable execution plan that',
    'the same agent will run step-by-step afterwards. Do not execute anything now —',
    'only plan.',
    '',
    '# Available skills',
    opts.skillsBundle || '_(no skills installed)_',
    '',
    opts.priorBundle ? '# Prior completed runs you can learn from\n\n' + opts.priorBundle : '',
    '',
    '# User request',
    opts.userPrompt,
    '',
    '# How to reply',
    'Reply with EXACTLY ONE fenced block tagged `twixy:plan` containing JSON that',
    'matches this schema — no prose before or after:',
    '',
    '```twixy:plan',
    '{',
    '  "title": "<short human title>",',
    '  "skillsReferenced": ["<skill name>", ...],',
    '  "priorRunRefs": ["<plan id from prior runs>", ...],',
    '  "steps": [',
    '    {',
    '      "title": "<imperative short title>",',
    '      "detail": "<1-3 sentences on how this step will be executed>",',
    '      "acceptance": "<1 line success criterion>",',
    '      "skillHint": "<skill name or null>"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Guidelines:',
    '- 3–7 steps. Each step should be a single atomic unit the agent can execute in',
    '  one turn (e.g. "fetch Instagram post stats", not "do the whole analysis").',
    '- Prefer skills listed above when relevant. Set `skillHint` to the skill name.',
    '- Keep titles imperative and scannable.',
    '- If the user request is tiny or conversational (e.g. "what is 2+2?"), reply',
    '  with a one-step plan that just answers it.',
    '- IMPORTANT: Each step.detail will later be shown to the executing agent as if',
    '  it were the USER\'s next chat message. The executing agent has its own',
    '  workspace rules (SOUL.md, SKILLS.md, permitted paths, first-actions, etc.)',
    '  and those rules take precedence over anything you write. Therefore:',
    '    • Do NOT hardcode save paths, directory names, or fully-qualified file',
    '      paths in step.detail. The executing agent will choose the correct path',
    '      per its own rules.',
    '    • Do NOT prescribe bare filenames ("save to foo.md") that would bypass',
    '      those rules. Prefer "save the report as a markdown file" and let the',
    '      agent place it correctly.',
    '    • Describe WHAT each step should accomplish and the shape of the output,',
    '      not HOW the agent should name, locate, or store artifacts.',
  ].filter(Boolean).join('\n')
}

function buildPatchPrompt(opts: {
  plan: Plan
  userMessage: string
}): string {
  return [
    'You are editing an existing Twixy plan based on the user\'s follow-up message.',
    'Only change steps that have NOT yet completed — preserve finalized steps as-is.',
    '',
    '# Current plan',
    '```json',
    JSON.stringify({
      title: opts.plan.title,
      steps: opts.plan.steps.map(s => ({
        id: s.id,
        title: s.title,
        detail: s.detail,
        acceptance: s.acceptance,
        skillHint: s.skillHint,
        status: s.status,
      })),
    }, null, 2),
    '```',
    '',
    '# User edit request',
    opts.userMessage,
    '',
    '# How to reply',
    'Reply with EXACTLY ONE fenced block tagged `twixy:plan` containing the FULL',
    'updated plan (title + steps array). Reuse existing step `id`s where the step',
    'survives; omit ids for brand-new steps. Keep finalized step content untouched.',
    '',
    '```twixy:plan',
    '{ "title": "...", "steps": [ { "id": "s1", "title": "...", "detail": "...",',
    '  "acceptance": "...", "skillHint": null } ] }',
    '```',
  ].join('\n')
}

// ── Per-step compaction ─────────────────────────────────────────────
// After each successful step, the runner asks the LLM to compact the step's
// gateway transcript into a markdown summary. The summary is inlined into
// the next step's prompt (replacing the raw turn-by-turn dialog), and the
// session itself is reset on the gateway so the LLM input stays bounded.
//
// The compactor LLM may also flag specific toolCallIds for raw retention —
// those raw tool_use / tool_result blocks are persisted and re-injected
// verbatim into the prompts of any later step that needs them, sidestepping
// the "summary lost the data we needed" failure mode.

// Convention parsed by parseRawRetentions:
//   ## Raw retentions
//   - callId: tc_xxx — <reason>
//   - callId: tc_yyy — <reason>
function buildCompactPrompt(opts: {
  plan:           Plan
  step:           PlanStep
  stepIdx:        number          // 0-based index of the just-finished step
  remainingSteps: PlanStep[]
  messages:       unknown[]       // gateway transcript slice for this step
}): string {
  const N = opts.stepIdx + 1
  const skill = opts.step.skillHint ?? 'no-skill'
  const remainingBlock = opts.remainingSteps.length > 0
    ? opts.remainingSteps.map((s, i) => {
        const idx = N + i + 1
        const sk  = s.skillHint ?? 'no-skill'
        const desc = s.detail ? `${s.title} — ${s.detail}` : s.title
        return `- step ${idx} (${sk}): ${desc}`
      }).join('\n')
    : '_(none — this is the last pending step)_'

  let messagesJson: string
  try {
    messagesJson = JSON.stringify(opts.messages, null, 2)
  } catch {
    messagesJson = '"(messages were not serialisable)"'
  }

  return [
    `You are compacting step ${N} of a multi-step plan to save context tokens.`,
    '',
    `=== STEP ${N} (${skill}) DIALOG ===`,
    '',
    '```json',
    messagesJson,
    '```',
    '',
    '=== REMAINING STEPS ===',
    '',
    remainingBlock,
    '',
    'Produce a compact summary that:',
    '1. Records what was accomplished and any failures/constraints',
    '2. EXPLICITLY preserves any data items downstream steps will likely need:',
    '   - URLs, file paths, IDs, numeric values, entity names',
    '3. Lists artifacts written to disk (full paths)',
    '4. For each remaining step, note what info from this step it might need',
    '5. If a tool output is too important to summarize, list its toolCallId so',
    '   the orchestrator can keep it raw',
    '',
    'Output format: markdown with sections.',
    '',
    'For raw retentions (#5), use this EXACT section heading and bullet format',
    'so the orchestrator can parse them. Each callId must match a `toolCall`',
    "block's `id` (or a `toolResult` message's `toolCallId`) from the dialog above:",
    '',
    '## Raw retentions',
    '- callId: <toolCallId> — <one-line reason>',
    '',
    'Omit the "## Raw retentions" section entirely if every tool output can be',
    'safely summarised. Do NOT include this section as a placeholder.',
  ].join('\n')
}

// Pull toolCallIds out of the compactor's "## Raw retentions" section.
// Tolerates extra prose, indentation, and surrounding sections.
function parseRawRetentions(text: string): string[] {
  // Match "## Raw retentions" up to the next heading or end of text.
  const sectionMatch = text.match(/##\s*Raw\s*retentions\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i)
  if (!sectionMatch) return []
  const body = sectionMatch[1] ?? ''
  const ids: string[] = []
  for (const m of body.matchAll(/(?:^|\n)\s*[-*]\s*callId\s*:\s*([A-Za-z0-9_\-]+)/gi)) {
    if (m[1]) ids.push(m[1])
  }
  return [...new Set(ids)]
}

// A single executed tool call, pulled verbatim from the gateway transcript.
// This is the replay-grade unit: toolName + the exact input arguments + the
// callId that anchors back to raw.jsonl.
type ToolUse = { toolCallId: string; toolName: string; input: unknown }

// Walk a gateway message slice and return every tool call, in order. These are
// the canonical L8 Steps — what actually ran — independent of what the compactor
// LLM chose to describe.
//
// The OpenClaw gateway serialises tool calls as `{ type:'toolCall', id, name,
// arguments }`. The Anthropic-style `{ type:'tool_use', id, name, input }` is
// accepted too so the helper survives a gateway schema change.
function extractToolUses(messages: unknown[]): ToolUse[] {
  const out: ToolUse[] = []
  for (const msgRaw of messages) {
    const msg = msgRaw as { content?: unknown }
    if (!Array.isArray(msg.content)) continue
    for (const b of msg.content) {
      const block = b as { type?: string; id?: string; name?: string; input?: unknown; arguments?: unknown }
      const isCall = block?.type === 'toolCall' || block?.type === 'tool_use'
      if (isCall && typeof block.id === 'string') {
        out.push({
          toolCallId: block.id,
          toolName:   typeof block.name === 'string' ? block.name : 'unknown',
          input:      block.arguments !== undefined ? block.arguments : block.input,
        })
      }
    }
  }
  return out
}

// Derive a human-readable label for a tool call from its most salient argument,
// used when the compactor didn't supply one.
function deriveStepLabel(tu: ToolUse): string {
  const inp = tu.input as Record<string, unknown> | undefined
  const pick = (k: string) => (inp && typeof inp[k] === 'string' ? inp[k] as string : undefined)
  const arg = pick('url') ?? pick('targetUrl') ?? pick('path') ?? pick('file_path')
            ?? pick('relPath') ?? pick('command') ?? pick('query') ?? pick('prompt')
            ?? pick('action')
  return arg ? `${tu.toolName}: ${arg.slice(0, 80)}` : tu.toolName
}

// Read a browser tool call's `action` field ("open" | "navigate" | "act" |
// "snapshot" | "evaluate" | "wait" | …), or null for non-browser tools.
function browserAction(tu: ToolUse): string | null {
  if (tu.toolName !== 'browser') return null
  const a = (tu.input as { action?: unknown } | undefined)?.action
  return typeof a === 'string' ? a : null
}

// Build the L7 Sub-task / L8 Step hierarchy DETERMINISTICALLY from the executed
// tool calls — no LLM involved. This is deliberate: the record's purpose is a
// machine-consumable, reproducible replay log, so grouping must not depend on
// compactor-LLM quality (minimax routinely drops the grouping instruction).
//
// Grouping rule (single pass, order-preserving):
//   - A browser `open`/`navigate` starts a new sub-task (new page = new logical
//     unit). Subsequent browser actions on that page (act/snapshot/evaluate/
//     wait) fold into the same sub-task.
//   - Every non-browser tool (read, write, tool_write_*, sessions_spawn, …) is
//     its own sub-task.
// Each L8 Step keeps the real toolName + full input args + callId (raw.jsonl
// anchor), so the whole tree is replay-grade.
function buildWorkBreakdown(toolUses: ToolUse[]): L7Subtask[] {
  // Phase 1 — partition the ordered calls into groups.
  const groups: ToolUse[][] = []
  let cur: ToolUse[] | null = null
  let curIsBrowser = false
  for (const tu of toolUses) {
    const action     = browserAction(tu)
    const isBrowser  = action !== null
    const foldsIntoCurrent =
      isBrowser && action !== 'open' && action !== 'navigate' && cur !== null && curIsBrowser
    if (foldsIntoCurrent) {
      cur!.push(tu)
    } else {
      cur = [tu]
      curIsBrowser = isBrowser
      groups.push(cur)
    }
  }

  // Phase 2 — map each group to an L7 Sub-task; the first call names it.
  return groups.map((g, i) => ({
    id:     `s7_${i + 1}`,
    title:  deriveStepLabel(g[0]),
    status: 'done' as const,
    steps:  g.map((tu, j) => ({
      id:         `s8_${i + 1}_${j + 1}`,
      title:      deriveStepLabel(tu),
      toolName:   tu.toolName,
      toolCallId: tu.toolCallId,
      input:      tu.input,
    })),
  }))
}

// Walk a raw gateway message slice and return only the messages that contain
// tool call / tool result data matching the requested toolCallIds. Each
// returned message is shallow-cloned so re-serialisation is stable.
//
// Two schemas are matched (mirroring extractToolUses above):
//   - OpenClaw gateway: calls are `{ type:'toolCall', id }` content blocks;
//     results are WHOLE messages — `{ role:'toolResult', toolCallId, toolName,
//     content }` with the linking id at message level, not inside a block.
//   - Anthropic-style: `{ type:'tool_use', id }` / `{ type:'tool_result',
//     tool_use_id }` content blocks, kept so the helper survives a gateway
//     schema change.
function extractRawByToolCallIds(
  messages: unknown[],
  toolCallIds: string[],
): Array<{ role: string; content: unknown[]; toolCallId?: string; toolName?: string }> {
  if (!toolCallIds.length) return []
  const idSet = new Set(toolCallIds)
  const out: Array<{ role: string; content: unknown[]; toolCallId?: string; toolName?: string }> = []
  for (const msgRaw of messages) {
    const msg = msgRaw as { role?: string; content?: unknown; toolCallId?: unknown; toolName?: unknown }
    const role = typeof msg.role === 'string' ? msg.role : ''
    if (!role) continue
    // OpenClaw result message — keep the whole message (its content IS the
    // tool output) plus the message-level id/name so the re-injected JSON
    // stays anchored to the call.
    if (role === 'toolResult' && typeof msg.toolCallId === 'string' && idSet.has(msg.toolCallId)) {
      out.push({
        role,
        toolCallId: msg.toolCallId,
        ...(typeof msg.toolName === 'string' ? { toolName: msg.toolName } : {}),
        content: Array.isArray(msg.content) ? msg.content : [],
      })
      continue
    }
    if (!Array.isArray(msg.content)) continue
    const matchingBlocks = (msg.content as unknown[]).filter(b => {
      const block = b as { type?: string; id?: string; tool_use_id?: string; toolCallId?: string }
      if ((block?.type === 'toolCall' || block?.type === 'tool_use')
                                        && typeof block.id          === 'string' && idSet.has(block.id))          return true
      // Some gateway frames inline the result as a block (e.g. session.message
      // events parsed in electron/main.ts) — accept that form too.
      if (block?.type === 'toolResult'  && typeof block.toolCallId  === 'string' && idSet.has(block.toolCallId))  return true
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && idSet.has(block.tool_use_id)) return true
      return false
    })
    if (matchingBlocks.length > 0) {
      out.push({ role, content: matchingBlocks })
    }
  }
  return out
}

// Build the prepended-context block for a step's prompt: prior step
// compactSummaries + retained raw tool blocks. Async because retained raw
// blocks are loaded from disk via the planStepReadRaw IPC. Returns '' when
// there's nothing to prepend (e.g. step 1 of a plan).
async function buildPriorContextBlock(
  planId: string,
  plan: Plan,
  currentStepIdx: number,
): Promise<string> {
  const completedBefore = plan.steps
    .slice(0, currentStepIdx)
    .filter(s => s.status === 'done' && (s.compactSummary?.trim().length ?? 0) > 0)

  if (completedBefore.length === 0) return ''

  const summaryBlocks: string[] = ['=== Prior step summaries (compacted) ===', '']
  for (const s of completedBefore) {
    const idx = plan.steps.findIndex(p => p.id === s.id) + 1
    summaryBlocks.push(`--- Step ${idx}: ${s.title} ---`)
    summaryBlocks.push((s.compactSummary ?? '').trim())
    summaryBlocks.push('')
  }

  const rawBlocks: string[] = []
  for (const s of completedBefore) {
    const ids = s.rawToolCallIds ?? []
    if (ids.length === 0) continue
    let raw: unknown[] = []
    try { raw = await window.twixy.planStepReadRaw(planId, s.id) } catch { /* missing raw is non-fatal */ }
    if (raw.length === 0) continue
    const matched = extractRawByToolCallIds(raw, ids)
    if (matched.length === 0) continue
    const idx = plan.steps.findIndex(p => p.id === s.id) + 1
    rawBlocks.push(`--- Retained raw from step ${idx} ("${s.title}") ---`)
    for (const m of matched) {
      rawBlocks.push('```json')
      try { rawBlocks.push(JSON.stringify(m, null, 2)) } catch { rawBlocks.push('"(unserializable)"') }
      rawBlocks.push('```')
    }
    rawBlocks.push('')
  }

  const out: string[] = [...summaryBlocks]
  if (rawBlocks.length > 0) {
    out.push('=== Retained raw tool outputs from prior steps ===', '', ...rawBlocks)
  }
  out.push('=== End of prior context — your actual instruction follows ===', '', '')
  return out.join('\n')
}

// Render the standard-procedure guidance block for an Execution Plan step.
// Returns '' for chat-origin plans so the normal prompt is left untouched.
// The point of an Execution Plan is "fewer variables": the SOP already says
// what to do (step.procedure = L7/L8), and the upper-level (L2-L5) context
// (plan.executionContext) says which values to use — so the agent should follow
// the procedure tightly rather than re-plan from scratch.
function renderProcedureGuidance(plan: Plan, step: PlanStep): string {
  if (plan.origin !== 'execution-plan') return ''
  const lines: string[] = []
  lines.push('=== STANDARD PROCEDURE (this is an automated run of a standard operating procedure) ===')
  if (plan.executionContext) {
    lines.push('')
    lines.push('Upper-level context (apply these values where the procedure has variable parameters):')
    lines.push(plan.executionContext.trim())
  }
  if (step.procedure && step.procedure.length > 0) {
    lines.push('')
    lines.push('Follow this procedure for THIS step, in order:')
    for (const st of step.procedure) {
      lines.push(`- ${st.title}`)
      // st.steps may be missing on plans saved before procedure validation.
      for (const ls of st.steps ?? []) {
        const tool = ls.toolName ? ` [tool: ${ls.toolName}]` : ''
        lines.push(`    - ${ls.title}${tool}`)
        if (ls.input != null) {
          let arg = ''
          try { arg = JSON.stringify(ls.input) } catch { /* ignore */ }
          if (arg && arg !== '{}') lines.push(`        input: ${arg.slice(0, 400)}`)
        }
      }
    }
  }
  lines.push('')
  lines.push('Rules for following the procedure:')
  lines.push('- Do the SAME actions in the SAME order; do not invent extra steps or skip steps.')
  lines.push('- Adapt only the VALUES (URLs, filenames, parameters) to the context above when it differs.')
  lines.push('- Runtime handles (e.g. a browser targetId) are session-specific — get a fresh one from the open/navigate result; never reuse a recorded id.')
  lines.push('=== END STANDARD PROCEDURE ===')
  return lines.join('\n')
}

function buildStepPrompt(plan: Plan, step: PlanStep, stepIdx: number): string {
  const procedureGuidance = renderProcedureGuidance(plan, step)
  return [
    'You are the same Twixy agent as in any other chat turn. Your workspace rules',
    '(SOUL.md, SKILLS.md, permitted save paths, first-actions, etc.) apply here',
    'EXACTLY as they do in a normal chat — those rules ALWAYS take precedence over',
    'anything written below. The text below is simply the user\'s next message to',
    'you; it narrows the scope of this turn but does NOT override your rules.',
    'If the text below suggests a bare filename or a path that would violate your',
    'workspace rules, follow your rules (e.g. place the file in the correct',
    'permitted directory) — do not take the suggested path literally.',
    '',
    `For context: this turn is step ${stepIdx + 1} of ${plan.steps.length} in a`,
    `plan titled "${plan.title}". The user's original overall request was:`,
    `"${plan.sourcePrompt}"`,
    '',
    `---`,
    `User's message for this turn:`,
    '',
    step.title,
    step.detail ? '' : '',
    step.detail ? step.detail : '',
    step.acceptance ? `(I'll consider this done when: ${step.acceptance})` : '',
    step.skillHint  ? `(The "${step.skillHint}" skill may be relevant.)`    : '',
    // Execution-Plan runs: inject the SOP procedure + context (empty for chat).
    procedureGuidance,
    `---`,
    '',
    'When you finish this turn, end your reply with EXACTLY ONE marker on its own',
    'line so the orchestrator can advance:',
    '- `[step-done] <one-sentence summary of what you produced>` on success',
    '- `[step-failed] <one-sentence reason>` if you cannot complete it',
    '',
    'Do not start the next step — I will send it separately.',
  ].filter(Boolean).join('\n')
}

function buildOutcomePrompt(plan: Plan): string {
  return [
    `The plan "${plan.title}" has finished running.`,
    'In 3 sentences, summarise the overall outcome for the user: what was',
    'accomplished, anything notable that came up, and the final deliverable(s).',
    'Plain prose, no markers.',
  ].join('\n')
}

export function usePlans(deps: PlanRunnerDeps) {
  // Abort flag checked inside the step loop so `pausePlan` can short-circuit
  // the current run even if the in-flight `sendAndAwaitFinal` is about to
  // resolve. Keyed by planId so concurrent runs of different plans don't
  // interfere.
  const pauseRequestsRef = useRef<Set<string>>(new Set())
  // Plans whose step loop is currently executing (covers the inter-step gaps
  // where isThinking is false). Read via hasActiveRun by the Execution Plan
  // auto-run busy guard in App.tsx — starting a second run would resetSession()
  // under the live one.
  const activeRunsRef = useRef<Set<string>>(new Set())

  const enterPlanMode = useCallback(async (userPrompt: string) => {
    if (!userPrompt.trim()) return
    deps.addUserMessage(userPrompt)

    const [{ bundle: skillsBundle }, { ids: priorIds, bundle: priorBundle }] = await Promise.all([
      loadInstalledSkills(),
      loadPriorRunSamples(3),
    ])

    const plannerPrompt = buildPlannerPrompt({ userPrompt, skillsBundle, priorBundle })

    let raw = ''
    let plannerMsgId: string | null = null
    try {
      const res = await deps.sendAndAwaitFinal(plannerPrompt, { timeoutMs: 3 * 60 * 1000 })
      raw = res.text
      plannerMsgId = res.messageId
    } catch (err) {
      deps.addSystemMessage(`⚠️ Planner failed: ${String(err)}`)
      return
    }

    raw = await correctPlannerText(raw, userPrompt)
    const parsed = extractPlanJson(raw)
    if (!parsed) {
      deps.addSystemMessage('⚠️ Planner returned an unparseable reply — see the message above for the raw response.')
      return
    }

    try {
      const plan = await window.twixy.planCreate({
        title:            parsed.title || userPrompt.slice(0, 60),
        sourcePrompt:     userPrompt,
        priorRunRefs:     Array.isArray(parsed.priorRunRefs)
                            ? parsed.priorRunRefs.filter(id => priorIds.includes(id))
                            : priorIds,
        skillsReferenced: Array.isArray(parsed.skillsReferenced) ? parsed.skillsReferenced : [],
        steps: parsed.steps.map(s => ({
          title:      String(s.title ?? '').trim(),
          detail:     s.detail,
          acceptance: s.acceptance,
          skillHint:  s.skillHint ?? null,
        })),
      }) as Plan | null
      if (!plan) throw new Error('planCreate returned null')
      // Replace the raw planner JSON reply with an interactive PlanCard in
      // place so the chat doesn't end up with both bubbles side by side.
      if (plannerMsgId) {
        deps.patchMessage(plannerMsgId, { content: '', planId: plan.id })
      } else {
        deps.insertPlanMessage(plan.id)
      }
    } catch (err) {
      deps.addSystemMessage(`⚠️ Plan creation failed: ${String(err)}`)
    }
  }, [deps])

  const updatePlanViaChat = useCallback(async (planId: string, userMessage: string) => {
    const current = await window.twixy.planGet(planId) as Plan | null
    if (!current) { deps.addSystemMessage('Plan not found.'); return }
    deps.addUserMessage(userMessage)

    let raw: string
    let plannerMsgId: string | null = null
    try {
      const res = await deps.sendAndAwaitFinal(
        buildPatchPrompt({ plan: current, userMessage }),
        { timeoutMs: 3 * 60 * 1000 },
      )
      raw = res.text
      plannerMsgId = res.messageId
    } catch (err) {
      deps.addSystemMessage(`⚠️ Plan edit failed: ${String(err)}`)
      return
    }
    raw = await correctPlannerText(raw, userMessage)
    const parsed = extractPlanJson(raw)
    if (!parsed) {
      deps.addSystemMessage(`⚠️ Planner returned an unparseable edit. Raw:\n\n${raw}`)
      return
    }

    try {
      await window.twixy.planUpdate(planId, {
        title: parsed.title,
        steps: parsed.steps.map(s => ({
          id:         (s as PlannedStep & { id?: string }).id,
          title:      s.title,
          detail:     s.detail,
          acceptance: s.acceptance,
          skillHint:  s.skillHint ?? null,
        })),
      })
      // The existing PlanCard bubble auto-refreshes via onPlanChanged, so the
      // raw planner JSON reply is redundant. Drop it so the chat doesn't show
      // the same plan twice (raw JSON + card).
      if (plannerMsgId) deps.removeMessage(plannerMsgId)
    } catch (err) {
      deps.addSystemMessage(`⚠️ planUpdate failed: ${String(err)}`)
    }
  }, [deps])

  // ── Step runner ────────────────────────────────────────────────
  // Iterates pending steps sequentially. On each iteration we re-read
  // the plan from disk so late user edits + pause flags are picked up.
  // A step is considered finished when the LLM emits either marker; if
  // the marker is missing we re-prompt once to ask for it explicitly.
  const runFromCurrent = useCallback(async (planId: string) => {
    // Reset the reject-new-runs guard so any previous failure doesn't block this run.
    deps.setRejectNewRuns(false)
    let stoppedOnFailure = false
    let plan = await window.twixy.planGet(planId) as Plan | null
    if (!plan) { deps.addSystemMessage('Plan not found.'); return }
    // Record whichever gateway session key is currently active on the
    // plan. If we don't have one yet, the first sendAndAwaitFinal call
    // will trigger ensureSession; we'll just stamp an empty string here
    // and let run.md carry the key implicitly via the session log files.
    const sessionKey = deps.getSessionKey() ?? plan.sessionKey ?? ''

    try {
      plan = await window.twixy.planBeginRun(planId, sessionKey) as Plan
    } catch (err) {
      deps.addSystemMessage(`⚠️ Could not start run: ${String(err)}`)
      return
    }

    // Auto-open the always-on-top sidetab so the user can monitor progress
    // while working in other apps. Optional chaining covers older builds
    // where the IPC may not exist (or if we ever add a user preference to
    // disable auto-open).
    try { await window.twixy.openSidetab?.() } catch { /* cosmetic */ }

    // Reset the gateway session at the very start of the run so step 1
    // begins on a fresh transcript. Anything before this point (the
    // planner's JSON exchange, prior chat) is dropped on the gateway side —
    // each step's input is bounded going forward. Prior step summaries +
    // retained raw blocks (for resumed runs) are re-injected via
    // buildPriorContextBlock.
    try { await deps.resetSession() } catch { /* non-fatal */ }

    while (true) {
      plan = await window.twixy.planGet(planId) as Plan | null
      if (!plan) return

      // Pause requests from disk (pauseRequested=true) OR from our in-memory
      // flag (set by pausePlan before the main-side flag has flushed).
      if (plan.pauseRequested || pauseRequestsRef.current.has(planId)) {
        pauseRequestsRef.current.delete(planId)
        await window.twixy.planMarkPaused(planId)
        return
      }

      const idx = plan.currentStepIdx
      const nextPendingIdx = plan.steps.findIndex((s, i) =>
        i >= idx && (s.status === 'pending' || s.status === 'interrupted' || s.status === 'failed'),
      )
      if (nextPendingIdx < 0) break

      const step = plan.steps[nextPendingIdx]
      try { await window.twixy.planStepStart(planId, step.id) } catch { /* ignore */ }

      // ── logbook 작업 마커: L6 = 이 PlanStep, L7 = 그 실행(exec) ──
      // L6 start 직후 L7 start. 종료는 아래 try/finally 의 finally 에서
      // L7 end → L6 end 순으로 — 성공·실패·일시정지·예외 어느 경로든 end 가
      // 발사되어 logbook 스택에 잔존 마커가 남지 않는다. 전 과정
      // fire-and-forget 이라 logbook 미연결 시에도 plan 실행에 영향 없음.
      const l6Id = l6TaskId(planId, step.id)
      const l7Id = l7TaskId(planId, step.id)
      logbookMark({ event: 'start', task_id: l6Id, level: 'L6', actor: 'AI', title: step.title, plan_id: planId })
      logbookMark({ event: 'start', task_id: l7Id, level: 'L7', actor: 'AI', title: `${step.title} (exec)`, parent_id: l6Id, plan_id: planId })
      // L8 창 오픈: useOpenClaw 의 session.tool 핸들러가 이 구간에 도착하는
      // 도구 호출만 L8 마커로 발사한다 (src/lib/logbook.ts 참고).
      beginL8Window(l7Id, planId)

      let finalText = ''
      let toolCalls: Array<{ name: string; detail?: string }> = []
      let interrupted = false
      // Hoisted out of the try/finally below — read by the pause/failure
      // handling and the compaction block after the markers are closed.
      let marker: ReturnType<typeof parseStepMarker> = null
      let verifyFailReason = ''
      let shouldPause = false
      let status: PlanStepStatus = 'interrupted'
      try {
        try {
          // Prepend prior step compactSummaries + any retained raw blocks so
          // the agent has just enough context to execute this step against a
          // freshly-reset gateway session. First step's prefix is empty.
          const priorContext = await buildPriorContextBlock(planId, plan, nextPendingIdx)
          const stepPrompt   = priorContext + buildStepPrompt(plan, step, nextPendingIdx)
          // Clear rejectNewRuns just before sending. The previous step's
          // boundary set it to true (L770) to block autonomous announces in
          // the inter-step gap. Leaving it true into our own intentional send
          // races: between compaction's chat.final and this awaiter being
          // pushed, length=0 + rejectNewRuns=true causes the lifecycle
          // interceptor to fire `sessions.abort` (fire-and-forget) which can
          // race with our sessions.send and abort our step's LLM run
          // (observed: step 3 aborted ~4s after send, content:[],
          // stopReason:"aborted").
          deps.setRejectNewRuns(false)
          const res = await deps.sendAndAwaitFinal(stepPrompt)
          finalText = res.text
          toolCalls = res.toolCalls
        } catch (err) {
          // sendAndAwaitFinal was aborted (most likely by pausePlan) — treat as
          // interrupted and let the outer pause-check handle the status.
          interrupted = true
          finalText = String(err)
        }

        // Kill any subagents still in flight the instant main LLM yields.
        // Main LLM ending its turn after sessions_spawn leaves the subagent
        // running in the background; its completion fires `subagent_announce`
        // which autonomously wakes the main session LLM — even after a plan
        // failure. Killing HERE (not after verifyAcceptance) gives the kill
        // RPC seconds of headroom to propagate through the gateway before
        // runSubagentAnnounceFlow reaches its delivery gate; the late kill at
        // step-end races the announce and loses.
        // markSubagentRunTerminated sets suppressAnnounceReason="killed" on
        // both in-flight and already-ended entries (via the openclaw patch),
        // so the announce flow bails at its next suppress check.
        try { await deps.killActiveSubagents() } catch { /* best-effort */ }

        // Pause may have landed during the step — re-check before finalising.
        const latest = await window.twixy.planGet(planId) as Plan | null
        shouldPause = !!(latest?.pauseRequested || pauseRequestsRef.current.has(planId) || interrupted)

        marker = parseStepMarker(finalText)
        if (!marker && !shouldPause) {
          // One retry to coax the marker out — some models drop it on the first try.
          try {
            const retry = await deps.sendAndAwaitFinal(
              'Reply with ONLY one line: `[step-done] <summary>` if you completed the step, or `[step-failed] <reason>` if not.',
              { timeoutMs: 60_000 },
            )
            if (retry.messageId) deps.removeMessage(retry.messageId)
            marker = parseStepMarker(retry.text)
            if (retry.text) finalText = finalText + '\n\n' + retry.text
          } catch { /* fall through — will record as interrupted */ }
        }

        // Runtime output validation: if the agent claimed done but the output
        // contains clear signals of a non-result (silent subagent failure or
        // dispatch-without-result), downgrade to failed before writing to disk.
        if (marker?.kind === 'done' && !shouldPause) {
          const noOutput = /\(no output\)/i.test(finalText)
          if (noOutput) {
            // Lock immediately — no more LLM calls should be triggered by late announces.
            deps.setRejectNewRuns(true)
            marker = { kind: 'failed', summary: 'subagent or tool returned no output' }
            finalText = finalText + '\n\n[step-failed] subagent or tool returned no output'
          } else if (step.acceptance) {
            // Lock before the async verifyAndExplain call so that any announce that
            // arrives while verify is awaiting cannot slip through (turnAwaiters=1
            // during verify, but we want it blocked the moment verify finishes too).
            deps.setRejectNewRuns(true)
            const { failed, reason } = await verifyAndExplain(
              deps, step.acceptance, finalText,
              { title: step.title, detail: step.detail, markerSummary: marker?.summary },
            )
            if (failed) {
              verifyFailReason = reason
              marker = { kind: 'failed', summary: reason }
              finalText = finalText + `\n\n[step-failed] ${reason}`
            } else {
              // Step passed — unlock so the next step's LLM call is allowed.
              deps.setRejectNewRuns(false)
            }
          }
        }

        status = shouldPause
          ? 'interrupted'
          : marker?.kind === 'done'   ? 'done'
          : marker?.kind === 'failed' ? 'failed'
          : 'interrupted'

        try {
          await window.twixy.planStepEnd(planId, step.id, {
            status,
            summary:   marker?.summary,
            finalText,
            toolCalls,
          })
        } catch { /* IO errors shouldn't stop the run */ }
      } finally {
        // logbook 마커 닫기 — L8 창 → L7 end → L6 end 순. 잔존 L8 start 는
        // logbook 서버가 L7 end 수신 시 스택에서 함께 pop 한다.
        endL8Window()
        logbookMark({ event: 'end', task_id: l7Id, level: 'L7', actor: 'AI' })
        logbookMark({ event: 'end', task_id: l6Id, level: 'L6', actor: 'AI' })
      }

      // Step boundary: main LLM can end its turn immediately after
      // sessions_spawn (posting [step-done] while the subagent is still
      // running). When the subagent later completes or errors, the gateway
      // fires `announce:v1:agent:main:subagent:…` on the main session and
      // autonomously restarts the main LLM — which then runs untracked tool
      // calls (e.g. reading a file the subagent was supposed to produce).
      // Kill any still-pending subagents here so the gateway suppresses
      // their announce. Safe even on success because a subagent that had
      // already contributed its output will have finished before the main
      // LLM's final turn landed, so killing here is a no-op for those.
      // Also briefly hold rejectNewRuns=true while kill dispatches so any
      // announce that races the delete RPC still gets intercepted.
      deps.setRejectNewRuns(true)
      try { await deps.killActiveSubagents() } catch { /* best-effort */ }

      if (shouldPause) {
        pauseRequestsRef.current.delete(planId)
        await window.twixy.planMarkPaused(planId)
        return
      }
      if (status === 'failed' || status === 'interrupted') {
        // killActiveSubagents + setRejectNewRuns(true) already fired above
        // at the step boundary — both success and failure need the same
        // defence against late `subagent_announce` autonomous wake-ups.
        // Additionally freeze requester announces at the gateway: even if a
        // subagent already ended (endedAt set) the openclaw kill path no-ops
        // and the announce proceeds. The freeze gate in runSubagentAnnounceFlow
        // drops the announce unconditionally, regardless of lifecycle state.
        // Cleared by the next user-initiated sendMessage.
        try { await deps.setRequesterAnnounceFrozen(true) } catch { /* best-effort */ }
        const reason = verifyFailReason || marker?.summary || 'unknown error'
        stoppedOnFailure = true
        deps.addSystemMessage(
          `⚠️ **Plan stopped** — Step ${nextPendingIdx + 1} "${step.title}" failed\n\n**Reason:** ${reason}\n\nWould you like me to try again?`,
          {
            actions: [
              { label: 'Try again', primary: true, actionId: 'plan-resume', planId },
              { label: 'No thanks',                actionId: 'plan-dismiss', planId },
            ],
          },
        )
        break
      }

      // ── Per-step compaction + session reset (success path) ──────────
      // Capture the full gateway transcript for this step BEFORE sending
      // any further prompts so the slice is pure step content. Then ask
      // the LLM to compact it (so the next step's prompt can carry a
      // markdown summary in place of the raw turns) plus decompose it into
      // the L7/L8 work breakdown, persist the result + raw transcript to
      // disk, and reset the gateway session so the next step starts on a
      // fresh, bounded transcript.
      //
      // Runs on EVERY successful step — including the last — because the
      // work breakdown (L6 Task → L7 Sub-task → L8 Step) must be recorded
      // for every L6 Task. On the last step the session reset is skipped
      // (no downstream step to feed) but the compaction round-trip still
      // produces the breakdown.
      const planAfterEnd = await window.twixy.planGet(planId) as Plan | null
      const remainingPending = (planAfterEnd?.steps ?? []).filter((s, i) =>
        i > nextPendingIdx && (s.status === 'pending' || s.status === 'interrupted' || s.status === 'failed'),
      )
      {
        let rawSlice: unknown[] = []
        try { rawSlice = await deps.getSessionMessages() } catch { /* ignore */ }

        let compactText = ''
        let compactMsgId: string | null = null
        try {
          const cres = await deps.sendAndAwaitFinal(
            buildCompactPrompt({
              plan:           planAfterEnd ?? plan,
              step,
              stepIdx:        nextPendingIdx,
              remainingSteps: remainingPending,
              messages:       rawSlice,
            }),
            { timeoutMs: 90_000 },
          )
          compactText  = cres.text
          compactMsgId = cres.messageId
        } catch (err) {
          console.warn('[plan/compact] round-trip failed', err)
        }
        if (compactMsgId) deps.removeMessage(compactMsgId)

        const rawIds = compactText ? parseRawRetentions(compactText) : []
        // L7/L8 breakdown is derived deterministically from the actual tool
        // calls in the transcript — independent of the compactor LLM, so it's
        // produced even if compaction failed/timed out.
        const toolUses = extractToolUses(rawSlice)
        const subtasks = buildWorkBreakdown(toolUses)
        try {
          await window.twixy.planStepCompact(planId, step.id, {
            compactSummary: compactText.trim() || '_(compaction failed — raw transcript retained)_',
            rawToolCallIds: rawIds,
            rawMessages:    rawSlice,
            subtasks,
          })
        } catch (err) {
          console.warn('[plan/compact] save failed', err)
        }

        // Reset the gateway transcript so the next step's sendAndAwaitFinal
        // begins on a fresh sessionFile. The compact summary + retained raw
        // blocks will be re-injected into the next step's prompt prefix.
        // Skipped on the last step — there's no next step to start fresh.
        if (remainingPending.length > 0) {
          try { await deps.resetSession() } catch { /* non-fatal */ }
        }
      }
    }

    // Step failure: pause the plan instead of finalizing as failed so that
    // run.md doesn't get a premature "## Outcome / status: failed" block.
    // On resume, beginRun appends "_Resumed at..._" and execution continues
    // from the failed step. planFinalize only runs when all steps complete.
    if (stoppedOnFailure) {
      try { await window.twixy.planMarkPaused(planId) } catch { /* ignore */ }
      return
    }

    // Outcome summary — only runs when all steps completed successfully.
    const finalPlan = await window.twixy.planGet(planId) as Plan | null
    const anyFailed = finalPlan?.steps.some(
      s => s.status === 'failed' || s.status === 'interrupted',
    ) ?? false

    let outcomeText = ''
    if (!anyFailed) {
      try {
        if (finalPlan) {
          const res = await deps.sendAndAwaitFinal(
            buildOutcomePrompt(finalPlan),
            { timeoutMs: 60_000 },
          )
          outcomeText = res.text
        }
      } catch { /* ignore */ }
    }
    // Note: setRejectNewRuns(true) is already set inside the loop at the first
    // failure/interrupted break, so no PLAN_ABORTED injection is needed here.
    // Injecting an extra sendAndAwaitFinal would create a turnAwaiters=1 window
    // during which late announces could slip through unblocked.

    try { await window.twixy.planFinalize(planId, outcomeText) } catch { /* ignore */ }
  }, [deps])

  const buildPlan = useCallback(async (planId: string) => {
    pauseRequestsRef.current.delete(planId)
    activeRunsRef.current.add(planId)
    try { await runFromCurrent(planId) } finally { activeRunsRef.current.delete(planId) }
  }, [runFromCurrent])

  const resumePlan = useCallback(async (planId: string) => {
    pauseRequestsRef.current.delete(planId)
    activeRunsRef.current.add(planId)
    try { await runFromCurrent(planId) } finally { activeRunsRef.current.delete(planId) }
  }, [runFromCurrent])

  // True while any plan's step loop is in flight. Stable identity (reads a
  // ref) so event-subscription effects can call it without re-subscribing.
  const hasActiveRun = useCallback(() => activeRunsRef.current.size > 0, [])

  const pausePlan = useCallback(async (planId: string) => {
    pauseRequestsRef.current.add(planId)
    try { await window.twixy.planRequestPause(planId) } catch { /* ignore */ }
    try { await deps.abortMessage() } catch { /* ignore */ }
  }, [deps])

  const deletePlan = useCallback(async (planId: string) => {
    try { await window.twixy.planDelete(planId) } catch { /* ignore */ }
  }, [])

  const revealRun = useCallback(async (planId: string) => {
    try {
      const workspace = await window.twixy.getWorkspace()
      if (!workspace) return
      const runPath = `${workspace}/plans/${planId}/run.md`
      await window.twixy.revealInFinder(runPath)
    } catch { /* ignore */ }
  }, [])

  // UI import of an Execution Plan (JSON text). Creates a DRAFT plan for human
  // review and surfaces its PlanCard — it does NOT auto-run (the human presses
  // Start). Auto-run is reserved for the API path. Returns the planId or null.
  const importExecutionPlan = useCallback(async (jsonText: string): Promise<string | null> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      deps.addSystemMessage('⚠️ Execution Plan import failed: invalid JSON.')
      return null
    }
    try {
      const plan = await window.twixy.executionPlanImport(parsed) as Plan
      // The PlanCard renders the SOP-style report for execution-plan origin,
      // so no separate markdown message is needed — just surface the card.
      deps.insertPlanMessage(plan.id)
      return plan.id
    } catch (err) {
      deps.addSystemMessage(`⚠️ Execution Plan import failed: ${String(err)}`)
      return null
    }
  }, [deps])

  return {
    enterPlanMode,
    updatePlanViaChat,
    buildPlan,
    pausePlan,
    resumePlan,
    deletePlan,
    revealRun,
    importExecutionPlan,
    hasActiveRun,
  }
}
