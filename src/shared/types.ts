import type { ResolvedTheme, ThemePref } from './theme'
import type { HolidayStatus, WeekdayMode } from './holiday'
import type { UpdateCheck, UpdateDownload } from './update'

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
  /** 「工作日」的判定方式：按星期 / 按法定节假日与调休 */
  weekdayMode: WeekdayMode
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
  /** 外观主题：跟随系统 / 浅色 / 深色 */
  theme: ThemePref
  /** 启动后自动查一次更新（只提示，不自动下载） */
  autoCheckUpdate: boolean
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
  /**
   * 实际生效的主题（偏好 + 系统深浅合起来的结果）。
   *
   * 这个必须由主进程算完推下来，不能让渲染层自己去猜：
   * 系统在深浅之间切换时，Electron 会更新渲染层的 prefers-color-scheme，
   * 但**不会**给 matchMedia 派发 change 事件 —— 靠监听它，跟随系统就会僵在旧主题上。
   */
  resolvedTheme: ResolvedTheme
  /** 应用版本，来自主进程的 app.getVersion() */
  version: string
  /** 最近一次更新检查的结果；从没查过就是 null */
  update: UpdateCheck | null
  /**
   * 应用内下载安装的进度。
   *
   * 和 update 分开推：一个是「查到了什么」，一个是「正在做什么」。
   * 合在一起就得回答「正在下载时 update.state 算哪个」这种问题，
   * 渲染层只能靠字段猜。
   */
  download: UpdateDownload
  /** 节假日/调休数据的本地状态（今年有没有、什么时候更新的） */
  holiday: HolidayStatus
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
  /** 手动查一次更新；结果同时会通过 state 推下来 */
  checkUpdate(): Promise<UpdateCheck>
  /**
   * 在当前应用内下载、校验并安装新版本。
   * 成功走到安装那一步的话，本进程随后会自己退出；进度走 state 推下来。
   */
  downloadUpdate(): Promise<void>
  /**
   * 打开新版本的下载页。
   * 只在没法应用内安装时用（发布时漏了安装包）；主进程会校验域名，
   * 非 github.com 一律忽略并退回仓库的 releases 页。
   */
  openRelease(url: string): Promise<void>
  /** 拉取今年的节假日/调休数据并保存到本地；结果同时会通过 state 推下来 */
  holidayUpdate(): Promise<HolidayStatus>
  /** 小水滴页面把自己量到的渲染数据回报给主进程，写进 float.log */
  reportFloatMetrics(metrics: FloatMetrics): void
  pause(minutes: number): Promise<AppState>
  resume(): Promise<AppState>
  openDataDir(): Promise<void>
  /** 在系统浏览器里打开项目主页；地址写死在主进程，渲染层不传参数 */
  openRepo(): Promise<void>
  openMain(): Promise<void>
  quit(): Promise<void>
  notifyFloatReady(): void
  onState(cb: (state: AppState) => void): () => void
  onReminder(cb: () => void): () => void
}
