import { powerMonitor } from 'electron'
import { intervalMsOf, nextReminderAt, type ActiveWindow, activeWindowAt } from '../shared/schedule'
import type { Settings } from '../shared/types'

/** 状态巡检周期。10 秒足够，且远比 1 秒省电 */
const TICK_MS = 10_000
/** 因为人离开而静默后，多久再试一次 */
const QUIET_RETRY_MS = 5 * 60_000
/** 错过超过这个倍数的间隔，就认定是「睡了一觉」，不再补提醒 */
const STALE_FACTOR = 1.5

export interface SchedulerHooks {
  onFire(): void
  onTick(): void
}

/**
 * 提醒调度器（Electron 外壳）。
 *
 * 真正的时间计算在 shared/schedule.ts 里，那边不依赖 Electron，
 * 可以脱离窗口无头跑测试 —— 这块逻辑踩一次坑就够难受的了。
 * 这里只负责：定时巡检、判断该不该静默、把「到点了」抛出去。
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private cursor = 0
  private pausedUntilValue: number | null = null
  private settings: Settings

  constructor(
    settings: Settings,
    private readonly hooks: SchedulerHooks
  ) {
    this.settings = settings
  }

  get nextAt(): number | null {
    return this.pausedUntilValue ? null : this.cursor
  }

  get pausedUntil(): number | null {
    return this.pausedUntilValue
  }

  get intervalMs(): number {
    return intervalMsOf(this.settings)
  }

  /** 当前是否处于活跃时段内 */
  get inActiveWindow(): ActiveWindow | null {
    return activeWindowAt(this.settings, Date.now())
  }

  start(): void {
    this.cursor = nextReminderAt(this.settings, Date.now())
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  update(settings: Settings): void {
    this.settings = settings
    this.replan()
  }

  pause(minutes: number): void {
    this.pausedUntilValue = Date.now() + Math.max(1, minutes) * 60_000
    this.hooks.onTick()
  }

  resume(): void {
    this.pausedUntilValue = null
    this.replan()
  }

  replan(from = Date.now()): void {
    if (this.pausedUntilValue) return
    this.cursor = nextReminderAt(this.settings, from)
    this.hooks.onTick()
  }

  /** 打卡后调用：从现在起重新计时，而不是继续等原来那个点 */
  resetAfterDrink(): void {
    if (this.pausedUntilValue) return
    this.cursor = Date.now() + this.intervalMs
    this.hooks.onTick()
  }

  private tick(): void {
    const now = Date.now()

    if (this.pausedUntilValue) {
      if (now < this.pausedUntilValue) return
      this.pausedUntilValue = null
      this.replan(now)
      return
    }

    if (now < this.cursor) return

    // 离开太久 / 睡了一夜：不补提醒，直接重排
    if (now - this.cursor > this.intervalMs * STALE_FACTOR) {
      this.cursor = nextReminderAt(this.settings, now)
      this.hooks.onTick()
      return
    }

    if (this.isQuiet()) {
      this.cursor = now + QUIET_RETRY_MS
      this.hooks.onTick()
      return
    }

    this.cursor = nextReminderAt(this.settings, now)
    this.hooks.onFire()
    this.hooks.onTick()
  }

  private isQuiet(): boolean {
    if (!this.settings.quietWhenIdle) return false
    const idleSeconds = powerMonitor.getSystemIdleTime()
    return idleSeconds >= Math.max(1, this.settings.idleThresholdMin) * 60
  }
}
