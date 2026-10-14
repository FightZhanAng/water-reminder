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
import {
  activeWindowAt,
  isActiveDate,
  nextAfterDrink,
  nextQuietRetryAt,
  nextReminderAt
} from '../src/shared/schedule'
import { isUsableCalendar, parseHolidayPayload, resolveWorkday } from '../src/shared/holiday'
import { formatClockWithDay } from '../src/shared/date'
import { sanitizeLog, sanitizeLogs } from '../src/shared/logs'
import { sanitizeSettingsPatch } from '../src/shared/settings'
import { recentDays, streakDays } from '../src/shared/stats'
import { isThemePref, THEME_PREFS } from '../src/shared/theme'
import {
  describeDownload,
  formatSize,
  humanizeNetworkError,
  isNewer,
  isTrustedAssetUrl,
  isTrustedReleaseUrl,
  parseSha256Digest,
  parseVersion,
  pickUpdateAsset,
  sizeOrDigestProblem
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

console.log('\n--- 下载状态文案派生（状态栏 / 关于弹窗共用） ---')
// 两处界面共用 describeDownload，这里把每种状态的输出逐字钉死：
// 文案是拼接出来的（版本号、字节数、全角空格），任何一环改动都该在这里被看见
const dlIdle = describeDownload({ state: 'idle' })
check('idle 不占按钮', dlIdle.busy, false)
check('idle 没有完整文案（让位给检查链路）', dlIdle.text, null)
check('idle 没有相位文案', dlIdle.phase, null)
check(
  '下载中带字节数',
  describeDownload({ state: 'downloading', latest: '9.9.9', received: 1024, total: 4096 }).text,
  '正在下载 9.9.9　1 KB / 4 KB'
)
check(
  '服务端没给总大小时不拼分母',
  describeDownload({ state: 'downloading', latest: '9.9.9', received: 512, total: 0 }).text,
  '正在下载 9.9.9　512 B'
)
check(
  '下载中的相位文案不含字节数 —— 读屏器只念一次，不跟 120ms 进度刷屏',
  describeDownload({ state: 'downloading', latest: '9.9.9', received: 1, total: 2 }).phase,
  '正在下载 9.9.9…'
)
check('校验中', describeDownload({ state: 'verifying', latest: '9.9.9' }).text, '正在校验安装包…')
check(
  '安装中',
  describeDownload({ state: 'installing', latest: '9.9.9' }).phase,
  '正在安装 9.9.9，应用即将重启…'
)
check('失败原因进 failed（按钮重试文案和 tone 靠它派生）', describeDownload({ state: 'error', reason: '下载超时' }).failed, '下载超时')
check('失败文案带前缀', describeDownload({ state: 'error', reason: '下载超时' }).text, '更新失败：下载超时')
check('失败时不再占按钮（让位给「重试下载」）', describeDownload({ state: 'error', reason: 'x' }).busy, false)

console.log('\n--- 体积与摘要校验 ---')
check('体积摘要都对得上', sizeOrDigestProblem({ size: 100, sha256: 'aa' }, 100, 'aa'), null)
check('少了字节报缺口', sizeOrDigestProblem({ size: 4096, sha256: null }, 0, ''), '安装包下载不完整（少了 4 KB）')
check('多出字节也拒', sizeOrDigestProblem({ size: 100, sha256: null }, 200, ''), '安装包大小与发布信息不符')
check('体积过关但摘要不符', sizeOrDigestProblem({ size: 100, sha256: 'aa' }, 100, 'bb'), '安装包校验失败')
check('发布方没给摘要时只查体积', sizeOrDigestProblem({ size: 100, sha256: null }, 100, 'whatever'), null)
check('体积未知（0）时跳过体积判定', sizeOrDigestProblem({ size: 0, sha256: null }, 12345, ''), null)
check('体积未知但摘要不符照样拒', sizeOrDigestProblem({ size: 0, sha256: 'aa' }, 12345, 'bb'), '安装包校验失败')

console.log('\n--- 网络报错翻人话 ---')
check('检查超时', humanizeNetworkError('The operation was aborted', true, '检查'), '请求超时')
check('下载超时', humanizeNetworkError('The operation was aborted', true, '下载'), '下载超时')
check('fetch failed', humanizeNetworkError('fetch failed', false, '检查'), '连不上 GitHub，检查网络或代理')
check('Chromium 网络错误', humanizeNetworkError('net::ERR_CERT_AUTHORITY_INVALID', false, '下载'), '连不上 GitHub，检查网络或代理')
check('DNS 解析失败', humanizeNetworkError('getaddrinfo ENOTFOUND api.github.com', false, '检查'), '连不上 GitHub，检查网络或代理')
check('连接被重置', humanizeNetworkError('read ECONNRESET', false, '下载'), '连不上 GitHub，检查网络或代理')
check('认不出的原文照原样透传', humanizeNetworkError('GitHub 返回 403', false, '检查'), 'GitHub 返回 403')

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

console.log('\n--- 打卡后的下一次提醒（必须真落在窗口内） ---')
// 这一组盯的是一个真实缺陷：朴素「现在 + 间隔」当时只比了窗口的上界，
// 而 activeWindowAt 对窗口起点之前的时刻照样返回当天的窗口对象，
// 于是 08:00 记一杯 → 下次提醒被排到 08:45，而窗口 09:00 才开始。
// 「不变量」那两条比单点更重要：单点只能钉住想得到的那几个时刻。
check('打卡在窗口前 → 回到窗口起点', nextAfterDrink(base, at(2026, 9, 16, 7, 0)), at(2026, 9, 16, 9, 0))
check('窗口前一刻打卡 → 回到窗口起点', nextAfterDrink(base, at(2026, 9, 16, 8, 0)), at(2026, 9, 16, 9, 0))
check('窗口内的朴素点原样保留', nextAfterDrink(base, at(2026, 9, 16, 8, 30)), at(2026, 9, 16, 9, 15))
check('窗口末尾打卡 → 次日窗口起点', nextAfterDrink(base, at(2026, 9, 16, 20, 30)), at(2026, 9, 17, 9, 0))
check('深夜打卡不排到凌晨', nextAfterDrink(base, at(2026, 9, 16, 23, 30)), at(2026, 9, 17, 9, 0))
check('周五晚打卡 → 周一窗口起点', nextAfterDrink(weekdays, at(2026, 9, 18, 20, 30)), at(2026, 9, 21, 9, 0))
check(
  '节假日打卡 → 补班日窗口起点',
  nextAfterDrink(holidayMode, at(2026, 1, 1, 10, 0), cal2026),
  at(2026, 1, 4, 9, 0)
)
{
  const probes = [0, 7, 8, 9, 12, 20, 23].map((h) => at(2026, 9, 16, h, h === 20 ? 30 : 0))
  // activeWindowAt 现在回答「此刻处在哪个窗口里」（终点算在内、窗口可跨夜），
  // 于是「排出来的点必须是窗口内的点」就是一句 null 判断
  const outside = probes
    .map((ts) => nextAfterDrink(base, ts))
    .filter((ts) => activeWindowAt(base, ts) === null)
  check('不变量：打卡排出的点全部落在窗口内', outside.length, 0)
}

console.log('\n--- 静默重试点也必须是合法提醒点 ---')
// 另一条真实缺陷：人离开后直接写「now + 5 分钟」，不看窗口也不看日期。
// 窗口终点那个提醒点（21:00 正好是栅格点）顺延 5 分钟就跑到窗口外；
// 窗口终点贴近午夜时会顺延到次日，于是在「仅工作日」下于周六弹通知。
check('窗口终点的重试 → 次日窗口起点', nextQuietRetryAt(base, at(2026, 9, 16, 21, 0)), at(2026, 9, 17, 9, 0))
check('窗口起点的重试 → 第一个栅格点', nextQuietRetryAt(base, at(2026, 9, 16, 9, 0)), at(2026, 9, 16, 9, 45))
check('窗口内的重试 → 下一个栅格点', nextQuietRetryAt(base, at(2026, 9, 16, 10, 30)), at(2026, 9, 16, 11, 15))
check(
  '周五深夜的重试不落到周六',
  nextQuietRetryAt({ ...base, weekdaysOnly: true, intervalMin: 5, activeEnd: '23:59' }, at(2026, 9, 18, 23, 55)),
  at(2026, 9, 21, 9, 0)
)
{
  const grid = [at(2026, 9, 16, 9, 0), at(2026, 9, 16, 10, 30), at(2026, 9, 16, 20, 30), at(2026, 9, 16, 21, 0)]
  const outside = grid
    .map((ts) => nextQuietRetryAt(base, ts))
    .filter((ts) => activeWindowAt(base, ts) === null)
  check('不变量：静默重试排出的点全部落在窗口内', outside.length, 0)
}

console.log('\n--- 跨夜窗口（结束时间不晚于开始时间即为次日） ---')
// 窗口归属它的开始日：21:00–09:00 的窗口里，凌晨那半截算「开始日」那天的。
// 这条归属决定「仅工作日 / 法定节假日」按哪一天判定，也决定栅格从哪一刻起算 ——
// 所以凌晨的点不是「第二天的第一个点」，而是同一个窗口里的点。
const night: Settings = { ...base, activeStart: '21:00', activeEnd: '09:00' }
const nightWeekday: Settings = { ...night, weekdaysOnly: true }
const nightHoliday: Settings = { ...night, weekdaysOnly: true, weekdayMode: 'holiday' }
const allDay: Settings = { ...base, activeStart: '09:00', activeEnd: '09:00' }

check(
  '夜里 22:00 落在当天 21:00 起的窗口里',
  activeWindowAt(night, at(2026, 9, 16, 22, 0))?.start,
  at(2026, 9, 16, 21, 0)
)
check(
  '跨夜窗口的终点落在次日早上',
  activeWindowAt(night, at(2026, 9, 16, 22, 0))?.end,
  at(2026, 9, 17, 9, 0)
)
check(
  '凌晨 3 点属于前一天开始的那一份窗口',
  activeWindowAt(night, at(2026, 9, 17, 3, 0))?.start,
  at(2026, 9, 16, 21, 0)
)
check('白天（10:00–21:00 之间）不在任何窗口里', activeWindowAt(night, at(2026, 9, 17, 12, 0)), null)
check('跨夜窗口内照旧按栅格推进', nextReminderAt(night, at(2026, 9, 16, 22, 0)), at(2026, 9, 16, 22, 30))
check('提醒点可以落在午夜之后', nextReminderAt(night, at(2026, 9, 16, 23, 50)), at(2026, 9, 17, 0, 0))
check('窗口结束后排到当晚窗口起点', nextReminderAt(night, at(2026, 9, 17, 10, 0)), at(2026, 9, 17, 21, 0))
check('白天排到当晚窗口起点', nextReminderAt(night, at(2026, 9, 17, 12, 0)), at(2026, 9, 17, 21, 0))
check('跨夜窗口里打卡：朴素点仍在时段内', nextAfterDrink(night, at(2026, 9, 16, 23, 30)), at(2026, 9, 17, 0, 15))
check('窗口结束前打卡：排到当晚窗口起点', nextAfterDrink(night, at(2026, 9, 17, 8, 30)), at(2026, 9, 17, 21, 0))
check(
  '仅工作日：周五深夜的点仍成立（窗口归周五）',
  nextReminderAt(nightWeekday, at(2026, 9, 18, 23, 50)),
  at(2026, 9, 19, 0, 0)
)
check(
  '仅工作日：周六凌晨仍处在前一晚（周五）的窗口里',
  activeWindowAt(nightWeekday, at(2026, 9, 19, 3, 0))?.start,
  at(2026, 9, 18, 21, 0)
)
check(
  '仅工作日：周日凌晨没有窗口（归属周六=休息日）',
  activeWindowAt(nightWeekday, at(2026, 9, 20, 3, 0)),
  null
)
check(
  '仅工作日：周六凌晨不提醒（窗口归周六）',
  nextReminderAt(nightWeekday, at(2026, 9, 20, 3, 0)),
  at(2026, 9, 21, 21, 0)
)
check('仅工作日：休息日当晚不排提醒', nextReminderAt(nightWeekday, at(2026, 9, 19, 22, 0)), at(2026, 9, 21, 21, 0))
check(
  '节假日凌晨仍归前一工作日的窗口',
  nextReminderAt(nightHoliday, at(2026, 1, 1, 2, 0), cal2026),
  at(2026, 1, 1, 2, 15)
)
check(
  '连续假期不排提醒，跳到补班日当晚',
  nextReminderAt(nightHoliday, at(2026, 1, 1, 22, 0), cal2026),
  at(2026, 1, 4, 21, 0)
)
check('起止相同 = 全天时段', activeWindowAt(allDay, at(2026, 9, 16, 15, 0))?.start, at(2026, 9, 16, 9, 0))
check('全天时段照常按栅格推进', nextReminderAt(allDay, at(2026, 9, 16, 10, 0)), at(2026, 9, 16, 10, 30))
{
  const probes = [
    at(2026, 9, 16, 22, 0),
    at(2026, 9, 17, 3, 0),
    at(2026, 9, 17, 8, 30),
    at(2026, 9, 17, 20, 0),
    at(2026, 9, 18, 23, 50)
  ]
  const outside = probes
    .map((ts) => nextReminderAt(night, ts))
    .filter((ts) => activeWindowAt(night, ts) === null)
  check('不变量：跨夜窗口排出的点也落在时段内', outside.length, 0)
}

console.log('\n--- 本地缓存里的日历能不能用 ---')
// 读盘路径原本只校验 year / updatedAt：缺 holidays / workdays 的对象能进到
// resolveWorkday，那句 `key in undefined` 抛的 TypeError 跑在 10 秒一次的巡检里。
// 校验不过是「当作没有这一年的数据」，判定回退按星期，界面提示去更新。
check('完整日历通过', isUsableCalendar(cal2026, 2026), true)
check('缺 holidays 字段被拒', isUsableCalendar({ year: 2026, workdays: {}, updatedAt: STAMP }, 2026), false)
check(
  'workdays 是数组被拒',
  isUsableCalendar({ year: 2026, holidays: { '01-01': '元旦' }, workdays: [], updatedAt: STAMP }, 2026),
  false
)
check('年份对不上被拒', isUsableCalendar(cal2026, 2025), false)
check(
  'updatedAt 缺失被拒',
  isUsableCalendar({ year: 2026, holidays: { '01-01': '元旦' }, workdays: {} }, 2026),
  false
)
check(
  'updatedAt 是 NaN 被拒',
  isUsableCalendar({ year: 2026, holidays: { '01-01': '元旦' }, workdays: {}, updatedAt: Number.NaN }, 2026),
  false
)
check(
  '日期键格式非法被拒',
  isUsableCalendar({ year: 2026, holidays: { '1-1': '元旦' }, workdays: {}, updatedAt: STAMP }, 2026),
  false
)
check(
  '名称不是字符串被拒',
  isUsableCalendar({ year: 2026, holidays: { '01-01': 1 }, workdays: {}, updatedAt: STAMP }, 2026),
  false
)
check('两张表都空被拒（等于没有日历）', isUsableCalendar({ year: 2026, holidays: {}, workdays: {}, updatedAt: STAMP }, 2026), false)
check('null 被拒', isUsableCalendar(null, 2026), false)

console.log('\n--- 设置项的合法化规则（渲染层 patch 与读盘共用一份） ---')
// 读盘路径原本完全不校验，实测：intervalMin 写成 "abc" → intervalMsOf 变 NaN →
// 当天剩下的提醒全丢、退化成一天一次；写成 null → 走 Number(null)=0 被夹成 5 分钟，
// 比用户设的 45 分钟响得还勤；时段写成非法时刻 → 窗口失效、提醒退回按间隔乱弹。
// 三条都是「响得不对」而不是报错，所以只能靠用例钉住。
const fullRoundTrip = sanitizeSettingsPatch({ ...DEFAULT_SETTINGS })
check(
  '全量设置过一遍规则后一个字段都不少（加新设置项时必须同步规则）',
  Object.keys(DEFAULT_SETTINGS)
    .filter((key) => !(key in fullRoundTrip))
    .join(','),
  ''
)
check('intervalMin 是字符串 → 回落默认值', sanitizeSettingsPatch({ intervalMin: 'abc' }).intervalMin, 45)
check('intervalMin 是 NaN → 回落默认值', sanitizeSettingsPatch({ intervalMin: Number.NaN }).intervalMin, 45)
check(
  'intervalMin 是 null → 回落默认值（不是被夹成 5 分钟）',
  sanitizeSettingsPatch({ intervalMin: null }).intervalMin,
  45
)
check('intervalMin 是数字字符串 → 照常取用', sanitizeSettingsPatch({ intervalMin: '60' }).intervalMin, 60)
check('intervalMin 超出上限 → 夹紧', sanitizeSettingsPatch({ intervalMin: 9999 }).intervalMin, 240)
check('dailyGoal 低于下限 → 夹紧', sanitizeSettingsPatch({ dailyGoal: 10 }).dailyGoal, 500)
check('时段格式非法 → 丢掉该键', sanitizeSettingsPatch({ activeStart: '99:99' }).activeStart, undefined)
check('时段合法 → 保留', sanitizeSettingsPatch({ activeStart: '21:00' }).activeStart, '21:00')
check('weekdayMode 乱码 → 丢掉', sanitizeSettingsPatch({ weekdayMode: '周末也提醒' }).weekdayMode, undefined)
check('theme 乱码 → 丢掉', sanitizeSettingsPatch({ theme: 'midnight' }).theme, undefined)
check('未知键不会进设置', Object.keys(sanitizeSettingsPatch({ 未知字段: 1 })).length, 0)
check('非对象输入 → 空 patch', Object.keys(sanitizeSettingsPatch('oops')).length, 0)
check('null 输入 → 空 patch', Object.keys(sanitizeSettingsPatch(null)).length, 0)
check('缺的键不会被补上（patch 语义：不动它）', sanitizeSettingsPatch({}).intervalMin, undefined)

console.log('\n--- 时刻文案：不在今天就必须写清是哪天 ---')
// 跨夜时段下「下次提醒 09:00」分不清是今早还是明早；「暂停至 04:00」同理
// （最长暂停 8 小时，晚上暂停必然跨到次日）
const noon = at(2026, 9, 16, 12, 0)
check('今天只显示时分', formatClockWithDay(at(2026, 9, 16, 9, 45), noon), '09:45')
check('明天加「明天」前缀', formatClockWithDay(at(2026, 9, 17, 9, 0), noon), '明天 09:00')
check('跨夜的提醒点分得清是哪天', formatClockWithDay(at(2026, 9, 17, 0, 0), at(2026, 9, 16, 23, 50)), '明天 00:00')
check('更远写月日', formatClockWithDay(at(2026, 9, 21, 21, 0), noon), '9月21日 21:00')
check(
  '跨月的明天也算明天',
  formatClockWithDay(at(2026, 10, 1, 9, 0), at(2026, 9, 30, 22, 0)),
  '明天 09:00'
)

console.log('\n--- 记录读盘清理（ml 范围 / source 白名单 / id 去重） ---')
// 坏记录比坏设置更外露：source 是对象时，渲染层那句
// `SOURCE_LABEL[log.source] ?? log.source` 会把对象交给 React 当子节点 —— 直接白屏。
// ml 是 0/负数则会让今日合计、连续达标、近 7 天全跟着错，且从界面上看不出来。
const mint = (() => {
  let n = 0
  return () => `mint-${(n += 1)}`
})()
const rec = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  ml: 250,
  ts: at(2026, 9, 16, 9, 0),
  source: 'manual',
  ...over
})

