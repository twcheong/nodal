// ─────────────────────────────────────────────────────────────────────────────
// LiveBrowserPreview — headless-Chrome 를 앱 안에서 "보고 + 조작"하는 패널.
//
// Chrome 은 항상 headless (openclaw.json browser.headless: true) 라 OS 창이
// 전혀 안 뜸 → 포커스 뺏김 0. 사용자는 이 패널이 유일한 상호작용 창구:
//   · 볼 때 : CDP screencast 프레임을 <img> 로 렌더
//   · 조작 : 프레임 위 클릭/휠/키입력을 CDP Input 으로 전달
//
// 렌더:
//   ┌───────────────────────────────────────────────┐
//   │ [탭1 썸네일] [탭2*활성] [탭3]                 │  ← target strip
//   ├───────────────────────────────────────────────┤
//   │ title | url                                   │
//   │      활성 target 프레임 (클릭/타이핑 가능)    │
//   └───────────────────────────────────────────────┘
//
// 좌표는 표시된 <img> 기준 fraction(0..1) 으로 보내고, 메인이 프레임 메타
// (deviceWidth/Height) 로 CSS 픽셀에 매핑한다. img 는 letterbox 없이 natural
// aspect 로 렌더하므로 getBoundingClientRect() 가 곧 렌더된 이미지 영역이다.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PRODUCT } from '../../lib/product'

interface TargetSummary {
  targetId: string
  title:    string
  url:      string
  isActive: boolean
}

