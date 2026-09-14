import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  dailyGoal: 2000,
  intervalMin: 45,
  activeStart: '09:00',
  activeEnd: '21:00',
  weekdaysOnly: true,
  notifyEnabled: true,
  soundEnabled: false,
  floatEnabled: true,
  // 默认不透明。透明窗口在部分 Windows 环境下「isVisible 为 true 但屏幕上什么都没有」，
  // 默认值必须是那个一定能显示出来的。
  floatTransparent: false,
  floatAutoHideSec: 20,
  cupSize: 250,
  quietWhenIdle: true,
  idleThresholdMin: 8,
  autoLaunch: false
}

export const QUICK_AMOUNTS = [150, 250, 500]

/** 数据保留天数，超出后自动裁剪 */
export const RETENTION_DAYS = 400
