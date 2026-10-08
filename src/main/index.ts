import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeTheme,
  Notification,
  powerMonitor,
  session,
  shell,
  type TitleBarOverlay
} from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey, isValidHM } from '../shared/date'
import { isWeekdayMode, type HolidayStatus } from '../shared/holiday'
import { isThemePref, type ResolvedTheme } from '../shared/theme'
import { isTrustedReleaseUrl, type UpdateCheck, type UpdateDownload } from '../shared/update'
import type { AppState, DrinkSource, FloatMetrics, FloatState, Settings } from '../shared/types'
import { FloatWindow } from './float'
import { HolidayStore } from './holidays'
import { appIconPath, assetsDir, hardenWindow, loadRenderer, preloadPath } from './paths'

import { Scheduler } from './scheduler'
import { Store } from './store'
import { TrayController } from './tray'
import {
  checkForUpdate,
  cleanupLeftovers,
  downloadUpdate,
  launchAfterExit,
  releasePageUrl,
  repoPageUrl
} from './updater'

/**
 * Windows 通知身份（AppUserModelID）。
 *
 * 开发态必须和安装版分开，否则这两个坑一定会踩：
 *
 * 1) Electron 会按当前 AUMID 自动生成一个开始菜单快捷方式（文件名 Electron.lnk，
 *    位于 %APPDATA%\Microsoft\Windows\Start Menu\Programs），因为 Windows 要求
 *    「AUMID 必须有一个开始菜单快捷方式」才肯把通知归属于本应用。
 * 2) 但那个自动生成的快捷方式只写了 target + workingDirectory，**不带应用路径参数**。
 *
 * 于是共用同一个 AUMID 时：安装版弹出的通知被点击 → Windows 按 AUMID 找到开发版
 * 那个快捷方式 → 启动一个裸 electron.exe → 弹出 Electron 欢迎页
 * （页面还会贴心地提示 "electron.exe path-to-app"）。
 *
 * 分开之后，开发版的快捷方式只挂 .dev 的 AUMID，碰不到安装版的通知。
 */
const APP_ID = app.isPackaged ? 'com.tomcato.water-reminder' : 'com.tomcato.water-reminder.dev'
const QUICK_SHORTCUT = 'CommandOrControl+Alt+W'
const SMOKE = process.env['WATER_SMOKE_TEST'] === '1'

/**
 * 冒烟自检的输出目录。
 * Windows 上 GUI 进程不挂控制台，所以结论一律落到磁盘文件，
 * 否则「跑没跑起来」都判断不了。
 */
function smokeDir(): string {
  return join(tmpdir(), 'water-reminder-smoke')
}

// 最早的落点：先证明主进程脚本真的被执行了。
// 没有这一行，「Electron 没起来」和「起来了但提前退出」长得一模一样。
if (SMOKE) {
  const write = (name: string, body: string): void => {
    try {
      mkdirSync(smokeDir(), { recursive: true })
      writeFileSync(join(smokeDir(), name), body, 'utf-8')
    } catch {
      // 自检探针失败不影响正常运行
    }
  }

  write('boot.txt', `booted=${new Date().toISOString()}\npid=${process.pid}\nargv=${process.argv.join(' ')}\n`)

  // 启动期崩溃在 GUI 模式下是彻底静默的，必须落到文件里
  process.on('uncaughtException', (err) => write('crash.txt', String(err?.stack ?? err)))
  process.on('unhandledRejection', (reason) => write('crash.txt', `unhandledRejection: ${String(reason)}`))
}

let store: Store
let scheduler: Scheduler
let tray: TrayController
let float: FloatWindow
let holidayStore: HolidayStore

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let lastSignature = ''
let activeNotification: Notification | null = null

/* ------------------------------------------------------------------ 主题 */

/**
 * 窗口底色（不是页面底色，页面由 CSS 决定）。
 * 这个值决定「窗口出现到页面首帧之间」闪什么颜色，
 * 所以必须和 tokens.css 里的 --bg 对齐 —— 主进程读不到 CSS，只能各写一份。
 */
