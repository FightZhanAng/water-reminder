import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { formatClock } from '../shared/date'
import { QUICK_AMOUNTS } from '../shared/defaults'
import type { AppState } from '../shared/types'
import { trayIconImage } from './paths'

export interface TrayCallbacks {
  onQuickLog(ml: number): void
  onUndo(): void
  onOpenMain(): void
  onPause(minutes: number): void
  onResume(): void
  onToggleFloat(enabled: boolean): void
  onPreviewFloat(): void
  onToggleAutoLaunch(enabled: boolean): void
  onOpenDataDir(): void
  onQuit(): void
}

const PAUSE_OPTIONS = [15, 30, 60, 120]

export class TrayController {
  private tray: Tray | null = null
  private menu: Menu | null = null
  private signature = ''

  constructor(private readonly cb: TrayCallbacks) {}

  create(state: AppState): void {
    this.tray = new Tray(trayIconImage(0))
    this.tray.setToolTip('喝水提醒')
    this.tray.on('click', () => this.cb.onOpenMain())
    this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.menu ?? undefined))
    this.update(state)
  }

  update(state: AppState): void {
    if (!this.tray) return

    const percent = state.today.goal > 0 ? state.today.total / state.today.goal : 0
    const nextLabel = state.pausedUntil
      ? `已暂停至 ${formatClock(state.pausedUntil)}`
      : state.nextAt
        ? `下次提醒 ${formatClock(state.nextAt)}`
        : '今日不再提醒'

    // 只在可见内容真的变了时才重建菜单，避免每 10 秒白干一次
    const signature = [
      state.today.total,
      state.today.goal,
      state.today.logs.length,
      nextLabel,
      state.settings.floatEnabled,
      state.settings.autoLaunch,
      state.settings.cupSize
    ].join('|')
    if (signature === this.signature) return
    this.signature = signature

    this.tray.setImage(trayIconImage(percent))
    this.tray.setToolTip(`喝水提醒 · 今日 ${state.today.total}/${state.today.goal} ml · ${nextLabel}`)

    const pct = Math.round(percent * 100)
    const template: MenuItemConstructorOptions[] = [
      { label: `今日 ${state.today.total} / ${state.today.goal} ml（${pct}%）`, enabled: false },
      { label: nextLabel, enabled: false },
      { type: 'separator' },
      {
        label: '记一杯',
        submenu: QUICK_AMOUNTS.map((ml) => ({
          label: `+${ml} ml`,
          click: () => this.cb.onQuickLog(ml)
        }))
      },
      {
        label: '撤销上一次',
        enabled: state.today.logs.length > 0,
        click: () => this.cb.onUndo()
      },
      { type: 'separator' },
      { label: '打开主界面', click: () => this.cb.onOpenMain() },
      state.pausedUntil
        ? { label: '恢复提醒', click: () => this.cb.onResume() }
        : {
            label: '暂停提醒',
            submenu: PAUSE_OPTIONS.map((min) => ({
              label: min >= 60 ? `${min / 60} 小时` : `${min} 分钟`,
              click: () => this.cb.onPause(min)
            }))
          },
      { type: 'separator' },
      {
        label: '桌面小水滴',
        type: 'checkbox',
        checked: state.settings.floatEnabled,
        click: (item) => this.cb.onToggleFloat(item.checked)
      },
      {
        label: '预览小水滴',
        enabled: state.settings.floatEnabled,
        click: () => this.cb.onPreviewFloat()
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: state.settings.autoLaunch,
        click: (item) => this.cb.onToggleAutoLaunch(item.checked)
      },
      { type: 'separator' },
      { label: '打开数据目录', click: () => this.cb.onOpenDataDir() },
      { label: '退出', click: () => this.cb.onQuit() }
    ]

    this.menu = Menu.buildFromTemplate(template)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
