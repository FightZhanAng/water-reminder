# AGENTS.md

给在这个仓库里干活的 AI / 协作者。

只写**「不知道就会踩」的操作性规则**。架构、设计取舍、每个坑的完整成因链看
[README.md](README.md)，这里不重复，只留「怎么做 / 别做什么」。

本机是 Windows + PowerShell，项目只出 Windows 包。

---

## 1. 命令

### 正常情况（有 TTY 的真终端）

```bash
pnpm dev          # 开发模式，带 HMR
pnpm typecheck    # 主进程 / 渲染层分别类型检查
pnpm test:core    # 核心逻辑无头测试（提醒点计算 + 统计聚合 + 主题偏好）
pnpm build        # 产出 out/
pnpm dist         # 打包到 release/（走 scripts/dist.mjs 注入国内镜像）
pnpm gen:icons    # 重新生成图标资源
```

### 非 TTY 环境（CI 脚本、代理执行器）

`pnpm <script>` 会先做依赖状态检查；一旦判定 `node_modules` 与当前 pnpm 不一致，
它会要求清空重装，而**没有 TTY 时直接中止**：

```
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY
```

**不要**为此设置 `CI=true` 或 `confirmModulesPurge=false` —— 那会真的去清空
`node_modules` 再联网重装（本机连不上 GitHub Releases，electron 二进制会装不回来）。
直接用等价的二进制调用，全部实测可用：

```powershell
$node = "node"   # 或在无 PATH 的环境里写 node.exe 的绝对路径
& $node node_modules\typescript\bin\tsc --noEmit -p tsconfig.node.json
& $node node_modules\typescript\bin\tsc --noEmit -p tsconfig.web.json
& $node node_modules\typescript\bin\tsc -p tsconfig.test.json
& $node .tmp-test\scripts\core-test.js
& $node node_modules\electron-vite\bin\electron-vite.js build
& $node scripts\electron-run.mjs dev          # 等价于 pnpm dev
```

---

## 2. 本机环境坑

### 2.1 `ELECTRON_RUN_AS_NODE`

这个变量只要在环境里，`electron.exe` 就退化成普通 Node，主进程在模块顶部算
`APP_ID` 那一行直接崩：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
    at out/main/index.js:790
```

`pnpm dev` / `pnpm preview` 已经会自动摘掉它（`scripts/electron-run.mjs`）。
**只有直接调 `electron.exe` 时才要自己处理**，例如冒烟自检：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:WATER_SMOKE_TEST = "1"
& node_modules\electron\dist\electron.exe . --user-data-dir="$env:TEMP\wr-smoke-lock"
# 报告：$env:TEMP\water-reminder-smoke\smoke-report.txt，正常末行是 PASS
```

`--user-data-dir` 是必须的：单实例锁在 `app.setPath('userData')` 之前就抢了，
不隔离会和同机其他 Electron 进程打架，表现是「没有报告、退出码 0」。

另一个坑：**Git Bash 里直接调 GUI 版 `electron.exe` 会瞬间静默退出**（退出码 0、
无任何输出、连模块顶部的写入探针都不执行，`--version` 也不回显；node 模式
`ELECTRON_RUN_AS_NODE=1` 反而正常）。要跑 GUI 探针改用 PowerShell，并注意它
用 `&` 调 GUI 程序不等结束、`$LASTEXITCODE` 会是空的 —— 要么
`Start-Process -PassThru -Wait` 拿退出码，要么直接轮询报告文件确认结果。

### 2.2 到 GitHub 的网络

- **SSH 通道当前不可靠。** `ssh.github.com:443` 的 TCP 能连上
  （`Test-NetConnection ssh.github.com -Port 443` 返回 True），但 SSH 握手会卡住，
  最后 `Received disconnect ... Bye Bye`、退出码 255、看不到 `Hi <user>!`。
  22 端口直接不通。**别反复重试 SSH**，直接走 §3.1。
- **HTTPS 读是通的**（`git ls-remote https://...` 匿名可读，仓库是 public）。
- **别用 curl / Invoke-WebRequest / Node fetch 去够 GitHub。** 本机 schannel 的
  证书吊销检查（`CRYPT_E_NO_REVOCATION_CHECK`）会把它们全挡下，报的还是笼统的
  `fetch failed`。只有 git 自带的 libcurl 不受影响。要下二进制走镜像
  （`scripts/dist.mjs` 已注入 npmmirror）。
