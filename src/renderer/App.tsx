import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatClock } from '@shared/date'
import AboutMenu from './components/AboutMenu'
import DropMark from './components/DropMark'
import QuickLog from './components/QuickLog'
import SettingsPanel from './components/SettingsPanel'
import StatusBar from './components/StatusBar'
import ThemeSwitch from './components/ThemeSwitch'
import TodayList from './components/TodayList'
import WaterGauge from './components/WaterGauge'
import WeekChart from './components/WeekChart'
import { useAppState } from './useAppState'
import { useTheme } from './useTheme'

/**
 * 水位尺上的分度：每 10% 一道，逢 25 加长。
 * 这些位置是固定的刻度位置（0–100%），和当前水位无关 ——
 * 水位由 .hero-rail-fill 的宽度表示，尺子本身不动。
 */
const RAIL_TICKS = Array.from({ length: 11 }, (_, i) => i * 10)

export default function App(): React.JSX.Element {
  const { state, addDrink, undo, patch, pause, resume } = useAppState()
  const [now, setNow] = useState(() => Date.now())
  const [checking, setChecking] = useState(false)
  useTheme(state?.resolvedTheme)

  // 本地跑倒计时，不用每秒钟去烦主进程
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const checkUpdate = useCallback(async () => {
    setChecking(true)
    try {
      // 结果由主进程推回来（AppState.update），这里只负责转圈
      await window.api.checkUpdate()
    } finally {
      setChecking(false)
    }
  }, [])

  const countdown = useMemo(() => {
    if (!state) return ''
    if (state.pausedUntil) return `暂停至 ${formatClock(state.pausedUntil)}`
    if (!state.nextAt) return '今日不再提醒'
    const diff = state.nextAt - now
    if (diff <= 0) return '马上提醒'
    const minutes = Math.floor(diff / 60_000)
    const seconds = Math.floor((diff % 60_000) / 1000)
    if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后`
    return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒后`
  }, [state, now])

  if (!state) {
    return <div className="loading">正在加载…</div>
  }

  const { today, settings } = state
  const reached = today.total >= today.goal
  const remaining = Math.max(0, today.goal - today.total)
  const percent = today.goal > 0 ? Math.min(1, today.total / today.goal) : 0

  return (
    <div className="app">
      {/*
        标题栏：只放「关于」和右侧的系统三键（三键是原生画的，页面这侧只负责给它留位）。
        品牌和操作按钮都下移到工具栏那一行 —— 标题栏这一条越干净，
        越不会被误当成可以随便点的工具条。
      */}
      <div className="titlebar">
        <AboutMenu
          version={state.version}
          update={state.update}
          download={state.download}
          checking={checking}
          onCheck={() => void checkUpdate()}
          onDownload={() => void window.api.downloadUpdate()}
          onOpenRepo={() => void window.api.openRepo()}
          onQuit={() => void window.api.quit()}
        />
      </div>

      <header className="topbar">
        <div className="brand">
          <span className={reached ? 'brand-mark is-done' : 'brand-mark'}>
            <DropMark />
          </span>
          <h1>喝水提醒</h1>
        </div>
        <div className="topbar-actions">
          <ThemeSwitch value={settings.theme} onChange={(theme) => void patch({ theme })} />
          {state.pausedUntil ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resume()}>
              恢复
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void pause(30)}>
              暂停 30 分
            </button>
          )}
        </div>
      </header>

      <main className="content">
        {/*
          水位区。这一块是整屏的主视觉，所以做了两处「破格」：
          顶部的横向水位尺通栏铺满、直接冲出卡片内边距（卡片自己不留 padding，
          内边距交给 .hero-body），量筒则向左出血、视觉上探出内容列。
        */}
        <section className="card is-hero">
          <div
            className={reached ? 'hero-rail is-done' : 'hero-rail'}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={today.goal}
            aria-valuenow={today.total}
            aria-label="今日水位"
          >
            <div className="hero-rail-fill" style={{ width: `${percent * 100}%` }} />
            {/*
              水位前缘的水面线。单独一个元素而不是 fill 的伪元素：
              一滴都没有时用百分比定位的伪元素会停在最左边露出一条竖杠，
              看着像「有一点水」。这里直接不渲染。
            */}
            {percent > 0 && (
              <span
                className="hero-rail-head"
                style={{ left: `${percent * 100}%` }}
                aria-hidden="true"
              />
            )}
            <div className="hero-rail-ticks" aria-hidden="true">
              {RAIL_TICKS.map((at) => (
                <span
                  key={at}
                  className={at % 25 === 0 ? 'hero-rail-tick is-major' : 'hero-rail-tick'}
                />
              ))}
            </div>
            <span className="hero-rail-label" aria-hidden="true">
              {Math.round(percent * 100)}%
            </span>
          </div>

          <div className="hero-body">
            <WaterGauge total={today.total} goal={today.goal} />
            <div className="readout">
              <h2 className="eyebrow">今日水位</h2>
              <p className="readout-value">
                {today.total}
                <span className="readout-unit">ml</span>
              </p>
              <dl className="readout-grid">
                <div className="readout-cell">
                  <dt>目标</dt>
                  <dd>{today.goal} ml</dd>
                </div>
                <div className="readout-cell">
                  <dt>还差</dt>
                  <dd className={remaining === 0 ? 'is-close' : undefined}>
                    {remaining === 0 ? '已达标' : `${remaining} ml`}
                  </dd>
                </div>
                <div className="readout-cell">
                  <dt>今日次数</dt>
                  <dd>{today.logs.length} 次</dd>
                </div>
                <div className="readout-cell">
                  <dt>连续达标</dt>
                  <dd>{state.streak} 天</dd>
                </div>
              </dl>
            </div>
          </div>

          {/*
            倒计时单独占一条通栏，不塞进读数列里：读数列比量筒高，
            塞进去会让量筒下面空出一大块；通栏之后两块自然齐平，
            而且「下次提醒」本来就该比那四个格子更显眼。
          */}
          <p className="hero-foot">
            <span className="hero-foot-label">下次提醒</span>
            <strong>{countdown}</strong>
          </p>
        </section>

        <QuickLog cupSize={settings.cupSize} onLog={addDrink} />

        <TodayList logs={today.logs} onUndo={undo} />

        <WeekChart recent={state.recent} goal={today.goal} />

        <SettingsPanel
          settings={settings}
          holiday={state.holiday}
          onChange={patch}
          onOpenDataDir={() => void window.api.openDataDir()}
          onOpenRepo={() => void window.api.openRepo()}
          onPreviewFloat={() => window.api.previewFloat()}
          onUpdateHoliday={() => void window.api.holidayUpdate()}
          onQuit={() => void window.api.quit()}
        />
      </main>

      <StatusBar
        version={state.version}
        update={state.update}
        download={state.download}
        checking={checking}
        onCheck={() => void checkUpdate()}
        onDownload={() => void window.api.downloadUpdate()}
        onOpen={(url) => void window.api.openRelease(url)}
      />
    </div>
  )
}
