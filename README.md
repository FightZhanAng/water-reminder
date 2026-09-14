# 喝水提醒

Windows 桌面常驻的喝水提醒工具。三种提醒形态并存，互不抢戏：

- **托盘进度环** —— 图标本身就是一个环形进度条，抬头一眼就知道今天喝了多少
- **系统通知** —— 点击通知即记录一杯，不用切窗口
- **桌面小水滴** —— 右下角飘出一个小水珠，水量随进度上涨，可直接点快捷记录

技术栈：Electron 43 + electron-vite 5 + React 19 + TypeScript。

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

打包产物落在 `release/`：

| 文件 | 说明 |
| --- | --- |
| `water-reminder-0.1.0-setup.exe` | NSIS 安装包（约 100 MB），可选安装目录、建桌面快捷方式 |
| `water-reminder-0.1.0-x64.nsis.7z` | 安装包的载荷数据 |
| `win-unpacked/` | 免安装的解包版本，双击里面的 `water-reminder.exe` 直接跑 |

首次打包会从镜像下载 winCodeSign / nsis / electron 等二进制到
`%LOCALAPPDATA%/electron-builder/Cache`，之后就快了。

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

## 目录结构

```
src/
  shared/            主进程与渲染层共用，且不依赖 Electron
    types.ts         AppState / Settings / DrinkLog 等
    defaults.ts      默认设置、快捷杯量、数据保留天数
    date.ts          本地时区的日期工具
    schedule.ts      ★ 提醒时间点计算（最核心的一段）
    stats.ts         按天聚合、近 7 天、连续达标天数
  main/
    index.ts         生命周期、单实例锁、IPC、通知、全局快捷键
    store.ts         JSON 持久化（原子写）
    scheduler.ts     调度器外壳：巡检 + 静默判断
    tray.ts          托盘图标与右键菜单
    float.ts         桌面小水滴浮窗
    paths.ts         资源与产物路径、窗口加固
  preload/index.ts   contextBridge 桥接
  renderer/
    index.html       主面板
    float.html       小水滴浮窗
    App.tsx / components/ / styles.css
    float.tsx / float.css
scripts/
  gen-icons.mjs      纯 Node 生成应用图标与 11 帧托盘进度环
  core-test.ts       核心逻辑测试
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
托盘进度环按 10% 一档量化成 11 帧 PNG，按需缓存 `nativeImage`；
应用图标直接写出 7 帧多尺寸 `.ico`（小尺寸 BMP、大尺寸 PNG 内嵌）。

两条路都不走的原因：主进程没有 canvas，而 sharp / canvas 是原生模块，
为一个图标就得处理 electron-rebuild；而 electron-builder 内置的 WASM 图标工具
（png→ico 转换）在内存受限的环境里会直接 `WebAssembly.Memory(): could not allocate memory`
把整个打包搞挂。自己写 ICO 一共不到 60 行，确定性强得多。

**闲时静默是「跳过」而不是「顺延累计」。**
系统空闲超过阈值就跳过这次提醒，5 分钟后再看，不补也不堆。
离开电脑一小时后回来收到 8 条提醒，是最快让用户卸载应用的方式。

## 已知限制

- **全屏检测未实现。** 判断「在开会 / 打游戏」需要读前台窗口标题，得依赖
  `active-win` 之类的原生模块。目前只用系统空闲时长做静默判断，够用但不够准。
- **透明窗口会挡住点击。** Windows 不做逐像素命中测试，小水滴那 200×236 的矩形
  整块都会拦截鼠标。缓解办法是窗口开小 + 默认 20 秒自动隐藏。
- **开机自启只在安装版生效。** 开发模式下注册的会是 `electron.exe`，没意义还容易残留。
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
数据写到临时目录不污染正式数据。注意这个自检无法在
`ELECTRON_RUN_AS_NODE=1` 的环境里运行 —— 那种环境下 electron 会退化成普通 Node，
`require('electron')` 拿到的是 npm 包路径而不是内置模块。在普通终端里跑：

```bash
WATER_SMOKE_TEST=1 ./node_modules/electron/dist/electron.exe .   # Git Bash
```

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
| 全局快捷键 | `Ctrl + Alt + W` 记一杯 |
| 数据保留 | 400 天，超出自动裁剪 |
