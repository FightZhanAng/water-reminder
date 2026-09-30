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

### 依赖没装全 / pnpm 拒绝跑脚本

pnpm 10 起 `package.json` 里的 `pnpm.onlyBuiltDependencies` **不再生效**（pnpm 11 会忽略并警告），
允许跑安装脚本的白名单只认 **`pnpm-workspace.yaml` 的 `allowBuilds`**。不在名单里的依赖会
静默跳过 postinstall：`node_modules/electron/dist` 直接不存在。而且每次 `pnpm <script>` 前的
依赖状态检查都会 `[ERR_PNPM_IGNORED_BUILDS]` 中止 —— 报错里那一大串 pnpm 内部调用栈只是
这个判定的副作用，别顺着栈去查。

补装 electron 二进制（`@electron/get` 会先查本地缓存，命中就不联网）：

```bash
node node_modules/electron/install.js
cat node_modules/electron/path.txt      # 内容是 electron.exe 即成功
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

**打包后的 exe 也支持 node 模式 + 内联脚本**（2026-09-30 拿
`release/win-unpacked/water-reminder.exe` 实测）：

```bash
ELECTRON_RUN_AS_NODE=1 ./release/win-unpacked/water-reminder.exe -e "<脚本>" a b c
# process.argv = [exe, 'a', 'b', 'c'] —— slice(1) 正好是传给脚本的参数
```

主进程那个「等本进程退出再拉起安装包」的助手就是靠它跑起来的：
把脚本作为 `-e` 的实参传进去，一个文件都不用落盘（落 `.cmd` / `.ps1` 的话，
路径里的中文会被批处理的编码搞乱）。

### 2.2 到 GitHub 的网络

- **SSH 时通时不通，先花 5 秒验一下再决定走哪条路。**
  2026-09-30 实测 `git ls-remote git@github.com:FightZhanAng/water-reminder.git`
  以及随后的 `git push`（main + tag）都一次成功；更早的会话里则是握手卡住、
  `Received disconnect ... Bye Bye`、退出码 255。`~/.ssh/config` 里已经配好
  `HostName ssh.github.com / Port 443`（22 端口不通）。所以：**先跑一次 `ls-remote`**，
  通了就走 SSH（§3.1 的首选路径），卡住或 255 再换备用路径，别反复重试同一招。
- **HTTPS 读是通的**（`git ls-remote https://...` 匿名可读，仓库是 public）。
- **shell 侧的 curl / Invoke-WebRequest 够不到 GitHub** —— 本机 schannel 的证书吊销
  检查（`CRYPT_E_NO_REVOCATION_CHECK`）会把它们挡下，报的还是笼统的 `fetch failed`。
  但 **`node:https` 能通 `api.github.com`**：2026-09-30 实测用它列 Actions runs、
  查 Release 资产都正常。本机没有 `gh`（见 §3.1），查 CI 状态就走这条路（§3.4）。
  要下二进制仍走镜像（`scripts/dist.mjs` 已注入 npmmirror）。
- **GitHub 会偶发 502**（API 和 git 都可能）：`gh run list` / `gh release view` /
  `ls-remote` 都可能撞上 `HTTP 502 Bad Gateway`。**等 20 秒重试一次**，
  不要据此判定「发布失败」。

---

## 3. GitHub 操作（重点）

### 3.1 推送代码：先试 SSH，不行再退 gh

**首选 SSH**（2026-09-30 实测 main 与 tag 都一次成功）。仓库的 `origin` 常态就是
SSH 地址，直接推，不用改 remote：

```bash
GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" \
  timeout 90 git push origin main 2>&1 | tail -20
echo "exit=${PIPESTATUS[0]}"     # 管道吃掉了退出码，必须取 PIPESTATUS 才是 git 的
```

- 推之前先 `git ls-remote git@github.com:FightZhanAng/water-reminder.git` 验一下通道（§2.2）。
- `BatchMode=yes` + `GIT_TERMINAL_PROMPT=0`：宁可失败也别挂在那儿等输入。

