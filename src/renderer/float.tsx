import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FloatCard from './components/FloatCard'
import './float.css'

// 这里是浮窗页面的入口。
// 之前这个文件只导出了组件、没有挂载，结果就是：页面加载成功、脚本也执行了，
// 但 DOM 始终是空的 —— 透明模式下表现成「完全看不见」，
// 不透明模式下表现成「一块空白的浅蓝方块」。两个症状同一个原因。
const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <FloatCard />
  </StrictMode>
)
