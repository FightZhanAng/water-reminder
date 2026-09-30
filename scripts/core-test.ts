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
import { isActiveDate, nextReminderAt } from '../src/shared/schedule'
import { parseHolidayPayload, resolveWorkday } from '../src/shared/holiday'
import { recentDays, streakDays } from '../src/shared/stats'
import { isThemePref, THEME_PREFS } from '../src/shared/theme'
import {
  formatSize,
  isNewer,
  isTrustedAssetUrl,
  isTrustedReleaseUrl,
  parseSha256Digest,
  parseVersion,
  pickUpdateAsset
} from '../src/shared/update'
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

console.log('\n--- 主题偏好 ---')
check('默认跟随系统', DEFAULT_SETTINGS.theme, 'system')
check('非法偏好值被拒', isThemePref('midnight'), false)
check('合法偏好值被接受', isThemePref('dark'), true)
check('白名单覆盖全部偏好', THEME_PREFS.every(isThemePref), true)

console.log('\n--- 版本号比较（更新检查） ---')
check('解析带 v 前缀', JSON.stringify(parseVersion('v0.3.0')), '[0,3,0]')
check('解析不带前缀', JSON.stringify(parseVersion('0.3.0')), '[0,3,0]')
check('丢掉预发布后缀', JSON.stringify(parseVersion('0.4.0-beta.1')), '[0,4,0]')
check('解析不出来返回 null', parseVersion('latest'), null)
check('非字符串返回 null', parseVersion(undefined), null)
check('补丁号变大算新', isNewer('0.3.1', '0.3.0'), true)
check('次版本号变大算新', isNewer('0.4.0', '0.3.9'), true)
check('主版本号变大算新', isNewer('1.0.0', '0.9.9'), true)
check('位数不同也要比（0.4 vs 0.3.9）', isNewer('0.4', '0.3.9'), true)
check('同版本不算新', isNewer('0.3.0', '0.3.0'), false)
check('旧版本不算新', isNewer('0.2.9', '0.3.0'), false)
check('远端版本号解析不出来时不误报', isNewer('nightly', '0.3.0'), false)
check('本地版本号解析不出来时不误报', isNewer('0.4.0', 'dev'), false)
check('只认 github.com 的下载地址', isTrustedReleaseUrl('https://github.com/a/b/releases/tag/v1'), true)
check('别的域名被拒', isTrustedReleaseUrl('https://evil.example.com/x.exe'), false)
check('http 也被拒', isTrustedReleaseUrl('http://github.com/a/b'), false)
check('非字符串被拒', isTrustedReleaseUrl(undefined), false)

console.log('\n--- 应用内更新：挑包 / 摘要 / 下载地址 ---')

const asset = (name: string, size = 100, sha256: string | null = null) => ({
  name,
  url: `https://github.com/FightZhanAng/water-reminder/releases/download/v9.9.9/${name}`,
  size,
  sha256
})
const RELEASE_ASSETS = [
  asset('water-reminder-9.9.9-setup.exe', 100_031_839),
  asset('water-reminder-9.9.9-portable.exe', 99_796_368),
  asset('latest.yml', 300)
]

check(
  '安装版挑到 setup',
  pickUpdateAsset(RELEASE_ASSETS, 'setup')?.name,
  'water-reminder-9.9.9-setup.exe'
)
check(
  '免安装版挑到 portable',
  pickUpdateAsset(RELEASE_ASSETS, 'portable')?.name,
  'water-reminder-9.9.9-portable.exe'
)
check('没有对应资产时返回 null（渲染层据此退回打开发布页）', pickUpdateAsset([asset('latest.yml')], 'setup'), null)
check('空列表返回 null', pickUpdateAsset([], 'setup'), null)
check(
  '后缀必须完整匹配，不能被别的名字骗到',
  pickUpdateAsset([asset('water-reminder-9.9.9-setup.exe.blockmap')], 'setup'),
  null
)
check(
  '同一后缀出现多个时挑最大的',
  pickUpdateAsset([asset('a-setup.exe', 10), asset('b-setup.exe', 900)], 'setup')?.size,
  900
)
check('大小写不敏感', pickUpdateAsset([asset('X-Setup.EXE')], 'setup')?.name, 'X-Setup.EXE')

