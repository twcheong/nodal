import React, { useEffect, useState, useRef } from 'react'
import { marked } from 'marked'
import { safeHtml } from '../lib/safeHtml'
import { friendlyTool } from '../lib/friendlyTool'
import { useOverlaySync } from '../hooks/useOverlaySync'
import type { PlanStepStatus, PlanStatus } from './PlanCard'

// Render assistant/user message content as GitHub-flavored markdown with
// line breaks preserved. We keep sanitation minimal — only the agent and
// the user produce these strings, and both come from Twixy's own plumbing.
function renderMd(text: string): string {
  return marked(text, { breaks: true, gfm: true }) as string
}

// The overlay is a separate BrowserWindow loaded from sidetab.html. It is
// a read-mostly mirror of mainWindow state, with two write paths (Stop and
// Send) that forward through IPC so the main renderer's hooks stay the
// single source of truth for chat/plan session ownership.

type OverlayPlan = {
  id:             string
  title:          string
  status:         PlanStatus
  currentStepIdx: number
  steps: {
    id:         string
    title:      string
    detail:     string
    acceptance: string
    summary?:   string
    status:     PlanStepStatus
  }[]
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
    default:        return 'var(--text-secondary)'
  }
}

// Compact version of ChatPanel's ThinkingDots — same visual language (3
// bouncing dots) so the overlay feels like the main chat.
function ThinkingDots() {
  return (
    <div style={{
      display: 'inline-flex', gap: 4, alignItems: 'center',
      padding: '8px 12px', borderRadius: 10,
      background: 'rgba(20, 32, 27,0.05)',
      border: '1px solid rgba(20, 32, 27,0.08)',
    }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--accent)', display: 'inline-block',
          animation: `sidetab-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
    </div>
  )
}

// Groups a tool name into the same coarse bucket used by the main chat's
// action summary (e.g. "7 browser actions · 2 file operations"). Kept in
// sync with toolGroupKey()/toolGroupLabel() in ChatPanel.tsx.
function toolBucket(tool: string): string {
  if (['read','write','edit','glob','grep'].includes(tool)) return 'files'
  if (['web_fetch','web_search','tavily_search','tavily_extract'].includes(tool)) return 'web'
  if (tool.startsWith('browser')) return 'browser'
  if (['sessions_spawn','sessions_yield'].includes(tool)) return 'subagent'
  if (['exec','bash'].includes(tool)) return 'terminal'
  return tool
}
function bucketLabel(key: string, n: number): string {
  if (key === 'files')    return `${n} file operation${n === 1 ? '' : 's'}`
  if (key === 'web')      return `${n} web request${n === 1 ? '' : 's'}`
  if (key === 'browser')  return `${n} browser action${n === 1 ? '' : 's'}`
  if (key === 'subagent') return 'Sub-agent task'
  if (key === 'terminal') return `${n} command${n === 1 ? '' : 's'}`
  return `${n} ${key}`
}

// Compact, overlay-sized rendering of a batch of tool calls. Same
// collapse/expand semantics as ChatPanel's ToolActionGroup, stripped
// down for the dark floating panel palette.
interface BatchItem { detail: string; tool: string }
function OverlayActionGroup({ items, defaultOpen }: { items: BatchItem[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => { setOpen(defaultOpen) }, [defaultOpen])

  const buckets = new Map<string, BatchItem[]>()
  for (const it of items) {
    const k = toolBucket(it.tool)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(it)
  }
  const parts = [...buckets.entries()].map(([k, g]) => bucketLabel(k, g.length))
  const headerLabel = items.length === 1
    ? (items[0].detail || friendlyTool(items[0].tool, false))
    : `${items.length} actions — ${parts.join(' · ')}`

  return (
    <div style={{ alignSelf: 'stretch', marginLeft: 2 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: '1px solid rgba(20, 32, 27,0.08)',
          background: 'rgba(20, 32, 27,0.03)',
          borderRadius: 8, padding: '4px 9px',
          fontSize: 10.5, color: 'var(--text-secondary)', cursor: 'pointer',
          width: '100%', textAlign: 'left',
        }}
      >
        <span style={{ opacity: 0.5, fontSize: 9 }}>◎</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {headerLabel}
        </span>
        <span style={{ opacity: 0.5, fontSize: 9 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 3, padding: '5px 9px',
          border: '1px solid rgba(20, 32, 27,0.08)', borderTop: 'none',
          borderBottomLeftRadius: 8, borderBottomRightRadius: 8,
          background: 'rgba(20, 32, 27,0.025)',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {[...buckets.entries()].map(([key, g]) => (
            <div key={key}>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '2px 0' }}>
                {bucketLabel(key, g.length)}
              </div>
              {g.map((it, i) => (
                <div key={i} style={{
                  fontSize: 10, color: 'var(--text-secondary)',
                  padding: '1px 0 1px 10px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {it.detail}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ActionBatch { anchorMsgId: string | null; items: BatchItem[] }

export function SidetabOverlay() {
  const snapshot = useOverlaySync()
  const [plan, setPlan] = useState<OverlayPlan | null>(null)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  const [opacity, setOpacity] = useState(1)
  const listRef    = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // Bottom-sticky autoscroll: while stickToBottomRef is true, we pin the
  // list to the bottom on *every* content-size change (new message, new
  // action batch, markdown reflow, action-group expand/collapse, async
  // image load — anything). A tight 24px threshold on the user's own
  // scroll flips it off only when they actively scroll up.
  const stickToBottomRef = useRef(true)
  // Drives the "Ns · N tool calls" inline elapsed display. Ticks once
  // per second while a tool batch is in flight; stops when it clears.
  const [, setNowTick] = useState(0)

  // Mirror of ChatPanel's per-turn action batching. Each batch is anchored
  // to the id of the last assistant message at the moment the first tool
  // fired; the overlay renders the batch inline under that message so the
  // user can scroll back through past turns' actions.
  const [actionBatches, setActionBatches] = useState<ActionBatch[]>([])
  const currentBatchIdxRef = useRef<number | null>(null)
  const seenActionsRef     = useRef(new Set<string>())
  const isNewThinkingRef   = useRef(false)
  const prevThinkingRef    = useRef(false)

  useEffect(() => {
    const thinking = !!snapshot?.isThinking
    if (thinking && !prevThinkingRef.current) {
      isNewThinkingRef.current = true
      seenActionsRef.current.clear()
    }
    prevThinkingRef.current = thinking
  }, [snapshot?.isThinking])

  useEffect(() => {
    const activity = snapshot?.toolActivity
    if (!activity) return
    const key = activity.callId ?? `${activity.name}:${activity.detail}`
    if (seenActionsRef.current.has(key)) return
    seenActionsRef.current.add(key)

    const item: BatchItem = {
      detail: activity.detail ?? friendlyTool(activity.name, !!activity.isSubagent),
      tool:   activity.name,
    }

    if (isNewThinkingRef.current) {
      isNewThinkingRef.current = false
      const lastMsg = (snapshot?.messages ?? []).at(-1)
      const anchorMsgId = lastMsg?.id ?? null
      setActionBatches(prev => {
        currentBatchIdxRef.current = prev.length
        return [...prev, { anchorMsgId, items: [item] }]
      })
    } else if (currentBatchIdxRef.current !== null) {
      setActionBatches(prev => prev.map((b, i) =>
        i === currentBatchIdxRef.current ? { ...b, items: [...b.items, item] } : b
      ))
    }
  }, [snapshot?.toolActivity?.callId, snapshot?.toolActivity?.name, snapshot?.toolActivity?.detail])

  // Whenever the active plan id changes (or any plan-changed event fires
  // for the active plan), re-read the minimal fields we render. Using the
  // existing planGet IPC avoids stuffing the full plan into every overlay
  // snapshot push.
  useEffect(() => {
    const id = snapshot?.activePlanId
    if (!id) { setPlan(null); return }
    let cancelled = false
    const load = async () => {
      try {
        const p = await window.twixy.planGet(id)
        if (cancelled || !p) return
        setPlan({
          id:             p.id,
          title:          p.title,
          status:         p.status as PlanStatus,
          currentStepIdx: p.currentStepIdx,
          steps: p.steps.map(s => ({
            id:         s.id,
            title:      s.title,
            detail:     s.detail ?? '',
            acceptance: s.acceptance ?? '',
            summary:    s.summary,
            status:     s.status as PlanStepStatus,
          })),
        })
      } catch { /* overlay is cosmetic — ignore */ }
    }
    void load()
    const off = window.twixy.onPlanChanged(e => {
      if (e.id === id) void load()
    })
    return () => { cancelled = true; off() }
  }, [snapshot?.activePlanId])

  // Bottom-sticky autoscroll: a ResizeObserver on the inner content
  // wrapper pins the list to the bottom whenever content height changes
  // and stickToBottomRef is still true. This covers every source of
  // height change — new messages, action batches, markdown reflow,
  // OverlayActionGroup expand/collapse, late-arriving images — without
  // having to enumerate them as React effect deps.
  useEffect(() => {
    const list    = listRef.current
    const content = contentRef.current
    if (!list || !content) return
    const pin = () => {
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight
    }
    // Prime the scroll on first mount so we land at the bottom.
    pin()
    const ro = new ResizeObserver(pin)
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  // While Twixy is working, tick once per second so the "Ns · N tool
  // calls" elapsed display stays live. Stops once thinking clears.
  useEffect(() => {
    if (!snapshot?.isThinking) return
    const t = setInterval(() => setNowTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [snapshot?.isThinking])

  // Push opacity changes to the main process, which applies setOpacity()
  // to both overlay windows (side panel + composer) so they stay in sync.
  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    setOpacity(v)
    void window.twixy.overlaySetOpacity(v)
  }

  const total     = plan?.steps.length ?? 0
  const doneCount = plan?.steps.filter(s => s.status === 'done').length ?? 0
  const isDraft   = plan?.status === 'draft'
  const isPaused  = plan?.status === 'paused'

  const handleStart  = () => { void window.twixy.overlayStart() }
  const handleResume = () => { void window.twixy.overlayResume() }

  // Elapsed seconds since the current tool batch started. Matches the
  // main chat's "Ns · N tool calls" format so the popup reads the same.
  const startedAt = snapshot?.toolStats?.startedAt ?? null
  const toolCount = snapshot?.toolStats?.count ?? 0
  const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0

  // Show the last ~30 messages — big enough to give real context, small
  // enough not to choke a tiny overlay on a long session.
  const recent = (snapshot?.messages ?? []).slice(-30)

  return (
    <div style={shellStyle}>
      {/* Drag bar + close */}
      <div style={dragBarStyle}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>
          TWIXY
        </span>
        {snapshot && !snapshot.connected && (
          <span style={{
            marginLeft: 8, fontSize: 9.5, color: 'var(--warning)',
            padding: '1px 6px', borderRadius: 999,
            border: '1px solid rgba(251,191,36,0.4)',
            background: 'rgba(251,191,36,0.10)',
          }}>offline</span>
        )}
        <div style={{ flex: 1 }} />
        {/* Transparency slider — custom-styled range. A short track with
            fill showing the current opacity, applied to both overlay
            windows (side panel + composer) via setOpacity(). */}
        <div style={opacityWrapStyle} title={`Opacity ${Math.round(opacity * 100)}%`}>
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={opacity}
            onChange={handleOpacityChange}
            className="sidetab-opacity-range"
            style={{
              '--sidetab-opacity-fill': `${((opacity - 0.3) / 0.7) * 100}%`,
            } as React.CSSProperties}
          />
        </div>
        <button
          onClick={() => window.twixy.closeSidetab()}
          style={closeBtnStyle}
          title="Close sidetab"
        >
          ×
        </button>
      </div>

      <div style={contentStyle}>
        {/* Plan summary */}
        {plan && (
          <div style={planBlockStyle}>
            <button
              onClick={() => setPlanCollapsed(v => !v)}
              style={planHeaderStyle}
              title={planCollapsed ? 'Expand plan' : 'Collapse plan'}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                📋 {plan.title}
              </span>
              <span style={{
                fontSize: 10, padding: '2px 7px', borderRadius: 999,
                background: 'rgba(0,0,0,0.3)', color: statusColor(plan.status),
                border: `1px solid ${statusColor(plan.status)}`,
              }}>
                {plan.status}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {doneCount}/{total}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', width: 12, textAlign: 'center' }}>
                {planCollapsed ? '▸' : '▾'}
              </span>
            </button>

            {!planCollapsed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {plan.steps.map((s, i) => {
                  const isCurrent = plan.status === 'running' && i === plan.currentStepIdx
                  return (
                    <div key={s.id} style={{
                      display: 'flex', gap: 8, alignItems: 'flex-start',
                      padding: '5px 6px',
                      background: isCurrent ? 'rgba(13, 92, 80,0.16)' : 'transparent',
                      border: isCurrent ? '1px solid rgba(13, 92, 80,0.45)' : '1px solid transparent',
                      borderRadius: 6,
                    }}>
                      <span style={{
                        width: 16, textAlign: 'center', flexShrink: 0,
                        fontSize: 12,
                        color: s.status === 'done' ? 'var(--accent)' : s.status === 'failed' ? 'var(--danger)' : isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)',
                      }}>
                        {stepIcon(s.status)}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          <strong>{i + 1}.</strong> {s.title}
                        </div>
                        {s.detail && (
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                            {s.detail}
                          </div>
                        )}
                        {s.acceptance && (
                          <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 2, fontStyle: 'italic', lineHeight: 1.4 }}>
                            Accepts: {s.acceptance}
                          </div>
                        )}
                        {s.summary && (
                          <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                            → {s.summary}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Start button lives here so users review the plan + detail
                in this tall panel before kicking off the run. The composer
                bar below only handles in-flight Stop / Send. */}
            {isDraft && !planCollapsed && (
              <button onClick={handleStart} style={planStartBtnStyle} title="Start executing this plan">
                ▶  Start plan
              </button>
            )}
            {/* Resume for paused runs — same visual treatment as Start,
                but delegates to plans.resumePlan via overlay-resume IPC. */}
            {isPaused && !planCollapsed && (
              <button onClick={handleResume} style={planStartBtnStyle} title="Resume this paused plan">
                ▶  Resume
              </button>
            )}
          </div>
        )}

        {/* Messages. The ResizeObserver watches the inner content div
            (not the scroll container) so any height change — new msgs,
            markdown reflow, action-group toggles, async images — fires
            the pin-to-bottom check. */}
        <div
          ref={listRef}
          style={messagesStyle}
          onScroll={e => {
            const el = e.currentTarget
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight
            // Tight threshold: any real scroll-up detaches sticky mode.
            // User gets sticky back by scrolling within 24px of bottom.
            stickToBottomRef.current = distance < 24
          }}
        >
        <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {recent.map(m => {
            const isUser   = m.role === 'user'
            const isSystem = m.role === 'system'
            const label    = isUser ? 'You' : isSystem ? 'System' : 'Twixy'
            const labelColor = isUser ? 'var(--accent)' : isSystem ? 'var(--warning)' : 'var(--accent)'
            const anchoredBatches = actionBatches.filter(b => b.anchorMsgId === m.id)
            // Only the latest batch of the active thinking session auto-opens;
            // older batches collapse so the overlay stays scannable.
            const lastBatchIdx = anchoredBatches.length - 1
            return (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                    color: labelColor, textTransform: 'uppercase',
                  }}>
                    {label}
                  </div>
                  <div className="sidetab-md" style={{
                    fontSize: 12.5, lineHeight: 1.5,
                    padding: '8px 10px', borderRadius: 10,
                    background: isUser    ? 'rgba(13, 92, 80,0.14)'
                              : isSystem  ? 'rgba(251,191,36,0.10)'
                              :             'rgba(20, 32, 27,0.05)',
                    border: '1px solid ' +
                      (isUser   ? 'rgba(13, 92, 80,0.30)'
                     : isSystem ? 'rgba(251,191,36,0.25)'
                     :            'rgba(20, 32, 27,0.08)'),
                    color: 'var(--text-secondary)',
                    wordBreak: 'break-word',
                  }}>
                    {m.planId
                      ? <em style={{ color: 'var(--text-secondary)' }}>[plan card — see plan above]</em>
                      : <div dangerouslySetInnerHTML={{ __html: safeHtml(renderMd(m.content)) }} />
                    }
                  </div>
                </div>
                {anchoredBatches.map((b, bi) => (
                  <OverlayActionGroup
                    key={bi}
                    items={b.items}
                    defaultOpen={!!snapshot?.isThinking && bi === lastBatchIdx}
                  />
                ))}
              </div>
            )
          })}

          {/* Thinking indicator — same visual vocabulary as main chat */}
          {snapshot?.isThinking && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--accent)', textTransform: 'uppercase' }}>
                Twixy
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <ThinkingDots />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {snapshot.toolActivity ? (
                    <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                      {snapshot.toolActivity.subagentLabel
                        ? `Sub-agent: ${snapshot.toolActivity.subagentLabel} — ${friendlyTool(snapshot.toolActivity.name, false)}`
                        : friendlyTool(snapshot.toolActivity.name, snapshot.toolActivity.isSubagent)}
                      {snapshot.toolActivity.detail && (
                        <span style={{ color: 'var(--text-secondary)', marginLeft: 4 }}>
                          · {truncate(snapshot.toolActivity.detail, 60)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                      Thinking…
                    </span>
                  )}
                  {(toolCount > 0 || elapsedSec > 0) && (
                    <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                      {elapsedSec}s
                      {toolCount > 0 ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {recent.length === 0 && !snapshot?.isThinking && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', padding: '12px 4px' }}>
              Waiting for activity…
            </div>
          )}
        </div>
        </div>
      </div>

      {/* The composer lives in its own BrowserWindow (composer.html /
          ComposerBar.tsx), rendered as a separate floating bar at the
          bottom of the screen. This panel intentionally has no composer. */}

      <style>{`
        @keyframes sidetab-bounce {
          0%, 80%, 100% { transform: translateY(0);   opacity: 0.4; }
          40%           { transform: translateY(-4px); opacity: 1;   }
        }
        /* Markdown styles scoped to the overlay's message bubbles so we
           don't collide with the main app's CSS. Sized up vs. the prior
           cramped variant — the overlay is now chat-sized, not pill-sized. */
        .sidetab-md p               { margin: 0 0 6px 0; }
        .sidetab-md p:last-child    { margin-bottom: 0; }
        .sidetab-md h1,
        .sidetab-md h2,
        .sidetab-md h3,
        .sidetab-md h4              { margin: 6px 0 4px 0; font-size: 13px; font-weight: 700; }
        .sidetab-md ul,
        .sidetab-md ol              { margin: 4px 0 6px 0; padding-left: 20px; }
        .sidetab-md li              { margin: 2px 0; }
        .sidetab-md code            { background: rgba(20, 32, 27,0.08); padding: 1px 4px; border-radius: 3px; font-size: 11.5px; font-family: ui-monospace, monospace; }
        .sidetab-md pre             { background: rgba(0,0,0,0.40); padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-size: 11.5px; margin: 6px 0; }
        .sidetab-md pre code        { background: transparent; padding: 0; }
        .sidetab-md a               { color: var(--accent); text-decoration: underline; }
        .sidetab-md blockquote      { margin: 6px 0; padding-left: 10px; border-left: 2px solid rgba(20, 32, 27,0.2); color: var(--text-secondary); }
        .sidetab-md table           { border-collapse: collapse; font-size: 11.5px; margin: 6px 0; }
        .sidetab-md th,
        .sidetab-md td              { border: 1px solid rgba(20, 32, 27,0.1); padding: 3px 8px; }
        .sidetab-md hr              { border: none; border-top: 1px solid rgba(20, 32, 27,0.08); margin: 8px 0; }

        /* Custom range input for the opacity slider.
           --sidetab-opacity-fill is set inline (0–100%) to color the
           filled portion on the left of the thumb. */
        .sidetab-opacity-range {
          -webkit-appearance: none;
          appearance: none;
          width: 84px;
          height: 18px;
          background: transparent;
          cursor: pointer;
          outline: none;
          margin: 0;
          padding: 0;
        }
        .sidetab-opacity-range::-webkit-slider-runnable-track {
          height: 3px;
          border-radius: 2px;
          border: none;
          background: linear-gradient(
            to right,
            rgba(20, 32, 27,0.22) 0%,
            rgba(20, 32, 27,0.22) var(--sidetab-opacity-fill),
            rgba(20, 32, 27,0.06) var(--sidetab-opacity-fill),
            rgba(20, 32, 27,0.06) 100%
          );
        }
        .sidetab-opacity-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: rgba(180,180,185,0.85);
          border: none;
          box-shadow: none;
          margin-top: -3px;
          transition: transform 0.15s ease, background 0.15s ease;
        }
        .sidetab-opacity-range:hover::-webkit-slider-thumb,
        .sidetab-opacity-range:focus::-webkit-slider-thumb {
          transform: scale(1.15);
          background: rgba(220,220,225,0.95);
        }
        .sidetab-opacity-range::-moz-range-track {
          height: 3px;
          border-radius: 2px;
          border: none;
          background: rgba(20, 32, 27,0.06);
        }
        .sidetab-opacity-range::-moz-range-progress {
          height: 3px;
          border-radius: 2px;
          background: rgba(20, 32, 27,0.22);
        }
        .sidetab-opacity-range::-moz-range-thumb {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: rgba(180,180,185,0.85);
          border: none;
          box-shadow: none;
        }
      `}</style>
    </div>
  )
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// ── styles ────────────────────────────────────────────────────────
const shellStyle: React.CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(15,15,15,0.78)',
  backdropFilter: 'saturate(140%) blur(18px)',
  WebkitBackdropFilter: 'saturate(140%) blur(18px)',
  border: '1px solid rgba(20, 32, 27,0.08)',
  borderRadius: 12,
  overflow: 'hidden',
  color: 'var(--text-secondary)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
}

const dragBarStyle: React.CSSProperties = {
  height: 32,
  display: 'flex',
  alignItems: 'center',
  padding: '0 8px 0 12px',
  gap: 6,
  borderBottom: '1px solid rgba(20, 32, 27,0.06)',
  WebkitAppRegion: 'drag',
} as React.CSSProperties

const closeBtnStyle: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 6,
  background: 'transparent', border: 'none',
  color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1,
  WebkitAppRegion: 'no-drag',
} as React.CSSProperties

const contentStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '12px 14px',
  overflow: 'hidden',
  minHeight: 0,
}

const planBlockStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 10,
  background: 'rgba(20, 32, 27,0.035)',
  border: '1px solid rgba(20, 32, 27,0.07)',
  flexShrink: 0,
  maxHeight: 520,
  overflowY: 'auto',
}

const planHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  width: '100%',
  background: 'transparent', border: 'none', padding: 0,
  cursor: 'pointer',
  color: 'var(--text-secondary)',
}

const messagesStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minHeight: 0,
  paddingRight: 2,
}

// Transparency slider sits in the drag bar. Seamless — no wrapper
// background or border — so it blends into the glass drag bar. The
// wrapper is marked `no-drag` so pointer events reach the range input.
const opacityWrapStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  padding: '0 4px',
  WebkitAppRegion: 'no-drag',
} as React.CSSProperties


// Start button rendered inside the plan block (not the drag bar) so the
// user can review the plan's detail/acceptance before kicking off a run.
const planStartBtnStyle: React.CSSProperties = {
  marginTop: 10,
  width: '100%',
  padding: '9px 12px',
  fontSize: 12.5, fontWeight: 700, letterSpacing: '0.02em',
  background: 'linear-gradient(135deg, #0d5c50, #0d5c50)',
  color: '#f5f3ff',
  border: 'none', borderRadius: 10, cursor: 'pointer',
  boxShadow: '0 2px 10px rgba(13, 92, 80,0.35)',
}
