import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { Simulator } from './lib/simulator'
import { store } from './lib/store'
import { inTauri, TauriSource } from './lib/tauriSource'
import { WsSource } from './lib/wsSource'

// 只有显式的 demo 构建才用模拟数据；连不上后端时绝不悄悄退回假数据。
// 桌面应用走 IPC，浏览器里访问独立服务走 WebSocket
const source = import.meta.env.VITE_DATA_SOURCE === 'sim' ? new Simulator() : inTauri ? new TauriSource() : new WsSource()
store.connect(source)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
