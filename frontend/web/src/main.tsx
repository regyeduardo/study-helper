import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppProvider } from './context/AppContext'
import App from './App'
import './index.css'

// Initialize Mermaid
import mermaid from 'mermaid'
const savedBg = (() => {
  try { return JSON.parse(localStorage.getItem('diagram-bg') || 'null') } catch { return null }
})()
mermaid.initialize({
  startOnLoad: false,
  theme: savedBg === 'white' ? 'default' : savedBg && savedBg !== 'theme' ? 'dark' : 'default',
  securityLevel: 'loose',
  maxTextSize: 100000,
});

// Make mermaid available globally for the renderer
(window as any).mermaid = mermaid;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
)
