import { useEffect, useRef, useState } from 'react'
import { QUICK_AMOUNTS } from '@shared/defaults'
import type { AppState } from '@shared/types'

// 水滴轮廓。
// 圆弧那一段的 sweep-flag 必须是 0：sweep=1 会从左侧点「往上」绕到右侧点，
// 画出来是个尖顶拱门；sweep=0 才会「往下」绕出圆底，才是水滴。
const DROP_PATH = 'M32 4 C32 4 8 30 8 48 a24 24 0 0 0 48 0 C56 30 32 4 32 4 Z'
const DROP_TOP = 4
const DROP_BOTTOM = 72
const DROP_SPAN = DROP_BOTTOM - DROP_TOP

export default function FloatCard() {
  const [state, setState] = useState<AppState | null>(null)
  const [fireCount, setFireCount] = useState(0)
  const [fatal, setFatal] = useState<string | null>(null)
  const reported = useRef(false)

  useEffect(() => {
    // 整段包起来：这里是「窗口一片空白」最容易发生的地方 ——
    // 一旦 effect 抛错又没有错误边界，React 会把整棵树卸载掉，
    // 结果就是窗口在、但屏幕上什么都没有，且没有任何提示。
    try {
      window.api?.notifyFloatReady()
      void window.api?.getState().then(setState)
      const offState = window.api?.onState(setState)
      const offFire = window.api?.onReminder(() => setFireCount((n) => n + 1))
      return () => {
        offState?.()
        offFire?.()
      }
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }, [])

  // 把 DOM 实际量到的尺寸回报给主进程，写进 float.log。
  // 「窗口可见但屏幕空白」时，只有这组数据能区分是 DOM 没渲染出来（尺寸为 0）
  // 还是 DOM 正常但窗口没合成上。
  useEffect(() => {
    if (!state || reported.current) return
    if (typeof window.api?.reportFloatMetrics !== 'function') return
    reported.current = true

    const timer = setTimeout(() => {
      const card = document.querySelector('.float-card')
      const drop = document.querySelector('.float-drop')
      if (!(card instanceof HTMLElement)) return
      const rect = card.getBoundingClientRect()
      window.api.reportFloatMetrics({
        bodyHeight: Math.round(document.body.getBoundingClientRect().height),
        cardWidth: Math.round(rect.width),
        cardHeight: Math.round(rect.height),
        cardBackground: getComputedStyle(card).backgroundColor,
        dropVisible: drop instanceof HTMLElement && drop.getBoundingClientRect().height > 0
      })
    }, 300)

    return () => clearTimeout(timer)
  }, [state])

  // 每次提醒都重放一次「啪」的动画
  useEffect(() => {
    if (fireCount === 0) return
    const el = document.querySelector('.float-card')
    if (!(el instanceof HTMLElement)) return
    el.classList.remove('is-popping')
    void el.offsetWidth
    el.classList.add('is-popping')
  }, [fireCount])

  if (fatal) {
    return (
      <div className="float-root is-opaque">
        <div className="float-card">
          <p className="float-title">小水滴出错</p>
          <p className="float-fatal">{fatal}</p>
        </div>
      </div>
    )
  }

  // 状态还没到 / preload 没注入时，也要画点东西出来。
  // 否则窗口是「透明 + 空白」，看起来跟没弹出来一模一样，根本没法排查。
  if (!state) {
    return (
      <div className="float-root">
        <div className="float-card">
          <div className="float-grip" />
          <div className="float-drop">
            <svg viewBox="0 0 64 80" width="64" height="80" aria-hidden="true">
              <path d={DROP_PATH} className="drop-outline" />
              <path d={DROP_PATH} className="drop-stroke" />
            </svg>
          </div>
          <p className="float-title">该喝水了</p>
          <p className="float-sub">{window.api ? '正在准备…' : 'preload 未注入'}</p>
        </div>
      </div>
    )
  }

  const { today, settings } = state
  const percent = today.goal > 0 ? Math.min(1, today.total / today.goal) : 0
  const remaining = Math.max(0, today.goal - today.total)
  const waterHeight = DROP_SPAN * percent

  const log = async (ml: number): Promise<void> => {
    await window.api.addDrink(ml, 'float')
    await window.api.hideFloat()
  }

  return (
    <div
      className={settings.floatTransparent ? 'float-root' : 'float-root is-opaque'}
      onMouseEnter={() => void window.api.extendFloat()}
    >
      <div className="float-card">
        <div className="float-grip" />

        <div className="float-drop">
          <svg viewBox="0 0 64 80" width="64" height="80" aria-hidden="true">
            <defs>
              <clipPath id="dropClip">
                <path d={DROP_PATH} />
              </clipPath>
            </defs>
            <path d={DROP_PATH} className="drop-outline" />
            <g clipPath="url(#dropClip)">
              <rect
                x="0"
                y={DROP_BOTTOM - waterHeight}
                width="64"
                height={waterHeight}
                className={percent >= 1 ? 'drop-water is-done' : 'drop-water'}
              />
            </g>
            <path d={DROP_PATH} className="drop-stroke" />
          </svg>
        </div>

        <p className="float-title">该喝水了</p>
        <p className="float-sub">
          {today.total} / {today.goal} ml
          {remaining > 0 ? ` · 还差 ${remaining}` : ' · 今天够了'}
        </p>

        <div className="float-actions">
          {QUICK_AMOUNTS.map((ml) => (
            <button
              key={ml}
              type="button"
              className={ml === settings.cupSize ? 'float-btn is-primary' : 'float-btn'}
              onClick={() => void log(ml)}
            >
              +{ml}
            </button>
          ))}
        </div>

        <button type="button" className="float-later" onClick={() => void window.api.hideFloat()}>
          稍后再说
        </button>
      </div>
    </div>
  )
}