check('解析 sha256 摘要', parseSha256Digest(`sha256:${'a'.repeat(64)}`), 'a'.repeat(64))
check('摘要统一转小写', parseSha256Digest(`SHA256:${'A'.repeat(64)}`), 'a'.repeat(64))
check('容忍前后空白', parseSha256Digest(`  sha256:${'b'.repeat(64)}  `), 'b'.repeat(64))
check('别的算法被拒', parseSha256Digest(`sha512:${'a'.repeat(128)}`), null)
check('长度不足（截断）被拒', parseSha256Digest(`sha256:${'a'.repeat(63)}`), null)
check('长度超出被拒', parseSha256Digest(`sha256:${'a'.repeat(65)}`), null)
check('空摘要被拒 —— 不能宽松地当成合法值，否则校验永远通过', parseSha256Digest('sha256:'), null)
check('没有算法前缀被拒', parseSha256Digest('a'.repeat(64)), null)
check('非字符串被拒', parseSha256Digest(null), null)

const OK_ASSET_URL = `https://github.com/FightZhanAng/water-reminder/releases/download/v9.9.9/water-reminder-9.9.9-setup.exe`
const MOCK_PREFIX = 'http://127.0.0.1:8099/'

check('认本仓库的 releases/download 地址', isTrustedAssetUrl(OK_ASSET_URL), true)
check(
  '别的仓库被拒 —— 只校验 github.com 域名会放过任何人上传的包',
  isTrustedAssetUrl('https://github.com/evil/evil/releases/download/v1/x.exe'),
  false
)
check(
  '本仓库的非下载路径被拒',
  isTrustedAssetUrl('https://github.com/FightZhanAng/water-reminder/releases/tag/v9.9.9'),
  false
)
check(
  '本仓库的其他路径也被拒',
  isTrustedAssetUrl('https://github.com/FightZhanAng/water-reminder/issues'),
  false
)
check('http 被拒', isTrustedAssetUrl(OK_ASSET_URL.replace('https', 'http')), false)
check('空串被拒', isTrustedAssetUrl(''), false)
check('非字符串被拒', isTrustedAssetUrl(null), false)
check('验证模式下放行 mock 前缀', isTrustedAssetUrl(`${MOCK_PREFIX}x.exe`, MOCK_PREFIX), true)
check(
  '验证模式不会顺带放行别的地址',
  isTrustedAssetUrl('http://evil.example.com/x.exe', MOCK_PREFIX),
  false
)
check('空的前缀等于没开验证模式', isTrustedAssetUrl(`${MOCK_PREFIX}x.exe`, ''), false)

console.log('\n--- 体积文案（状态栏只有 440px） ---')
// 这组用例的存在理由是「失败原因被省略号截掉」：早先写的是
// 「应为 4198400 字节，实际收到 4194304」，界面上只显示到「实际收…」，
// 唯一有信息量的数字全没了。所以这里逐个钉死每种量级的输出。
check('0 字节', formatSize(0), '0 B')
check('负数按 0 处理', formatSize(-5), '0 B')
check('NaN 按 0 处理', formatSize(Number.NaN), '0 B')
check('不足 1KB 按字节', formatSize(512), '512 B')
check('少了 4 KB', formatSize(4096), '4 KB')
check('不到 1MB 还在 KB 档', formatSize(1023 * 1024), '1023 KB')
check('整 1MB 保留一位小数', formatSize(1024 * 1024), '1.0 MB')
check('4MB 的假包', formatSize(4194304), '4.0 MB')
check('95.4MB 的真安装包', formatSize(100031843), '95.4 MB')
check('刚好 100MB 起去掉小数', formatSize(100 * 1024 * 1024), '100 MB')
check('192MB', formatSize(201326592), '192 MB')