**备用路径：HTTPS + gh 的凭据助手。** （2026-09-30 本机**已经装不到 gh** ——
`/c/Program Files/GitHub CLI/` 不存在，C 盘深度 4、D 盘深度 3 都没搜到，
所以在重新装上之前这条路走不通改用 §3.4 查结果。下面这份记录留着，
换机器或重装 gh 之后还能用。）

SSH 不走、HTTPS 又没有缓存凭据（仓库里配的 `credential.helper=manager`，
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

**用代理执行器（非交互工具）跑推送时，走 Bash 而不是 PowerShell。**
完全相同的参数，经由 PowerShell 那一侧执行会 `exit 128` 而且**把 git 的错误输出全部吞掉**
（`*>` 重定向到文件也是空文件），现场只剩一个退出码，没法排查。Bash 侧同样的命令一次成功：

```bash
ORIG=$(git remote get-url origin)
git remote set-url origin https://github.com/FightZhanAng/water-reminder.git
GIT_TERMINAL_PROMPT=0 git -c "credential.helper=" \
  -c "credential.helper=!gh auth git-credential" push origin main 2>&1 | tail -20
echo "exit=${PIPESTATUS[0]}"          # 管道吃掉了退出码，必须取 PIPESTATUS 才是 git 的
git remote set-url origin "$ORIG"     # 无论成败都要还原
```

- 代理执行器的 Bash 侧 PATH 里没有 GitHub CLI 目录 —— 2026-09-30 实测
  `gh auth git-credential` 报 `gh: command not found`，`which gh` 也找不到，
  所以走备用路径前先 `which gh` 确认它还在。
- `... | tail` 之后看 `$?` 拿到的是 `tail` 的退出码，会误判成成功。

### 3.2 报错对照表

| 报错 | 真正原因 | 处理 |
| --- | --- | --- |
| `ssh: connect to host ssh.github.com port 443: Connection timed out` | SSH 通道不稳 | 走 §3.1 |
| `Received disconnect ... Bye Bye` + 退出码 255 | SSH 认证没过（注意：没有 `Hi <user>!` 就是没通过） | 走 §3.1 |
| `fatal: could not read Username for 'https://github.com'` | HTTPS 无凭据 + 禁用了交互 | 走 §3.1 |
| `git push` 退出 128，且**一行输出都没有** | 从 PowerShell 侧执行，错误被吞了 | 换 Bash 跑同一套命令（§3.1） |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 依赖检查 + 无 TTY | 走 §1 的直接调用 |
| `Cannot read properties of undefined (reading 'isPackaged')` | `ELECTRON_RUN_AS_NODE` | §2.1 |
| `HTTP 502 Bad Gateway`（gh / git） | GitHub 瞬时故障 | 等 20 秒重试一次 |
| `gh run watch --exit-status` 退出 1，但只有 annotations 报 502 | 同上，**不是** run 失败 | 用 `gh run list --limit 3` 复核 |
| `gh: command not found`（凭据助手指向 gh 时） | 本机没装 gh（§3.1） | 推送改走 SSH；查 CI 结果走 §3.4 |
| `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ...` | pnpm 10+ 不读 package.json 里的白名单 | 写进 `pnpm-workspace.yaml` 的 `allowBuilds`（§1） |

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

### 3.4 查 CI 结果：本机没有 gh 时用 API

`gh` 已经装不到了（§3.1），验证发布改用 Node 自带的 `node:https` 打 api.github.com ——
公开仓库匿名可读，限流 60 次/小时，15 秒轮询一次完全够（§2.2 实测可用）：

| 目的 | 路径 |
| --- | --- |
| 最近几次 run | `/repos/FightZhanAng/water-reminder/actions/runs?per_page=3` |
| 单次 run 状态 | `/repos/.../actions/runs/<id>` → `status` / `conclusion` |
| 每个 step 的结论 | `/repos/.../actions/runs/<id>/jobs` |
| Release 资产 | `/repos/.../releases/tags/vX.Y.Z` → `assets[]` |

