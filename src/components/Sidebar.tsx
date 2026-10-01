// ─────────────────────────────────────────────────────────────────────────────
// Sidebar.tsx — 좌측 아이콘 네비게이션 바.
// 52px 너비의 세로 막대에 패널 전환 버튼들을 배치한다.
// 활성 뷰는 App.tsx 가 상태로 관리하고, 여기선 콜백으로 알려주기만 함.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import appLogoDark from '../../assets/icon.iconset/icon_64x64.png'
import appLogoLight from '../../assets/icon-petrol-64.png'
import { useEffectiveTheme } from '../design/theme'
import { PRODUCT, type View } from '../lib/product'
import { getProductLogo, getProductView } from '../lib/productShell'


interface Props {
  activeView: View
  onViewChange: (v: View) => void
  // 메인 윈도우가 fullscreen 일 때는 위쪽 트래픽 라이트도 사라지고 커스텀
  // 타이틀바도 숨겨지므로, 상단 패딩을 줄여 IDE 영역을 더 확보한다.
  isFullscreen?: boolean
}

// 메인 네비게이션 항목 리스트. 아이콘은 유니코드 심볼로 SVG 없이 렌더링.
// Settings 는 하단에 분리 배치되므로 이 배열에 포함되지 않는다 (렌더 시점에 합쳐짐).
const navItems: { id: View; icon: string; label: string }[] = [
  // Copilot — 채팅-퍼스트 메인 화면. 입력하면 워크플로 빌더가 팝업으로 등장.
  // 기존 'chat' 탭(범용 어시스턴트)은 MVP 에서 숨김 — 라벨 "Chat" 은 이쪽이 승계.
  { id: 'copilot',    icon: '◎', label: 'Chat' },
  { id: 'chat',       icon: '◎', label: 'Chat (legacy)' },
  // PDF 0613 정의: 사이드바 2번째 = Workflow (편집·뷰어 풀 화면).
  { id: 'workflow',   icon: '◇', label: 'Workflow' },
  // Orchestration — 워크플로 + AI Agent(relay 그룹, 파일로 재사용)를 한 캔버스에서 조율.
  { id: 'orchestration', icon: '◈', label: 'Orchestration' },
  { id: 'dashboard',  icon: '⊟', label: 'Dashboard' },
  { id: 'data',       icon: '⊞', label: 'Data Management' },
  { id: 'skills',     icon: '⊛', label: 'Skills' },
  { id: 'mr',         icon: '⇄', label: 'Merge Requests' },
  { id: 'admin',      icon: '⌬', label: 'Admin' },
]

// 어떤 탭을 어떤 순서로 보일지는 제품 프로필이 정한다 (PRODUCT.features.views).
// 여기 navItems 는 id → 아이콘·라벨 사전일 뿐이다. 프로필에 없는 탭은 사이드바에
// 안 나오지만, 패널 자체는 features.panels 에 있으면 App.tsx 가 계속 마운트한다
// (Smart Export 등 내부 라우팅 유지).

export function Sidebar({ activeView, onViewChange, isFullscreen }: Props) {
  // 테마별 로고 — 다크=기존 보라, 라이트=petrol
  const effectiveTheme = useEffectiveTheme()
  const productLogo = getProductLogo()
  const appLogo = effectiveTheme === 'dark' ? (productLogo?.dark ?? appLogoDark) : (productLogo?.light ?? appLogoLight)
  // 코어 탭 사전에 없으면 제품이 등록한 탭 (src/lib/productShell.ts).
  const orderedItems = PRODUCT.features.views
    .map(id => navItems.find(i => i.id === id) ?? getProductView(id))
    .filter((i): i is (typeof navItems)[number] => !!i)
  return (
    <aside style={{
      width: 52,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: isFullscreen ? 12 : 48,
      paddingBottom: 12,
      gap: 4,
      WebkitAppRegion: 'no-drag',
    } as React.CSSProperties}>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, width: '100%', paddingInline: 6, marginTop: 8 }}>
        {[...orderedItems, { id: 'settings' as View, icon: '⚙', label: 'Settings' }].map(item => {
          const isActive  = activeView === item.id
          const isCopilot = item.id === 'copilot'
          return (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            title={item.label}
            style={{
              width: '100%',
              height: 36,
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              // CT(copilot)는 보라 하이라이트 대신 아이콘만 커진다 — 배경 강조 없음.
              background: isActive && !isCopilot ? 'var(--accent-dim)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              if (!isActive && !isCopilot)
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover)'
            }}
            onMouseLeave={e => {
              if (!isActive && !isCopilot)
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
          >
            {isCopilot
              ? <img src={appLogo} alt={PRODUCT.displayName} style={{ width: 22, height: 22, borderRadius: 5, display: 'block', transform: isActive ? 'scale(1.25)' : 'scale(1)', transition: 'transform 0.15s' }} />
              : item.icon}
          </button>
          )
        })}
      </div>
    </aside>
  )
}
