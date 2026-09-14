import { formatClock } from '@shared/date'
import type { DrinkLog, DrinkSource } from '@shared/types'

const SOURCE_LABEL: Record<DrinkSource, string> = {
  manual: '手动',
  tray: '托盘',
  shortcut: '快捷键',
  float: '小水滴',
  notification: '通知'
}

interface TodayListProps {
  logs: DrinkLog[]
  onUndo: () => void
}

export default function TodayList({ logs, onUndo }: TodayListProps) {
  const newestFirst = [...logs].reverse()

  return (
    <section className="card">
      <div className="card-head">
        <h2>今天的记录</h2>
        {logs.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onUndo}>
            撤销上一次
          </button>
        )}
      </div>
      {newestFirst.length === 0 ? (
        <p className="empty">还没有记录。喝一口就点上面的按钮，一次点击的事。</p>
      ) : (
        <ul className="log-list">
          {newestFirst.map((log) => (
            <li key={log.id}>
              <span className="log-time">{formatClock(log.ts)}</span>
              <span className="log-ml">{log.ml} ml</span>
              <span className="log-source">{SOURCE_LABEL[log.source] ?? log.source}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