现成脚本：`~/.workbuddy/skills/github-release-verify/scripts/check-release.cjs` ——
等 run 跑完 + 报各 job 结论 + 报 Release 资产，仓库从 `origin` 推导，
tag 取 `package.json` 的 `version`，run 按 `head_branch == tag` 自动发现。
不用再每次现写轮询。

**别把 tag 写死在脚本里。** 之前那版硬编码成 `v0.7.0`，发 0.8.0 时忘了改，
它静默去查了**上一个** Release，输出看起来完全正常 —— 这种错最难发现。

正常结果：run `completed / success`，job「构建并发布 Windows 安装包」`success`，
Release `draft=false`，两个产物各约 95 MB：

- `water-reminder-X.Y.Z-setup.exe`（NSIS 安装包）
- `water-reminder-X.Y.Z-portable.exe`（免安装单文件）

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

验证三件套（缺一不可；装了 `gh` 就用下面这套，本机没装则走 §3.4 的 API）：

```powershell
gh run list --limit 3                                        # status / conclusion
gh run watch <run-id> --interval 15                          # 阻塞到结束
gh release view vX.Y.Z --json tagName,isDraft,createdAt,assets
```

本机没装 `gh`，跑技能里那个现成脚本就等价于上面三条（退出码非 0 即失败）：

```bash
node ~/.workbuddy/skills/github-release-verify/scripts/check-release.cjs
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

### 6.3 更新：检查 + 应用内下载安装

- **I/O 必须在主进程**：打包后渲染层的 CSP 是 `default-src 'self'`，`connect-src`
  跟着回落，渲染层直接 `fetch` 外网会被挡掉。用 `net.fetch`（走 Chromium 网络栈，
  能吃系统代理），别用全局 fetch。
- **纯逻辑放 `src/shared/update.ts`**（版本解析/比较、挑包、摘要解析、地址白名单、
  体积文案），跟着 `pnpm test:core` 一起测。这几样写错了都不报错：
  版本比较错了是「永远说已是最新」，挑包错了是下载到不对的那个安装包，
  摘要解析放松了是校验形同虚设。
- **`isNewer(candidate, current)` 是 candidate 在前**，写反了不报错，只会永远 false。
- **任何来自远端的地址都要过白名单**：下载地址只认本仓库
  `releases/download/` 前缀 —— 光校验域名不够，仓库里任何一个 release 的
  任何一个附件都能塞进来自动执行；`shell.openExternal` 只认 `https://github.com/`。
- **三重校验缺一不可**（体积 / sha256 / MZ 头），任何一条不过都必须把文件删掉。
  少了体积那条，就会拿半个安装包去执行 —— 传输中断不会让 `fetch` 报错。
- **别把失败原因写长**：状态栏只有 440px。早先那句「应为 4198400 字节，实际收到
  4194304」在界面上被省略号切掉后半截，唯一有信息量的数字全没了。
  用 `formatSize` 折算成「少了 4 KB」这种。
- **`spawn` 失败是异步报的**：`child_process.spawn` 撞上 ENOENT / EACCES 不会抛，
  而是下一个 tick 发 `error` 事件。等待助手里只写同步 `try/catch` 的话，日志永远
  写「spawned」，而「点了更新没反应」唯一需要的那句真实原因恰好在那儿。
  要挂 `child.on('error')`，并且别让助手进程立刻退出（事件还没到就退了）。
- **拉起目标前必须 `delete env.ELECTRON_RUN_AS_NODE`**：助手自己是靠这个变量退化成
  Node 的，子进程默认继承环境 —— 不摘掉的话免安装版的新包会以 Node 模式启动，
  没有窗口、没有托盘，还正常退 0，查起来毫无线索。
- **只提示 + 用户点一下才开始**：不后台偷偷下，也不静默重启。便携版本来也无法
  自更新，静默重启又会打断常驻托盘的工具。
- **本机测不了真实链路**（够不到 GitHub）。完整链路验证用 `WATER_UPDATE_API`
  把地址指到本地 mock —— 它同时会放行 mock 源的下载白名单，否则
  「下载 → 校验 → 拉起」这一段在真机上根本走不到。脚本见 §7.2。

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

