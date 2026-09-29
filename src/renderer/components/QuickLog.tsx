import { useState } from 'react'
import { QUICK_AMOUNTS } from '@shared/defaults'

interface QuickLogProps {
  cupSize: number
  onLog: (ml: number) => void
}

export default function QuickLog({ cupSize, onLog }: QuickLogProps): React.JSX.Element {
  const [custom, setCustom] = useState('')

  const submitCustom = (): void => {
    const value = Number.parseInt(custom, 10)
    if (Number.isFinite(value) && value > 0) {
      onLog(value)
      setCustom('')
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="eyebrow">记一杯</h2>
      </div>
      <div className="quick-row">
        {QUICK_AMOUNTS.map((ml) => (
          <button
            key={ml}
            type="button"
            className={ml === cupSize ? 'quick-btn is-default' : 'quick-btn'}
            title={ml === cupSize ? `快捷键记的那一杯：${ml} ml` : `记 ${ml} ml`}
            onClick={() => onLog(ml)}
          >
            <span className="quick-plus">+</span>
            <span className="quick-num">{ml}</span>
            <span className="quick-unit">ml</span>
          </button>
        ))}
      </div>
      <div className="quick-custom">
        <input
          type="number"
          min={10}
          max={2000}
          step={10}
          value={custom}
          placeholder="自定义毫升数"
          aria-label="自定义毫升数"
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitCustom()
          }}
        />
        <button type="button" className="btn" onClick={submitCustom}>
          记录
        </button>
      </div>
      <p className="hint">
        <span className="kbd">Ctrl + Alt + W</span>
        <span>随时记一杯（{cupSize} ml），不用切窗口</span>
      </p>
    </section>
  )
}
