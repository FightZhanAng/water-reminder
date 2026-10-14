import { parseHM, startOfDay } from './date'
import { resolveWorkday, type HolidayCalendar } from './holiday'
import type { Settings } from './types'

export interface ActiveWindow {
  start: number
  /** 终点算在窗口内：排程允许「窗口末尾」那一个提醒点 */
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

/** 本地日零点往前/后挪几天。用 Date 构造而不是加减毫秒：跨月、跨年、夏令时都交给它 */
function addDays(ts: number, days: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

/**
 * 某个提醒日的活跃窗口。
 *
 * **窗口归属它的开始日**：这条归属决定了「仅工作日 / 法定节假日」按哪一天判定 ——
 * 21:00–09:00 这种跨夜窗口里，凌晨那半截算开始日那天的（周五晚到周六早上要提醒，
 * 周六晚到周日早上不提醒）。它同时决定栅格从哪一刻起算，所以不能改成按自然日判。
 *
 * 起 < 止 → 当天窗口；起 >= 止 → 跨夜窗口，止于次日（起 === 止 就是一个整天）。
 *
 * 时间点一律用 Date 构造，不用「当天零点 + h * 3600000」：后者在夏令时切换日
 * 会把整个窗口挪一小时（实测纽约 2026-03-08，配置的 09:00 起点变成了 10:00）。
 */
function windowOfDay(
  settings: Settings,
  dayStart: number,
  calendar: HolidayCalendar | null
): ActiveWindow | null {
  if (!isActiveDate(settings, dayStart, calendar)) return null
  const d = new Date(dayStart)
  const from = parseHM(settings.activeStart)
  const to = parseHM(settings.activeEnd)

  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), from.h, from.m, 0, 0).getTime()
  const overnight = to.h * 60 + to.m <= from.h * 60 + from.m
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    overnight ? d.getDate() + 1 : d.getDate(),
    to.h,
    to.m,
    0,
    0
  ).getTime()
  return { start, end }
}

/**
 * end 不早于 ts 的第一个窗口 —— 含「前一天跨夜过来的那一份」。
 *
 * 必须先看前一天：21:00–09:00 的窗口里，凌晨 3 点属于昨天开始的那一份。
 * 往后最多扫 400 天：周末和长假（春节 8 天）都在这段范围里；
 * 扫满还找不到只可能是日历数据坏掉了，交给调用方兜底。
 */
function firstWindowEndingAtOrAfter(
  settings: Settings,
  ts: number,
  calendar: HolidayCalendar | null
): ActiveWindow | null {
  let dayStart = addDays(startOfDay(ts), -1)
  for (let guard = 0; guard < 400; guard++) {
    const window = windowOfDay(settings, dayStart, calendar)
    if (window && window.end >= ts) return window
    dayStart = addDays(dayStart, 1)
  }
  return null
}

/**
 * 某时刻所处的活跃窗口；不在任何窗口内返回 null。跨夜窗口可能属于前一天，
 * 所以窗口的 start/end 和 ts 所在的自然日不一定是同一天。
 *
 * 终点算在内：排程允许「窗口末尾」那一个提醒点（见 nextReminderAt），
 * 判定「此刻是否在时段内」也得认这个边界，否则同一时刻两处结论不一致。
 */
export function activeWindowAt(
  settings: Settings,
  ts: number,
  calendar: HolidayCalendar | null = null
): ActiveWindow | null {
  const window = firstWindowEndingAtOrAfter(settings, ts, calendar)
  if (!window || ts < window.start || ts > window.end) return null
  return window
}

/**
 * 找出严格晚于 from 的下一个提醒点。
 *
 * 这是整个应用最核心的一段逻辑，也是最容易写错的一段：
 * 提醒点永远取「窗口起点 + 间隔的整数倍」，而不是「上次提醒 + 间隔」。
 * 只有前者能在系统休眠、定时器被节流、时钟被调整之后依然不漂移。
 *
 * 窗口可以跨夜，所以算出来的点完全可能落在午夜之后（21:00 起、45 分钟一个点，
 * 00:00 就是一个合法提醒点）—— 它不是「第二天的第一个点」，而是同一个窗口里的点。
 */
export function nextReminderAt(
  settings: Settings,
  from: number,
  calendar: HolidayCalendar | null = null
): number {
  const step = intervalMsOf(settings)
  let probe = from

  for (let guard = 0; guard < 400; guard++) {
    const window = firstWindowEndingAtOrAfter(settings, probe, calendar)
    if (!window) break

    let next =
      probe <= window.start
        ? window.start
        : window.start + Math.ceil((probe - window.start) / step) * step
    // 正好落在栅格点上时，必须再前进一格
    if (next <= probe) next = probe + step
    if (next <= window.end) return next
    // 这个窗口里已经没有剩下的栅格点，跳到窗口之后再接着找
    probe = window.end + 1
  }

  // 理论到不了这里（日历坏到一年都挑不出一个提醒日才会）；
  // 真到了就退化成一个朴素间隔，保证功能不中断
  return from + step
}

/** 因为人离开而静默后，隔多久再试一次 */
export const QUIET_RETRY_MS = 5 * 60_000

/**
 * 打卡之后的下一个提醒点。
 *
 * 朴素间隔「现在 + 间隔」只在它本身就是窗口内的提醒点时才成立 ——
 * 判断必须是「落在窗口内」，不能是「属于窗口那一天」：
 * activeWindowAt 回答的是「这个时刻处在哪个窗口里」，而窗口可以跨夜。
 * 放松成「不超过窗口终点」的后果是窗口开始前打卡会把提醒排到窗口之前：
 * 07:00 记一杯、间隔 45 分钟，下一次提醒被排到 07:45，而窗口 09:00 才开始。
 */
export function nextAfterDrink(
  settings: Settings,
  from: number,
  calendar: HolidayCalendar | null = null
): number {
  const naive = from + intervalMsOf(settings)
  if (activeWindowAt(settings, naive, calendar)) return naive
  return nextReminderAt(settings, naive, calendar)
}

/**
 * 「人离开，这次不提醒」之后的下一次尝试。
 *
 * 不能写成 `now + 重试间隔`：那个时刻不保证是合法提醒点。最后几个提醒点
 * 里就有一个可能正好落在窗口终点上，把它顺延 5 分钟就跑到窗口之外；
 * 窗口终点贴近午夜时还会顺延到次日，于是「仅工作日」在周六照常弹通知 ——
 * 越界的提醒恰恰是静默想躲开的东西。
 * 走回同一套排程：重试点仍然是栅格上的点，且必定在窗口内、在提醒日。
 */
export function nextQuietRetryAt(
  settings: Settings,
  from: number,
  calendar: HolidayCalendar | null = null
): number {
  return nextReminderAt(settings, from + QUIET_RETRY_MS, calendar)
}
