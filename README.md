# 喝水提醒

Windows 桌面常驻的喝水提醒工具。三种提醒形态并存，互不抢戏：

- **托盘水位水滴** —— 图标是一颗水滴，水位随今天喝的量上涨，抬头一眼就知道进度
- **系统通知** —— 点击通知即记录一杯，不用切窗口
- **桌面小水滴** —— 右下角飘出一个小水珠，水量随进度上涨，可直接点快捷记录

技术栈：Electron 43 + electron-vite 5 + React 19 + TypeScript。

界面按「一台量水仪器」来做：主面板左侧是一支真的量筒，刻度按目标值换算成毫升、
液面随进度上涨，右侧是读数表；反复出现的「刻度竖线」是分区记号，和量筒上的分度
是同一套语言。深浅两套主题就是**水深** —— 浅水（矿物纸底 + 印刷水色）与
深水（深渊底色 + 荧光青）。

## 快速开始

```bash
pnpm install          # 若 electron 二进制没下下来，见下方「环境注意事项」
pnpm dev              # 开发模式，带 HMR
pnpm typecheck        # 类型检查（主进程 / 渲染层分别检查）
pnpm test:core        # 核心逻辑无头测试（提醒点计算 + 统计聚合）
pnpm gen:icons        # 重新生成图标资源
pnpm build            # 产出 out/，可直接 run
pnpm dist             # 打 Windows 安装包 + 便携版，输出到 release/
```

`pnpm dist` 不直接调 electron-builder，而是走 `scripts/dist.mjs`。
那个包装器会注入国内镜像 —— 本机访问 GitHub Releases 会卡在证书吊销检查上
（`CRYPT_E_NO_REVOCATION_CHECK`）直接失败，走 `npmmirror.com` 才通得过。
镜像地址可以用环境变量覆盖，换网络环境不用改代码。

`pnpm dev` / `pnpm preview` 也套了一层 `scripts/electron-run.mjs`，它只做一件事：
启动前把 `ELECTRON_RUN_AS_NODE` 从环境里摘掉。留着那个变量，electron 会退化成普通
Node，启动即崩，而且报错看不出原因 —— 详见「环境注意事项」。

打包产物落在 `release/`：

| 文件 | 说明 |
| --- | --- |
| `water-reminder-0.4.0-setup.exe` | NSIS 安装包（约 100 MB），可选安装目录、建桌面快捷方式 |
| `water-reminder-0.4.0-portable.exe` | 免安装单文件版，双击直接跑 |
| `water-reminder-0.4.0-x64.nsis.7z` | 安装包的载荷数据 |
| `win-unpacked/` | 免安装的解包版本，双击里面的 `water-reminder.exe` 直接跑 |

首次打包会从镜像下载 winCodeSign / nsis / electron 等二进制到
`%LOCALAPPDATA%/electron-builder/Cache`，之后就快了。

### 发布版本

推一个 `v*` 的 tag 就会触发 GitHub Actions，在 `windows-latest` 上重新构建
并把两个安装包挂到 Release 上：

```bash
git tag -a v0.4.0 -m "喝水提醒 0.4.0"
git push origin v0.4.0
```

工作流在 `.github/workflows/release.yml`，包含类型检查、核心逻辑测试和打包三步，
任何一步失败都不会发布。

之所以不"本地打完包再上传"：这台开发机除了 git 自己的 libcurl，
所有到 GitHub 的 HTTPS 通道都被证书吊销检查挡住了，而 Release 资产只能走 HTTP 上传
（SSH 管不了）。交给 CI 反而更省事，也顺带保证 Release 里的包一定能从源码重现。

## 小水滴怎么才看得见

桌面小水滴**只在提醒真正触发的那一刻出现**，然后 20 秒后自动隐藏 —— 它不是常驻挂件。
所以刚启动应用时看不到它是正常的。

想立刻看效果，两个入口：

- 设置面板 →「提醒方式」→ 桌面小水滴右侧的**预览**按钮
- 托盘右键 →「预览小水滴」

另外，把小水滴开关从关打到开的那一下，会自动弹一次给你看。

### 「透明背景」这个开关是干什么的

默认**关闭**，小水滴是一块不透明的小面板 —— 最稳，任何环境都能显示出来。

打开之后才是真正「浮在桌面上」的水滴（窗口是 `transparent: true`）。
代价是：**部分 Windows 环境（显示缩放非 100%、特定显卡驱动、软件合成）下，
透明窗口会出现「窗口确实存在、`isVisible()` 返回 true、但屏幕上什么都没有」**。
这台机器就是其中之一。

