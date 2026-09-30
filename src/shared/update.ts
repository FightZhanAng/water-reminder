/**
 * 更新链路里与网络无关的纯逻辑：版本号解析与比较、发布资产挑选、digest 解析、
 * 地址白名单、下载校验与显示文案派生。
 *
 * 放 shared 是为了能脱离 Electron 直接跑测试（见 scripts/core-test.ts）——
 * 这几样写错了都不会报错，只会静默跑偏：
 * 版本比较错了是「永远说已是最新」，挑包错了是下载到不对的那个安装包，
 * digest 解析错了是「要么把正常包拒掉，要么校验形同虚设」。
 */

/** 仓库地址的唯一来源。主进程和信任白名单都从这里取，避免两处写得不一样 */
export const REPO = 'FightZhanAng/water-reminder'
export const REPO_PAGE = `https://github.com/${REPO}`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`

/**
 * 发布资产的下载地址前缀。
 * `releases/download/<tag>/<file>` 是 GitHub 的固定路径，2013 年起没变过。
 * 校验到这一段为止（而不是只看到 github.com）—— 只校验域名的话，
 * 仓库里任何一个 release 的任何一个附件都能塞进来自动执行。
 */
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`

/** GitHub 发布接口返回的一个附件 */
export interface UpdateAsset {
  name: string
  url: string
  size: number
  /** 从 `digest` 字段解出来的 sha256 十六进制；GitHub 没给就是 null */
  sha256: string | null
}

/** 本机该吃哪种包：安装版吃 setup，免安装版吃 portable */
export type UpdateAssetKind = 'setup' | 'portable'

/**
 * 字节数 → 给用户看的大小。
 *
 * 主进程（拼失败原因）和渲染层（下载进度）都得用同一套规则：状态栏只有
 * 440px 宽，一句「应为 4198400 字节，实际收到 4194304」会被省略号吃掉后半截，
 * 而那几个数字恰恰是唯一有信息量的部分。所以按量级挑单位：
 * 百兆以上不要小数、MB 级留一位、再小就用 KB —— 既短，位数也不会在
 * 每 120ms 一次的进度刷新里来回跳。
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const mb = bytes / 1024 / 1024
  if (mb >= 100) return `${Math.round(mb)} MB`
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  const kb = bytes / 1024
  if (kb >= 1) return `${Math.round(kb)} KB`
  return `${Math.round(bytes)} B`
}

/** 一次更新检查的结果。渲染层按 state 决定显示什么 */
export type UpdateCheck =
  | {
      state: 'update'
      latest: string
      url: string
      publishedAt: string | null
      /**
       * 能应用内下载安装就用它。挑不到（发布时漏了资产、或名字不符合约定）就是 null，
       * 渲染层据此退回「打开发布页」—— 宁可让用户手动下，也不能给一个错的包。
       */
      asset: UpdateAsset | null
    }
  | { state: 'current'; latest: string }
  | { state: 'error'; reason: string }

/**
 * 应用内下载安装的进度。跟着 AppState 推给渲染层。
 *
 * 和 UpdateCheck 分开是因为两者生命周期不同：check 是「查到了什么」，
 * download 是「正在做什么」。合在一个联合类型里会出现「正在下载时 state 算什么」这种
 * 说不清的状态，渲染层就得靠字段猜。
 */
export type UpdateDownload =
  | { state: 'idle' }
  | { state: 'downloading'; latest: string; received: number; total: number }
  | { state: 'verifying'; latest: string }
  | { state: 'installing'; latest: string }
  | { state: 'error'; reason: string }

/**
 * 只认 https://github.com/ 开头的地址。
 * 下载链接来自远端 JSON，不能拿到就用 —— 那是把任意 URL 交给系统浏览器。
 */
export function isTrustedReleaseUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://github.com/')
}

/**
 * 下载安装包的地址白名单：必须是本仓库的 releases/download 路径。
 *
 * `extraPrefix` 是留给验证的口子 —— 本地 mock 服务器起在 127.0.0.1 上，
 * 不额外放行的话这条链路在真机上根本测不到（和 `WATER_UPDATE_API` 同一个理由）。
 * 只有主进程在验证模式下才会传它进来，正常运行时是空的。
 */
export function isTrustedAssetUrl(url: unknown, extraPrefix?: string | null): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  if (url.startsWith(ASSET_PREFIX)) return true
  return typeof extraPrefix === 'string' && extraPrefix.length > 0 && url.startsWith(extraPrefix)
}

/**
 * 解析 GitHub 的附件摘要字段，形如 `sha256:<64 位十六进制>`。
 *
 * 只认 sha256 且长度严格是 64 —— 别的算法、或者被截断的值一律返回 null。
 * 返回 null 的后果是「跳过摘要校验」，所以这里必须严格：
 * 宽松地把一个空串当成合法摘要，会让校验永远通过。
 */
