import React from 'react'
import ReactDOM from 'react-dom/client'
import { ComposerBar } from '../components/ComposerBar'
import '../styles/globals.css'
import { initTheme } from '../design/theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ComposerBar />
  </React.StrictMode>
)
