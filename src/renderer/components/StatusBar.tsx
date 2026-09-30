import { describeDownload, type UpdateCheck, type UpdateDownload } from '@shared/update'

interface StatusBarProps {
  version: string
  update: UpdateCheck | null
  download: UpdateDownload
  checking: boolean
  onCheck: () => void
  onDownload: () => void
  onOpen: (url: string) => void
}

/** 全程可能拿不到总大小（服务端没给 content-length），这时宁可不画进度也不画个假的 */
function percentOf(received: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, received / total))
}

/**
 * 窗口底部的状态栏：左边版本号，右边更新状态。
 *
 * 更新提示放在这儿而不是折叠的设置面板里 —— 设置面板默认是收起的，
 * 藏在里面等于没提示。这一条也顺带把「版本号显示」摆在明面上。
 *
 * 下载/校验/安装都在这里就地显示：更新是个「点了之后要等几十秒」的操作，
 * 中间没有反馈的话，用户只会以为按钮没生效，然后再点一次。
 */
export default function StatusBar({
  version,
  update,
  download,
  checking,
  onCheck,
  onDownload,
  onOpen
}: StatusBarProps): React.JSX.Element {
  const pending = update?.state === 'update' ? update : null
  const checkFailed = update?.state === 'error' ? update : null
  const downloading = download.state === 'downloading' ? download : null
  const verifying = download.state === 'verifying'
  const installing = download.state === 'installing'

  /*
   * 下载链路的显示口径全部从 shared 的 describeDownload 派生（「关于」弹窗
   * 共用同一份），这里只补它管不到的检查链路 —— 两条链路谁在台前就显示谁，
   * 下载链路 idle 时 text 为 null，正好让位。
   */
  const dl = describeDownload(download)

  // 校验和安装没法报百分比（前者是一瞬间的摘要比对，后者是等安装器接过去），
  // 但都属于「正在进行」，和下载一样占住按钮
  const busy = dl.busy
  const ratio = downloading ? percentOf(downloading.received, downloading.total) : 0

  const checkText = checking
    ? '正在检查…'
    : pending
      ? `有新版本 ${pending.latest}`
      : checkFailed
        ? `检查失败：${checkFailed.reason}`
        : update
          ? '已是最新'
          : ''

  const text = dl.text ?? checkText

  const tone =
    dl.busy || (pending && !dl.failed)
      ? ' is-update'
      : checkFailed || dl.failed
        ? ' is-error'
        : ''

  const title = dl.failed ?? checkFailed?.reason ?? undefined

  return (
    <footer className="statusbar">
      {/*
        进度条压在状态栏的上边框上，而不是挤进这一行里：
        它是「进行中」的临时物，一出现就让整条状态栏长高的话，
        下面的内容会跟着跳一下。
      */}
      {(downloading || verifying) && (
        <div className="statusbar-progress" aria-hidden="true">
          <div
            className={verifying ? 'statusbar-progress-fill is-hold' : 'statusbar-progress-fill'}
            style={downloading ? { width: `${ratio * 100}%` } : undefined}
          />
        </div>
      )}

      <span className="statusbar-version" title={`喝水提醒 ${version}`}>
        v{version}
      </span>
      <span className="statusbar-state">
        {text && (
          <span className={`statusbar-text${tone}`} title={title}>
            {text}
          </span>
        )}
        {installing ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled>
            安装中…
          </button>
        ) : busy ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled>
            {verifying ? '校验中' : `${Math.round(ratio * 100)}%`}
          </button>
        ) : pending?.asset ? (
          <button type="button" className="btn btn-sm" onClick={onDownload}>
            {dl.failed ? '重试下载' : '下载并安装'}
          </button>
        ) : pending ? (
          // 发布时漏了可直接安装的包。退回手动下载，总比给一个错的包强
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
            {checkFailed ? '重试' : '检查更新'}
          </button>
        )}
      </span>
      {/*
        aria-live 单独放在 sr-only 元素里、且只装「相位」文案：
        挂在 .statusbar-state 上的话，120ms 一次的字节数刷新会全部进读屏器，
        一场 95MB 的下载等于让屏幕阅读器念几百遍进度。相位在下载期间不变，
        内容不变就不会重复播报。
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {dl.phase ?? checkText}
      </span>
    </footer>
  )
}
