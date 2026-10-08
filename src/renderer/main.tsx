import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// macOS 的红绿灯画在左上角（约 80px 宽），Windows 三键在右上角 —— 标题栏留位方向
// 相反，CSS 按 html.is-mac 区分。用 UA 判断就够了：渲染层只缺这一个事实，
// 为它开一条 IPC 通道不值。主进程侧已确认小水滴是 frame: false，不会冒红绿灯
if (/Mac/i.test(navigator.userAgent)) document.documentElement.classList.add('is-mac')

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
