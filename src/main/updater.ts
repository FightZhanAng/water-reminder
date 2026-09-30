import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  formatSize,
  isNewer,
  isTrustedAssetUrl,
  isTrustedReleaseUrl,
  parseSha256Digest,
  parseVersion,
  pickUpdateAsset,
  RELEASES_PAGE,
  REPO,
  REPO_PAGE,
  type UpdateAsset,
  type UpdateAssetKind,
  type UpdateCheck
} from '../shared/update'

const TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

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

/**
 * 下载地址白名单的额外放行前缀，只在验证模式下非空。
 *
 * 开了 `WATER_UPDATE_API` 就一并放行 mock 的源 —— 否则「下载 → 校验 → 拉起安装」
 * 这一段在真机上根本走不到，而它恰恰是最需要真机验证的部分（网络流、写盘、
 * 摘要、进程等待，四样都只有真跑才暴露问题）。
 */
function devAssetPrefix(): string | null {
  const mock = process.env['WATER_UPDATE_API']
  if (!mock) return null
  try {
    return `${new URL(mock).origin}/`
  } catch {
    return null
  }
}

export function releasePageUrl(): string {
  return RELEASES_PAGE
}

/**
 * 仓库主页。和 releases 页分开导出的理由只有一个：地址只写在主进程这一处，
 * 渲染层不传 URL 过来 —— 少一条能往系统浏览器里塞任意链接的通道。
 */
export function repoPageUrl(): string {
  return REPO_PAGE
}

interface ReleasePayload {
  tag_name?: unknown
  html_url?: unknown
  published_at?: unknown
  assets?: unknown
}

/**
 * 本机是不是免安装版。
 * electron-builder 的 portable 目标会在环境里塞这两个变量。
 *
 * 必须区分：免安装版去下 setup.exe 会把它变成安装版 —— 那是换了一种用法，不是更新。
 */
function isPortableBuild(): boolean {
  return Boolean(process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.env['PORTABLE_EXECUTABLE_DIR'])
}

/**
 * 把接口返回的附件数组整理成我们自己认识的形状。
 * 认不出的条目直接丢掉，不猜 —— 猜错就是下载并执行一个来路不明的东西。
 */
