interface WaterGaugeProps {
  total: number
  goal: number
}

/*
 * 量筒几何（viewBox 内坐标系，渲染时 1:1 输出）。
 * 左边留 18 给液面指针，右边留出刻度数字的位置。
 */
const VB_W = 112
const VB_H = 180
const X = 18
const W = 58
const TOP = 8
const BOTTOM = 172
const RADIUS = 10
/** 内壁顶端（水面最高只能到这儿）到底端；刻度与水位共用这一套换算 */
const INNER_TOP = TOP + 6
const SPAN = BOTTOM - INNER_TOP
const RIGHT = X + W
const LABEL_X = 90

/** 液面波的周期。CSS 里 tide 动画的位移量必须等于它，才能无缝循环 */
const WAVE_PERIOD = 58
const WAVE_AMP = 2.5
const WAVE_SPAN = W + WAVE_PERIOD * 2

/**
 * 以 y=0 为基线、周期 period 的起伏曲线，再封成一条向下 7px 的带子。
 * 每半周期用一个二次贝塞尔近似正弦：控制点落在极值处，中点正好等于振幅。
 */
function waveBand(span: number, period: number, amp: number): string {
  const half = period / 2
  let d = 'M 0 0'
  let dir = -1
  for (let x = 0; x < span; x += half) {
    d += ` Q ${x + half / 2} ${dir * amp * 2} ${x + half} 0`
    dir = -dir
  }
  return `${d} L ${span} 7 L 0 7 Z`
}

const WAVE_D = waveBand(WAVE_SPAN, WAVE_PERIOD, WAVE_AMP)

/** 长刻度带数字（0 / 一半 / 目标），短刻度只做四分之一分度 */
const TICKS = [
  { at: 0, long: true },
  { at: 0.25, long: false },
  { at: 0.5, long: true },
  { at: 0.75, long: false },
  { at: 1, long: true }
] as const

/**
 * 水位计 —— 这个界面的签名元素。
 *
 * 不是进度环：这里真的是一支量筒，刻度按目标值换算成毫升，
 * 液面会缓慢起伏。整个应用反复出现的「刻度」记号就是从它来的。
 */
export default function WaterGauge({ total, goal }: WaterGaugeProps): React.JSX.Element {
  const percent = goal > 0 ? Math.min(1, Math.max(0, total / goal)) : 0
  const done = percent >= 1
  /** 整筒水整体下移多少：这样液面和指针能一起做补间，不会一个动一个跳 */
  const offset = SPAN * (1 - percent)

  return (
    <svg
      className="gauge"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width={VB_W}
      height={VB_H}
      aria-hidden="true"
    >
      <defs>
        <clipPath id="gauge-clip">
          <rect x={X} y={TOP} width={W} height={BOTTOM - TOP} rx={RADIUS} />
        </clipPath>
        <linearGradient id="gauge-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="gauge-stop-top" />
          <stop offset="1" className="gauge-stop-bottom" />
        </linearGradient>
        <linearGradient id="gauge-glare" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" className="gauge-stop-glare" />
          <stop offset="1" className="gauge-stop-glare" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="gauge-ticks">
        {TICKS.map(({ at, long }) => {
          const y = BOTTOM - SPAN * at
          return (
            <line
              key={at}
              className={long ? 'gauge-tick is-long' : 'gauge-tick'}
              x1={RIGHT}
              y1={y}
              x2={RIGHT + (long ? 10 : 5)}
              y2={y}
            />
          )
        })}
      </g>

      {TICKS.filter((tick) => tick.long).map(({ at }) => (
        <text
          key={at}
          className="gauge-scale"
          x={LABEL_X}
          y={BOTTOM - SPAN * at}
          dominantBaseline="middle"
        >
          {Math.round(goal * at)}
        </text>
      ))}

      <rect className="gauge-glass" x={X} y={TOP} width={W} height={BOTTOM - TOP} rx={RADIUS} />

      {/*
        裁剪必须放在**没有 transform 的那一层**。
        clipPath 是在引用它的元素的用户坐标系里解析的：把裁剪放进被 translate 的组里，
        裁剪框会跟着水一起下移，等于没裁 —— 真正挡住水的只剩 SVG 视口本身
        （根 svg 默认 overflow: hidden），于是水从筒底漏出一小截，看着像「差一点」。
        水面以下的水整体下移做补间，裁剪框钉死在筒身上。
      */}
      <g clipPath="url(#gauge-clip)">
        <g className="gauge-move" style={{ transform: `translateY(${offset}px)` }}>
          {/*
            一滴都没有时不画水：液面波的下沿比水面低几个像素，
            整体下移到底后仍会在筒底露出 2px 的浅色条，看着像「筒里有点水」。
          */}
          {percent > 0 && (
            <>
              <rect
                className={done ? 'gauge-water is-done' : 'gauge-water'}
                x={X}
                y={INNER_TOP}
                width={W}
                height={SPAN}
              />
              <g transform={`translate(${X - WAVE_PERIOD} ${INNER_TOP})`}>
                <path className={done ? 'gauge-wave is-done' : 'gauge-wave'} d={WAVE_D} />
              </g>
            </>
          )}
        </g>
      </g>

      {/* 液面指针在筒外，不在裁剪范围内，所以另起一层跟着水位走 */}
      <g className="gauge-move" style={{ transform: `translateY(${offset}px)` }}>
        <line className="gauge-marker" x1={4} y1={INNER_TOP} x2={X} y2={INNER_TOP} />
      </g>

      <g clipPath="url(#gauge-clip)">
        <rect className="gauge-glare" x={X + 7} y={TOP + 9} width={9} height={BOTTOM - TOP - 22} rx={4.5} />
      </g>

      <rect className="gauge-wall" x={X} y={TOP} width={W} height={BOTTOM - TOP} rx={RADIUS} />
    </svg>
  )
}