所以规矩是：**屏幕上看不到就把这个开关关掉**。开关一改会重建窗口（`transparent`
是创建参数，改不了），重建后再点一次预览即可。

**点了预览还是没反应怎么办**：按钮下方会直接显示窗口的实际状态
（没创建 / 创建了但不可见 / 可见但页面未加载完 / 正常显示，含坐标与当前透明模式）。
设置面板里的「打开数据目录」进去有 `float.log`，记录了每一次创建、加载、呈现、
失败，以及渲染层自己量到的 `renderer metrics`（卡片宽高、背景色、水滴是否渲染）。
有这组数据就能区分「DOM 根本没渲染」和「DOM 正常但窗口没合成上」。

## 深浅主题

外观三档：**跟随系统 / 浅色 / 深色**，切换在主面板右上角的三个图标，默认跟随系统
（白天浅水、晚上自动深水）。选择存在设置里，重启后还在；老的数据文件没有这个字段，
读取时会自动补上默认值。

实现上有两条硬约束，都是实测才知道的：

1. **主题不能由渲染层自己算。** 系统在深浅之间切换时，Electron 会更新渲染层的
   `prefers-color-scheme`，但**不会**给 `matchMedia` 派发 `change` 事件 ——
   谁去监听它，「跟随系统」就会僵在旧主题上（实测：`matches` 已经是 true，
   `change` 一次都没来）。所以主进程把偏好灌进 `nativeTheme.themeSource`，
   再把算好的 `AppState.resolvedTheme` 推给渲染层，渲染层只负责写
   `<html data-theme>`，不自己判断。
2. **首帧不能闪。** React 挂载前那一帧没有任何 JS 参与，所以 `tokens.css` 里
   深色 token 写了两份：一份在 `@media (prefers-color-scheme: dark)` 里带
   `:not([data-theme])`，只管首帧兜底；一份是 `:root[data-theme='dark']`，是权威的。
   两份必须逐字一致，改一份就要改另一份。

窗口底色（`BrowserWindow` 的 `backgroundColor`）也在主进程里跟着主题走，
否则窗口出现到页面首帧之间会闪一下旧底色。这几个色值在主进程里是硬编码的
（`WINDOW_BG` / `FLOAT_BG`）—— 主进程读不到 CSS，只能和 `tokens.css` 里的
`--bg`、`--surface` 各写一份、手动对齐。

## 版本号与更新检查

窗口底部常驻一条状态栏：左边版本号，右边更新状态。启动 8 秒后自动查一次
（设置 →「其他」→ 自动检查更新，可关），也可以随时点「检查更新」。

- **只提示，不自动下载**：发现新版本时给出「去下载」，打开 GitHub 的 Release 页，
  由你自己选装安装版还是便携版
- 走 GitHub 的 `releases/latest`：公开仓库免鉴权，匿名限流 60 次/小时/IP，
  一天一次远远够用
- 请求在主进程发，用 `net.fetch` —— 打包后渲染层的 CSP 是 `default-src 'self'`，
  `connect-src` 跟着回落，渲染层直接 fetch 外网会被挡掉。用 `net.fetch` 而不是
  全局 fetch，是为了走 Chromium 的网络栈，系统代理和企业证书设置能跟着走
- 下载链接来自远端 JSON，**开之前校验域名**（只认 `https://github.com/`），
  不合法就退回仓库的 releases 页 —— 不能把任意 URL 交给系统浏览器
- 版本比较、地址白名单这些纯逻辑在 `src/shared/update.ts`，跟着 `pnpm test:core` 一起测

验证用的口子：`WATER_UPDATE_API` 可以把检查地址指到别处（本机够不到 GitHub，
只有指向本地 mock 服务才测得了这条链路）。

```powershell
$env:WATER_UPDATE_API = "http://127.0.0.1:8899/update"
```

**在这台开发机上会显示「检查失败：连不上 GitHub，检查网络或代理」** —— 这台机器的
Node / Chromium 到 GitHub 的 HTTPS 都被证书吊销检查挡住了（见「环境注意事项」），
只有 git 和 `gh` 能通。换个网络环境或修好证书链就正常，不是代码问题。

## 通知点击为什么打开了 Electron 欢迎页

踩过一次，记下来。

**症状**：点系统通知，弹出来的不是主面板，而是 Electron 的默认欢迎页 ——
页面上还贴心地提示 `electron.exe path-to-app`。

**成因链**：

1. Windows 上 toast 通知靠 AppUserModelID（AUMID）归属。光调
   `app.setAppUserModelId()` 不够 —— Windows 还需要知道「这个 AUMID 该由谁处理」，
   才能把点击投回运行中的进程。
