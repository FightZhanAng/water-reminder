import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Notification,
  powerMonitor,
  session,
  shell
} from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey, isValidHM } from '../shared/date'
import type { AppState, DrinkSource, FloatMetrics, FloatState, Settings } from '../shared/types'
import { FloatWindow } from './float'
import { appIconPath, assetsDir, hardenWindow, loadRenderer, preloadPath } from './paths'

import { Scheduler } from './scheduler'
import { Store } from './store'
import { TrayController } from './tray'

const APP_ID = 'com.tomcato.water-reminder'
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

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let lastSignature = ''
let activeNotification: Notification | null = null

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
    streak: store.streak()
  }
}

/** 把秒级抖动抹掉，这样倒计时不会每 10 秒推一次状态 */
function signatureOf(state: AppState): string {
  return JSON.stringify({
    today: state.today,
    settings: state.settings,
    nextAt: state.nextAt === null ? null : Math.floor(state.nextAt / 60_000),
    pausedUntil: state.pausedUntil === null ? null : Math.floor(state.pausedUntil / 60_000),
    recent: state.recent,
    streak: state.streak
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
    height: 700,
    minWidth: 400,
    minHeight: 580,
    show: false,
    autoHideMenuBar: true,
    title: '喝水提醒',
    icon: appIconPath(),
    backgroundColor: '#F2F7FC',
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

  const wasFloatEnabled = store.settings.floatEnabled
  const settings = store.patchSettings(clean)
  scheduler.update(settings)
  applyAutoLaunch()

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

  scheduler = new Scheduler(store.settings, {
    onFire: handleFire,
    onTick: () => refresh()
  })

  float = new FloatWindow(preloadPath(), store.settings.floatTransparent)

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
  createMainWindow()
  tray.create(buildState())
  applyAutoLaunch()
  registerShortcuts()
  scheduler.start()

  // 合盖唤醒后立刻重排，别让「睡了一觉」把节奏带偏
  powerMonitor.on('resume', () => scheduler.replan())
  powerMonitor.on('unlock-screen', () => scheduler.replan())

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

  // Windows 上不设这个，系统通知根本不会弹 —— 新手第一大坑
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
  })

  void app.whenReady().then(init)
}
