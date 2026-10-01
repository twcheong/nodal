// ─────────────────────────────────────────────────────────────────────────────
// LazyPanel.tsx — "첫 방문 때 코드를 받아 마운트하고, 그 뒤로는 계속 마운트" 하는 패널용 래퍼.
//
// App.tsx 는 패널을 전부 마운트해 두고 display 로만 가린다 (탭을 오가도 스크롤·편집 상태 유지).
// 그 대가로 한 번도 안 여는 패널의 코드까지 초기 JS 에 들어가고, 숨겨진 채 마운트 effect
// (IPC 조회, cron.list RPC …)가 시작 직후에 돈다. 실행·구독을 소유하지 않는 순수 UI 패널만
// 이 래퍼로 감싼다 — 분류 근거는 docs/refactor/d0-panel-classification.md.
//
// ⚠ 이 래퍼는 "언제 처음 렌더할지" 를 정하지 않는다. 숨긴 채로라도 렌더하면 import() 가 바로
// 시작돼 분리한 의미가 없으므로, 호출부(App.tsx 의 visited)가 첫 방문 전에는 아예 렌더하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react'
import { Button, Spinner } from './ui'

const center = {
  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 10, padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
} as const

// 청크 로드 실패(업데이트가 실행 중인 앱의 assets 를 갈아치운 경우 등)와 패널 렌더 예외를 받는다.
// 이 저장소에는 ErrorBoundary 가 없어서 지금까지는 패널 하나의 예외가 앱 전체를 빈 화면으로 만들었다.
class PanelErrorBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div style={center} role="alert">
        <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Could not load this panel</div>
        <div style={{ maxWidth: 420, wordBreak: 'break-word' }}>{error.message}</div>
        <Button size="sm" onClick={() => { this.props.onRetry(); this.setState({ error: null }) }}>Retry</Button>
      </div>
    )
  }
}

/**
 * `load` 는 named export 를 꺼내 돌려주는 동적 import:
 *   lazyPanel(() => import('./SkillsPanel').then(m => m.SkillsPanel))
 */
export function lazyPanel<P extends object>(load: () => Promise<ComponentType<P>>) {
  const make = () => lazy(() => load().then(c => ({ default: c })))
  return function LazyPanel(props: P) {
    // React.lazy 는 실패한 promise 를 그대로 캐시한다 — 같은 lazy 를 다시 렌더해도 같은 에러만 난다.
    // 그래서 재시도는 이 패널의 lazy 만 새로 만든다 (모듈 수준에서 갈아끼우면 이미 마운트된
    // 다른 패널까지 컴포넌트 identity 가 바뀌어 상태를 잃는다).
    const [Panel, setPanel] = useState(make)
    return (
      <PanelErrorBoundary onRetry={() => setPanel(make())}>
        <Suspense fallback={<div style={center}><Spinner size={18} /></div>}>
          <Panel {...props} />
        </Suspense>
      </PanelErrorBoundary>
    )
  }
}