// 특수키 → CDP code/keyCode. printable 문자는 insertText(text)로 처리.
const SPECIAL_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter:      { code: 'Enter',      keyCode: 13, text: '\r' },
  Backspace:  { code: 'Backspace',  keyCode: 8 },
  Tab:        { code: 'Tab',        keyCode: 9 },
  Delete:     { code: 'Delete',     keyCode: 46 },
  Escape:     { code: 'Escape',     keyCode: 27 },
  ArrowUp:    { code: 'ArrowUp',    keyCode: 38 },
  ArrowDown:  { code: 'ArrowDown',  keyCode: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home:       { code: 'Home',       keyCode: 36 },
  End:        { code: 'End',        keyCode: 35 },
  PageUp:     { code: 'PageUp',     keyCode: 33 },
  PageDown:   { code: 'PageDown',   keyCode: 34 },
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// cdpPort — 어느 Chrome 을 볼지 (18800 = 채팅 기본, 18801-3 = 워크플로 슬롯
// wf-1..3). 호출부가 <LiveBrowserPreview key={port} cdpPort={port} /> 로
// remount 하면 이전 포트는 stop(pause), 새 포트는 start 되는 lifecycle 을 탄다.
export function LiveBrowserPreview({ cdpPort = PRODUCT.cdpPort }: { cdpPort?: number }) {
  const [targets, setTargets] = useState<TargetSummary[]>([])
  const [frames,  setFrames]  = useState<Map<string, string>>(() => new Map())
  const [error,   setError]   = useState<string | null>(null)
  const [copied,  setCopied]  = useState(false)   // URL 복사 피드백 (⧉ → ✓)
  const [refreshing, setRefreshing] = useState(false)

  // ⟳ 하드 새로고침 — CDP 를 끊고 재연결. headless 스크린캐스트가 프레임을 안
  // 뱉는 "Waiting for first frame" 걸림을 attach 부터 다시 타서 푼다.
  const refresh = useCallback(async () => {
    const api = window.twixy
    if (!api?.browserPreviewRefresh || refreshing) return
    setRefreshing(true)
    setError(null)
    setFrames(new Map())   // 낡은 프레임 제거 — 재연결 후 새 프레임으로 채워짐
    try {
      const res = await api.browserPreviewRefresh({ cdpPort })
      if (!res.ok) setError(res.error ?? 'Failed to refresh preview.')
    } finally {
      setRefreshing(false)
    }
  }, [cdpPort, refreshing])
  const imgRef = useRef<HTMLImageElement | null>(null)
  const frameBoxRef = useRef<HTMLDivElement | null>(null)

  // mount/unmount lifecycle — start CDP stream, tear down on close.
  useEffect(() => {
    let alive = true
    const api = window.twixy
    if (!api?.browserPreviewStart) {
      setError('Browser preview bridge is unavailable.')
      return
    }

    void api.browserPreviewStart({ cdpPort }).then(res => {
      if (!alive) return
      if (!res.ok) setError(res.error ?? 'Failed to start preview.')
    })

    // 이벤트는 모든 포트가 공유 채널로 옴 — 자기 포트 것만 반영.
    const offFrame = api.onBrowserPreviewFrame?.(payload => {
      if (payload.cdpPort !== cdpPort) return
      setFrames(prev => {
        const next = new Map(prev)
        next.set(payload.targetId, payload.base64)
        return next
      })
    })
    const offList = api.onBrowserPreviewTargetList?.(payload => {
      if (payload.cdpPort !== cdpPort) return
      setTargets(payload.targets)
      setFrames(prev => {
        const nextIds = new Set(payload.targets.map(t => t.targetId))
        let changed = false
        const next = new Map<string, string>()
        for (const [id, b64] of prev) {
          if (nextIds.has(id)) next.set(id, b64)
          else changed = true
        }
        return changed ? next : prev
      })
    })

    return () => {
      alive = false
      offFrame?.()
      offList?.()
      void api.browserPreviewStop?.({ cdpPort })
    }
  }, [cdpPort])

  // Report the frame box size so main can match the Chrome viewport aspect to
  // it → the frame fills the panel with no letterbox black bars. Debounced so a
  // resize drag doesn't spam setDeviceMetricsOverride.
  useEffect(() => {
    const box = frameBoxRef.current
    const api = window.twixy
    if (!box || !api?.browserPreviewSetViewport) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const report = () => {
      const r = box.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      void api.browserPreviewSetViewport?.({ width: Math.round(r.width), height: Math.round(r.height), cdpPort })
    }
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(report, 150)
    })
    ro.observe(box)
    report()
    return () => { if (timer) clearTimeout(timer); ro.disconnect() }
  }, [cdpPort])

  const active = useMemo(() => targets.find(t => t.isActive) ?? null, [targets])
  const activeFrame = active ? frames.get(active.targetId) ?? null : null

  const send = useCallback((payload: BrowserPreviewInput) => {
    void window.twixy?.browserPreviewInput?.({ ...payload, cdpPort })
  }, [cdpPort])

  // 표시된 이미지 좌표 → fraction(0..1)
  const fracFromPointer = (clientX: number, clientY: number): { xFrac: number; yFrac: number } | null => {
    const el = imgRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return {
      xFrac: clamp01((clientX - r.left) / r.width),
      yFrac: clamp01((clientY - r.top)  / r.height),
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    if (!active) return
    imgRef.current?.focus()
    const f = fracFromPointer(e.clientX, e.clientY)
    if (!f) return
    send({ targetId: active.targetId, kind: 'click', ...f, button: 'left', clickCount: e.detail || 1 })
  }

  const handleWheel = (e: React.WheelEvent) => {
    if (!active) return
    const f = fracFromPointer(e.clientX, e.clientY)
    if (!f) return
    send({ targetId: active.targetId, kind: 'wheel', ...f, deltaX: e.deltaX, deltaY: e.deltaY })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!active) return
    const t = active.targetId
    // Ctrl/Cmd 조합은 브라우저 단축키로 넘기지 않고 무시 (앱 단축키 보호).
    if (e.metaKey || e.ctrlKey) return
    if (e.key.length === 1) {
      e.preventDefault()
      send({ targetId: t, kind: 'text', text: e.key })
      return
    }
    const sp = SPECIAL_KEYS[e.key]
    if (sp) {
      e.preventDefault()
      send({ targetId: t, kind: 'key', action: 'down', key: e.key, code: sp.code, keyCode: sp.keyCode, text: sp.text })
      send({ targetId: t, kind: 'key', action: 'up',   key: e.key, code: sp.code, keyCode: sp.keyCode })
    }
  }

  const handleThumbnailClick = (targetId: string) => {
    void window.twixy?.browserPreviewSetActive?.({ targetId, cdpPort })
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-base)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      {/* Target strip — thumbnails of every open tab/popup */}
      <div style={{
        display: 'flex',
        gap: 6,
        padding: 8,
        borderBottom: '1px solid var(--border-subtle)',
        overflowX: 'auto',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}>
        {targets.length === 0 && (
          <div style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            padding: '10px 8px',
          }}>
            {error ? error : 'Waiting for browser…'}
          </div>
        )}
        {targets.map(t => (
          <ThumbnailButton
            key={t.targetId}
            target={t}
            frame={frames.get(t.targetId) ?? null}
            onClick={() => handleThumbnailClick(t.targetId)}
            onClose={() => { void window.twixy?.browserPreviewCloseTarget?.({ targetId: t.targetId, cdpPort }) }}
          />
        ))}
        <div style={{ flex: 1 }} />
        {/* ⟳ 새로고침 — 프레임이 안 오거나 낡았을 때 CDP 재연결로 다시 잡는다 */}
        <button
          onClick={() => { void refresh() }}
          disabled={refreshing}
          title="Refresh the preview — reconnects to the browser (use when the frame is stuck)"
          style={{
            flexShrink: 0, alignSelf: 'center', padding: '4px 8px', fontSize: 12, lineHeight: 1,
            background: 'transparent', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)', cursor: refreshing ? 'default' : 'pointer',
            color: 'var(--text-muted)', opacity: refreshing ? 0.5 : 1,
          }}
        >⟳</button>
      </div>

      {/* Active target — title bar + interactive frame */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {active && (
          <div style={{
            padding: '6px 10px',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <span style={{
              color: 'var(--text-primary)', fontWeight: 500, maxWidth: 240,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{active.title || '(untitled)'}</span>
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{active.url}</span>
            {/* 링크 복사 — headless 라 주소창이 없으니 여기서 URL 을 꺼낸다 */}
            <button
              onClick={() => {
                void navigator.clipboard.writeText(active.url).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                }).catch(() => { /* clipboard denied — 무시 */ })
              }}
              title="Copy page URL"
              style={urlBarBtnStyle(copied)}
            >{copied ? '✓' : '⧉'}</button>
            {/* 시스템 기본 브라우저(크롬)로 열기 */}
            <button
              onClick={() => { void window.twixy?.openExternal?.(active.url) }}
              title="Open in your browser"
              style={urlBarBtnStyle(false)}
            >⤢</button>
          </div>
        )}
        <div ref={frameBoxRef} style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          overflow: 'hidden',
          minHeight: 0,
        }}>
          {activeFrame ? (
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${activeFrame}`}
              alt={active?.title ?? ''}
              tabIndex={0}
              draggable={false}
              onClick={handleClick}
              onWheel={handleWheel}
              onKeyDown={handleKeyDown}
              style={{
                // letterbox 없이 natural aspect → rect == 렌더된 이미지 영역.
                maxWidth:  '100%',
                maxHeight: '100%',
                display:   'block',
                outline:   'none',
                cursor:    'default',
                // 프레임 위 드래그로 이미지 고스트가 뜨지 않게.
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
            />
          ) : (
            <div
              onClick={targets.length === 0 ? undefined : () => { void refresh() }}
              title={targets.length === 0 ? undefined : 'Click to refresh the preview connection'}
              style={{
                color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)',
                cursor: targets.length === 0 ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              {targets.length === 0 ? '' : (refreshing ? 'Reconnecting…' : 'Waiting for first frame…  ⟳ click to refresh')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// URL 바 우측 미니 버튼 (복사/외부열기 공용).
function urlBarBtnStyle(active: boolean): React.CSSProperties {
  return {
    flexShrink: 0, padding: '2px 6px', fontSize: 11, lineHeight: 1,
    background: 'transparent', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
    color: active ? '#10b981' : 'var(--text-muted)',
  }
}

function ThumbnailButton({
  target, frame, onClick, onClose,
}: {
  target: TargetSummary
  frame: string | null
  onClick: () => void
  onClose: () => void
}) {
  // 외곽은 div — 닫기 버튼이 안에 있어 button 중첩(invalid HTML)을 피한다.
  return (
    <div
      onClick={onClick}
      role="button"
      title={`${target.title || '(untitled)'}\n${target.url}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 4,
        background: target.isActive ? 'var(--bg-active)' : 'var(--bg-base)',
        border: `1px solid ${target.isActive ? 'var(--accent)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        flexShrink: 0,
        width: 130,
        position: 'relative',
      }}
    >
      {/* 탭 닫기 — Chrome 의 그 탭 자체를 닫는다 (targetDestroyed 로 목록 자동 갱신) */}
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        title="Close this browser tab"
        style={{
          position: 'absolute', top: 2, right: 2, zIndex: 2,
          width: 16, height: 16, padding: 0, lineHeight: 1, fontSize: 11,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.55)', color: '#fff',
          border: 'none', borderRadius: 3, cursor: 'pointer',
        }}
      >×</button>
      <div style={{
        width: '100%', height: 78, background: '#000', borderRadius: 2,
        overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame}`} alt=""
               style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: 9, fontFamily: 'var(--font-mono)' }}>…</span>
        )}
      </div>
      <span style={{
        fontSize: 10,
        color: target.isActive ? 'var(--text-primary)' : 'var(--text-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        textAlign: 'left', width: '100%',
      }}>
        {target.title || '(untitled)'}
      </span>
    </div>
  )
}
