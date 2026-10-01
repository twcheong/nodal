import React from 'react'
import ReactDOM from 'react-dom/client'
import { SidetabOverlay } from '../components/SidetabOverlay'
import '../styles/globals.css'
import { initTheme } from '../design/theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidetabOverlay />
  </React.StrictMode>
)
