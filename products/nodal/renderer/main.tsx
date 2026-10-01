// Nodal 렌더러 엔트리. 앱 셸(App)은 공용 코어 것을 그대로 쓰고, 무엇이 보이는지는
// ../profile.ts 의 features 가 정한다. Nodal 전용 화면은 이 폴더에 두고, App 을 렌더하기
// **전에** 코어의 등록 자리(copilotModes · productShell)에 끼운다.
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '../../../src/App'
import { initTheme } from '../../../src/design/theme'
import { navigateToView, onShellReady, registerProductView, setProductLogo } from '../../../src/lib/productShell'
import logo from '../assets/logo.svg'
import { lazyPanel } from '../../../src/components/LazyPanel'
import type { ProductViewProps } from '../../../src/lib/productShell'
import { engineApi } from './engineApi'
import { ENGINE_VIEW_ID } from './useEngineStatus'
import { registerVideoMode } from './videoMode'

initTheme()
registerVideoMode()   // App 이 렌더되기 전에 — useCopilotChat 이 첫 렌더에 기본 모드를 읽는다
// 첫 방문 때 코드를 받는다 — 노드 에디터(xyflow·yjs)만 수백 KB 라 채팅 첫 화면을 늦추지 않게.
registerProductView({ id: 'studio', icon: '🎬', label: '스튜디오', Component: lazyPanel<ProductViewProps>(() => import('./studio/StudioView').then((m) => m.StudioView)) })
registerProductView({ id: 'nodes', icon: '⬡', label: '노드', Component: lazyPanel<ProductViewProps>(() => import('./nodes/NodesView').then((m) => m.NodesView)) })
registerProductView({ id: ENGINE_VIEW_ID, icon: '⚡', label: '엔진 · 모델', Component: lazyPanel<ProductViewProps>(() => import('./setup/EngineView').then((m) => m.EngineView)) })
setProductLogo({ light: logo, dark: logo })

// 첫 실행: 엔진이 아직 설치되지 않았으면 채팅 대신 설치 탭부터.
onShellReady(() => {
  void engineApi.setup.status()
    .then((s) => { if (!s.runtimeInstalled) navigateToView(ENGINE_VIEW_ID) })
    .catch(() => { /* 앱 밖 */ })
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
