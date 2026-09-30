import { useEffect, useRef, useState } from 'react'
import type { UpdateCheck, UpdateDownload } from '@shared/update'
import DropMark from './DropMark'

interface AboutMenuProps {
  version: string
  update: UpdateCheck | null
  download: UpdateDownload
  checking: boolean
  onCheck: () => void
  onDownload: () => void
  onOpenRepo: () => void
  onQuit: () => void
}

/**
 * 引擎版本从 UA 里捞，不额外走 IPC。
 *
 * Electron 的默认 UA 里同时带着 `Chrome/<chromium>` 和 `Electron/<electron>`，
 * 报这两项是为了让「版本信息」在你排查问题时真的有用 ——
 * 只写一个应用版本号，遇到渲染层/layout 差异时没有任何线索可查。
 */
function engineVersions(): { electron: string; chromium: string } {
  const ua = navigator.userAgent
  const at = (re: RegExp): string => re.exec(ua)?.[1] ?? '未知'
  return { electron: at(/Electron\/([\d.]+)/), chromium: at(/Chrome\/([\d.]+)/) }
}

/** UA 在一次会话里不会变，解析一次就够 */
const ENGINE = engineVersions()

const UPDATE_TEXT: Record<UpdateCheck['state'], string> = {
  update: '有新版本',
  current: '已是最新',
  error: '检查失败'
}

/**
 * 下载四态在「关于」里的一句话说法。
 * 这一层不做进度百分比 —— 状态栏本来就在盯着这件事，弹窗里再放一条进度条
 * 只会让人不知道该看哪个。这里只回答「现在能不能关掉这个窗口」。
 */
function downloadLine(download: UpdateDownload): string {
  switch (download.state) {
    case 'downloading':
      return `正在下载 ${download.latest}…`
    case 'verifying':
      return '正在校验安装包…'
    case 'installing':
      return `正在安装 ${download.latest}，应用即将重启…`
    case 'error':
      return `更新失败：${download.reason}`
    default:
      return ''
  }
}

/**
 * 标题栏左侧的「关于」菜单。
 *
 * 菜单和版本弹窗都放在这个组件里：它们共用同一份版本/更新状态，
 * 拆成两个组件就得把状态提到 App 再传两遍，中间还多一层「谁负责关闭」的协调。
 */
export default function AboutMenu({
  version,
  update,
  download,
  checking,
  onCheck,
  onDownload,
  onOpenRepo,
  onQuit
}: AboutMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /*
   * 点空白处、按 Esc 都要能关掉。
   * 用 pointerdown 而不是 click：拖动窗口时松手落在别处也算「点了外面」，
   * 等 click 会出现「拖完窗口菜单还杵在那儿」。
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!aboutOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAboutOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [aboutOpen])

  const pending = update?.state === 'update' ? update : null
  const hint = update ? (pending ? `v${pending.latest}` : UPDATE_TEXT[update.state]) : ''

  /*
   * 能应用内装就直接装 —— 「去下载」把人赶到浏览器里，下完还得自己找回来双击，
   * 整条链路上最容易断的就是这一步。只有发布时漏了安装包（asset 为 null）才退回发布页。
   */
  const canInstall = Boolean(pending?.asset)
  const busy =
    download.state === 'downloading' ||
    download.state === 'verifying' ||
    download.state === 'installing'
  const downloadFailed = download.state === 'error'

  const label = busy
    ? download.state === 'installing'
      ? '安装中…'
      : download.state === 'verifying'
        ? '校验中…'
        : '下载中…'
    : canInstall
      ? downloadFailed
        ? '重试下载'
        : '下载并安装'
      : checking
        ? '正在检查…'
        : '检查更新'

  const note = downloadLine(download) || (canInstall ? `可在应用内更新到 ${pending?.latest}` : '')

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        关于
        <svg className="menu-caret" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M0.5 2.5 4 6 7.5 2.5" />
        </svg>
      </button>

      {open && (
        <div className="menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              setAboutOpen(true)
            }}
          >
            <span>版本</span>
            <span className="menu-item-hint">v{version}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={checking || busy}
            onClick={() => {
              setOpen(false)
              if (canInstall) onDownload()
              else onCheck()
            }}
          >
            <span>{label}</span>
            {hint && <span className="menu-item-hint">{hint}</span>}
          </button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item is-danger" onClick={onQuit}>
            <span>退出</span>
          </button>
        </div>
      )}

      {aboutOpen && (
        <div
          className="overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAboutOpen(false)
          }}
        >
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
            <div className="dialog-head">
              <span className="dialog-mark">
                <DropMark />
              </span>
              <div>
                <h2 id="about-title" className="dialog-title">
                  喝水提醒
                </h2>
                <p className="dialog-sub">托盘常驻的桌面喝水提醒</p>
              </div>
            </div>

            <dl className="about-list">
              <dt>版本</dt>
              <dd>v{version}</dd>
              <dt>Electron</dt>
              <dd>{ENGINE.electron}</dd>
              <dt>Chromium</dt>
              <dd>{ENGINE.chromium}</dd>
              <dt>更新</dt>
              <dd>{update ? `${UPDATE_TEXT[update.state]}${update.state === 'update' ? ` ${update.latest}` : ''}` : '还没检查过'}</dd>
            </dl>

            {note && <p className="dialog-note">{note}</p>}

            <div className="action-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRepo}>
                项目主页
              </button>
              {canInstall && !busy && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setAboutOpen(false)
                    onDownload()
                  }}
                >
                  {downloadFailed ? '重试下载' : '下载并安装'}
                </button>
              )}
              <button
                type="button"
                // 有待办事项时把「关闭」降成次要按钮：这块地方一次只该有一个明确的主 action
                className={canInstall && !busy ? 'btn btn-ghost btn-sm' : 'btn btn-sm'}
                onClick={() => setAboutOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