function parseAssets(raw: unknown): UpdateAsset[] {
  if (!Array.isArray(raw)) return []
  const out: UpdateAsset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = record['name']
    const url = record['browser_download_url']
    if (typeof name !== 'string' || typeof url !== 'string') continue
    out.push({
      name,
      url,
      size: typeof record['size'] === 'number' ? record['size'] : 0,
      sha256: parseSha256Digest(record['digest'])
    })
  }
  return out
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

    const kind: UpdateAssetKind = isPortableBuild() ? 'portable' : 'setup'

    return {
      state: 'update',
      latest,
      // 链接来自远端 JSON，不是 github.com 就退回仓库的 releases 页
      url: isTrustedReleaseUrl(data.html_url) ? data.html_url : RELEASES_PAGE,
      publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
      asset: pickUpdateAsset(parseAssets(data.assets), kind)
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { state: 'error', reason: humanize(raw, controller.signal.aborted, '检查') }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------ 下载与安装 */

export interface DownloadProgress {
  received: number
  total: number
}

export interface DownloadHooks {
  onProgress: (progress: DownloadProgress) => void
  /**
   * 字节收完、转入落盘与校验时调一次（在 `handle.sync()` 之前，理由见调用处）。
   *
   * 单拎一个回调出来，是因为这一段整个发生在 downloadUpdate 内部 ——
   * 外面没有别的时点能把界面从「下载中」切到「校验中」。
   */
  onVerifying?: () => void
}

const UPDATE_DIR_NAME = 'water-reminder-update'

/**
 * 下载落在哪个目录。
 *
 * 免安装版落在 exe 自己旁边 —— 用户拿到的应该是一个能直接双击的新程序，
 * 而不是藏在临时目录里、重启就被清掉的一份。但免安装版可能放在只读位置
 * （U 盘、Program Files），所以先做一次真实的写测试：
 * Windows 上 `access(W_OK)` 基本只看存在性、信不过，得真写一个文件再删掉。
 */
async function resolveDownloadDir(): Promise<string> {
  const portableDir = process.env['PORTABLE_EXECUTABLE_DIR']
  if (portableDir) {
    try {
      const probe = join(portableDir, `.wr-write-probe-${process.pid}`)
      await writeFile(probe, '')
      await unlink(probe)
      return portableDir
    } catch {
      // 只读位置，往下退回临时目录
    }
  }
  const dir = join(app.getPath('temp'), UPDATE_DIR_NAME)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 清掉上一次更新留在临时目录里的安装包，启动时调一次。
 *
 * 一个包 95MB，安装器一旦跑起来就不再看这个文件了，留着纯属浪费 ——
 * 试几次更新就是几百兆。**只清临时目录**：免安装版的下载落在 exe 自己旁边，
 * 那是用户放程序的地方，顺手删过去就是事故。
 *
 * 删不掉就算了（可能正被上一次的安装器占着），清理失败绝不能影响启动。
 */
export async function cleanupLeftovers(): Promise<void> {
  if (isPortableBuild()) return
  const dir = join(app.getPath('temp'), UPDATE_DIR_NAME)
  try {
    const entries = await readdir(dir)
    await Promise.all(
      entries.map((name) => rm(join(dir, name), { force: true, recursive: true }))
    )
  } catch {
    // 目录不存在（从没更新过）或被占用，都不是问题
  }
}

/**
 * 把安装包下到本地并做三重校验，返回落盘路径。
 *
 * 三重校验缺一不可：
 *   1. 大小 —— 传输中断（尤其国产网络下的长连接）不会让 fetch 报错，
 *      只会少几个字节，不查就是拿着半个安装包去执行；
 *   2. sha256 —— GitHub 现在会在附件上返回 `digest`，这是唯一能证明
 *      「拿到的就是我发的那个包」的东西；
 *   3. PE 头 —— 摘要可能缺失（老 release 没有），而错误页/登录页会被
 *      安安静静地存成 .exe。两个字节的检查就能挡住「下载了一堆文本准备去执行」。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  hooks: DownloadHooks
): Promise<string> {
  if (!isTrustedAssetUrl(asset.url, devAssetPrefix())) {
    throw new Error('下载地址不在白名单里')
  }

  const file = join(await resolveDownloadDir(), asset.name)
  await rm(file, { force: true })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const hash = createHash('sha256')
  let received = 0

  try {
    const res = await net.fetch(asset.url, {
      signal: controller.signal,
      headers: { 'user-agent': `water-reminder/${app.getVersion()}` }
    })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    if (!res.body) throw new Error('下载失败：响应没有内容')

    const total = asset.size > 0 ? asset.size : Number(res.headers.get('content-length') ?? 0)

    // 边收边写边算摘要。整包在内存里过一遍对 100MB 的安装包不合适
    const handle = await open(file, 'w')
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        const chunk = Buffer.from(value)
        received += chunk.byteLength
        hash.update(chunk)
        await handle.write(chunk)
        hooks.onProgress({ received, total })
      }
      /*
       * 字节收完就在这里切相位，不能等下面那三样检查做完再切。
       * `handle.sync()` 要把整个包刷到磁盘（95MB 在慢盘上要好几秒），
       * 期间界面会一直显示「正在下载 95 MB / 95 MB」，看着就是卡死了；
       * 而 sync 之后到返回之间只有零点几毫秒，那个相位根本没人看得见。
       */
      hooks.onVerifying?.()
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (err) {
    await rm(file, { force: true }).catch(() => undefined)
    const raw = err instanceof Error ? err.message : String(err)
    throw new Error(humanize(raw, controller.signal.aborted, '下载'))
  } finally {
    clearTimeout(timer)
  }

  const problem = await inspectDownload(file, asset, received, hash.digest('hex'))
  if (problem) {
    await rm(file, { force: true }).catch(() => undefined)
    throw new Error(problem)
  }
  return file
}

/**
 * 返回人话描述的失败原因；没问题返回 null。
 *
 * 这几句话会被原样塞进 440px 宽的状态栏，所以刻意写得短：
 * 早先那版是「应为 4198400 字节，实际收到 4194304」，直接被省略号吃掉后半截 ——
 * 唯一有信息量的数字全没了。缺多少用 `formatSize` 折算成「少了 4 KB」这种。
 */
async function inspectDownload(
  file: string,
  asset: UpdateAsset,
  received: number,
  digest: string
): Promise<string | null> {
  if (asset.size > 0 && received !== asset.size) {
    const missing = asset.size - received
    return missing > 0
      ? `安装包下载不完整（少了 ${formatSize(missing)}）`
      : '安装包大小与发布信息不符'
  }
  if (asset.sha256 && digest !== asset.sha256) {
    return '安装包校验失败'
  }

  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(2)
    await handle.read(head, 0, 2, 0)
    if (head[0] !== 0x4d || head[1] !== 0x5a) {
      return '下载到的不是可执行文件'
    }
  } finally {
    await handle.close()
  }
  return null
}

