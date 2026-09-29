import { useEffect } from 'react'
import type { ResolvedTheme } from '@shared/theme'

/**
 * 把主进程算好的主题写到 `<html data-theme>` 上。
 *
 * 主题不在渲染层解析：系统深浅变化时，Electron 只更新 prefers-color-scheme，
 * 不给 matchMedia 派发 change 事件，所以「跟随系统」如果靠监听它就会僵住。
 * 主进程推下来的 resolvedTheme 才是权威值；CSS 里那份媒体查询只负责
 * React 挂载前的首帧兜底（见 tokens.css），状态没到时**不要**写 data-theme，
 * 否则会把兜底也一起挡掉，深色系统下先闪一帧白。
 */
export function useTheme(resolved: ResolvedTheme | undefined): void {
  useEffect(() => {
    if (!resolved) return
    document.documentElement.dataset['theme'] = resolved
  }, [resolved])
}