export function parseSha256Digest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const matched = /^sha256:([0-9a-f]{64})$/i.exec(raw.trim())
  return matched ? matched[1].toLowerCase() : null
}

/**
 * 从附件列表里挑出本机要用的那个包。
 *
 * 按后缀认而不是按完整文件名认：文件名里带版本号（`water-reminder-0.9.0-setup.exe`），
 * 硬编码完整名字的话，每发一版都得跟着改，漏改就是「找不到安装包」。
 * 同一后缀理论上只有一个；真出现多个就挑最大的，别随手拿第一个。
 */
export function pickUpdateAsset(
  assets: readonly UpdateAsset[],
  kind: UpdateAssetKind
): UpdateAsset | null {
  const suffix = `-${kind}.exe`
  const hits = assets.filter(
    (asset) => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith(suffix)
  )
  if (hits.length === 0) return null
  return hits.reduce((best, current) => (current.size > best.size ? current : best))
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

/* ------------------------------------------------------------ 校验与文案派生 */

/**
 * 下载完成后的体积与摘要校验，返回人话的失败原因；都过关返回 null。
 *
 * 从主进程搬来 shared 的理由：这是纯比较逻辑，留在主进程就只能靠整条链路
 * 真跑才测得到，搬出来就能逐个分支钉死（少了多少字节、摘要对不上、发布方没给摘要）。
 * PE 头检查要真开文件，只能留在主进程。
 */
export function sizeOrDigestProblem(
  asset: Pick<UpdateAsset, 'size' | 'sha256'>,
  received: number,
  digest: string
): string | null {
  if (asset.size > 0 && received !== asset.size) {
    const missing = asset.size - received
    return missing > 0
      ? `安装包下载不完整（少了 ${formatSize(missing)}）`
      : '安装包大小与发布信息不符'
  }
  if (asset.sha256 && digest !== asset.sha256) {
    return '安装包校验失败'
  }
  return null
}

/**
 * 把底层网络报错翻成人话。
 *
 * 「fetch failed」「net::ERR_CERT_AUTHORITY_INVALID」这类原文对用户没有任何指导
 * 意义 —— 他不知道该去检查网络、代理还是证书。认得出的情况给一句能行动的，
 * 认不出的照原样透传。搬来 shared 是为了让这几句文案的口径进 core-test。
 */
export function humanizeNetworkError(
  raw: string,
  aborted: boolean,
  what: '检查' | '下载'
): string {
  if (aborted) return what === '下载' ? '下载超时' : '请求超时'
  if (/fetch failed|net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|CERT_|certificate/i.test(raw)) {
    return '连不上 GitHub，检查网络或代理'
  }
  return raw
}

/**
 * `describeDownload` 的返回：一次下载状态的「全部显示口径」一次算清。
 *
 * 拆成四个字段而不是只有一个 text，是因为消费方要的不一样：
 * 状态栏要带字节数的完整进度；「关于」弹窗和读屏器只要相位 ——
 * 少了这层区分，要么弹窗跟着 120ms 刷一次，要么读屏器把字节数念成洪水。
 */
export interface DownloadSummary {
  /** 下载/校验/安装任一进行中 —— 按钮要占住，不给重复点击留缝 */
  busy: boolean
  /** 下载链路的失败原因；没失败为 null（检查失败不在这，那是 UpdateCheck 的事） */
  failed: string | null
  /** 状态栏完整文案（下载中带字节数）；idle 时为 null，让位给检查链路的文案 */
  text: string | null
  /** 相位级短文案（不含字节数）：「关于」弹窗与 aria-live 播报共用；idle 为 null */
  phase: string | null
}

/**
 * 从下载状态派生显示文案。状态栏和「关于」弹窗共用这一份派生 ——
 * 在这之前两边各写了一遍三元链，改口径时漏掉一边就是
 * 「弹窗说下载中、状态栏说更新失败」。
 */
export function describeDownload(download: UpdateDownload): DownloadSummary {
  switch (download.state) {
    case 'downloading':
      return {
        busy: true,
        failed: null,
        text: `正在下载 ${download.latest}　${formatSize(download.received)}${
          download.total > 0 ? ` / ${formatSize(download.total)}` : ''
        }`,
        phase: `正在下载 ${download.latest}…`
      }
    case 'verifying':
      return { busy: true, failed: null, text: '正在校验安装包…', phase: '正在校验安装包…' }
    case 'installing':
      return {
        busy: true,
        failed: null,
        text: `正在安装 ${download.latest}，应用即将重启…`,
        phase: `正在安装 ${download.latest}，应用即将重启…`
      }
    case 'error':
      return {
        busy: false,
        failed: download.reason,
        text: `更新失败：${download.reason}`,
        phase: `更新失败：${download.reason}`
      }
    default:
      return { busy: false, failed: null, text: null, phase: null }
  }
}
