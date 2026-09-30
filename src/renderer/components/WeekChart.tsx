import type { CSSProperties } from 'react'
import { formatWeekday } from '@shared/date'
import type { DayTotal } from '@shared/types'

interface WeekChartProps {
  recent: DayTotal[]
  goal: number
}

/**
 * 近 7 天 —— 横向水位条。
 *
 * 没用竖柱：竖柱读「哪天过得高」要横向比高度，而这个窗口只有 400 出头宽，
 * 7 根柱子挤在一起后差距反而看不出来。换成一行一条水位之后，
 * 条形长度直接就是完成度，达标与否还能用荧光色和第二行信息说清楚。
 *
 * 目标线是一条贯穿所有行的竖向虚线。每一行的轨道左右边界完全一致
 * （同一个 grid 模板、同一个间隙），所以只要按「标签列 + 间隙 + 轨道宽度 × 比例」
 * 算出横向位置，就能与每一条轨道对齐 —— 不需要额外包一层定位容器。
 */
export default function WeekChart({ recent, goal }: WeekChartProps): React.JSX.Element {
  const max = Math.max(goal, ...recent.map((day) => day.total), 1)
  const lastIndex = recent.length - 1
  const ratio = goal / max

  const hitDays = recent.filter((day) => day.total >= goal).length
  const logged = recent.filter((day) => day.total > 0)
  const average = logged.length > 0 ? Math.round(recent.reduce((sum, d) => sum + d.total, 0) / recent.length) : 0

  const goalLine: CSSProperties = {
    left: `calc(var(--level-label) + var(--level-gap) + (100% - var(--level-label) - var(--level-value) - var(--level-gap) * 2) * ${ratio})`
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="eyebrow">近 7 天</h2>
        <span className="card-sub">目标 {goal} ml</span>
      </div>

      <div className="levels">
        <div className="levels-rows">
          {recent.map((day, index) => (
            <div
              className={[
                'level-row',
                day.total >= goal ? 'is-hit' : '',
                index === lastIndex ? 'is-today' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              key={day.date}
              title={`${day.date} · ${day.total} ml`}
            >
              <span className="level-day">{formatWeekday(day.date)}</span>
              <span className="level-track">
                <span
                  className="level-fill"
                  style={{ width: `${Math.round((day.total / max) * 100)}%` }}
                />
              </span>
              <span className="level-value">{day.total > 0 ? day.total : '—'}</span>
            </div>
          ))}
        </div>
        <span className="levels-goal" style={goalLine} aria-hidden="true" />
      </div>

      <div className="levels-axis">
        <span>达标 {hitDays} / {recent.length} 天</span>
        <span>日均 {average} ml</span>
      </div>
    </section>
  )
}