### 6.5 改界面布局时必踩的两处（类型检查和构建都是绿的）

- **纵向 flex 容器里，带 `overflow: hidden` 的子项会自动最小尺寸 0。**
  `.content` 是 `display: flex; flex-direction: column`，弹性项默认允许收缩，
  而自动最小尺寸 `min-height: auto` 在 `overflow` 不是 `visible` 时会退化成 **0**。
  于是唯一带 `overflow: hidden` 的卡片（`.card.is-hero`，为了顶部水位尺通栏破格）
  会把整列的收缩量全吞下去、塌成一条 1px 的线，肉眼表现是「这张卡没渲染出来」。
  所以 `.content > *` 必须写 `flex: none` —— 内容区本来就是滚动容器，
  子项该保持自然高度、溢出交给滚动。
- **浮窗只有 200×236（`main/float.ts` 的 `WIDTH/HEIGHT`），纵向多几个像素就从底部溢出。**
  修法不是逐个调 margin，而是让可伸缩区把余量吸收掉：
  `.float-drop { flex: 1 1 auto; min-height: 0 }`，固定部分才是硬约束。
  SVG 的尺寸交给 CSS（`width`/`height` 属性优先级低于任何 CSS 规则），别写死在 JSX 里。
  照这个模式，以后改动才不会又把 `.float-later` 顶到窗口外。

### 6.6 改图标只改 `scripts/gen-icons.mjs`，别手改 `resources/` 下的图

`resources/` 里那 13 个图（`icon.png` / `icon.ico` / `tray-0..100.png`）全是生成产物。
改了源脚本就跑 `pnpm gen:icons` 整体重出；手改单张图，下次生成就被覆盖。

三条只在改图标时才会撞上的坑：

- **`.ico` 平时根本跑不到。** 运行时用的是 `resources/icon.png`（窗口）和
  `tray/*.png`（托盘），`.ico` 只在 electron-builder 打包成快捷方式时被系统读。
  所以「dev 里看着没问题」证明不了 `.ico` 没问题 —— 它出错的几种方式
  （`biHeight` 忘了写两倍、AND 掩码方向反了、目录项尺寸对不上）**全都不报错**，
  只表现为打包后「快捷方式是个黑方块」或者糊成一团。
  改完跑一次验收脚本 —— 它把磁盘上的字节解码回来、逐项核对规格，
  再拼成「各尺寸 × 深浅两种底色」的对照图（含 16px 放大）：

  ```bash
  node scripts/gen-icons.mjs                                   # 先重新生成
  node ~/.workbuddy/skills/electron-gui-verify/scripts/icon-sheet.mjs .
  # 对照图落在 .workbuddy/verify/{icon,tray}-sheet.png，用 Read 看一眼再下结论
  ```
- **AND 掩码和 XOR 一样是自下而上存的**（同属一个 DIB）。现代 Windows 走 32bpp 的
  alpha、根本不看这块，但忽略 alpha 的旧路径会退回它 —— 写成全 0 的话，那些地方
  会把轮廓外的透明区域画成一个黑方块。正确写法是：透明处置 1。
- **水滴轮廓别用 `halfW = r·√((y-apex)/(cy-apex))`。** 那个剖面在顶点处斜率无穷大，
  会拉成一根细刺；细刺配上亮描边和一道平直液面，16px 下会被读成手提包而不是水滴。
  用「顶端小圆 + 底端大圆 + 外公切线」那套。同理，托盘水滴别做太扁太胖 ——
  顶端几乎没有尖的话它会变成一颗蛋。

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

### 7.1 另一条路子：CDP 连真机（不改项目代码）

上面那套要临时写主进程脚本；不想在仓库外维护一套 harness 时，可以给应用加
`--remote-debugging-port`，用 Node 自带的 `fetch` + `WebSocket` 连上去量 DOM 和截图。
好处是量的是**真窗口里的真页面**（含系统三键、原生窗口底色），不是伪造的 IPC 状态。
现成脚本在技能 `electron-gui-verify/scripts/cdp-audit.cjs`（模式见该技能）。

