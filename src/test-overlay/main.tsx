import React from 'react'
import ReactDOM from 'react-dom/client'
import { TestOverlay } from './TestOverlay'
import '../styles/globals.css'
import { initTheme } from '../design/theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TestOverlay />
  </React.StrictMode>
)
