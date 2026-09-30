import { useEffect, useRef, useState } from 'react'
import type { UpdateCheck } from '@shared/update'
import DropMark from './DropMark'

interface AboutMenuProps {
  version: string
  update: UpdateCheck | null
  checking: boolean
  onCheck: () => void
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
 * 标题栏左侧的「关于」菜单。
 *
 * 菜单和版本弹窗都放在这个组件里：它们共用同一份版本/更新状态，
 * 拆成两个组件就得把状态提到 App 再传两遍，中间还多一层「谁负责关闭」的协调。
 */
export default function AboutMenu({
  version,
  update,
  checking,
  onCheck,
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

  const hint = update ? (update.state === 'update' ? `v${update.latest}` : UPDATE_TEXT[update.state]) : ''

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
            disabled={checking}
            onClick={() => {
              setOpen(false)
              onCheck()
            }}
          >
            <span>{checking ? '正在检查…' : '检查更新'}</span>
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

            <div className="action-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRepo}>
                项目主页
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAboutOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