const WINDOW_BG = { light: '#e8f1f3', dark: '#03080e' } as const

/** 浮窗不透明模式下整块被卡片铺满，底色对齐 --surface-solid 而不是 --bg */
const FLOAT_BG = { light: '#fbffff', dark: '#0a212b' } as const

/**
 * 自绘标题栏（Windows 的 Window Controls Overlay）。
 *
 * 原生 caption 不听应用的深浅：它的着色优先级是
 * 「应用显式设的 caption 色 > 系统强调色 > 应用深浅」，光把偏好灌进
 * nativeTheme.themeSource 动不了它 —— 系统一开「在标题栏和窗口边框上显示强调色」
 * 更是直接锁死成一个颜色（DWM\ColorPrevalence）。表现就是深色面板顶着一条
 * 浅色标题栏，切主题时页面上下一片变色、只有头顶那条不动。
 *
 * 唯一能跟着主题走的做法：把原生 caption 藏掉（titleBarStyle: 'hidden'），
 * 只留系统的三个按钮。底色给全透明 —— 等于把标题栏这块交回渲染层自己画
 * （页面里就是 .topbar，底色跟着 --surface 走），这里只管三键符号的颜色，
 * 因为它画在网页之上，CSS 够不着。主题一变就调 setTitleBarOverlay 重新着色。
 */
const TITLEBAR = { light: '#062730', dark: '#e4f3f5' } as const

/**
 * 标题栏高度。渲染层的 `--titlebar-h` 必须和它一致：
 * 三键的高度和纵向位置由这个值决定，对不上就会出现「按钮贴着上半截」的错位。
 */
const TITLEBAR_HEIGHT = 34

/**
 * 把应用的外观偏好灌给 Electron。
 *
 * themeSource 一设，渲染层的 `prefers-color-scheme` 就跟着变，原生控件
 * （数字框的上下箭头、时间选择、滚动条）也一起进深色，首帧就已经是对的。
 * 但页面自己的颜色不认它：渲染层用的是推下去的 `resolvedTheme` ——
 * 系统深浅切换时 Electron 不会给渲染层的 matchMedia 派发 change 事件。
 */
function applyThemeSource(): void {
  const pref = store.settings.theme
  nativeTheme.themeSource = isThemePref(pref) ? pref : 'system'
}

function currentWindowBg(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light
}

function currentFloatBg(): string {
  return nativeTheme.shouldUseDarkColors ? FLOAT_BG.dark : FLOAT_BG.light
}

/**
 * 三键符号的颜色随主题走 —— 深色底上留深色符号等于把按钮删了。
 * 底色恒定透明：标题栏的底色由渲染层的 .topbar 画，换主题时才能整条一起过过渡。
 */
function currentTitleBarOverlay(): TitleBarOverlay {
  return {
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? TITLEBAR.dark : TITLEBAR.light,
    height: TITLEBAR_HEIGHT
  }
}

/** themeSource 里已经是偏好值，shouldUseDarkColors 就是把偏好和系统合起来的结果 */
function currentTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * 主题变了要同步窗口底色和三键符号；跟随系统时，系统切换也走这里。
 * setTitleBarOverlay 只在 Windows 存在（标注 @platform win32,linux）——
 * macOS 的红绿灯由系统画、永远彩色，不吃 symbolColor，调了就是未定义行为。
 */
function syncWindowTheme(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(currentWindowBg())
    if (process.platform === 'win32') {
      mainWindow.setTitleBarOverlay(currentTitleBarOverlay())
    }
  }
  float?.setBackground(currentFloatBg())
}

/* --------------------------------------------------------------- 更新检查 */

/** 最近一次检查结果。从没查过就是 null，渲染层据此显示「检查更新」 */
let updateState: UpdateCheck | null = null

/** 应用内下载安装的进度。idle = 当前没在做事（也从没做过） */
let downloadState: UpdateDownload = { state: 'idle' }

/** 启动后隔一会儿再查：别和启动那一堆事抢资源，也别让首屏先闪一下「正在检查」 */
const UPDATE_CHECK_DELAY_MS = 8000

