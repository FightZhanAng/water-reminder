import { isValidHM } from './date'
import { isWeekdayMode } from './holiday'
import { isThemePref } from './theme'
import type { Settings } from './types'

/**
 * 取整数并夹到区间内；「没有数字可言」的输入（null / 布尔 / 空串 / NaN）回落默认值。
 *
 * 不能图省事直接 `Number(value)`：它把 null 变成 0、把 true 变成 1，于是
 * `intervalMin: null` 会被夹成 5 分钟（最快那一档）而不是回落到默认的 45 ——
 * 表现是「提醒比用户设置的还勤」，而且完全不报错。数字字符串仍然接受，
 * 手改数据文件时写成 "60" 很常见。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 设置项的合法化规则 —— **只有这一份**。
 *
 * 两个来路都得过它：
 *   1. 渲染层推上来的 patch：IPC 的另一头不可全信，界面也可能是旧版本留下的；
 *   2. 磁盘上的数据文件：会被手改、被别的工具改写（本仓库的调试流程就手写过它）。
 *
 * 放 shared 而不是主进程，是为了能跟着 `pnpm test:core` 一起钉住。它守的东西
 * 平时看不出来，一旦漏了就是「响得不对」：实测把 intervalMin 改成 null，
 * 间隔会从 45 分钟悄悄变成 5 分钟；改成字符串则算出 NaN，当天剩下的提醒全丢、
 * 退化成一天一次。非法时段更糟 —— 窗口直接失效，提醒退回到「按间隔乱弹」。
 *
 * 返回的是「能用的那些键」，缺的键由调用方决定（渲染层的 patch 不动它，
 * 读盘时由 DEFAULT_SETTINGS 兜底）。
 */
export function sanitizeSettingsPatch(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const p = raw as Record<string, unknown>
  const clean: Partial<Settings> = {}

  if (p.dailyGoal !== undefined) clean.dailyGoal = clampNumber(p.dailyGoal, 500, 8000, 2000)
  if (p.intervalMin !== undefined) clean.intervalMin = clampNumber(p.intervalMin, 5, 240, 45)
  if (typeof p.activeStart === 'string' && isValidHM(p.activeStart)) clean.activeStart = p.activeStart
  if (typeof p.activeEnd === 'string' && isValidHM(p.activeEnd)) clean.activeEnd = p.activeEnd
  if (p.weekdaysOnly !== undefined) clean.weekdaysOnly = Boolean(p.weekdaysOnly)
  if (isWeekdayMode(p.weekdayMode)) clean.weekdayMode = p.weekdayMode
  if (p.notifyEnabled !== undefined) clean.notifyEnabled = Boolean(p.notifyEnabled)
  if (p.soundEnabled !== undefined) clean.soundEnabled = Boolean(p.soundEnabled)
  if (p.floatEnabled !== undefined) clean.floatEnabled = Boolean(p.floatEnabled)
  if (p.floatTransparent !== undefined) clean.floatTransparent = Boolean(p.floatTransparent)
  if (p.floatAutoHideSec !== undefined)
    clean.floatAutoHideSec = clampNumber(p.floatAutoHideSec, 5, 120, 20)
  if (p.cupSize !== undefined) clean.cupSize = clampNumber(p.cupSize, 50, 1000, 250)
  if (p.quietWhenIdle !== undefined) clean.quietWhenIdle = Boolean(p.quietWhenIdle)
  if (p.idleThresholdMin !== undefined)
    clean.idleThresholdMin = clampNumber(p.idleThresholdMin, 1, 120, 8)
  if (p.autoLaunch !== undefined) clean.autoLaunch = Boolean(p.autoLaunch)
  if (isThemePref(p.theme)) clean.theme = p.theme
  if (p.autoCheckUpdate !== undefined) clean.autoCheckUpdate = Boolean(p.autoCheckUpdate)

  return clean
}
