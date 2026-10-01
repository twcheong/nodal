import React, { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { useOverlaySync } from '../hooks/useOverlaySync'
import type { PlanStatus } from './PlanCard'

// The floating composer is the "─" (horizontal) of the reversed-L sidetab
// layout. Rendered in its own BrowserWindow (composer.html) so it can sit
// anywhere on screen independent of the taller side panel. It subscribes
// to the same overlay-sync state and forwards user actions through the
// same overlay-stop / overlay-send IPC paths. (Start lives in the side
// panel's plan block so users review before kicking off a run.)

export function ComposerBar() {
  const snapshot = useOverlaySync()
  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Korean IME + Enter race: Chromium occasionally fires keydown(Enter)
  // twice around a composition commit, causing the last jamo to send
  // as its own message. isComposing blocks most cases, but a 300ms
  // timestamp guard catches the rest.
  const lastSendAtRef = useRef(0)

  // The snapshot carries only the active plan id; the composer needs
  // plan.status to know whether to render Stop or Send. We pull it from
  // the same planGet IPC the side panel uses, and refresh on plan-changed.
  useEffect(() => {
    const id = snapshot?.activePlanId
    if (!id) { setPlanStatus(null); return }
    let cancelled = false
    const load = async () => {
      try {
        const p = await window.twixy.planGet(id)
        if (!cancelled) setPlanStatus((p?.status ?? null) as PlanStatus | null)
      } catch { /* cosmetic */ }
    }
    void load()
    const off = window.twixy.onPlanChanged(e => {
      if (e.id === id) void load()
    })
    return () => { cancelled = true; off() }
  }, [snapshot?.activePlanId])

  // Auto-grow the textarea up to 5 rows.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 110) + 'px'
  }, [draft])

  const isRunning = planStatus
    ? planStatus === 'running'
    : !!snapshot?.isThinking
  const isDraft  = planStatus === 'draft'
  const isPaused = planStatus === 'paused'

  const handleStop = () => { void window.twixy.overlayStop() }
  const handleTogglePlanMode = () => { void window.twixy.overlayTogglePlanMode() }
  const handleSend = () => {
    const now = Date.now()
    if (now - lastSendAtRef.current < 300) return
    const text = draft.trim()
    if (!text || isRunning) return
    lastSendAtRef.current = now
    void window.twixy.overlaySend(text)
    setDraft('')
  }
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = !isRunning && !isDraft && !!draft.trim()

  return (
    <div style={shellStyle}>
      {/* Drag handle — flush left, small vertical grip bars */}
      <div style={dragHandleStyle} title="Drag to move">
        <span style={gripDotStyle} />
        <span style={gripDotStyle} />
        <span style={gripDotStyle} />
      </div>

      {/* Textarea wrapper gets the focus ring + status accent so the
          textarea itself stays borderless and clean */}
      <div style={{
        ...fieldStyle,
        borderColor: isRunning ? 'rgba(181, 72, 47,0.45)'
                    : focused  ? 'rgba(13, 92, 80,0.55)'
                    :            'rgba(20, 32, 27,0.10)',
        boxShadow: focused && !isRunning ? '0 0 0 3px rgba(13, 92, 80,0.18)' : 'none',
      }}>
        {isRunning && (
          <span style={runningDotStyle} title="Twixy is working" />
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={
            isRunning ? 'Twixy is working — ⏹ to add a correction…'
          : isDraft   ? 'Review plan on the right, then press Start →'
          : isPaused  ? 'Add a correction…'
          :             'Message Twixy…'
          }
          rows={1}
          disabled={isRunning}
          style={{
            ...textareaStyle,
            opacity: isRunning ? 0.6 : 1,
            cursor:  isRunning ? 'not-allowed' : 'text',
          }}
        />
      </div>

      {/* Plan mode toggle — sits next to Send so users can flip plan-first
          routing on/off inline. Mirrors the header chip in the main chat. */}
      <button
        onClick={handleTogglePlanMode}
        title={snapshot?.planMode
          ? 'Planning mode is ON — messages generate a plan first'
          : 'Planning mode is OFF — messages go direct to the agent'}
        style={{
          ...planModeChipStyle,
          borderColor: snapshot?.planMode ? 'rgba(13, 92, 80,0.50)' : 'rgba(20, 32, 27,0.10)',
          background:  snapshot?.planMode ? 'rgba(13, 92, 80,0.22)' : 'rgba(20, 32, 27,0.04)',
          color:       snapshot?.planMode ? '#c4b8ff'               : 'var(--text-secondary)',
          boxShadow:   snapshot?.planMode ? '0 2px 8px rgba(13, 92, 80,0.18)' : 'none',
        }}
      >
        Plan {snapshot?.planMode ? 'ON' : 'OFF'}
      </button>

      {isRunning ? (
        <button onClick={handleStop} style={stopBtnStyle} title="Pause / stop current turn">
          <span style={{ fontSize: 14 }}>⏹</span>
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            ...sendBtnStyle,
            opacity: canSend ? 1 : 0.4,
            cursor:  canSend ? 'pointer' : 'not-allowed',
          }}
          title="Send (Enter)"
        >
          <span style={{ fontSize: 14, marginLeft: 1 }}>➤</span>
        </button>
      )}

      <style>{`
        @keyframes composer-pulse {
          0%, 100% { transform: scale(1);   opacity: 0.9; }
          50%      { transform: scale(1.25); opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}

// ── styles ────────────────────────────────────────────────────────
const shellStyle: React.CSSProperties = {
  height: '100vh',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  background: 'rgba(18,18,20,0.82)',
  backdropFilter: 'saturate(150%) blur(22px)',
  WebkitBackdropFilter: 'saturate(150%) blur(22px)',
  border: '1px solid rgba(20, 32, 27,0.08)',
  borderRadius: 14,
  color: 'var(--text-secondary)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  overflow: 'hidden',
  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
}

const dragHandleStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  width: 14,
  height: 32,
  cursor: 'grab',
  flexShrink: 0,
  opacity: 0.5,
  WebkitAppRegion: 'drag',
} as React.CSSProperties

const gripDotStyle: React.CSSProperties = {
  width: 3, height: 3, borderRadius: '50%',
  background: 'var(--text-secondary)',
  display: 'block',
}

const fieldStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  background: 'rgba(20, 32, 27,0.04)',
  border: '1px solid rgba(20, 32, 27,0.10)',
  borderRadius: 12,
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  WebkitAppRegion: 'no-drag',
} as React.CSSProperties

const runningDotStyle: React.CSSProperties = {
  width: 8, height: 8, borderRadius: '50%',
  background: 'var(--danger)',
  boxShadow: '0 0 8px rgba(181, 72, 47,0.6)',
  animation: 'composer-pulse 1.4s ease-in-out infinite',
  flexShrink: 0,
}

const textareaStyle: React.CSSProperties = {
  flex: 1,
  padding: '4px 0',
  background: 'transparent',
  border: 'none',
  color: 'var(--text-primary)',
  fontSize: 13, lineHeight: 1.45, fontFamily: 'inherit',
  resize: 'none',
  outline: 'none',
  minHeight: 20,
  maxHeight: 110,
}

const btnBase: React.CSSProperties = {
  width: 38, height: 38,
  fontSize: 14,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', borderRadius: 10,
  flexShrink: 0,
  transition: 'transform 0.1s ease, background 0.15s ease',
  WebkitAppRegion: 'no-drag',
} as React.CSSProperties

const stopBtnStyle: React.CSSProperties = {
  ...btnBase,
  background: 'linear-gradient(135deg, #b5482f, #b5482f)',
  color: '#0b0b0b',
  cursor: 'pointer',
  boxShadow: '0 2px 8px rgba(181, 72, 47,0.3)',
}

const sendBtnStyle: React.CSSProperties = {
  ...btnBase,
  background: 'linear-gradient(135deg, #0d5c50, #0d5c50)',
  color: '#f5f3ff',
  cursor: 'pointer',
  boxShadow: '0 2px 10px rgba(13, 92, 80,0.35)',
}

// Plan mode chip — sized to match the 38px send button so the two read
// as a matched pair. When ON, uses the same purple family as Send but
// tinted rather than gradient-filled so Send stays the primary action.
// When OFF, a soft dark fill keeps it looking like a solid button
// instead of a borderless ghost.
const planModeChipStyle: React.CSSProperties = {
  height: 38,
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(20, 32, 27,0.10)',
  background: 'rgba(20, 32, 27,0.04)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.02em',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  whiteSpace: 'nowrap',
  WebkitAppRegion: 'no-drag',
  transition: 'background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s',
} as React.CSSProperties