/**
 * 进度推送的最小间隔。
 *
 * 100MB 的包会切出上千个数据块；每个块都推一次状态，渲染层就要把整棵树重渲染
 * 上千遍 —— 界面反而会在下载期间卡住。字节是匀速来的，120ms 一次肉眼已经是连续的了。
 */
const PROGRESS_INTERVAL_MS = 120

/**
 * 退出前的等待。必须留：`app.quit()` 之后进程就不处理渲染层了，
 * 不给这一步的话「正在安装」这四个字可能一次都没画出来。
 */
const INSTALL_QUIT_DELAY_MS = 900

/**
 * 安装阶段的看门狗。
 *
 * 退出被什么东西挡住（比如某个 beforeunload 拦了 close）时，界面会永久停在
 * 「正在安装，即将重启」上 —— 用户既装不上也退不出，只能去杀进程。
 * 到点就把状态复位，至少让他知道要自己动手。
 */
const INSTALL_WATCHDOG_MS = 15 * 60_000

let installWatchdog: ReturnType<typeof setTimeout> | null = null
let lastProgressAt = 0

async function runUpdateCheck(): Promise<UpdateCheck> {
  updateState = await checkForUpdate(app.getVersion())
  // 重查一次就把上一轮的失败留在历史上：版本号可能都变了，
  // 界面上挂着「0.9.0 下载失败」而实际要装的是 1.0.0，只会让人更糊涂。
  // 下载中/校验中/安装中不动 —— 那是正在进行的事，不能被一次查询打断。
  if (downloadState.state === 'idle' || downloadState.state === 'error') {
    downloadState = { state: 'idle' }
  }
  refresh(true)
  return updateState
}

/**
 * 应用内完成下载 → 校验 → 安装。
 *
 * 为什么不做「静默下载、退出时替换」那一套：免安装版没有安装器能把自己重新拉起来，
 * 而引一个外置 updater 又会顺带接管安装路径，把现有的便携用法一起破坏掉。
 * 现在的做法是：
 *   - 安装版 → 下 setup.exe 并启动它（安装器自己会关掉旧实例、装完重启）；
 *   - 免安装版 → 把同目录的新 portable.exe 下下来，覆盖后再启动它。
 * 两条路都保住 `%APPDATA%\water-reminder`，记录不会丢。
 */
async function runUpdateDownload(): Promise<void> {
  const pending = updateState?.state === 'update' ? updateState : null

  if (!pending) {
    downloadState = { state: 'error', reason: '还没查到新版本，请先检查更新' }
    refresh(true)
    return
  }
  if (!pending.asset) {
    // 发布时漏了安装包、或者文件名不符合约定。宁可让用户去发布页手动下，
    // 也不能随手挑一个资产当安装包执行
    downloadState = { state: 'error', reason: '这个版本没有可直接安装的包，请到发布页下载' }
    refresh(true)
    return
  }
  if (downloadState.state === 'downloading' || downloadState.state === 'verifying') return
  if (downloadState.state === 'installing') return

  const latest = pending.latest
  downloadState = { state: 'downloading', latest, received: 0, total: pending.asset.size }
  lastProgressAt = 0
  refresh(true)

  try {
    const file = await downloadUpdate(pending.asset, {
      onProgress: ({ received, total }) => {
        const now = Date.now()
        if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return
        lastProgressAt = now
        downloadState = { state: 'downloading', latest, received, total }
        refresh()
      },
      onVerifying: () => {
        downloadState = { state: 'verifying', latest }
        refresh(true)
      }
    })

    downloadState = { state: 'installing', latest }
    refresh(true)

    // 先起助手再退出：助手会等我们这个 pid 消失，然后才把安装包拉起来。
    // 顺序反过来（先退再起）在免安装版上会撞单实例锁 —— 新包就是我们自己。
    launchAfterExit(file)

    installWatchdog = setTimeout(() => {
      downloadState = { state: 'idle' }
      refresh(true)
    }, INSTALL_WATCHDOG_MS)

    setTimeout(() => {
      isQuitting = true
      app.quit()
    }, INSTALL_QUIT_DELAY_MS)
  } catch (err) {
    downloadState = { state: 'error', reason: err instanceof Error ? err.message : String(err) }
    refresh(true)
  }
}