check('正常记录原样保留', sanitizeLogs([rec()], mint).length, 1)
check('source 是对象 → 回落 manual（否则渲染层会白屏）', sanitizeLog(rec({ source: { 恶意: 1 } }), mint)?.source, 'manual')
check('source 是未知字符串 → 回落 manual', sanitizeLog(rec({ source: 'unknown-src' }), mint)?.source, 'manual')
check('source 合法则保留', sanitizeLog(rec({ source: 'tray' }), mint)?.source, 'tray')
check('ml 是 0 → 丢掉整条', sanitizeLog(rec({ ml: 0 }), mint), null)
check('ml 是负数 → 丢掉整条', sanitizeLog(rec({ ml: -500 }), mint), null)
check('ml 超上限 → 夹到区间内（不丢记录）', sanitizeLog(rec({ ml: 5000 }), mint)?.ml, 2000)
check('ml 小于下限但为正 → 夹到下限', sanitizeLog(rec({ ml: 5 }), mint)?.ml, 10)
check('ts 是 NaN → 丢掉整条', sanitizeLog(rec({ ts: Number.NaN }), mint), null)
check('ts 是字符串 → 丢掉整条', sanitizeLog(rec({ ts: '昨天' }), mint), null)
check('id 缺失 → 补一个', String(sanitizeLog(rec({ id: undefined }), mint)?.id).startsWith('mint-'), true)
check('非对象 → 丢掉', sanitizeLog('oops', mint), null)
check('整个数组不是数组 → 空', sanitizeLogs('oops', mint).length, 0)
{
  const dup = sanitizeLogs([rec({ id: 'same' }), rec({ id: 'same', ts: at(2026, 9, 16, 10, 0) })], mint)
  check('id 撞车 → 重新发一个（渲染层 key 不能重复）', new Set(dup.map((l) => l.id)).size, 2)
  const sorted = sanitizeLogs(
    [rec({ id: 'late', ts: at(2026, 9, 16, 18, 0) }), rec({ id: 'early', ts: at(2026, 9, 16, 9, 0) })],
    mint
  )
  check('按时间排序（撤销「上一次」才等于时间上最后一次）', sorted.at(-1)?.id, 'late')
  check('坏记录不会把好记录带下水', sanitizeLogs([rec(), 'oops', null, rec({ id: 'l2', ml: -1 })], mint).length, 1)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks} 项通过`)
if (failures > 0) process.exitCode = 1
