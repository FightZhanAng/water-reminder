/** 'YYYY-MM-DD'（本地时区） */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

export function parseHM(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map((v) => Number.parseInt(v, 10))
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 }
}

/** 'HH:mm' 是否合法 */
export function isValidHM(hm: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return false
  const h = Number(m[1])
  const min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 'HH:mm'，不在今天时前面补一个日期。
 *
 * 「下次提醒 09:00」在跨夜时段里是有歧义的：那是今天早上还是明天早上？
 * 「暂停至 04:00」同理（最长可暂停 8 小时，晚上暂停必然跨到次日）。
 * 相对时间（「12 小时 30 分后」）没有这个问题，但托盘要的就是绝对时刻。
 *
 * 明天用「明天」，更远直接写「M月D日」——后者不会因为跨月、跨年而算错，
 * 也不需要判断「后天」「大后天」这些没有信息量的中间态。
 */
export function formatClockWithDay(ts: number, now = Date.now()): string {
  const clock = formatClock(ts)
  if (dayKey(ts) === dayKey(now)) return clock
  const d = new Date(now)
  // 用 Date 构造而不是加 86400000：夏令时切换那天，一天不是 24 小时
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  if (dayKey(ts) === dayKey(tomorrow)) return `明天 ${clock}`
  const t = new Date(ts)
  return `${t.getMonth() + 1}月${t.getDate()}日 ${clock}`
}

/** 'M-DD HH:mm'，用于「数据更新于 …」这类时间戳 */
export function formatStamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${formatClock(ts)}`
}

export function formatWeekday(dateKeyValue: string): string {
  const [y, m, d] = dateKeyValue.split('-').map((v) => Number.parseInt(v, 10))
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()]
}

export function isWeekend(dateKeyValue: string): boolean {
  const [y, m, d] = dateKeyValue.split('-').map((v) => Number.parseInt(v, 10))
  const wd = new Date(y, m - 1, d).getDay()
  return wd === 0 || wd === 6
}
