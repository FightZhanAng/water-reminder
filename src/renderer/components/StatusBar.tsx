import type { UpdateCheck } from '@shared/update'

interface StatusBarProps {
  version: string
  update: UpdateCheck | null
  checking: boolean
  onCheck: () => void
  onOpen: (url: string) => void
}

/**
 * 窗口底部的状态栏：左边版本号，右边更新状态。
 *
 * 更新提示放在这儿而不是折叠的设置面板里 —— 设置面板默认是收起的，
 * 藏在里面等于没提示。这一条也顺带把「版本号显示」摆在明面上。
 */
export default function StatusBar({
  version,
  update,
  checking,
  onCheck,
  onOpen
}: StatusBarProps): React.JSX.Element {
  const pending = update?.state === 'update' ? update : null
  const failed = update?.state === 'error' ? update : null

  const text = checking
    ? '正在检查…'
    : pending
      ? `有新版本 ${pending.latest}`
      : failed
        ? `检查失败：${failed.reason}`
        : update
          ? '已是最新'
          : ''

  const tone = pending ? ' is-update' : failed ? ' is-error' : ''

  return (
    <footer className="statusbar">
      <span className="statusbar-version" title={`喝水提醒 ${version}`}>
        v{version}
      </span>
      <span className="statusbar-state">
        {text && (
          <span className={`statusbar-text${tone}`} title={failed ? failed.reason : undefined}>
            {text}
          </span>
        )}
        {pending ? (
          <button type="button" className="btn btn-sm" onClick={() => onOpen(pending.url)}>
            去下载
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={checking}
            onClick={onCheck}
          >
            {failed ? '重试' : '检查更新'}
          </button>
        )}
      </span>
    </footer>
  )
}
