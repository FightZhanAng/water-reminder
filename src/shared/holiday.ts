/**
 * 法定节假日 / 调休的工作日判定。
 *
 * 与网络无关的纯逻辑放这儿：解析远端数据、判定某天是不是工作日、
 * 缺数据时的回退规则。跟着 pnpm test:core 一起测 ——
 * 判定写错了不会报错，只会「节假日照常吵你」或「补班日不提醒」。
 */

/** 一个年度的节假日/调休日历（来自 timor.tech 的年度接口） */
export interface HolidayCalendar {
  year: number
  /** 法定放假日 'MM-DD' → 名称 */
  holidays: Record<string, string>
  /** 调休补班日 'MM-DD' → 名称 */
  workdays: Record<string, string>
  /** 数据落本地的时间戳 */
  updatedAt: number
}

/** 「只在工作日提醒」时，工作日怎么判定 */
export type WeekdayMode =
  /** 按星期：周一到周五，周末一律不提醒（历史行为） */
  | 'plain'
  /** 按节假日：法定节假日不提醒，调休补班日提醒 */
  | 'holiday'

export const WEEKDAY_MODES: WeekdayMode[] = ['plain', 'holiday']

export function isWeekdayMode(value: unknown): value is WeekdayMode {
  return typeof value === 'string' && (WEEKDAY_MODES as string[]).includes(value)
}

/** 渲染层看到的节假日数据状态 */
export type HolidayStatus =
  | { state: 'loaded'; year: number; updatedAt: number; restDays: number; workdays: number }
  | { state: 'missing'; year: number }
  | { state: 'loading'; year: number }
  | { state: 'error'; year: number; reason: string }

interface HolidayEntry {
  holiday?: unknown
  name?: unknown
  date?: unknown
}

/**
 * 解析 timor.tech 年度接口的返回。
 *
 * 任何一处不符合预期都返回 null（宁可用回退规则，也不能拿残缺数据当真理）。
 * `holiday: true` 是放假日、`false` 是调休补班日，其余字段不参与判定。
 */
export function parseHolidayPayload(raw: unknown, year: number, now = Date.now()): HolidayCalendar | null {
  if (typeof raw !== 'object' || raw === null) return null
  const map = (raw as { holiday?: unknown }).holiday
  if (typeof map !== 'object' || map === null) return null

  const holidays: Record<string, string> = {}
  const workdays: Record<string, string> = {}
  for (const [key, entry] of Object.entries(map as Record<string, unknown>)) {
    if (!/^\d{2}-\d{2}$/.test(key)) return null
    if (typeof entry !== 'object' || entry === null) return null
    const e = entry as HolidayEntry
    // date 字段是「YYYY-MM-DD」，拿来交叉确认年份，防止把别的年份混进来
    if (typeof e.date === 'string' && !e.date.startsWith(`${year}-`)) return null
    const name = typeof e.name === 'string' && e.name ? e.name : key
    if (e.holiday === true) holidays[key] = name
    else if (e.holiday === false) workdays[key] = name
    else return null
  }
  // 一条都没有多半是「这个年份还没公布」，当成失败让上层提示，而不是静默当空日历用
  if (Object.keys(holidays).length === 0 && Object.keys(workdays).length === 0) return null
  return { year, holidays, workdays, updatedAt: now }
}

/** 某天的判定结果；unknown = 手里没有这一年的数据 */
export type WorkdayVerdict = 'workday' | 'rest' | 'unknown'

/**
 * 判定某个时刻是不是「上班的日子」。
 *
 * 调休补班日优先于「周末」，法定节假日优先于「工作日」，
 * 剩下的按星期。日历不是这一年的就返回 unknown，由调用方决定回退。
 */
export function resolveWorkday(ts: number, calendar: HolidayCalendar | null): WorkdayVerdict {
  const d = new Date(ts)
  if (!calendar || calendar.year !== d.getFullYear()) return 'unknown'
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (md in calendar.workdays) return 'workday'
  if (md in calendar.holidays) return 'rest'
  const weekday = d.getDay()
  return weekday === 0 || weekday === 6 ? 'rest' : 'workday'
}
