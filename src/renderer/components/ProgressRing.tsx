interface ProgressRingProps {
  total: number
  goal: number
}

const SIZE = 220
const CENTER = SIZE / 2
const RADIUS = 92
const INNER = RADIUS - 9
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const SPAN = INNER * 2
const TOP = CENTER - INNER

export default function ProgressRing({ total, goal }: ProgressRingProps) {
  const percent = goal > 0 ? Math.min(1, total / goal) : 0
  const waterHeight = SPAN * percent

  return (
    <div className="ring">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="ring-svg" aria-hidden="true">
        <defs>
          <clipPath id="ringClip">
            <circle cx={CENTER} cy={CENTER} r={INNER} />
          </clipPath>
        </defs>
        <circle cx={CENTER} cy={CENTER} r={RADIUS} className="ring-track" />
        <g clipPath="url(#ringClip)">
          <rect
            x={CENTER - INNER}
            y={TOP + SPAN - waterHeight}
            width={SPAN}
            height={waterHeight}
            className={percent >= 1 ? 'ring-water is-done' : 'ring-water'}
          />
        </g>
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          className="ring-arc"
          strokeDasharray={`${CIRCUMFERENCE * percent} ${CIRCUMFERENCE}`}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
        />
      </svg>
      <div className="ring-center">
        <span className="ring-total">{total}</span>
        <span className="ring-goal">/ {goal} ml</span>
        <span className="ring-percent">{Math.round(percent * 100)}%</span>
      </div>
    </div>
  )
}
