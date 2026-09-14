export type DrinkSource = 'manual' | 'tray' | 'shortcut' | 'float' | 'notification'

export interface DrinkLog {
  id: string
  ml: number
  ts: number
  source: DrinkSource
}

export interface Settings {
  /** 每日目标，毫升 */
  dailyGoal: number
  /** 提醒间隔，分钟 */
  intervalMin: number
  /** 活跃时段起点 'HH:mm' */
  activeStart: string
  /** 活跃时段终点 'HH:mm' */
  activeEnd: string
  /** 仅工作日提醒 */
  weekdaysOnly: boolean
  /** 系统通知 */
  notifyEnabled: boolean
  /** 通知是否出声 */
  soundEnabled: boolean
  /** 桌面小水滴浮窗 */
  floatEnabled: boolean
  /**
   * 小水滴是否用透明背景。
   * 关掉 = 一块普通的不透明小面板，最稳；
   * 打开 = 真正「浮在桌面上」的水滴，但部分 Windows 环境下透明窗口会
   * 出现「窗口存在、isVisible 为 true、屏幕上却什么都没有」的情况。
   */
  floatTransparent: boolean
  /** 小水滴自动隐藏秒数 */
  floatAutoHideSec: number
  /** 快捷记录默认杯量 */
  cupSize: number
  /** 人离开时静默 */
  quietWhenIdle: boolean
  /** 判定离开的空闲分钟数 */
  idleThresholdMin: number
  /** 开机自启（仅打包后生效） */
  autoLaunch: boolean
}

export interface DayTotal {
  date: string
  total: number
}

/**
 * 小水滴窗口的运行态。
 * 「预览没反应」这种事必须在界面上看得见，否则它就是个黑盒：
 * 窗口没创建、创建了但不可见、可见但页面是空白，三种情况表现一模一样。
 */
export interface FloatState {
  created: boolean
  visible: boolean
  loaded: boolean
  /** 当前窗口是否使用透明背景 */
  transparent: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
  url: string
}

/**
 * 小水滴页面自己量出来的渲染数据。
 * 「窗口可见但屏幕空白」时，靠它区分是 DOM 没渲染出来（尺寸为 0）
 * 还是 DOM 正常但窗口没合成上（透明窗口的锅）。
 */
export interface FloatMetrics {
  bodyHeight: number
  cardWidth: number
  cardHeight: number
  cardBackground: string
  dropVisible: boolean
}

export interface AppState {
  today: {
    key: string
    total: number
    goal: number
    logs: DrinkLog[]
  }
  settings: Settings
  /** 下次提醒时间戳；null = 已暂停或永不提醒 */
  nextAt: number | null
  /** 暂停截止时间戳 */
  pausedUntil: number | null
  /** 近 7 天（含今天） */
  recent: DayTotal[]
  /** 连续达成目标的天数 */
  streak: number
}

/** preload 暴露给渲染层的桥接接口 */
export interface Api {
  getState(): Promise<AppState>
  addDrink(ml: number, source: DrinkSource): Promise<AppState>
  undoLast(): Promise<AppState>
  patchSettings(patch: Partial<Settings>): Promise<AppState>
  hideFloat(): Promise<void>
  extendFloat(): Promise<void>
  /** 手动预览一次小水滴，不用等提醒触发；返回窗口实际状态便于排查 */
  previewFloat(): Promise<FloatState>
  /** 小水滴页面把自己量到的渲染数据回报给主进程，写进 float.log */
  reportFloatMetrics(metrics: FloatMetrics): void
  pause(minutes: number): Promise<AppState>
  resume(): Promise<AppState>
  openDataDir(): Promise<void>
  openMain(): Promise<void>
  quit(): Promise<void>
  notifyFloatReady(): void
  onState(cb: (state: AppState) => void): () => void
  onReminder(cb: () => void): () => void
}
