// ─────────────────────────────────────────────────────────────────────────────
// main.tsx — React 렌더러의 엔트리 포인트.
// index.html 의 #root 엘리먼트에 App 컴포넌트를 마운트한다.
// StrictMode 래핑은 dev 모드에서만 이중 렌더를 유발 — 훅의 부작용 클린업 누락을 조기에 잡아준다.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initTheme } from './design/theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
