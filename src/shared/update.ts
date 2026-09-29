/**
 * 更新检查里与网络无关的纯逻辑：版本号解析与比较、下载地址白名单。
 *
 * 放 shared 是为了能脱离 Electron 直接跑测试（见 scripts/core-test.ts）——
 * 版本比较这种东西写错了不会报错，只会「永远说已是最新」，必须有测试兜着。
 */

/** 一次更新检查的结果。渲染层按 state 决定显示什么 */
export type UpdateCheck =
  | { state: 'update'; latest: string; url: string; publishedAt: string | null }
  | { state: 'current'; latest: string }
  | { state: 'error'; reason: string }

/**
 * 只认 https://github.com/ 开头的地址。
 * 下载链接来自远端 JSON，不能拿到就用 —— 那是把任意 URL 交给系统浏览器。
 */
export function isTrustedReleaseUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://github.com/')
}

/**
 * `v0.3.0` / `0.3.0` / `0.4.0-beta.1` → `[0, 3, 0]`；解析不出来返回 null。
 * 预发布后缀直接丢掉：GitHub 的 releases/latest 本来就不返回预发布版本。
 */
export function parseVersion(raw: unknown): number[] | null {
  if (typeof raw !== 'string') return null
  const core = raw.trim().replace(/^v/i, '').split('-')[0]
  if (!core) return null
  const parts = core.split('.')
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    nums.push(Number.parseInt(part, 10))
  }
  return nums.length > 0 ? nums : null
}

/**
 * candidate 是否比 current 新。
 * 任一边解析不出来就返回 false —— 宁可漏报一次更新，也不能误报让用户去下个旧包。
 */
export function isNewer(candidate: unknown, current: unknown): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  const len = Math.max(next.length, now.length)
  for (let i = 0; i < len; i++) {
    const a = next[i] ?? 0
    const b = now[i] ?? 0
    if (a !== b) return a > b
  }
  return false
}
