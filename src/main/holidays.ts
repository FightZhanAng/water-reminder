import { net } from 'electron'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  isUsableCalendar,
  parseHolidayPayload,
  type HolidayCalendar,
  type HolidayStatus
} from '../shared/holiday'

const TIMEOUT_MS = 10_000
/** 缓存里最多留几个年份；跨年后旧数据没有判定价值，但也占不了几个字节 */
const KEEP_YEARS = 3

/**
 * 节假日数据的地址。
 *
 * 默认用 timor.tech 的年度接口（免费、免鉴权，一年查一次的量级毫无压力）。
 * `WATER_HOLIDAY_API` 是验证口子：`{year}` 会被替换成年份，本机测这条链路时
 * 把它指到本地 mock 服务器。
 */
function sourceUrl(year: number): string {
  const template = process.env['WATER_HOLIDAY_API'] ?? 'https://timor.tech/api/holiday/year/{year}'
  return template.replace('{year}', String(year))
}

/**
 * 节假日/调休数据的拉取与本地缓存。
 *
 * 数据必须落在磁盘而不是只在内存里：这是个常驻托盘工具，重启不该把
 * 「用户明确更新过」的数据丢掉。缓存按年份存，跨年后今年没数据会回到
 * missing 状态、界面上提示更新，判定本身回退到按星期（见 shared/schedule.ts）。
 */
export class HolidayStore {
  private readonly cache = new Map<number, HolidayCalendar>()
  private inflight: Promise<HolidayStatus> | null = null
  /** 最近一次拉取失败的原因；拉取成功或没有失败过就是 null */
  private lastError: { year: number; reason: string } | null = null

  constructor(
    private readonly filePath: string,
    private readonly appVersion: string
  ) {
    this.loadCache()
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>
      for (const [key, value] of Object.entries(raw)) {
        const year = Number.parseInt(key, 10)
        if (!Number.isInteger(year)) continue
        // 结构不完整的条目直接丢掉：判定会回退到按星期，总好过带着脏日历
        // 崩在 10 秒一次的巡检里（校验规则与网络来路共用，见 isUsableCalendar）
        if (isUsableCalendar(value, year)) this.cache.set(year, value)
      }
    } catch {
      // 没有缓存或文件损坏都从零开始，状态自然回到 missing，界面上会提示更新
    }
  }

  private persist(): void {
    const years = [...this.cache.keys()].sort((a, b) => b - a).slice(0, KEEP_YEARS)
    const payload: Record<string, HolidayCalendar> = {}
    for (const year of years) payload[String(year)] = this.cache.get(year)!
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      /*
       * 和数据文件同一套「临时文件 + fsync + rename」。
       * 直接 writeFileSync 会先把原文件截断再写：这时候断电，磁盘上就是半截 JSON。
       * 读盘校验会把半截文件判成「今年没数据」（降级按星期，不崩），但那等于把
       * 用户刚拉下来的日历白扔一次、还只留一句「点更新到本地」——等于让他再点一次。
       */
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.filePath)
    } catch (err) {
      // 写不进去只影响下次启动的缓存，判定功能本身不受影响
      console.error('[holiday] 缓存写入失败：', err)
    }
  }

  currentYear(): number {
    return new Date().getFullYear()
  }

  getCalendar(year = this.currentYear()): HolidayCalendar | null {
    const cal = this.cache.get(year)
    return cal && cal.year === year ? cal : null
  }

  getStatus(year = this.currentYear()): HolidayStatus {
    const cal = this.getCalendar(year)
    if (cal) {
      return {
        state: 'loaded',
        year,
        updatedAt: cal.updatedAt,
        restDays: Object.keys(cal.holidays).length,
        workdays: Object.keys(cal.workdays).length
      }
    }
    if (this.inflight) return { state: 'loading', year }
    if (this.lastError?.year === year) return { state: 'error', year, reason: this.lastError.reason }
    return { state: 'missing', year }
  }

  /** 拉取并缓存一年的数据。进行中重复调用会复用同一次请求 */
  async fetchYear(year = this.currentYear()): Promise<HolidayStatus> {
    if (this.inflight) return this.inflight
    this.inflight = this.doFetch(year).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doFetch(year: number): Promise<HolidayStatus> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await net.fetch(sourceUrl(year), {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': `water-reminder/${this.appVersion}`
        }
      })
      if (!res.ok) return this.fail(year, `数据源返回 ${res.status}`)

      const parsed = parseHolidayPayload(await res.json(), year, Date.now())
      if (!parsed) return this.fail(year, '返回里没有可用的调休数据')

      this.cache.set(year, parsed)
      this.lastError = null
      this.persist()
      return this.getStatus(year)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      return this.fail(year, humanize(raw, controller.signal.aborted))
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(year: number, reason: string): HolidayStatus {
    this.lastError = { year, reason }
    return { state: 'error', year, reason }
  }
}

/** 和 updater 里同一个思路：底层报错翻成人话，认不出的照原样透传 */
function humanize(raw: string, aborted: boolean): string {
  if (aborted) return '请求超时'
  if (/fetch failed|net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|CERT_|certificate/i.test(raw)) {
    return '连不上数据源，检查网络或代理'
  }
  return raw
}