- **GitHub 会偶发 502**（API 和 git 都可能）：`gh run list` / `gh release view` /
  `ls-remote` 都可能撞上 `HTTP 502 Bad Gateway`。**等 20 秒重试一次**，
  不要据此判定「发布失败」。

---

## 3. GitHub 操作（重点）

### 3.1 推送代码：唯一可行的非交互路径

SSH 不可用、HTTPS 又没有缓存凭据（仓库里配的 `credential.helper=manager`，
但 PATH 里没有 `git-credential-manager`，会退化成终端提示而失败）。可用的是
**已经登录的 `gh` CLI**（账号 FightZhanAng，token 带 `repo` 权限）：

```powershell
$env:GIT_TERMINAL_PROMPT = "0"          # 宁可失败也别挂在那儿等输入
$sshUrl   = "git@github.com:FightZhanAng/water-reminder.git"
$httpsUrl = "https://github.com/FightZhanAng/water-reminder.git"

git remote set-url origin $httpsUrl
try {
  git -c "credential.helper=" -c "credential.helper=!gh auth git-credential" push origin main
  git -c "credential.helper=" -c "credential.helper=!gh auth git-credential" push origin vX.Y.Z
} finally {
  git remote set-url origin $sshUrl      # 无论成败都要还原
}
git remote get-url origin                # 复核，必须还是 SSH
```

要点：

- `-c "credential.helper="`（空值）**先清空**继承来的 helper 列表，否则
  `manager` 会被先试一遍并失败；再挂上 gh 的助手。
- `gh auth status` 里写着 `Git operations protocol: ssh`，但
  `gh auth git-credential` 照样能给 HTTPS 供凭据 —— 实测可用，别被那行误导。
- **不写任何持久化凭据配置**（不要 `gh auth setup-git`、不要改全局 config）。
- **不要打印 token**：`gh auth token` 的结果不要进日志/回复。
- 推完必须把 `origin` 还原成 SSH 地址。

### 3.2 报错对照表

| 报错 | 真正原因 | 处理 |
| --- | --- | --- |
| `ssh: connect to host ssh.github.com port 443: Connection timed out` | SSH 通道不稳 | 走 §3.1 |
| `Received disconnect ... Bye Bye` + 退出码 255 | SSH 认证没过（注意：没有 `Hi <user>!` 就是没通过） | 走 §3.1 |
| `fatal: could not read Username for 'https://github.com'` | HTTPS 无凭据 + 禁用了交互 | 走 §3.1 |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 依赖检查 + 无 TTY | 走 §1 的直接调用 |
| `Cannot read properties of undefined (reading 'isPackaged')` | `ELECTRON_RUN_AS_NODE` | §2.1 |
| `HTTP 502 Bad Gateway`（gh / git） | GitHub 瞬时故障 | 等 20 秒重试一次 |
| `gh run watch --exit-status` 退出 1，但只有 annotations 报 502 | 同上，**不是** run 失败 | 用 `gh run list --limit 3` 复核 |

### 3.3 tag 与触发条件

`.github/workflows/release.yml` 的触发条件是 `on: push: tags: 'v*'`：

- **任何 `v*` tag 推上去都会跑一次完整构建 + 发布**。别推临时 tag 试手。
- **已经推过的 tag 不要删了重推**：会再触发一次 run；如果第一次还在跑，
  删 tag 会让它的 checkout（按 tag 名检出）失败，留下一个红叉。
- Release 创建是幂等的（`gh release view` 判断 + `--clobber`），重跑不会报错。
- **tag 用带注释的**：`git tag -a vX.Y.Z -m "喝水提醒 X.Y.Z"`。
  `v0.1.0` / `v0.2.0` 都是 annotated（`git cat-file -t` 返回 `tag`），
  `v0.3.0` 当时误用了轻量 tag（返回 `commit`），别再犯。