/* ------------------------------------------------------- 节假日/调休数据 */

/**
 * 把节假日数据更新一遍：数据落本地后必须重排提醒
 * （比如补上的调休补班日就在本周六，nextAt 立刻就变了）。
 */
async function runHolidayUpdate(): Promise<HolidayStatus> {
  const status = await holidayStore.fetchYear()
  if (status.state === 'loaded') scheduler.replan()
  refresh(true)
  return status
}

/** 「按节假日判定」开着、但今年还没数据：这种状态才会去拉 */
function needsHolidayFetch(): boolean {
  const { weekdaysOnly, weekdayMode } = store.settings
  return weekdaysOnly && weekdayMode === 'holiday' && holidayStore.getStatus().state === 'missing'
}

/* ------------------------------------------------------------------ 状态 */

function buildState(): AppState {
  const key = dayKey(Date.now())
  const logs = store.logsForDay(key)
  return {
    today: {
      key,
      total: logs.reduce((sum, log) => sum + log.ml, 0),
      goal: store.settings.dailyGoal,
      logs
    },
    settings: store.settings,
    nextAt: scheduler.nextAt,
    pausedUntil: scheduler.pausedUntil,
    recent: store.recentDays(7),
    streak: store.streak(),
    resolvedTheme: currentTheme(),
    version: app.getVersion(),
    update: updateState,
    download: downloadState,
    holiday: holidayStore.getStatus()
  }
}

/**
 * 把秒级抖动抹掉，这样倒计时不会每 10 秒推一次状态。
 * 下载进度同理按千分比进签名：原样带上字节数的话，一次 100MB 的下载
 * 会推出上千条各不相同的状态，渲染层每次都重渲染整棵树。
 */
function progressKey(download: UpdateDownload): unknown {
  if (download.state !== 'downloading') return download
  const permille =
    download.total > 0 ? Math.round((download.received / download.total) * 1000) : 0
  return { state: download.state, latest: download.latest, permille }
}

function signatureOf(state: AppState): string {
  return JSON.stringify({
    today: state.today,
    settings: state.settings,
    nextAt: state.nextAt === null ? null : Math.floor(state.nextAt / 60_000),
    pausedUntil: state.pausedUntil === null ? null : Math.floor(state.pausedUntil / 60_000),
    recent: state.recent,
    streak: state.streak,
    resolvedTheme: state.resolvedTheme,
    version: state.version,
    update: state.update,
    download: progressKey(state.download),
    holiday: state.holiday
  })
}

function refresh(force = false): void {
  const state = buildState()
  tray?.update(state)
  const signature = signatureOf(state)
  if (!force && signature === lastSignature) return
  lastSignature = signature
  mainWindow?.webContents.send('state:changed', state)
  float?.send('state:changed', state)
}

/* ------------------------------------------------------------------ 窗口 */

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    // 比内容区多出标题栏那一条：多来的 TITLEBAR_HEIGHT 就是「关于」所在的行，
    // 不补上的话这条会把内容区压扁 34px（同样的窗口高度，能看的内容变少了）
    height: 700 + TITLEBAR_HEIGHT,
    minWidth: 400,
    minHeight: 580 + TITLEBAR_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    title: '喝水提醒',
    icon: appIconPath(),
    backgroundColor: currentWindowBg(),
    // 原生标题栏换成自绘（原因见 TITLEBAR 注释）：页面顶上那条 .topbar 就是标题栏。
    // overlay 对象只在 win32 传：macOS 的 titleBarStyle: 'hidden' 自己会把红绿灯
    // 画在左上角（系统管的，不吃 symbolColor），overlay 的着色对它没意义
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? currentTitleBarOverlay() : undefined,
    webPreferences: {
      preload: preloadPath(),
      sandbox: false
    }
  })

  hardenWindow(win)
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())

  // 关掉只是收进托盘。真要退出走托盘菜单或界面里的退出按钮
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    mainWindow = null
  })

  loadRenderer(win, 'index')
  return win
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* --------------------------------------------------------------- 业务动作 */

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function sanitizeMl(value: unknown): number {
  return clampNumber(value, 10, 2000, 250)
}