2. 它找的是 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 下的 `CustomActivator`。
   **Electron 不写这个键**：它只写 `HKCU\Software\Classes\CLSID\{guid}`
   （默认值 `Electron Notification Activator`、`CustomActivator=1`、
   `LocalServer32=<exe>`）。同机上真正能正常工作的桌面通知应用
   （Watt Toolkit / Reasonix）都是**两者都有**。
3. 缺了这个映射，Windows 只能退化成「去启动某个注册过的目标」。而注册表里指向
   exe 的入口有**两个**：开发版 `electron.exe` 和安装版 `water-reminder.exe`。
4. 另外 Electron 在开发态还会**自动生成**一个开始菜单快捷方式充当身份：
   `%APPDATA%\...\Start Menu\Programs\Electron.lnk`，它只写 target +
   workingDirectory，**不带应用路径参数**（LinkFlags 缺 `HasArguments`）。
5. 于是安装版的通知被点击 → Windows 挑中了开发版那条路径 → 启动一个裸
   `electron.exe` → 欢迎页（页面还贴心地提示 `electron.exe path-to-app`）。

**修法（三步，缺一不可 —— 实测只做前两步仍然会弹欢迎页）**：

1. **开发态与安装版用不同的 AUMID**，见 `src/main/index.ts` 里 `APP_ID` 的注释。
2. **清掉开始菜单里残留的旧 AUMID 快捷方式**（那个 `Electron.lnk`）。改了代码
   它不会自动失效。
3. **补上 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 这个键** —— 关键、也最
   容易漏：

   ```
   [HKEY_CURRENT_USER\SOFTWARE\Classes\AppUserModelId\com.tomcato.water-reminder]
   "DisplayName"="喝水提醒"
   "IconUri"="D:\\App\\water-reminder\\resources\\assets\\icon.png"
   "IconBackgroundColor"="FF1E88E5"
   "CustomActivator"="{0D091DC3-8CFF-4FB6-8CAD-47992294943E}"
   "HasSentNotification"=dword:00000001
   ```

   CLSID 用 Electron 自己注册的那个：在 `HKCU\Software\Classes\CLSID` 下找
   `LocalServer32` 指向本应用 exe 的项。补上之后 Windows 会走 COM 激活把点击投回
   运行中的进程，不再去启动任何新目标。

**这个键没法靠源码自动生成**：CLSID 由 Electron 内部生成，应用拿不到。要么装机后
手动补（本次做法），要么在启动时扫 `HKCU\Software\Classes\CLSID` 找出
`LocalServer32 == process.execPath` 的那一项，自己把键写出来。

**排查手法**：

- `.lnk` 二进制：LinkFlags 在偏移 20（4 字节），`0x20` 位是 `HasArguments`；
  LinkInfo 里的 LocalBasePath 是 target；AUMID 以 `System.AppUserModel.ID` 存在
  ExtraData 的 PropertyStore 块（`0xA0000009`）里。
- 注册表：查 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 有没有 `CustomActivator`；
  再查 `HKCU\Software\Classes\CLSID` 下有没有指向**错误 exe** 的 `LocalServer32`。
- 注意 `reg query` 打印中文会因控制台代码页显示成乱码，**不代表值写坏了**；
  用 Python 的 `winreg` 回读确认才准。
- 写中文注册表值别走命令行参数（会被代码页吃掉），用 UTF-16LE 的 `.reg`
  文件 + `reg import`，或用 `winreg`。

## 目录结构

```
src/
  shared/            主进程与渲染层共用，且不依赖 Electron
    types.ts         AppState / Settings / DrinkLog 等
    defaults.ts      默认设置、快捷杯量、数据保留天数
    theme.ts         主题偏好类型与校验
    update.ts        版本号解析/比较、下载地址白名单（更新检查的纯逻辑）
    date.ts          本地时区的日期工具
    schedule.ts      ★ 提醒时间点计算（最核心的一段）
    stats.ts         按天聚合、近 7 天、连续达标天数
  main/
    index.ts         生命周期、单实例锁、IPC、通知、全局快捷键、主题与窗口底色
    store.ts         JSON 持久化（原子写）
    scheduler.ts     调度器外壳：巡检 + 静默判断
    tray.ts          托盘图标与右键菜单
    float.ts         桌面小水滴浮窗
    updater.ts       更新检查（主进程发请求，超时与错误文案都在这儿）
    paths.ts         资源与产物路径、窗口加固
  preload/index.ts   contextBridge 桥接
  renderer/
    index.html       主面板
    float.html       小水滴浮窗
    tokens.css       设计令牌（浅/深两套），主面板与浮窗共用
    useTheme.ts      把主进程推来的主题写到 <html data-theme>
    App.tsx / components/ / styles.css
    float.tsx / float.css
scripts/
  gen-icons.mjs      纯 Node 生成应用图标与 11 帧托盘水位水滴
  core-test.ts       核心逻辑测试
  electron-run.mjs   开发/预览启动器：摘掉 ELECTRON_RUN_AS_NODE 再交给 electron-vite
  dist.mjs           打包启动器：注入国内镜像
resources/           图标资源（打包时复制到 resources/assets）
```

