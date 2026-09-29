/*
 * 水滴轮廓 —— 托盘图标、桌面小水滴、主面板左上角用的是同一个形。
 * 圆弧那一段的 sweep-flag 必须是 0：sweep=1 会从左侧点「往上」绕到右侧点，
 * 画出来是个尖顶拱门；sweep=0 才会「往下」绕出圆底，才是水滴。
 */
export const DROP_PATH = 'M32 4 C32 4 8 30 8 48 a24 24 0 0 0 48 0 C56 30 32 4 32 4 Z'
const DROP_TOP = 4
export const DROP_BOTTOM = 72
export const DROP_SPAN = DROP_BOTTOM - DROP_TOP

/** 主面板左上角的小水滴标；颜色由外层 CSS 给（达标时转绿） */
export default function DropMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 80" aria-hidden="true">
      <path d={DROP_PATH} />
    </svg>
  )
}