function addDrink(ml: number, source: DrinkSource): AppState {
  store.addLog(sanitizeMl(ml), source)
  scheduler.resetAfterDrink()
  refresh()
  return buildState()
}

/** 到点了：发通知 + 放小水滴 */
function handleFire(): void {
  const state = buildState()
  const settings = store.settings

  if (settings.notifyEnabled && Notification.isSupported()) {
    const notification = new Notification({
      title: '该喝水了',
      body: `今日 ${state.today.total} / ${state.today.goal} ml · 点此记录 ${settings.cupSize} ml`,
      silent: !settings.soundEnabled
    })
    notification.on('click', () => {
      addDrink(settings.cupSize, 'notification')
      showMainWindow()
    })
    notification.on('close', () => {
      if (activeNotification === notification) activeNotification = null
    })
    notification.show()
    // 必须留引用：Windows 上对象一旦被回收，click 回调就可能不再触发
    activeNotification = notification
  }

  if (settings.floatEnabled) float.show(settings.floatAutoHideSec)
  refresh(true)
}

function applySettings(patch: Partial<Settings>): AppState {
  const clean: Partial<Settings> = {}
  if (patch.dailyGoal !== undefined) clean.dailyGoal = clampNumber(patch.dailyGoal, 500, 8000, 2000)
  if (patch.intervalMin !== undefined) clean.intervalMin = clampNumber(patch.intervalMin, 5, 240, 45)
  if (patch.activeStart !== undefined && isValidHM(patch.activeStart)) clean.activeStart = patch.activeStart
  if (patch.activeEnd !== undefined && isValidHM(patch.activeEnd)) clean.activeEnd = patch.activeEnd
  if (patch.weekdaysOnly !== undefined) clean.weekdaysOnly = Boolean(patch.weekdaysOnly)
  if (patch.weekdayMode !== undefined && isWeekdayMode(patch.weekdayMode))
    clean.weekdayMode = patch.weekdayMode
  if (patch.notifyEnabled !== undefined) clean.notifyEnabled = Boolean(patch.notifyEnabled)
  if (patch.soundEnabled !== undefined) clean.soundEnabled = Boolean(patch.soundEnabled)
  if (patch.floatEnabled !== undefined) clean.floatEnabled = Boolean(patch.floatEnabled)
  if (patch.floatTransparent !== undefined)
    clean.floatTransparent = Boolean(patch.floatTransparent)
  if (patch.floatAutoHideSec !== undefined)
    clean.floatAutoHideSec = clampNumber(patch.floatAutoHideSec, 5, 120, 20)
  if (patch.cupSize !== undefined) clean.cupSize = clampNumber(patch.cupSize, 50, 1000, 250)
  if (patch.quietWhenIdle !== undefined) clean.quietWhenIdle = Boolean(patch.quietWhenIdle)
  if (patch.idleThresholdMin !== undefined)
    clean.idleThresholdMin = clampNumber(patch.idleThresholdMin, 1, 120, 8)
  if (patch.autoLaunch !== undefined) clean.autoLaunch = Boolean(patch.autoLaunch)
  if (patch.theme !== undefined && isThemePref(patch.theme)) clean.theme = patch.theme
  if (patch.autoCheckUpdate !== undefined)
    clean.autoCheckUpdate = Boolean(patch.autoCheckUpdate)

  const wasFloatEnabled = store.settings.floatEnabled
  const wasAutoCheck = store.settings.autoCheckUpdate
  // 「按节假日判定」是不是已经在生效（开着开关 + 选了这个模式）——
  // 用于判断这次改动是不是把它从无到有打开，是的话要立刻补一次数据
  const wasHolidayActive =
    store.settings.weekdaysOnly && store.settings.weekdayMode === 'holiday'
  const settings = store.patchSettings(clean)
  scheduler.update(settings)
  applyAutoLaunch()
  applyThemeSource()
  syncWindowTheme()

  // 刚把开关打开就先查一次，不然「明明开了却一直没动静」
  if (settings.autoCheckUpdate && !wasAutoCheck) {
    setTimeout(() => void runUpdateCheck(), 300)
  }

  // 刚切到按节假日判定（或带着这个模式打开仅工作日）就先拉一次今年数据。
  // 拉不到也不挡路：判定会回退到按星期，界面上的提示会告诉用户去点更新
  if (
    settings.weekdaysOnly &&
    settings.weekdayMode === 'holiday' &&
    !wasHolidayActive &&
    holidayStore.getStatus().state === 'missing'
  ) {
    setTimeout(() => void runHolidayUpdate(), 300)
  }

  // 透明模式是窗口创建参数，改了必须重建
  float.setTransparent(settings.floatTransparent)

  if (!settings.floatEnabled) {
    float.hide()
  } else if (!wasFloatEnabled) {
    // 刚打开就先弹一次给用户看一眼。
    // 否则「明明开了，却一直没动静」——因为要等到提醒触发才出现，
    // 这种反馈缺失是最容易让人以为功能坏了的地方。
    previewFloat()
  }

  refresh(true)
  return buildState()
}