console.log('\n--- 节假日/调休：解析与判定 ---')
// 夹具取自 timor.tech 真实的 2026 年数据（元旦 1/1~1/3 休、1/4 周日补班；
// 2/14 周六春节前补班；10/1 国庆休、10/10 周六补班），日期的星期都是真的
const STAMP = at(2026, 9, 29, 12, 0)
const holidayRaw = {
  code: 0,
  holiday: {
    '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
    '01-02': { holiday: true, name: '元旦', date: '2026-01-02' },
    '01-03': { holiday: true, name: '元旦', date: '2026-01-03' },
    '01-04': { holiday: false, name: '元旦后补班', date: '2026-01-04' },
    '02-14': { holiday: false, name: '春节前补班', date: '2026-02-14' },
    '02-15': { holiday: true, name: '春节', date: '2026-02-15' },
    '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
    '10-10': { holiday: false, name: '国庆后补班', date: '2026-10-10' }
  }
}
const cal2026 = parseHolidayPayload(holidayRaw, 2026, STAMP)
check('解析出放假日与补班日', `${cal2026?.holidays['01-01']}/${cal2026?.workdays['01-04']}`, '元旦/元旦后补班')
check('解析保留更新时间', cal2026?.updatedAt, STAMP)
check('拒绝缺 holiday 字段的返回', parseHolidayPayload({}, 2026), null)
check('拒绝非对象返回', parseHolidayPayload('oops', 2026), null)
check('拒绝非法日期键', parseHolidayPayload({ holiday: { '1-1': { holiday: true } } }, 2026), null)
check('拒绝缺 holiday 标志的条目', parseHolidayPayload({ holiday: { '01-01': { name: 'x' } } }, 2026), null)
check('拒绝年份对不上的条目', parseHolidayPayload({ holiday: { '01-01': { holiday: true, date: '2025-01-01' } } }, 2026), null)
check('空数据视为不可用', parseHolidayPayload({ holiday: {} }, 2026), null)

check('法定节假日（周四）算休息', resolveWorkday(at(2026, 1, 1), cal2026), 'rest')
check('调休补班日（周日）算上班', resolveWorkday(at(2026, 1, 4), cal2026), 'workday')
check('调休补班日（周六）算上班', resolveWorkday(at(2026, 2, 14), cal2026), 'workday')
check('普通工作日算上班', resolveWorkday(at(2026, 3, 4), cal2026), 'workday')
check('普通周末算休息', resolveWorkday(at(2026, 3, 7), cal2026), 'rest')
check('日历不是这一年返回 unknown', resolveWorkday(at(2026, 3, 4), parseHolidayPayload(holidayRaw, 2025, STAMP)), 'unknown')
check('没有日历返回 unknown', resolveWorkday(at(2026, 3, 4), null), 'unknown')

console.log('\n--- 节假日/调休：接入调度 ---')
const holidayMode: Settings = { ...base, weekdaysOnly: true, weekdayMode: 'holiday' }
const plainMode: Settings = { ...base, weekdaysOnly: true, weekdayMode: 'plain' }
check('法定节假日的周四不提醒', isActiveDate(holidayMode, at(2026, 1, 1), cal2026), false)
check('调休补班的周日提醒', isActiveDate(holidayMode, at(2026, 1, 4), cal2026), true)
check('缺数据时按星期回退（周四是工作日）', isActiveDate(holidayMode, at(2026, 1, 1), null), true)
check('缺数据时按星期回退（周六不提醒）', isActiveDate(holidayMode, at(2026, 3, 7), null), false)
check('按星期模式不受节假日数据影响', isActiveDate(plainMode, at(2026, 1, 1), cal2026), true)
check('关掉仅工作日则节假日也提醒', isActiveDate({ ...base, weekdaysOnly: false, weekdayMode: 'holiday' }, at(2026, 1, 1), cal2026), true)

// 元旦 1/1(四)~1/3(六) 休、1/4(日) 补班：周四上午的下一个提醒点是补班日窗口起点
check('跨节假日跳到补班日窗口起点', nextReminderAt(holidayMode, at(2026, 1, 1, 10, 0), cal2026), at(2026, 1, 4, 9, 0))
check('周五晚跳到周六补班日', nextReminderAt(holidayMode, at(2026, 2, 13, 21, 30), cal2026), at(2026, 2, 14, 9, 0))
check('普通周五晚跳周一', nextReminderAt(holidayMode, at(2026, 3, 6, 21, 30), cal2026), at(2026, 3, 9, 9, 0))
check('缺数据时周五晚跳周一', nextReminderAt(holidayMode, at(2026, 2, 13, 21, 30), null), at(2026, 2, 16, 9, 0))

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks} 项通过`)
if (failures > 0) process.exitCode = 1