## 几个关键决策

**提醒点用绝对时间栅格，不做累加。**
下一个提醒点永远是「当天活跃时段起点 + 间隔的整数倍」，而不是「上一次提醒 + 间隔」。
笔记本合盖、系统休眠、定时器被浏览器节流、时钟被改，都不会让提醒点越漂越远。
这块逻辑放在 `shared/schedule.ts`，不依赖 Electron，所以能脱离窗口直接跑测试 —— 见 `pnpm test:core`。

**存储用 JSON 单文件，不用 SQLite。**
一年满打满算 3650 条记录，全量读进内存也就几百 KB，统计现算完全够用。
而 better-sqlite3 是原生模块，带上它就得处理 electron-rebuild 和打包时的 ABI 匹配，
对当前数据量不划算。写入用「临时文件 + rename + fsync」做原子替换，避免断电写坏。
真到几十万条的规模再换。

**主进程与 preload 强制产出 CommonJS。**
electron-vite 5 默认出 ESM，但 Electron 的 `electron` 模块是 CJS，
Node 对它的具名导出探测不生效，会直接报 `does not provide an export named 'BrowserWindow'`。
另外 ESM preload 还额外要求 `sandbox: false`，CJS 没这些约束。

**`electron` 必须显式外部化。**
一旦被 vite 打进产物，构建时就地解析成了 `node_modules/electron` 的「路径转发壳」，
运行时会去找根本不存在的 `out/main/dist/electron.exe`，然后报
`Electron failed to install correctly`。已在 `electron.vite.config.ts` 里显式声明。

**图标全部由 `scripts/gen-icons.mjs` 生成，一个二进制依赖都不引。**
托盘水位按 10% 一档量化成 11 帧 PNG，按需缓存 `nativeImage`；
应用图标直接写出 7 帧多尺寸 `.ico`（小尺寸 BMP、大尺寸 PNG 内嵌）。

两条路都不走的原因：主进程没有 canvas，而 sharp / canvas 是原生模块，
为一个图标就得处理 electron-rebuild；而 electron-builder 内置的 WASM 图标工具
（png→ico 转换）在内存受限的环境里会直接 `WebAssembly.Memory(): could not allocate memory`
把整个打包搞挂。自己写 ICO 一共不到 60 行，确定性强得多。

**闲时静默是「跳过」而不是「顺延累计」。**
系统空闲超过阈值就跳过这次提醒，5 分钟后再看，不补也不堆。
离开电脑一小时后回来收到 8 条提醒，是最快让用户卸载应用的方式。

**主题由主进程定，渲染层只负责显示。**
`AppState.resolvedTheme` 是唯一权威值，CSS 里那份媒体查询只做首帧兜底 —— 原因见「深浅主题」。
同理，`AppState` 里带 `resolvedTheme` 之后，主题切换会走和记录、设置完全一样的那条推送链路，
不需要新开一条 IPC 通道。

## 已知限制

- **全屏检测未实现。** 判断「在开会 / 打游戏」需要读前台窗口标题，得依赖
  `active-win` 之类的原生模块。目前只用系统空闲时长做静默判断，够用但不够准。
- **透明窗口会挡住点击。** Windows 不做逐像素命中测试，小水滴那 200×236 的矩形
  整块都会拦截鼠标。缓解办法是窗口开小 + 默认 20 秒自动隐藏。
- **开机自启只在安装版生效。** 开发模式下注册的会是 `electron.exe`，没意义还容易残留。
- **通知激活依赖一个手动补的注册表键。** 见上文「通知点击为什么打开了 Electron 欢迎页」：
  Electron 不写 `HKCU\Software\Classes\AppUserModelId\<AUMID>`，而这正是把点击投回
  运行中进程的关键。**重装或换机器后需要重新补**。要免掉这一步，得让应用在启动时
  自己扫 `HKCU\Software\Classes\CLSID` 找出 `LocalServer32 == process.execPath`
  的那一项，再把键写出来 —— 目前没做。