/** 小水滴处于关闭状态时的空状态 */
const FLOAT_OFF: FloatState = {
  created: false,
  visible: false,
  loaded: false,
  transparent: false,
  bounds: null,
  url: ''
}

/** 手动预览一次小水滴，不用等提醒触发 */
function previewFloat(): FloatState {
  if (!store.settings.floatEnabled) return FLOAT_OFF
  float.show(store.settings.floatAutoHideSec)
  return float.describe()
}

/** 预览并等窗口稳定后再回报状态 —— 刚 show 完 isVisible 还不一定为 true */
async function previewFloatAndReport(): Promise<FloatState> {
  const immediate = previewFloat()
  if (!immediate.created) return immediate
  await new Promise((resolve) => setTimeout(resolve, 800))
  return float.describe()
}

function applyAutoLaunch(): void {
  // 开发态注册的会是 electron.exe，没意义还容易残留，只在打包后生效
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: store.settings.autoLaunch,
      path: process.execPath,
      args: []
    })
  } catch (err) {
    console.error('[autoLaunch] 设置开机自启失败：', err)
  }
}

/* -------------------------------------------------------------------- IPC */

function registerIpc(): void {
  ipcMain.handle('app:state', () => buildState())
  ipcMain.handle('log:add', (_event, ml: number, source: DrinkSource) => addDrink(ml, source ?? 'manual'))
  ipcMain.handle('log:undo', () => {
    store.undoLast()
    refresh()
    return buildState()
  })
  ipcMain.handle('settings:patch', (_event, patch: Partial<Settings>) => applySettings(patch ?? {}))
  ipcMain.handle('float:hide', () => {
    float.hide()
  })
  ipcMain.handle('float:extend', () => {
    float.extend(store.settings.floatAutoHideSec)
  })
  ipcMain.handle('float:preview', () => previewFloatAndReport())
  ipcMain.handle('scheduler:pause', (_event, minutes: number) => {
    scheduler.pause(clampNumber(minutes, 1, 480, 30))
    refresh(true)
    return buildState()
  })
  ipcMain.handle('scheduler:resume', () => {
    scheduler.resume()
    refresh(true)
    return buildState()
  })
  ipcMain.handle('app:open-data-dir', async () => {
    const error = await shell.openPath(app.getPath('userData'))
    if (error) console.error('[shell] 打开数据目录失败：', error)
  })
  ipcMain.handle('app:open-main', () => showMainWindow())
  // 渲染层不传地址：仓库链接写死在 updater 里，比校验一个外部字符串更省心
  ipcMain.handle('app:open-repo', () => {
    void shell.openExternal(repoPageUrl())
  })
  ipcMain.handle('update:check', () => runUpdateCheck())
  ipcMain.handle('update:download', () => runUpdateDownload())
  ipcMain.handle('holiday:update', () => runHolidayUpdate())
  ipcMain.handle('update:open', (_event, url: unknown) => {
    // 链接来自远端 JSON，开之前必须校验域名：别把任意 URL 交给系统浏览器
    if (isTrustedReleaseUrl(url)) {
      void shell.openExternal(url)
    } else {
      void shell.openExternal(releasePageUrl())
    }
  })
  ipcMain.handle('app:quit', () => {
    isQuitting = true
    app.quit()
  })
  ipcMain.on('float:ready', () => {
    float.send('state:changed', buildState())
  })
  ipcMain.on('float:metrics', (_event, metrics: FloatMetrics) => {
    float.logMetrics(metrics)
  })
}

