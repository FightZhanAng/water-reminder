import { formatWeekday } from '@shared/date'
import type { DayTotal } from '@shared/types'

interface WeekChartProps {
  recent: DayTotal[]
  goal: number
}

export default function WeekChart({ recent, goal }: WeekChartProps): React.JSX.Element {
  const max = Math.max(goal, ...recent.map((day) => day.total), 1)
  const lastIndex = recent.length - 1

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="eyebrow">近 7 天</h2>
        <span className="card-sub">目标线 {goal} ml</span>
      </div>
      <div className="chart">
        {/* 柱高与目标线共用同一个高度坐标系，虚线才对得准 */}
        <div className="chart-cols">
          <div className="chart-goal" style={{ bottom: `${(goal / max) * 100}%` }} />
          {recent.map((day) => (
            <div className="chart-col" key={day.date}>
              <div
                className="chart-slot"
                style={{ height: `${Math.round((day.total / max) * 100)}%` }}
              >
                <div className={day.total >= goal ? 'chart-bar is-hit' : 'chart-bar'} />
              </div>
            </div>
          ))}
        </div>
        {/* 数值放轴下方：放柱顶会被目标线穿过，还会和卡片标题挤在一起 */}
        <div className="chart-axis">
          {recent.map((day, index) => (
            <div
              className={index === lastIndex ? 'chart-axis-cell is-today' : 'chart-axis-cell'}
              key={day.date}
            >
              <span className="chart-value">{day.total > 0 ? day.total : '—'}</span>
              <span className="chart-day">{formatWeekday(day.date)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