- **开发态点通知仍可能打开欢迎页。** 开发态那个身份快捷方式是 Electron 自己生成的，
  不带应用路径参数，所以开发版通知被点击时依旧可能启动一个裸 `electron.exe`。
  安装版已用不同 AUMID 隔开，不受影响。
- **关闭主窗口只是收进托盘。** 要真正退出走托盘菜单的「退出」或界面里的退出按钮。

## 环境注意事项

**这台机器访问 GitHub 会失败。**
不是网络不通，是 TLS 握手卡在证书吊销检查上：

```
schannel: next InitializeSecurityContext failed:
CRYPT_E_NO_REVOCATION_CHECK (0x80092012) - 吊销功能无法检查证书是否吊销
```

所以凡是默认从 GitHub Releases 拉二进制的工具（`@electron/get`、electron-builder
的 winCodeSign / nsis）都会报一句笼统的 `fetch failed`。
`registry.npmmirror.com` 和 `npmmirror.com/mirrors/` 是通的，走镜像即可 ——
`scripts/dist.mjs` 已经把这个注入好了。

**GitHub 的 22 端口在本机被拒，SSH 改走 443。**
`ssh github.com` 直接报 `Connection refused`。GitHub 官方提供 443 备用入口，
所以 `~/.ssh/config` 里加了一段：

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
```

**HTTPS 反而是通的** —— `git ls-remote https://github.com/...` 正常。
（`@electron/get` 那边失败是系统 schannel 的证书吊销检查，git 自带的 libcurl 不走那条路。）
所以 SSH 出问题时可以随时退回 HTTPS + Personal Access Token。

**Electron 二进制从本地缓存解压安装。**
本机网络访问不到 GitHub Releases，所以 `node_modules/electron/dist` 是从
`%LOCALAPPDATA%/electron/Cache` 里已有的 `electron-v43.3.0-win32-x64.zip` 手动解压的。
如果换机器、或用 `pnpm approve-builds` 重装失败，重新解压一次即可：

```bash
cd node_modules/electron
mkdir -p dist && unzip -o "<缓存目录>/electron-v43.3.0-win32-x64.zip" -d dist
printf 'electron.exe' > path.txt        # 注意不要带换行
```

`path.txt` 结尾多一个换行都会让 electron 认为二进制不存在，然后尝试联网下载。

**冒烟自检。**
`WATER_SMOKE_TEST=1` 会让应用跑一遍启动链路（托盘、窗口、读写、撤销）后自动退出，
数据写到临时目录不污染正式数据。两个前置条件，缺一个都会「静默什么都没发生」：

1. 不能在 `ELECTRON_RUN_AS_NODE=1` 的环境里跑 —— 那种环境下 electron 会退化成普通
   Node，`require('electron')` 拿到的是 npm 包那个「路径转发壳」字符串，于是启动即崩，
   报在模块顶部算 `APP_ID` 的那一行：

   ```
   TypeError: Cannot read properties of undefined (reading 'isPackaged')
       at out/main/index.js:790
   ```

   这个报错完全看不出真正的原因，而且 `pnpm build` 一切正常，只有真跑起来才炸。
   **`pnpm dev` / `pnpm preview` 已经会自动把它摘掉**（走 `scripts/electron-run.mjs`，
   理由和「镜像注入」一样：这类环境坑不该指望人记得）。只有像下面这样直接调
   `electron.exe` 时才需要自己 `unset`。
2. 要显式给一个独立的 `--user-data-dir`。单实例锁是在 `app.setPath('userData', ...)`
   **之前**、用默认 userData 抢的，所以哪怕自检会把数据挪到临时目录，锁仍然和同机
   其他 Electron 进程打架；锁没抢到就 `app.quit()`，表现是「没有报告、退出码 0」。

```bash
unset ELECTRON_RUN_AS_NODE
WATER_SMOKE_TEST=1 ./node_modules/electron/dist/electron.exe . \
  --user-data-dir="$TEMP/wr-smoke-lock"     # Git Bash
```

报告在 `$TEMP/water-reminder-smoke/smoke-report.txt`，正常应打出 `PASS`。

## 默认参数

| 项 | 默认值 |
| --- | --- |
| 每日目标 | 2000 ml |
| 提醒间隔 | 45 分钟 |
| 活跃时段 | 09:00 – 21:00 |
| 只工作日 | 开 |
| 默认杯量 | 250 ml |
| 空闲静默阈值 | 8 分钟 |
| 小水滴自动隐藏 | 20 秒 |
| 外观主题 | 跟随系统 |
| 自动检查更新 | 开（启动 8 秒后查一次，只提示不下载） |
| 全局快捷键 | `Ctrl + Alt + W` 记一杯 |
| 数据保留 | 400 天，超出自动裁剪 |
