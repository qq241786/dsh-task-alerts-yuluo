# 安装说明（dsh-task-alerts）

## 1. 需要额外下载什么吗？

**几乎不需要。** 这个 ZIP 已经是自包含的：

| 需要的东西 | 是否必须 | 说明 |
| --- | --- | --- |
| DeepSeek Harness 本体（含 `dsh plugin` 命令） | **必须** | 你要装插件，当然得有宿主 |
| Node.js / Python / 编译器 / 构建工具 | **不需要** | 插件只用 Node 内置模块；已编译好的 `lib/` 就在包里 |
| 网络 | **不需要** | 两个可选依赖已以实体目录随包附带（见下），解压即可用 |
| `js-yaml`（随包附带） | 可选 | 缺了会用内置的极简 YAML 解析器读配置，功能不受影响 |
| `node-global-key-listener`（随包附带） | 可选 | 缺了全局快捷键退化为「仅在应用窗口聚焦时有效」 |
| 提示音文件 | **不需要** | 已附带 `alert.wav`（0.54 秒双音提示） |
| 音效播放后端 | 系统自带 | Windows 用 `powershell.exe` + `System.Media.SoundPlayer`；macOS 用 `afplay`；Linux 用 `aplay`（可能需要 `alsa-utils`） |

`package.json` 里的 `peerDependencies`（`@deepseek-ai/cordis`、`react` 等）**全部标记为 optional**，由 DSH 自带，你不需要单独装。
换言之：**除了 DSH 本身，没有任何前置环境要求。**

## 2. 安装

### 2.1 通用（web profile）

```powershell
# 解压后，进到含 package.json 的那一层
dsh plugin --profile web add "D:\你解压到的路径\dsh-task-alerts"
```

### 2.2 桌面端（本项目实测路径）

桌面端 profile 是 Electron 独占的，`dsh plugin --profile web add` 不写它的装载清单。实测可行的做法是复刻它自己的机制：

```powershell
# 1) 把插件放进桌面端 profile 并记录依赖
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "D:\你解压到的路径\dsh-task-alerts"

# 2) 把它写进 profile 的装载清单（package.json 的 dsh.profile.bundles 数组里加一项）
#    "dsh-task-alerts"
```

### 2.3 生效方式（很容易踩）

| 改动位置 | 生效方式 |
| --- | --- |
| 浏览器半（`lib/client.js`，界面/面板/设置页） | **刷新网页**即可 |
| 宿主半（`lib/index.js`，快捷键 / 路由 / 音效 / 配置） | **必须完整重启应用**（托盘 → 退出 → 重开） |

装完后**完整重启一次**最稳。

## 3. 怎么确认装成功了

```powershell
# 宿主半起来了就会应答（端口与 DSH 的 webServer 一致）
Invoke-WebRequest "http://127.0.0.1:19387/task-alerts/state" -UseBasicParsing | Select-Object -Expand Content
```

在应用里也可以用两条命令：`/alert-test`（试一次提醒）、`/alert-stop`（停响）。

## 4. 装好之后在哪设置

**设置 → 任务提醒**（另有侧边栏底部的快捷入口）。可改：音效路径、重复间隔、重复上限、
卡住上限（尝试次数）、停止快捷键、面板快捷键、收起把手、各开关、报告目录与打开方式、毛玻璃参数。
另有设置页外的两个快捷键（**全局 + 应用内**两层都生效）：

| 快捷键 | 作用 | 默认 |
| --- | --- | --- |
| 停止快捷键 | 停止正在响的提示音 | `ctrl+alt+s` |
| 面板快捷键 | 打开 / 收起提醒面板 | `ctrl+alt+a` |

> 快捷键规则：必须是**修饰键 + 一个普通键**（如 `ctrl+alt+s`）。只按修饰键、裸字母、
> 或 `clear` 这类非标准键名都不会被接受——这是为了避免误绑定把正常打字吞掉。

## 5. 卸载

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm remove dsh-task-alerts
# 并从 profile 的 package.json 的 dsh.profile.bundles 里删掉 "dsh-task-alerts"
```

用户配置留在 `<DSH_HOME>\dsh-task-alerts.config.yaml`（默认 `C:\Users\<你>\.dsh\`），
报告在 `<包根>\reports\`，日志在 `<包根>\plugin.log`——都在包外，删不删随你。

## 6. 已知限制

- **全局快捷键**依赖 `node-global-key-listener`（随包附带）；若你的平台缺它，只有应用内快捷键生效。
- 真实的毛玻璃观感依赖浏览器的 `backdrop-filter`；极老的 WebView 上会退化为纯色背景。
- `logFile` 不能在设置页里改（改它等于换正在写的日志文件），其余都能改。
