import { useEffect, useRef, useState } from 'react'
import { QUICK_AMOUNTS } from '@shared/defaults'
import type { AppState } from '@shared/types'
import { DROP_BOTTOM, DROP_PATH, DROP_SPAN } from './DropMark'
import { waveBand } from '../wave'
import { useTheme } from '../useTheme'

/** 小水滴的液面波：周期必须与 CSS 里 drop-tide 的位移量一致才能无缝循环 */
const DROP_WAVE_PERIOD = 32
const DROP_WAVE_AMP = 2
const DROP_WAVE_SPAN = 64 + DROP_WAVE_PERIOD * 2
const DROP_WAVE_D = waveBand(DROP_WAVE_SPAN, DROP_WAVE_PERIOD, DROP_WAVE_AMP, 6)

/** 水滴里的水柱：一条纵向渐变，上缘亮、底部沉 —— 和主面板的量筒同一套水色 */
function DropWater({ waterHeight, done }: { waterHeight: number; done: boolean }) {
  if (waterHeight <= 0) return null
  const surface = DROP_BOTTOM - waterHeight

  return (
    <>
      <rect
        className={done ? 'drop-water is-done' : 'drop-water'}
        x="0"
        y={surface}
        width="64"
        height={waterHeight}
      />
      {/*
        液面波。这里也要判空：波的带子比液面低几个像素，
        一滴都没有时整体贴到滴底，会露出一条浅色横杠，看着像「有点水」。
      */}
      <g transform={`translate(${-DROP_WAVE_PERIOD} ${surface})`}>
        <path className={done ? 'drop-wave is-done' : 'drop-wave'} d={DROP_WAVE_D} />
      </g>
    </>
  )
}

export default function FloatCard(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [fireCount, setFireCount] = useState(0)
  const [fatal, setFatal] = useState<string | null>(null)
  const reported = useRef(false)
  useTheme(state?.resolvedTheme)

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
  const done = percent >= 1
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
              <linearGradient id="dropWater" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="drop-stop-top" />
                <stop offset="0.5" className="drop-stop-mid" />
                <stop offset="1" className="drop-stop-bottom" />
              </linearGradient>
              <linearGradient id="dropWaterDone" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="drop-stop-done" />
                <stop offset="0.5" className="drop-stop-mid" />
                <stop offset="1" className="drop-stop-bottom" />
              </linearGradient>
            </defs>
            <path d={DROP_PATH} className="drop-outline" />
            <g clipPath="url(#dropClip)">
              <DropWater waterHeight={waterHeight} done={done} />
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
              aria-label={`记 ${ml} 毫升`}
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