- **发现 tag 类型打错了，安全的改法是原子替换，不要「删远端再推」**（那中间有一段时间
  远端没有这个 tag）：

  ```powershell
  git tag -d vX.Y.Z                                   # 删本地的
  git tag -a vX.Y.Z <版本提交的 SHA> -m "喝水提醒 X.Y.Z"   # 显式指向版本提交，别用 HEAD
  git push --force origin vX.Y.Z                      # 原子替换
  ```

  代价是会再触发一次构建（约 2.5 分钟）；**实测无害**：Release 不会被删，
  第二次 run 会 `--clobber` 重新上传两个产物，结束后 `state=uploaded` 正常。
  改之前先确认上一次 run 已经结束 —— 在跑的 run 按 tag 名 checkout，动 tag 会让它失败。

---

## 4. 发版流程

版本号只有两处，改完自查一遍：

1. `package.json` 的 `version`
2. `README.md`：`release/` 产物表里的文件名、以及「发布版本」里的 `git tag` 示例

```powershell
# 1) 推送前必须全绿（CI 跑的也是这几步）
#    typecheck(node+web) / test:core / build
# 2) 提交（版本号建议折进这次的功能提交，和 git log 的历史一致）
# 3) 打带注释的 tag
git tag -a vX.Y.Z -m "喝水提醒 X.Y.Z"
# 4) 推 main + tag（§3.1）
# 5) 验证（见下）
```

验证三件套（缺一不可，`gh` 已登录）：

```powershell
gh run list --limit 3                                        # status / conclusion
gh run watch <run-id> --interval 15                          # 阻塞到结束
gh release view vX.Y.Z --json tagName,isDraft,createdAt,assets
```

正常结果：run `completed / success`，Release `isDraft=false`，
并且有**两个**产物：

- `water-reminder-X.Y.Z-setup.exe`（NSIS 安装包）
- `water-reminder-X.Y.Z-portable.exe`（免安装单文件）

`package.json` 的 `dist` 脚本里的 `--publish never` 必须留着：CI 里推 tag 会触发
electron-builder 的隐式发布，它会抢在 `gh release` 之前自己去发并因缺凭据失败，
连累整个 dist 步骤退出码 1。

---

## 5. 改代码的约定

- **注释写「为什么」，不写「做了什么」。** 这个仓库的注释密度是刻意的：
  每一段都在记「不这么写会踩什么」。改动时保持这个风格，中文。
- **提交信息**：`type: 中文摘要`，正文讲成因与取舍。类型沿用
  `feat` / `fix` / `ci` / `docs`（见 `git log`）。
- **推送前**：`typecheck` + `test:core` 必须过。别把红的推上去让 CI 告诉你。
- **临时文件不进仓库**：截图、验证脚本、假数据目录一律放 `%TEMP%` 下，
  用完删掉；仓库里只留源码和文档。
- **改设置项**要动三处：`src/shared/types.ts` 的类型、`src/shared/defaults.ts`
  的默认值、`src/main/index.ts` 里 `applySettings` 的白名单校验
  （老数据文件靠 `store.load()` 合并默认值来兼容，不用写迁移）。
- **改核心逻辑**（`src/shared/schedule.ts`、`stats.ts`、`theme.ts`、`update.ts`、
  `holiday.ts`）就补 `scripts/core-test.ts` 的用例 —— 这些模块不依赖 Electron，
  能脱离窗口直接跑。

---

## 6. 几条容易被改坏的硬约束

### 6.1 主题不能在渲染层自己算

系统在深浅之间切换时，Electron 会更新渲染层的 `prefers-color-scheme`，
但**不会**给 `matchMedia` 派发 `change` 事件（实测：`matches` 已经是 true，
`change` 一次都没来）。所以：

- 主题由主进程解析 → 放进 `AppState.resolvedTheme` 推下来；
  渲染层只用 `useTheme()` 写 `<html data-theme>`，**不要**自己判断。
- `src/renderer/tokens.css` 里深色 token 写了**两份**：
  `@media` 那份带 `:not([data-theme])` 只做 React 挂载前的首帧兜底，
  `:root[data-theme='dark']` 那份是权威。**改一份必须同步改另一份。**
- 主进程里的 `WINDOW_BG` / `FLOAT_BG` 要和 `tokens.css` 的 `--bg` / `--surface`
  手动对齐（主进程读不到 CSS），否则窗口出现到首帧之间会闪一下旧底色。

### 6.2 SVG 的 `clipPath` 是在「引用它的元素」的坐标系里解析的

