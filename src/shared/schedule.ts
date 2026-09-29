import { nextDayStart, parseHM } from './date'
import { resolveWorkday, type HolidayCalendar } from './holiday'
import type { Settings } from './types'

export interface ActiveWindow {
  start: number
  end: number
}

/** 提醒间隔（毫秒），下限 5 分钟 */
export function intervalMsOf(settings: Settings): number {
  return Math.max(5, settings.intervalMin) * 60_000
}

/**
 * 这天该不该提醒（不含时段，只判「这天」）。
 *
 * 日历缺失时（没更新到当年数据、或日历不是这一年的）按星期回退：
 * 宁可节假日多提醒一句，也不能一声不吭 —— 沉默才是最伤「提醒工具」信誉的故障。
 */
export function isActiveDate(settings: Settings, ts: number, calendar: HolidayCalendar | null): boolean {
  if (!settings.weekdaysOnly) return true
  if (settings.weekdayMode === 'holiday') {
    const verdict = resolveWorkday(ts, calendar)
    if (verdict !== 'unknown') return verdict === 'workday'
  }
  const weekday = new Date(ts).getDay()
  return weekday !== 0 && weekday !== 6
}

/** 某时刻所处的活跃窗口；不在活跃日返回 null */
export function activeWindowAt(
  settings: Settings,
  ts: number,
  calendar: HolidayCalendar | null = null
): ActiveWindow | null {
  if (!isActiveDate(settings, ts, calendar)) return null
  const d = new Date(ts)
  const from = parseHM(settings.activeStart)
  const to = parseHM(settings.activeEnd)
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
  const start = dayStart + from.h * 3_600_000 + from.m * 60_000
  const end = dayStart + to.h * 3_600_000 + to.m * 60_000
  if (end <= start) return null
  return { start, end }
}

/**
 * 找出严格晚于 from 的下一个提醒点。
 *
 * 这是整个应用最核心的一段逻辑，也是最容易写错的一段：
 * 提醒点永远取「当天窗口起点 + 间隔的整数倍」，而不是「上次提醒 + 间隔」。
 * 只有前者能在系统休眠、定时器被节流、时钟被调整之后依然不漂移。
 */
export function nextReminderAt(
  settings: Settings,
  from: number,
  calendar: HolidayCalendar | null = null
): number {
  const step = intervalMsOf(settings)
  let probe = from

  for (let guard = 0; guard < 400; guard++) {
    const window = activeWindowAt(settings, probe, calendar)
    if (window && probe < window.end) {
      let next =
        probe <= window.start
          ? window.start
          : window.start + Math.ceil((probe - window.start) / step) * step
      // 正好落在栅格点上时，必须再前进一格
      if (next <= probe) next = probe + step
      if (next <= window.end) return next
      probe = window.end + 1
      continue
    }
    probe = nextDayStart(probe)
  }

  // 理论到不了这里；真到了就退化成一个朴素间隔，保证功能不中断
  return from + step
}
