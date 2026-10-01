// 스튜디오 화면 공용 조각 — 후보 그리드(이미지·영상), 카드, 라벨.
import type { CSSProperties, ReactNode } from 'react'
import { Spinner } from '../../../../src/components/ui/Spinner'
import { ENGINE_URL } from '../../engineConfig'
import { assetUrl } from '../engineApi'
import type { Candidate } from './model'

export const card: CSSProperties = {
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)',
  padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
}
export const muted: CSSProperties = { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }
export const label: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }

export function Field({ title, children, style }: { title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, ...style }}>
      <span style={label}>{title}</span>
      {children}
    </label>
  )
}

/** 후보 썸네일 줄. `selectedId` 가 승인·선택된 것 (초록 테두리). 누르면 onPick. */
export function CandidateGrid({ items, selectedId, onPick, onRetry, size = 132, empty }: {
  items: Candidate[]
  selectedId: string | null
  onPick?: (c: Candidate) => void
  /** 실패한 후보를 같은 설정으로 다시. */
  onRetry?: (c: Candidate) => void
  size?: number
  empty?: string
}) {
  if (!items.length) return empty ? <div style={muted}>{empty}</div> : null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {items.map((c) => <Thumb key={c.id} c={c} selected={c.id === selectedId} onPick={onPick} onRetry={onRetry} size={size} />)}
    </div>
  )
}

function Thumb({ c, selected, onPick, onRetry, size }: { c: Candidate; selected: boolean; onPick?: (c: Candidate) => void; onRetry?: (c: Candidate) => void; size: number }) {
  const src = c.asset ? assetUrl(ENGINE_URL, c.asset.hash) : null
  const isVideo = c.asset?.mediaType.startsWith('video/')
  const clickable = c.status === 'done' && !!onPick
  return (
    <div
      role="button"
      tabIndex={clickable ? 0 : -1}
      aria-disabled={!clickable}
      title={c.error ?? c.prompt}
      onClick={() => clickable && onPick?.(c)}
      onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick?.(c) } }}
      style={{
        position: 'relative', width: size, height: size, padding: 0, borderRadius: 8, overflow: 'hidden',
        cursor: clickable ? 'pointer' : 'default', background: 'var(--bg-base)',
        border: selected ? '2px solid var(--success, #1f9d55)' : '1px solid var(--border-subtle)',
        boxShadow: selected ? '0 0 0 3px color-mix(in srgb, var(--success, #1f9d55) 25%, transparent)' : 'none',
      }}
    >
      {c.status === 'running' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          <Spinner size={14} />생성 중
        </div>
      )}
      {c.status === 'failed' && (
        <div style={{ position: 'absolute', inset: 0, padding: 8, fontSize: 10, color: 'var(--danger, #b42318)', textAlign: 'left', overflow: 'hidden', lineHeight: 1.4, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>실패 — {c.error}</span>
          {c.request && onRetry && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onRetry(c) }} style={{ alignSelf: 'flex-start', fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
              다시 시도
            </button>
          )}
        </div>
      )}
      {src && !isVideo && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      {src && isVideo && <video src={src} muted loop playsInline onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />}
      {selected && (
        <span style={{ position: 'absolute', top: 6, right: 6, background: 'var(--success, #1f9d55)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '1px 7px', fontWeight: 600 }}>승인</span>
      )}
    </div>
  )
}

export function AssetView({ hash, mediaType, style }: { hash: string; mediaType: string; style?: CSSProperties }) {
  const src = assetUrl(ENGINE_URL, hash)
  return mediaType.startsWith('video/')
    ? <video src={src} controls loop style={{ width: '100%', borderRadius: 8, background: '#000', ...style }} />
    : <img src={src} alt="" style={{ width: '100%', borderRadius: 8, ...style }} />
}
