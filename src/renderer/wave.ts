/**
 * 液面波 —— 量筒和桌面小水滴共用同一条曲线。
 *
 * 以 y=0 为基线、周期 period 的起伏曲线，再封成一条向下 depth 的带子。
 * 每半周期用一个二次贝塞尔近似正弦：控制点落在极值处，中点正好等于振幅。
 *
 * 生成时总是多画两个周期（span 由调用方给足），这样配合 CSS 里
 * `translateX(-period)` 的无限循环动画能无缝衔接 —— 位移一格之后，
 * 露出来的部分和原来的完全一样。
 */
export function waveBand(span: number, period: number, amp: number, depth = 7): string {
  const half = period / 2
  let d = 'M 0 0'
  let dir = -1
  for (let x = 0; x < span; x += half) {
    d += ` Q ${x + half / 2} ${dir * amp * 2} ${x + half} 0`
    dir = -dir
  }
  return `${d} L ${span} ${depth} L 0 ${depth} Z`
}
