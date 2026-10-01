// 패널 맨 위 한 줄 — GPU 사용률 · VRAM · 온도 · RAM. 생성이 느릴 때 이유(VRAM 이 꽉 차 시스템
// 메모리로 넘침)를 사용자가 직접 볼 수 있게 한다. 패널이 보이는 동안만 2초마다 묻는다.
import { useEffect, useState } from 'react'
import { engineApi, type SystemStats } from './engineApi'

const POLL_MS = 2000
/** 이 이상이면 VRAM 이 사실상 가득 찬 것 — Windows 는 넘친 만큼을 시스템 메모리로 돌리고, 그러면 수십 배 느려진다. */
export const VRAM_FULL_RATIO = 0.95

const gb = (mb: number) => (mb / 1024).toFixed(1)

export function formatStats(s: SystemStats): { text: string; vramFull: boolean } {
  const parts: string[] = []
  let vramFull = false
  if (s.gpu) {
    const { utilizationPct, memoryUsedMB, memoryTotalMB, temperatureC } = s.gpu
    vramFull = memoryTotalMB > 0 && memoryUsedMB / memoryTotalMB >= VRAM_FULL_RATIO
    parts.push(`GPU ${Math.round(utilizationPct)}%`, `VRAM ${gb(memoryUsedMB)}/${gb(memoryTotalMB)} GB`)
    if (temperatureC !== null) parts.push(`${Math.round(temperatureC)}°C`)
  } else {
    parts.push('GPU 정보 없음')
  }
  parts.push(`RAM ${gb(s.ramUsedMB)}/${gb(s.ramTotalMB)} GB`)
  return { text: parts.join(' · '), vramFull }
}

export function SystemStatsBar() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try { const s = await engineApi.systemStats(); if (!stopped) setStats(s) } catch { /* 앱 밖 — 안 보인다 */ }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [])
  if (!stats) return null
  const { text, vramFull } = formatStats(stats)
  return (
    <div
      title={stats.gpu?.name}
      style={{
        padding: '5px 12px', fontSize: 11, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
        color: vramFull ? 'var(--warning, #c47f00)' : 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {text}{vramFull ? ' — VRAM 가득 참: 생성이 크게 느려질 수 있습니다' : ''}
    </div>
  )
}
