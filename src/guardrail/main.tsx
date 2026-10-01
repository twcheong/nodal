import React from 'react'
import ReactDOM from 'react-dom/client'
import { GuardrailPopupWindow } from '../components/GuardrailPopupWindow'
import '../styles/globals.css'
import { initTheme } from '../design/theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GuardrailPopupWindow />
  </React.StrictMode>
)
