import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, fsyncSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, RETENTION_DAYS } from '../shared/defaults'
import { dayKey, startOfDay } from '../shared/date'
import { recentDays, streakDays } from '../shared/stats'
import type { DayTotal, DrinkLog, DrinkSource, Settings } from '../shared/types'

interface Persisted {
  version: number
  logs: DrinkLog[]
  settings: Settings
}

const FILE_VERSION = 1

/**
 * 用 JSON 单文件存储，不用 SQLite。
 *
 * 理由：一年满打满算 3650 条记录，全量读进内存也就几百 KB，
 * 聚合统计现算完全够用；而 better-sqlite3 是原生模块，
 * 一旦带上就得处理 electron-rebuild 和打包时的 ABI 匹配，
 * 对当前数据量来说是不划算的复杂度。真到了几十万条的规模再换。
 *
 * 写入用 「临时文件 + rename」 做原子替换，避免断电时把数据文件写坏。
 */
export class Store {
  private readonly file: string
  private data: Persisted

  constructor() {
    this.file = join(app.getPath('userData'), 'water-reminder.json')
    this.data = this.load()
    this.prune()
  }

  get dataFile(): string {
    return this.file
  }

  get settings(): Settings {
    return this.data.settings
  }

  get logs(): readonly DrinkLog[] {
    return this.data.logs
  }

  private load(): Persisted {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<Persisted>
        return {
          version: FILE_VERSION,
          logs: Array.isArray(raw.logs) ? raw.logs.filter(isValidLog) : [],
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
        }
      }
    } catch (err) {
      console.error('[store] 数据文件损坏，已重置为初始状态：', err)
    }
    return { version: FILE_VERSION, logs: [], settings: { ...DEFAULT_SETTINGS } }
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data), 'utf-8')
    // 显式落盘，早于 rename —— 否则崩溃可能留下一个「已改名但内容为空」的文件
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
  }

  patchSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.flush()
    return this.data.settings
  }

  addLog(ml: number, source: DrinkSource, ts = Date.now()): DrinkLog {
    const log: DrinkLog = { id: randomUUID(), ml: Math.round(ml), ts, source }
    this.data.logs.push(log)
    this.data.logs.sort((a, b) => a.ts - b.ts)
    this.flush()
    return log
  }

  removeLog(id: string): boolean {
    const before = this.data.logs.length
    this.data.logs = this.data.logs.filter((l) => l.id !== id)
    if (this.data.logs.length === before) return false
    this.flush()
    return true
  }

  undoLast(): DrinkLog | null {
    const last = this.data.logs.at(-1)
    if (!last) return null
    this.removeLog(last.id)
    return last
  }

  logsForDay(key: string): DrinkLog[] {
    return this.data.logs.filter((l) => dayKey(l.ts) === key)
  }

  totalForDay(key: string): number {
    return this.logsForDay(key).reduce((sum, l) => sum + l.ml, 0)
  }

  /** 近 n 天（含今天）的每日总量，缺失的日期补 0 */
  recentDays(n: number): DayTotal[] {
    return recentDays(this.data.logs, n)
  }

  /** 连续达成目标的天数 */
  streak(): number {
    return streakDays(this.data.logs, this.data.settings.dailyGoal)
  }

  private prune(): void {
    const cutoff = startOfDay(Date.now()) - RETENTION_DAYS * 86_400_000
    const kept = this.data.logs.filter((l) => l.ts >= cutoff)
    if (kept.length !== this.data.logs.length) {
      this.data.logs = kept
      this.flush()
    }
  }
}

function isValidLog(value: unknown): value is DrinkLog {
  if (!value || typeof value !== 'object') return false
  const l = value as Partial<DrinkLog>
  return typeof l.id === 'string' && typeof l.ml === 'number' && typeof l.ts === 'number'
}
