import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatClock } from '@shared/date'
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
    if (state.pausedUntil) return `已暂停至 ${formatClock(state.pausedUntil)}`
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
        <section className="card">
          <div className="hero-body">
            <WaterGauge total={today.total} goal={today.goal} />
            <div className="readout">
              <div className="readout-head">
                <h2 className="eyebrow">今日水位</h2>
                <span className="readout-percent">{Math.round(percent * 100)}%</span>
              </div>
              <p className="readout-value">
                {today.total}
                <span className="readout-unit">ml</span>
              </p>
              <dl className="readout-list">
                <dt>目标</dt>
                <dd>{today.goal} ml</dd>
                <dt>还差</dt>
                <dd className={remaining === 0 ? 'is-close' : undefined}>
                  {remaining === 0 ? '已达标' : `${remaining} ml`}
                </dd>
                <dt>今日次数</dt>
                <dd>{today.logs.length} 次</dd>
                <dt>连续达标</dt>
                <dd>{state.streak} 天</dd>
                <dt>下次提醒</dt>
                <dd>{countdown}</dd>
              </dl>
            </div>
          </div>
        </section>

        <QuickLog cupSize={settings.cupSize} onLog={addDrink} />

        <TodayList logs={today.logs} onUndo={undo} />

        <WeekChart recent={state.recent} goal={today.goal} />

        <SettingsPanel
          settings={settings}
          holiday={state.holiday}
          onChange={patch}
          onOpenDataDir={() => void window.api.openDataDir()}
          onPreviewFloat={() => window.api.previewFloat()}
          onUpdateHoliday={() => void window.api.holidayUpdate()}
          onQuit={() => void window.api.quit()}
        />
      </main>

      <StatusBar
        version={state.version}
        update={state.update}
        checking={checking}
        onCheck={() => void checkUpdate()}
        onOpen={(url) => void window.api.openRelease(url)}
      />
    </div>
  )
}
