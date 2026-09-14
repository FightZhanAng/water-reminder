import { formatWeekday } from '@shared/date'
import type { DayTotal } from '@shared/types'

interface WeekChartProps {
  recent: DayTotal[]
  goal: number
}

export default function WeekChart({ recent, goal }: WeekChartProps) {
  const max = Math.max(goal, ...recent.map((day) => day.total), 1)

  return (
    <section className="card">
      <div className="card-head">
        <h2>近 7 天</h2>
        <span className="card-sub">目标线 {goal} ml</span>
      </div>
      <div className="chart">
        {recent.map((day) => (
          <div className="chart-col" key={day.date}>
            <span className="chart-value">{day.total > 0 ? day.total : ''}</span>
            <div className="chart-bar-wrap">
              <div
                className={day.total >= goal ? 'chart-bar is-hit' : 'chart-bar'}
                style={{ height: `${Math.round((day.total / max) * 100)}%` }}
              />
            </div>
            <span className="chart-label">{formatWeekday(day.date)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