用隔离实例，别碰用户正在用的那份：`--user-data-dir=<仓库>/.workbuddy/tmp/userdata`
（顺带隔离了单实例锁）。预置数据直接写 `<userData>/water-reminder.json`
（`{version:1, logs:[{id,ml,ts,source}], settings:{...}}`）—— 要造「近 7 天历史」时
只能这么干，`addDrink` 只能写当下。

四个会误导判定的坑：

- **`Stop-Process` 之后立刻重启，新实例会被单实例锁顶掉，你其实一直在跟旧实例说话。**
  表现为「改了数据文件但应用读不到」，看着像 `store.load()` 有 bug。
  判据：改完回读一次文件、启动后再回读一次，**文件没被动过**且进程 PID 变了才算真读到。
- **`document.documentElement.scrollHeight` 量不到 `.content` 的滚动**（页面是固定
  高度的 `.app` + 内层滚动容器），永远等于视口高，看着像「没有滚动」，实际首屏被滚走了。
  直接量那个容器的 `scrollTop / scrollHeight / clientHeight`。
- **`getBoundingClientRect()` 会把「故意画宽、靠 `clipPath` 裁掉」的 SVG 路径报成越界**
  （液面波多画了两个周期）。查越界时先 `el.closest('[clip-path]')` 过滤。
- **重载之后立刻查 `document.fonts.check()` 会得到 `false`**（`ignoreCache: true`
  要重新解码字体，`status === 'loading'`）。别据此判定「内联字体没加载成功」。

### 7.2 应用内更新的验证脚本（放 `%TEMP%`，不进仓库）

本机够不到 GitHub，`WATER_UPDATE_API` 指向本地 mock 才跑得了完整链路。三个脚本
（`%TEMP%\wr-update-verify\`；其中驱动脚本的通用版已经沉淀到技能
`electron-gui-verify/scripts/cdp-drive.cjs`）：

- `mock-server.cjs` —— 假的 `releases/latest` + 假下载端点，`MOCK_MODE` 切
  `ok` / `bad-digest` / `no-digest` / `size-lie` / `html` / `flaky` / `big`
- `drive.cjs` —— CDP 点按钮、逐次记录状态栏、截图；可被 require
- `matrix.cjs` —— 每条用例起一个 mock + 一个隔离的应用实例，跑完核对落盘的字节数/
  sha256、助手日志，最后打一张断言表

```bash
node %TEMP%\wr-update-verify\matrix.cjs          # 全部用例（7 条，约 4 分钟）
node %TEMP%\wr-update-verify\matrix.cjs big      # 只跑某一条
```

四个会误导判定的坑：

- **靠 CDP 轮询采不到短的相位。** 一次 `Runtime.evaluate` + 截图要 200ms 上下，
  而「正在校验安装包」在本地盘上只有零点几毫秒。采样竞态会让结果随机 ——
  同一份代码这轮通过下轮不通过。正确做法是在页面里挂 `MutationObserver` 同步记一笔、
  轮询只负责把记录取回来（`window.__wrFlush()`）。
- **观察器不能装太早。** 应用刚起来时 React 还在渲染「正在加载…」，
  那时 `querySelector('.statusbar')` 是 `null`，观察器会挂在不存在的元素上、
  **静默采到 0 条**，而表面上一切正常。要轮询到 `.statusbar` 出现再装。
- **应用每次启动都会清空下载临时目录**（`cleanupLeftovers`）。各用例的落地文件、
  `apply.log` 必须在本轮内读掉 —— 留到全部跑完再统一断言，读到的是
  「已被下一条用例清掉」，报的错会指向完全无关的地方。
- **别拿真安装包当载荷。** 助手会真的把它 `spawn` 起来。用
  `where.exe + 零填充` 的假 PE 最安全：有 MZ 头（过校验）、能被 `spawn`、无副作用。
  想看「正在校验」就把它撑到 192MB（64MB 的 fsync 只有 150ms，还是会漏）。