/**
 * 「等本进程退出，再拉起目标程序」的助手脚本。
 *
 * 为什么不直接 spawn 目标然后退出：
 *
 * - **单实例锁**。免安装版的新包就是本程序自己。我们还没退干净它就起来，
 *   会撞上锁、然后安静地自己退掉 —— 用户看到的是「点了更新，什么都没发生」。
 *   安装版虽然可以直接拉起（安装器会自己关掉旧实例），但走同一条路更省心，
 *   也能保证我们的退出流程跑完再去动文件。
 * - **不能落 .cmd / .ps1**。路径里带中文时，批处理的编码会把文件名搞乱；
 *   用本程序自己的二进制 + `-e` 内联脚本，一个文件都不用写。
 * - **必须摘掉 `ELECTRON_RUN_AS_NODE`**。助手自己是靠这个变量退化成 Node 的，
 *   子进程默认继承环境 —— 不摘的话，免安装版的新包会以 Node 模式启动：
 *   窗口和托盘全都不出来，进程还正常退 0，查起来毫无线索。
 *
 * 日志写在安装包旁边，因为「点了更新没反应」最难查：有了它至少能看出
 * 是没等到进程退出、还是拉起失败。
 */
const APPLY_HELPER = `
const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const [pid, target, logPath] = process.argv.slice(1)
const note = (m) => { try { appendFileSync(logPath, new Date().toISOString() + ' ' + m + '\\n') } catch {} }
const gone = () => { try { process.kill(Number(pid), 0); return false } catch { return true } }
note('waiting pid=' + pid + ' target=' + target)
const deadline = Date.now() + 30000
const tick = () => {
  if (!gone() && Date.now() < deadline) { setTimeout(tick, 200); return }
  note(gone() ? 'parent exited' : 'timed out waiting for parent, launching anyway')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  try {
    child = spawn(target, [], { detached: true, stdio: 'ignore', env })
  } catch (err) {
    note('spawn threw: ' + (err && err.message ? err.message : String(err)))
    return
  }
  // spawn 失败是异步报的（下一个 tick 才发 error 事件），同步的 try/catch
  // 抓不到 ENOENT / EACCES / 权限不足。不留这个 handler，日志里永远写「spawned」，
  // 而「点了更新没反应」唯一需要的那句真实原因恰恰在这里。
  child.on('error', (err) => note('spawn error: ' + (err && err.message ? err.message : String(err))))
  child.unref()
  note('spawned pid=' + child.pid)
  // 多停 1.5 秒：上面那个 error 事件要等下一个 tick 才来，
  // 立刻退出的话日志停在「spawned pid=undefined」，等于什么都没说
  setTimeout(() => {}, 1500)
}
tick()
`

/**
 * 拉起助手，随后调用方应当尽快退出应用。
 * 助手是分离进程，我们退出不会把它带走。
 */
export function launchAfterExit(target: string): void {
  const logPath = `${target}.apply.log`
  const child = spawn(process.execPath, ['-e', APPLY_HELPER, String(process.pid), target, logPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  // 先留一行，好知道助手至少是起来了（它自己会接着往下写）
  void appendFile(logPath, `${new Date().toISOString()} helper spawned\n`).catch(() => undefined)
}

/**
 * 把底层报错翻成人话。
 *
 * 「fetch failed」「net::ERR_CERT_AUTHORITY_INVALID」这类原文对用户没有任何指导意义 ——
 * 他不知道该去检查网络、代理还是证书。认得出的情况给一句能行动的，认不出的照原样透传。
 */
function humanize(raw: string, aborted: boolean, what: '检查' | '下载'): string {
  if (aborted) return what === '下载' ? '下载超时' : '请求超时'
  if (/fetch failed|net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|CERT_|certificate/i.test(raw)) {
    return '连不上 GitHub，检查网络或代理'
  }
  return raw
}
