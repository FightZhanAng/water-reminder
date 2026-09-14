/**
 * 核心逻辑无头测试。
 *
 * 覆盖两块最容易出错、又完全不需要窗口就能验证的东西：
 *   1) 提醒时间点的计算（漂移、跨天、跨周末、边界）
 *   2) 统计聚合（补零、连续天数）
 *
 * 跑法：pnpm test:core
 */
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { nextReminderAt } from '../src/shared/schedule'
import { recentDays, streakDays } from '../src/shared/stats'
import type { DrinkLog, Settings } from '../src/shared/types'

let checks = 0
let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  checks++
  if (actual === expected) {
    console.log(`ok    ${name}`)
    return
  }
  failures++
  console.log(`FAIL  ${name}`)
  console.log(`        实际 = ${String(actual)}`)
  console.log(`        期望 = ${String(expected)}`)
}

/** 本地时间构造，避免时区把测试搞成偶然通过 */
function at(y: number, m: number, d: number, h = 0, min = 0, s = 0): number {
  return new Date(y, m - 1, d, h, min, s, 0).getTime()
}

function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 2026-09-14 是周一；故 16 日周三、18 日周五、19 日周六、21 日下周一 */
const base: Settings = {
  ...DEFAULT_SETTINGS,
  weekdaysOnly: false,
  activeStart: '09:00',
  activeEnd: '21:00',
  intervalMin: 45
}

console.log('\n--- 提醒点计算 ---')
check('清晨（窗口前）归到窗口起点', nextReminderAt(base, at(2026, 9, 16, 8, 0)), at(2026, 9, 16, 9, 0))
check('窗口内对齐到下一个栅格', nextReminderAt(base, at(2026, 9, 16, 9, 0, 3)), at(2026, 9, 16, 9, 45))
check('正好踩在栅格点上必须前进一格', nextReminderAt(base, at(2026, 9, 16, 9, 45, 0)), at(2026, 9, 16, 10, 30))
check('窗口内的零头也向前取整', nextReminderAt(base, at(2026, 9, 16, 10, 20)), at(2026, 9, 16, 10, 30))
check('窗口末尾仍可提醒', nextReminderAt(base, at(2026, 9, 16, 20, 30)), at(2026, 9, 16, 21, 0))
check('过了窗口跨到次日', nextReminderAt(base, at(2026, 9, 16, 21, 30)), at(2026, 9, 17, 9, 0))
check('深夜跨到次日', nextReminderAt(base, at(2026, 9, 16, 23, 0)), at(2026, 9, 17, 9, 0))

console.log('\n--- 连续推进 5 次不应漂移 ---')
{
  const expected = [
    at(2026, 9, 16, 9, 45),
    at(2026, 9, 16, 10, 30),
    at(2026, 9, 16, 11, 15),
    at(2026, 9, 16, 12, 0),
    at(2026, 9, 16, 12, 45)
  ]
  let cursor = at(2026, 9, 16, 9, 0)
  expected.forEach((want, index) => {
    cursor = nextReminderAt(base, cursor)
    check(`第 ${index + 1} 个点 = ${clock(want)}`, clock(cursor), clock(want))
  })
}

console.log('\n--- 只工作日 ---')
const weekdays: Settings = { ...base, weekdaysOnly: true }
check('周六不提醒，跳到周一', nextReminderAt(weekdays, at(2026, 9, 19, 10, 0)), at(2026, 9, 21, 9, 0))
check('周五晚跳到周一', nextReminderAt(weekdays, at(2026, 9, 18, 21, 30)), at(2026, 9, 21, 9, 0))
check('周日跳周一', nextReminderAt(weekdays, at(2026, 9, 20, 15, 0)), at(2026, 9, 21, 9, 0))

console.log('\n--- 统计聚合 ---')
{
  const now = at(2026, 9, 16, 12, 0)
  const mk = (ts: number, ml: number): DrinkLog => ({ id: `x${ts}${ml}`, ts, ml, source: 'manual' })
  const logs: DrinkLog[] = [
    mk(at(2026, 9, 13, 10, 0), 500),
    mk(at(2026, 9, 14, 9, 30), 1000),
    mk(at(2026, 9, 14, 14, 0), 1000),
    mk(at(2026, 9, 15, 9, 30), 800),
    mk(at(2026, 9, 15, 13, 0), 700),
    mk(at(2026, 9, 15, 18, 0), 500),
    mk(at(2026, 9, 16, 9, 30), 500),
    mk(at(2026, 9, 16, 12, 0), 500)
  ]

  const week = recentDays(logs, 7, now)
  check('近 7 天长度', week.length, 7)
  check('近 7 天首日补零', week[0].total, 0)
  check('今天合计', week[6].total, 1000)
  check('今天日期键', week[6].date, '2026-09-16')
  check('8 天前的记录不计入窗口', week.some((d) => d.date === '2026-09-09'), false)

  // 今天 1000 未达标 → 从昨天开始数；周二、周一达标，周日不达标
  check('今天未达标不判死，连续天数从昨天算', streakDays(logs, 2000, now), 2)
  check('目标调低后连续天数变长', streakDays(logs, 1500, now), 2)
  check('目标为 0 时返回 0', streakDays(logs, 0, now), 0)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks} 项通过`)
if (failures > 0) process.exitCode = 1