/** 打包后才收紧 CSP；开发态 Vite 的 HMR 需要内联脚本，收紧了反而跑不起来 */
function applyCsp(): void {
  if (!app.isPackaged) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
        ]
      }
    })
  })
}

/* ------------------------------------------------------------------ 启动 */

function registerShortcuts(): void {
  const ok = globalShortcut.register(QUICK_SHORTCUT, () => {
    addDrink(store.settings.cupSize, 'shortcut')
  })
  if (!ok) console.warn(`[shortcut] ${QUICK_SHORTCUT} 注册失败，可能已被其他程序占用`)
}

async function init(): Promise<void> {
  store = new Store()
  // 必须在建窗口之前：窗口底色和渲染层的 prefers-color-scheme 都依赖它
  applyThemeSource()

  // 必须在 scheduler 之前：调度器构造时要拿到日历提供者
  holidayStore = new HolidayStore(join(app.getPath('userData'), 'holidays.json'), app.getVersion())

  scheduler = new Scheduler(store.settings, {
    onFire: handleFire,
    onTick: () => refresh()
  }, () => holidayStore.getCalendar())

  float = new FloatWindow(preloadPath(), store.settings.floatTransparent, currentFloatBg())

  tray = new TrayController({
    onQuickLog: (ml) => addDrink(ml, 'tray'),
    onUndo: () => {
      store.undoLast()
      refresh()
    },
    onOpenMain: () => showMainWindow(),
    onPause: (minutes) => {
      scheduler.pause(minutes)
      refresh(true)
    },
    onResume: () => {
      scheduler.resume()
      refresh(true)
    },
    onToggleFloat: (enabled) => applySettings({ floatEnabled: enabled }),
    onPreviewFloat: () => previewFloat(),
    onToggleAutoLaunch: (enabled) => applySettings({ autoLaunch: enabled }),
    onOpenDataDir: () => {
      void shell.openPath(app.getPath('userData'))
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    }
  })

  registerIpc()
  applyCsp()
  // 必须把返回值挂回 mainWindow。
  // 否则窗口虽然建出来了，但模块级引用一直是 null：
  //   - refresh() 里的 mainWindow?.webContents.send() 全部静默丢弃，主面板收不到实时状态
  //   - 之后任何一次 showMainWindow() 都会因为 mainWindow 为 null 再建一个窗口，
  //     启动时那个窗口没人跟踪、又已经显示在屏幕上 —— 变成两个窗口
  mainWindow = createMainWindow()
  tray.create(buildState())
  applyAutoLaunch()
  registerShortcuts()
  scheduler.start()

  // 合盖唤醒后立刻重排，别让「睡了一觉」把节奏带偏
  powerMonitor.on('resume', () => scheduler.replan())
  powerMonitor.on('unlock-screen', () => scheduler.replan())

  // 跟随系统时，系统在深浅之间切换（比如日落自动切换）也要跟上：
  // 窗口底色直接改，渲染层靠这次推送拿到新的 resolvedTheme
  nativeTheme.on('updated', () => {
    syncWindowTheme()
    refresh(true)
  })

  // 启动后自动查一次更新。冒烟自检不查：它会自动退出，查了也是白查
  if (store.settings.autoCheckUpdate && !SMOKE) {
    setTimeout(() => void runUpdateCheck(), UPDATE_CHECK_DELAY_MS)
  }

  // 顺手清掉上次更新留下的安装包（一个包近百兆）。不 await：
  // 它是纯打扫，删不掉（正被安装器占着）也不该拖慢启动
  if (!SMOKE) void cleanupLeftovers()

  // 按节假日判定开着但今年还没数据：启动后补拉一次，
  // 拉不到也不重试轰炸，界面上的提示会引导用户手动点「更新到本地」
  if (needsHolidayFetch() && !SMOKE) {
    setTimeout(() => void runHolidayUpdate(), UPDATE_CHECK_DELAY_MS)
  }

  if (SMOKE) runSmokeTest()
}

