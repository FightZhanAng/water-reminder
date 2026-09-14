import { useEffect, useMemo, useState } from 'react'
import { formatClock } from '@shared/date'
import QuickLog from './components/QuickLog'
import ProgressRing from './components/ProgressRing'
import SettingsPanel from './components/SettingsPanel'
import TodayList from './components/TodayList'
import WeekChart from './components/WeekChart'
import { useAppState } from './useAppState'

export default function App(): React.JSX.Element {
  const { state, addDrink, undo, patch, pause, resume } = useAppState()
  const [now, setNow] = useState(() => Date.now())

  // 本地跑倒计时，不用每秒钟去烦主进程
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const countdown = useMemo(() => {
    if (!state) return ''
    if (state.pausedUntil) return `已暂停至 ${formatClock(state.pausedUntil)}`
    if (!state.nextAt) return '今日不再提醒'
    const diff = state.nextAt - now
    if (diff <= 0) return '马上提醒'
    const minutes = Math.floor(diff / 60_000)
    const seconds = Math.floor((diff % 60_000) / 1000)
    if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后提醒`
    return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒后提醒`
  }, [state, now])

  if (!state) {
    return <div className="loading">正在加载…</div>
  }

  const { today, settings } = state
  const reached = today.total >= today.goal

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`brand-dot${reached ? ' is-done' : ''}`} />
          <div>
            <h1>喝水提醒</h1>
            <p className="brand-sub">{countdown}</p>
          </div>
        </div>
        {state.pausedUntil ? (
          <button type="button" className="btn btn-ghost" onClick={() => void resume()}>
            恢复
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => void pause(30)}>
            暂停 30 分
          </button>
        )}
      </header>

      <main className="content">
        <section className="hero">
          <ProgressRing total={today.total} goal={today.goal} />
          <div className="hero-facts">
            <div className="fact">
              <span className="fact-value">{today.logs.length}</span>
              <span className="fact-label">今日次数</span>
            </div>
            <div className="fact">
              <span className="fact-value">{state.streak}</span>
              <span className="fact-label">连续达标</span>
            </div>
            <div className="fact">
              <span className="fact-value">{Math.max(0, today.goal - today.total)}</span>
              <span className="fact-label">还差 ml</span>
            </div>
          </div>
        </section>

        <QuickLog cupSize={settings.cupSize} onLog={addDrink} />

        <TodayList logs={today.logs} onUndo={undo} />

        <WeekChart recent={state.recent} goal={today.goal} />

        <SettingsPanel
          settings={settings}
          onChange={patch}
          onOpenDataDir={() => void window.api.openDataDir()}
          onPreviewFloat={() => window.api.previewFloat()}
          onQuit={() => void window.api.quit()}
        />
      </main>
    </div>
  )
}
