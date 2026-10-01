// 엔진 상태 — 채팅 패널·노드 탭·엔진 탭이 같이 쓴다. 상태 변화는 메인이 푸시하지 않으므로 폴링한다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../../src/components/ui/Button'
import { Spinner } from '../../../src/components/ui/Spinner'
import { navigateToView } from '../../../src/lib/productShell'
import { engineApi, type EngineStatus } from './engineApi'

export const ENGINE_VIEW_ID = 'engine'

export function useEngineStatus(active = true): { status: EngineStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const latest = useRef<EngineStatus | null>(null)
  const refresh = useCallback(async () => {
    try {
      const next = await engineApi.status()
      latest.current = next
      setStatus(next)
    } catch { /* 앱 밖(스토리북 등) — 그대로 둔다 */ }
  }, [])
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const tick = async () => {
      await refresh()
      if (stopped) return
      // 뜨는 중에는 촘촘히 — 준비되는 순간 화면이 바뀌어야 한다.
      timer = setTimeout(tick, latest.current?.state === 'starting' ? 1500 : 8000)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [active, refresh])
  return { status, refresh }
}

export const ENGINE_STATE_LABEL: Record<EngineStatus['state'], string> = {
  'idle': '대기',
  'not-installed': '설치 필요',
  'starting': '시작하는 중',
  'ready': '실행 중',
  'external': '실행 중 (외부)',
  'crashed': '멈춤',
  'stopped': '꺼짐',
}

/** 엔진이 쓸 수 없는 상태일 때 보여 줄 안내 + 다음 행동. 쓸 수 있으면 null. */
export function EngineNotice({ status, onRetry, compact }: { status: EngineStatus | null; onRetry?: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  if (!status) return <Centered><Spinner size={16} /></Centered>
  if (status.running) return null

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn() } catch { /* 상태 폴링이 결과를 보여 준다 */ } finally { setBusy(false); onRetry?.() }
  }
  const title =
    status.state === 'starting' ? '엔진을 시작하는 중입니다' :
    status.state === 'not-installed' ? '엔진 설치가 필요합니다' :
    status.state === 'crashed' ? '엔진이 멈췄습니다' :
    '엔진이 꺼져 있습니다'
  return (
    <Centered compact={compact}>
      {status.state === 'starting' && <Spinner size={16} />}
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {status.detail && <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 320 }}>{status.detail}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        {status.state === 'not-installed' && <Button size="sm" variant="primary" onClick={() => navigateToView(ENGINE_VIEW_ID)}>설치 화면으로</Button>}
        {(status.state === 'crashed' || status.state === 'stopped' || status.state === 'idle') && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => act(engineApi.start)}>엔진 시작</Button>
        )}
        {status.state === 'crashed' && <Button size="sm" variant="ghost" onClick={() => navigateToView(ENGINE_VIEW_ID)}>로그 보기</Button>}
      </div>
    </Centered>
  )
}

export function Centered({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: compact ? 12 : 24, textAlign: 'center' }}>
      {children}
    </div>
  )
}
