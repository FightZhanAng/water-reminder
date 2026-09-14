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

export function nextDayStart(ts: number): number {
  const d = new Date(startOfDay(ts))
  d.setDate(d.getDate() + 1)
  return d.getTime()
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

export function formatWeekday(dateKeyValue: string): string {
  const [y, m, d] = dateKeyValue.split('-').map((v) => Number.parseInt(v, 10))
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()]
}

export function isWeekend(dateKeyValue: string): boolean {
  const [y, m, d] = dateKeyValue.split('-').map((v) => Number.parseInt(v, 10))
  const wd = new Date(y, m - 1, d).getDay()
  return wd === 0 || wd === 6
}
