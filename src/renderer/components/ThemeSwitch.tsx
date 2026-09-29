import type { ThemePref } from '@shared/theme'

interface ThemeSwitchProps {
  value: ThemePref
  onChange: (next: ThemePref) => void
}

interface Option {
  pref: ThemePref
  label: string
  icon: React.JSX.Element
}

const OPTIONS: Option[] = [
  {
    pref: 'system',
    label: '跟随系统',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" className="seg-stroke" />
        <path d="M8 2.25a5.75 5.75 0 0 0 0 11.5Z" className="seg-fill" />
      </svg>
    )
  },
  {
    pref: 'light',
    label: '浅色',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.1" className="seg-fill" />
        <g className="seg-stroke" strokeLinecap="round">
          <path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3.05 3.05l1.27 1.27M11.68 11.68l1.27 1.27M12.95 3.05l-1.27 1.27M4.32 11.68l-1.27 1.27" />
        </g>
      </svg>
    )
  },
  {
    pref: 'dark',
    label: '深色',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.4 10.2A5.9 5.9 0 0 1 5.8 2.6a5.9 5.9 0 1 0 7.6 7.6Z" className="seg-fill" />
      </svg>
    )
  }
]

/** 三个并排的小段，图标表达、title 说人话 */
export default function ThemeSwitch({ value, onChange }: ThemeSwitchProps): React.JSX.Element {
  return (
    <div className="segment" role="group" aria-label="外观主题">
      {OPTIONS.map(({ pref, label, icon }) => (
        <button
          key={pref}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={value === pref}
          onClick={() => onChange(pref)}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}
