import { app, BrowserWindow, screen } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FloatState } from '../shared/types'
import { hardenWindow, loadRenderer } from './paths'

const WIDTH = 200
const HEIGHT = 236
const MARGIN = 24
/** showInactive 之后等这么久还是不可见，就回退到带焦点的 show() */
const VISIBLE_FALLBACK_MS = 700

/**
 * 桌面小水滴浮窗。
 *
 * 三个已知取舍，写在这儿免得以后自己都忘了：
 * 1) transparent 窗口在 Windows 上不做逐像素命中测试，所以整块 200x236
 *    的矩形都会挡住下面窗口的点击。缓解办法是窗口开小 + 默认 20 秒自动隐藏。
 * 2) 刻意用 showInactive()，不抢焦点 —— 提醒弹出来把正在打字的焦点抢走，
 *    是这类工具最招人烦的行为。但透明窗口在部分环境下 showInactive 会「显示不出来」，
 *    所以留了一次回退。
 * 3) 透明窗口加载失败 / 渲染空白，表现和「没弹出来」完全一样。
 *    因此所有关键节点都往 float.log 写一行，否则这种事查都没法查。
 */
export class FloatWindow {
  private win: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private visibleFallback: NodeJS.Timeout | null = null
  private readyTimeout: NodeJS.Timeout | null = null
  private loaded = false
  private readyToShow = false
  private pendingFire = false
  private pendingShow = false

  constructor(
    private readonly preload: string,
    private transparent = false
  ) {}

  get browserWindow(): BrowserWindow | null {
    return this.win
  }

  get pageLoaded(): boolean {
    return this.loaded
  }

  private get logFile(): string {
    return join(app.getPath('userData'), 'float.log')
  }

  private log(message: string): void {
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${message}\n`, 'utf-8')
    } catch {
      // 日志写不了不该影响功能
    }
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const transparent = this.transparent
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent,
      // 不透明模式下让窗口底色跟页面底色一致，四角不会露出突兀的白块
      backgroundColor: transparent ? '#00000000' : '#f2f7fc',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: !transparent,
      title: '喝水提醒',
      webPreferences: {
        preload: this.preload,
        sandbox: false
      }
    })

    hardenWindow(win)
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

    // 首次绘制完成前就 showInactive()，透明窗口经常表现为「存在但什么都不显示」。
    // 所以等 ready-to-show 再真正呈现。
    win.once('ready-to-show', () => {
      this.readyToShow = true
      this.log('ready-to-show')
      if (this.pendingShow) {
        this.pendingShow = false
        this.present(win)
      }
    })

    win.webContents.on('did-finish-load', () => {
      this.loaded = true
      this.log('did-finish-load')
      if (this.pendingFire) {
        this.pendingFire = false
        win.webContents.send('reminder:fire')
      }
    })

    // 透明窗口加载失败的表现是「什么都不显示」，和「没弹出来」完全一样
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.log(`did-fail-load code=${code} desc=${description} url=${url}`)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.log(`render-process-gone reason=${details.reason}`)
    })
    win.webContents.on('console-message', (_event, _level, message) => {
      this.log(`renderer console: ${message}`)
    })

    win.on('closed', () => {
      this.log('window closed')
      this.win = null
      this.loaded = false
      this.readyToShow = false
      this.pendingShow = false
      this.pendingFire = false
    })

    loadRenderer(win, 'float')
    this.win = win
    this.log(`ensure() 已创建窗口 url=${win.webContents.getURL()}`)
    return win
  }

  /** 弹出提醒；autoHideSec 秒后自动隐藏 */
  show(autoHideSec: number): void {
    const win = this.ensure()
    this.position(win)

    if (this.loaded) {
      win.webContents.send('reminder:fire')
    } else {
      this.pendingFire = true
    }

    if (this.readyToShow) {
      this.present(win)
    } else {
      this.pendingShow = true
      // 万一 ready-to-show 一直不来，也不能让窗口永远不出现
      if (this.readyTimeout) clearTimeout(this.readyTimeout)
      this.readyTimeout = setTimeout(() => {
        if (win.isDestroyed() || !this.pendingShow) return
        this.pendingShow = false
        this.log('ready-to-show 超时，强行呈现')
        this.present(win)
      }, 1500)
    }

    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => this.hide(), Math.max(5, autoHideSec) * 1000)
  }

  /** 真正把窗口呈现出来 */
  private present(win: BrowserWindow): void {
    win.showInactive()
    win.setAlwaysOnTop(true, 'floating')
    this.log(`present() bounds=${JSON.stringify(win.getBounds())} visible=${win.isVisible()}`)

    if (this.visibleFallback) clearTimeout(this.visibleFallback)
    this.visibleFallback = setTimeout(() => {
      if (win.isDestroyed()) return
      if (win.isVisible()) {
        this.log('present 后可见，正常')
        return
      }
      this.log('showInactive 后仍不可见，回退到 show()')
      win.show()
      this.log(`回退 show() 后 visible=${win.isVisible()}`)
    }, VISIBLE_FALLBACK_MS)
  }

  /** 用户正在操作，重新计时，别让自动隐藏打断他 */
  extend(autoHideSec: number): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => this.hide(), Math.max(5, autoHideSec) * 1000)
  }

  hide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed() && this.loaded) {
      this.win.webContents.send(channel, ...args)
    }
  }

  /** 供自检和「预览」按钮回报状态，别让它变成一个黑盒 */
  describe(): FloatState {
    const win = this.win
    if (!win || win.isDestroyed()) {
      return { created: false, visible: false, loaded: false, transparent: this.transparent, bounds: null, url: '' }
    }
    return {
      created: true,
      visible: win.isVisible(),
      loaded: this.loaded,
      transparent: this.transparent,
      bounds: win.getBounds(),
      url: win.webContents.getURL()
    }
  }

  /** 把渲染层量到的 DOM 数据写进日志，用于区分「没渲染」和「没合成上」 */
  logMetrics(metrics: unknown): void {
    this.log(`renderer metrics: ${JSON.stringify(metrics)}`)
  }

  /**
   * 切换透明模式。
   * transparent 是创建窗口时的选项，改不了，只能销毁重建 ——
   * 好在窗口本来就是按需创建的。
   */
  setTransparent(transparent: boolean): void {
    if (this.transparent === transparent) return
    this.transparent = transparent
    this.log(`透明模式切换为 ${transparent}，重建窗口`)
    this.destroy()
  }

  destroy(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    if (this.visibleFallback) clearTimeout(this.visibleFallback)
    if (this.readyTimeout) clearTimeout(this.readyTimeout)
    this.hideTimer = null
    this.visibleFallback = null
    this.readyTimeout = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  /** 贴到鼠标所在屏幕的右下角 */
  private position(win: BrowserWindow): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { workArea } = display
    win.setPosition(
      Math.round(workArea.x + workArea.width - WIDTH - MARGIN),
      Math.round(workArea.y + workArea.height - HEIGHT - MARGIN),
      false
    )
  }
}
