/** 外观偏好：跟随系统 / 强制浅色 / 强制深色 */
export type ThemePref = 'system' | 'light' | 'dark'

/** 真正生效的主题 */
export type ResolvedTheme = 'light' | 'dark'

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark'
}
