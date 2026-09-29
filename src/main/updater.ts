import { net } from 'electron'
import { isNewer, isTrustedReleaseUrl, parseVersion, type UpdateCheck } from '../shared/update'

const REPO = 'FightZhanAng/water-reminder'
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
const TIMEOUT_MS = 10_000

/**
 * 更新检查的地址。
 *
 * 默认打 GitHub 的 `releases/latest`（公开仓库免鉴权，匿名限流 60 次/小时/IP，
 * 一天查一次远远够用）。`WATER_UPDATE_API` 是留给验证的口子：本机的 Node 和
 * Chromium 都够不到 GitHub，只有把地址指到本地 mock 服务器，这条链路才测得了。
 */
function apiUrl(): string {
  return process.env['WATER_UPDATE_API'] ?? `https://api.github.com/repos/${REPO}/releases/latest`
}

export function releasePageUrl(): string {
  return RELEASES_PAGE
}

interface ReleasePayload {
  tag_name?: unknown
  html_url?: unknown
  published_at?: unknown
}

/**
 * 查一次最新版本。
 *
 * 必须在主进程发请求：打包后渲染层的 CSP 是 `default-src 'self'`，
 * `connect-src` 跟着回落，渲染层直接 fetch 外网会被挡掉。
 * 用 `net.fetch` 而不是全局 fetch，是为了走 Chromium 的网络栈 ——
 * 系统代理、企业环境的证书设置都能跟着走。
 */
export async function checkForUpdate(current: string): Promise<UpdateCheck> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await net.fetch(apiUrl(), {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `water-reminder/${current}`
      }
    })
    if (!res.ok) return { state: 'error', reason: `GitHub 返回 ${res.status}` }

    const data = (await res.json()) as ReleasePayload
    const parsed = parseVersion(data.tag_name)
    if (!parsed) return { state: 'error', reason: '返回里没有可用的版本号' }

    const latest = parsed.join('.')
    if (!isNewer(latest, current)) return { state: 'current', latest }

    return {
      state: 'update',
      latest,
      // 链接来自远端 JSON，不是 github.com 就退回仓库的 releases 页
      url: isTrustedReleaseUrl(data.html_url) ? data.html_url : RELEASES_PAGE,
      publishedAt: typeof data.published_at === 'string' ? data.published_at : null
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { state: 'error', reason: humanize(raw, controller.signal.aborted) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把底层报错翻成人话。
 *
 * 「fetch failed」「net::ERR_CERT_AUTHORITY_INVALID」这类原文对用户没有任何指导意义 ——
 * 他不知道该去检查网络、代理还是证书。认得出的情况给一句能行动的，认不出的照原样透传。
 */
function humanize(raw: string, aborted: boolean): string {
  if (aborted) return '请求超时'
  if (/fetch failed|net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|CERT_|certificate/i.test(raw)) {
    return '连不上 GitHub，检查网络或代理'
  }
  return raw
}