/**
 * 冒烟自检：WATER_SMOKE_TEST=1 时跑一遍启动链路并自动退出。
 * 用来在没人盯屏幕的环境里确认「装得上、起得来、弹得出、写得进」。
 * 结果同时打到控制台和 smoke-report.txt ——
 * Windows 上 GUI 进程不挂控制台，只靠 stdout 经常什么都看不到。
 */
function runSmokeTest(): void {
  const lines: string[] = []
  const say = (message: string): void => {
    lines.push(message)
    console.log(`[smoke] ${message}`)
  }

  const finish = (): void => {
    try {
      writeFileSync(join(app.getPath('userData'), 'smoke-report.txt'), lines.join('\n'), 'utf-8')
    } catch {
      // 报告写不出来也不该盖住真正的失败原因
    }
    isQuitting = true
    app.quit()
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  setTimeout(() => {
    void (async () => {
      try {
        say(`userData = ${app.getPath('userData')}`)
        say(`assets   = ${assetsDir()}`)
        say(`tray     = ${tray ? 'ok' : 'missing'}`)
        say(`主窗口   = ${mainWindow && !mainWindow.isDestroyed() ? 'ok' : 'missing'}`)
        say(`下次提醒 = ${scheduler.nextAt ? new Date(scheduler.nextAt).toLocaleString('zh-CN') : '无'}`)

        const log = store.addLog(250, 'manual')
        say(`写入记录 = ${log.ml} ml；今日合计 = ${store.totalForDay(dayKey(Date.now()))}`)
        say(`撤销     = ${store.undoLast() ? 'ok' : 'failed'}`)

        // 小水滴是这次自检的重点：它只在提醒触发时出现，
        // 光看代码没法确认透明窗口到底弹没弹出来
        say(`小水滴开关 = ${store.settings.floatEnabled}`)
        say(`预览返回   = ${JSON.stringify(previewFloat())}`)
        await wait(3000)
        say(`三秒后状态 = ${JSON.stringify(float.describe())}`)
        say('PASS')
      } catch (err) {
        say(`FAIL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
        process.exitCode = 1
      } finally {
        finish()
      }
    })()
  }, 4000)
}

/* ---------------------------------------------------------------- 生命周期 */

if (!app.requestSingleInstanceLock()) {
  // 已经有一个实例在跑，把这件事交给它，自己安静退场
  app.quit()
} else {
  // 冒烟自检时把数据写到临时目录，别动正式数据
  if (SMOKE) {
    app.setPath('userData', smokeDir())
  }

  // Windows 上不设这个，系统通知根本不会弹 —— 新手第一大坑。
  // 光设还不够：Windows 要求该 AUMID 能对应到一个开始菜单快捷方式，才能
  // 归属通知、并在点击时把激活事件投回来。安装版的快捷方式由 electron-builder
  // 的 NSIS 建（shortcutName: 喝水提醒）；开发版的由 Electron 自己建。
  // 两边的 AUMID 必须不同 —— 原因见文件顶部 APP_ID 的注释。
  app.setAppUserModelId(APP_ID)

  app.on('second-instance', () => showMainWindow())

  app.on('window-all-closed', () => {
    // 托盘常驻，不跟随窗口关闭退出
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    scheduler?.stop()
    float?.destroy()
    tray?.destroy()
    // 不撤掉的话，这个 15 分钟的定时器会一直挂在事件循环上
    if (installWatchdog) clearTimeout(installWatchdog)
  })

  void app.whenReady().then(init)
}