`WaterGauge` 里踩过一次：把裁剪放进被 `translateY` 变换的那一层，裁剪框会跟着
水一起下移，等于没裁 —— 真正挡住水的只剩根 `<svg>` 的 `overflow: hidden`，
于是水从筒底漏出一小截。**裁剪层不能带 transform。**

同理，改量筒几何时注意：刻度换算和水位换算必须共用同一个 `SPAN`
（`BOTTOM - INNER_TOP`），否则液面和刻度对不上。

### 6.3 更新检查

- **I/O 必须在主进程**：打包后渲染层的 CSP 是 `default-src 'self'`，`connect-src`
  跟着回落，渲染层直接 `fetch` 外网会被挡掉。用 `net.fetch`（走 Chromium 网络栈，
  能吃系统代理），别用全局 fetch。
- **纯逻辑放 `src/shared/update.ts`**（版本解析/比较、地址白名单），跟着
  `pnpm test:core` 一起测。版本比较写错了不会报错，只会「永远说已是最新」。
- **远端给的 URL 不能直接交给 `shell.openExternal`**：只认 `https://github.com/`
  开头，不合法就退回仓库 releases 页。
- **本机测不了真实链路**（够不到 GitHub）。验证用 `WATER_UPDATE_API` 把地址指到
  本地 mock 服务，七种情形（有新版本 / 已是最新 / 非 github 域名 / 缺 html_url /
  版本号不可解析 / 500 / 超时）都能覆盖。
- **只提示，不自动下载**：这是刻意选的形态。便携版本来也无法自更新，
  静默重启又会打断常驻托盘的工具。

### 6.4 节假日/调休判定

- **缺数据必须回退到按星期，不能沉默**：没更新当年数据、跨年、拉取失败时，
  判定回退按星期（`isActiveDate`，见 `src/shared/schedule.ts`）。节假日多提醒一句
  是小事，「该提醒的日子一声不吭」才是事故。
- **解析器从严**：`parseHolidayPayload` 对返回做键格式、年份交叉核对、空数据校验，
  任何一处不对返回 null 当失败处理，不把残缺数据当日历用。
- **数据 I/O 在主进程**（`src/main/holidays.ts`，`net.fetch` + 落盘
  `userData/holidays.json`），纯逻辑（解析/判定/回退）在 `src/shared/holiday.ts`，
  跟着 `pnpm test:core` 跑。
- **验证口子**：`WATER_HOLIDAY_API` 指到本地 mock（`{year}` 占位符）。
  与 GitHub 不同，本机到数据源 timor.tech 的 HTTPS 是通的，真实链路也能直接测。
- **打卡后的下一次提醒同样受判定约束**（`scheduler.resetAfterDrink`）：
  朴素「现在 + 间隔」只在当天是提醒日且落在窗口内时成立，否则跳到下一个
  合法提醒点 —— 不然节假日喝了杯水，45 分钟后照常弹通知，开关等于虚设。

---

## 7. 无头验证 UI 的做法

这个项目没有测试框架能覆盖界面，但**不能靠肉眼看截图下结论**（上面那个
「水漏出筒外」的 bug 就是被误读成「水正好到筒底」而放过去的）。做法：

1. 写一个临时的 Electron 主进程脚本（放 `%TEMP%`，**不要**放仓库里），
   用假的 IPC 状态源加载 `out/renderer/*.html`，`capturePage` 截图；
2. 用 Pillow 之类的库对截图像素做断言，而不是只把图贴出来看。

四个必踩的坑：

- **隐藏窗口不参与合成**：`show: false` 时 `capturePage` 会拿到旧帧。
  先 `win.showInactive()`，再 `webContents.invalidate()`，然后截图。
- **隐藏窗口会节流 CSS 过渡**：底色会卡在起始值上。截图前注入
  `*,*::before,*::after{transition:none!important;animation:none!important}` 拿终态。
- **`<defs>` / `<clipPath>` 里的元素不参与渲染**，`getBoundingClientRect()`
  全是 0。要拿几何基准就用可见元素（例如 `.gauge-wall`）。
- **新写的断言要先做变异测试**：故意把被验证的机制破坏掉（例如
  `removeAttribute('clip-path')`），确认断言会 FAIL。抓不住 bug 的断言等于没有。
