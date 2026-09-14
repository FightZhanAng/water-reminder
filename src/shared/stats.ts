import { dayKey, startOfDay } from './date'
import type { DayTotal, DrinkLog } from './types'

/** 按天聚合总毫升数 */
export function totalsByDay(logs: readonly DrinkLog[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const log of logs) {
    const key = dayKey(log.ts)
    map.set(key, (map.get(key) ?? 0) + log.ml)
  }
  return map
}

/** 近 days 天（含今天）的每日总量，缺失日期补 0 */
export function recentDays(logs: readonly DrinkLog[], days: number, now = Date.now()): DayTotal[] {
  const byDay = totalsByDay(logs)
  const today = startOfDay(now)
  const out: DayTotal[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = dayKey(d.getTime())
    out.push({ date: key, total: byDay.get(key) ?? 0 })
  }
  return out
}

/**
 * 连续达成目标的天数。
 * 今天还没打满不算断档 —— 这一天还没过完，不该提前判死。
 */
export function streakDays(
  logs: readonly DrinkLog[],
  goal: number,
  now = Date.now(),
  lookback = 400
): number {
  if (goal <= 0) return 0
  const byDay = totalsByDay(logs)
  const cursor = new Date(startOfDay(now))

  if ((byDay.get(dayKey(cursor.getTime())) ?? 0) < goal) {
    cursor.setDate(cursor.getDate() - 1)
  }

  let count = 0
  for (let i = 0; i < lookback; i++) {
    const key = dayKey(cursor.getTime())
    if ((byDay.get(key) ?? 0) >= goal) {
      count++
      cursor.setDate(cursor.getDate() - 1)
    } else {
      break
    }
  }
  return count
}
