import { useEffect, useState } from 'react'
import type { FloatState, Settings } from '@shared/types'

interface SettingsPanelProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onOpenDataDir: () => void
  onPreviewFloat: () => Promise<FloatState>
  onQuit: () => void
}

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onCommit: (value: number) => void
}

/** 数字输入用「本地草稿 + 失焦提交」，避免每敲一个字符就往磁盘写一次 */
function NumberField({ label, value, min, max, step = 1, unit, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(String(value))
      return
    }
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span className="field-unit">{unit}</span>
      </span>
    </label>
  )
}

interface ToggleProps {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  )
}

export default function SettingsPanel({
  settings,
  onChange,
  onOpenDataDir,
  onPreviewFloat,
  onQuit
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null)

  /** 预览结果必须显示出来。「点了没反应」是最难查的一类问题 */
  const handlePreview = async (): Promise<void> => {
    setPreview({ ok: true, text: '正在预览…' })

    if (!window.api || typeof window.api.previewFloat !== 'function') {
      setPreview({
        ok: false,
        text: 'preload 里没有 previewFloat —— preload 不会热更新，应用需要完全重启'
      })
      return
    }

    try {
      const state = await onPreviewFloat()
      if (!state.created) {
        setPreview({ ok: false, text: '窗口没有创建出来：请确认「桌面小水滴」已打开' })
      } else if (!state.visible) {
        const where = state.bounds ? `${state.bounds.x},${state.bounds.y}` : '未知'
        setPreview({
          ok: false,
          text: `窗口已创建但不可见（透明模式=${state.transparent ? '开' : '关'}，已加载=${state.loaded}，位置=${where}）—— 详细日志见「打开数据目录」下的 float.log`
        })
      } else if (!state.loaded) {
        setPreview({ ok: false, text: '窗口已显示，但页面尚未加载完成，再看一眼？' })
      } else {
        const b = state.bounds
        setPreview({
          ok: true,
          text: `已显示于 ${b?.x},${b?.y}（${b?.width}×${b?.height}，透明模式=${state.transparent ? '开' : '关'}）`
        })
      }
    } catch (err) {
      setPreview({ ok: false, text: `调用失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  return (
    <section className="card">
      <button type="button" className="card-head as-button" onClick={() => setOpen(!open)}>
        <h2>设置</h2>
        <span className="card-sub">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="settings">
          <h3>目标与节奏</h3>
          <NumberField
            label="每日目标"
            value={settings.dailyGoal}
            min={500}
            max={8000}
            step={100}
            unit="ml"
            onCommit={(dailyGoal) => onChange({ dailyGoal })}
          />
          <NumberField
            label="提醒间隔"
            value={settings.intervalMin}
            min={5}
            max={240}
            step={5}
            unit="分钟"
            onCommit={(intervalMin) => onChange({ intervalMin })}
          />
          <NumberField
            label="默认杯量"
            value={settings.cupSize}
            min={50}
            max={1000}
            step={50}
            unit="ml"
            onCommit={(cupSize) => onChange({ cupSize })}
          />
          <div className="field">
            <span className="field-label">活跃时段</span>
            <span className="field-control field-control-wide">
              <input
                type="time"
                value={settings.activeStart}
                onChange={(event) => onChange({ activeStart: event.target.value })}
              />
              <span className="field-unit">至</span>
              <input
                type="time"
                value={settings.activeEnd}
                onChange={(event) => onChange({ activeEnd: event.target.value })}
              />
            </span>
          </div>
          <Toggle
            label="只在工作日提醒"
            hint="周六周日完全安静"
            checked={settings.weekdaysOnly}
            onChange={(weekdaysOnly) => onChange({ weekdaysOnly })}
          />

          <h3>提醒方式</h3>
          <Toggle
            label="系统通知"
            hint="点击通知即记录一杯"
            checked={settings.notifyEnabled}
            onChange={(notifyEnabled) => onChange({ notifyEnabled })}
          />
          <Toggle
            label="通知带提示音"
            hint="默认静音，不打断你手上的事"
            checked={settings.soundEnabled}
            onChange={(soundEnabled) => onChange({ soundEnabled })}
          />
          <div className="inline-row">
            <Toggle
              label="桌面小水滴"
              hint="提醒触发时才出现；想立刻看效果就点右边的预览"
              checked={settings.floatEnabled}
              onChange={(floatEnabled) => onChange({ floatEnabled })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!settings.floatEnabled}
              onClick={() => void handlePreview()}
            >
              预览
            </button>
          </div>
          {preview && (
            <p className={preview.ok ? 'preview-status' : 'preview-status is-error'}>{preview.text}</p>
          )}
          <Toggle
            label="透明背景"
            hint="开启才是真正浮在桌面上的水滴。部分 Windows 环境下透明窗口会「存在但显示不出来」—— 屏幕上看不到就把它关掉"
            checked={settings.floatTransparent}
            onChange={(floatTransparent) => onChange({ floatTransparent })}
          />
          <NumberField
            label="小水滴自动隐藏"
            value={settings.floatAutoHideSec}
            min={5}
            max={120}
            step={5}
            unit="秒"
            onCommit={(floatAutoHideSec) => onChange({ floatAutoHideSec })}
          />

          <h3>不要打扰我</h3>
          <Toggle
            label="离开电脑时静默"
            hint="系统空闲超过阈值就跳过这次提醒，不累计、事后也不补"
            checked={settings.quietWhenIdle}
            onChange={(quietWhenIdle) => onChange({ quietWhenIdle })}
          />
          <NumberField
            label="判定离开的空闲时长"
            value={settings.idleThresholdMin}
            min={1}
            max={120}
            unit="分钟"
            onCommit={(idleThresholdMin) => onChange({ idleThresholdMin })}
          />

          <h3>其他</h3>
          <Toggle
            label="开机自动启动"
            hint="仅安装版生效，开发模式不会写注册表"
            checked={settings.autoLaunch}
            onChange={(autoLaunch) => onChange({ autoLaunch })}
          />
          <div className="action-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenDataDir}>
              打开数据目录
            </button>
            <button type="button" className="btn btn-ghost btn-sm is-danger" onClick={onQuit}>
              退出应用
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
