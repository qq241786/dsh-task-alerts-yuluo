# dsh-task-alerts-yuluo

DSH（DeepSeek Harness）插件：监控任务执行过程，在**程序执行结束**和**同一问题尝试达到上限仍未解决**时提醒你。

- 播放提醒音效；**没关闭就一直响**，响铃间隔可配置
- 在 DSH Web UI 中弹出**毛玻璃（Glassmorphism）浅蓝色**提醒面板 / 轻量 Toast
- 判定为「无法解决」时在指定目录生成 TXT 报告；面板里可**一键打开报告**，也可配置自动打开
- 快捷键（可配置）随时关闭音效，插件本身不退出
- **所有配置都能在 DSH 设置里改，点保存即刻生效、不用重启**

---

## 1. 在哪里设置（最常问的）

有两个地方，**推荐用第一个**：

### 方式一：DSH 设置页（不用重启）

1. 点侧边栏底部的 **设置**
2. 左侧导航里找到 **「任务提醒」**
3. 改完点 **保存** —— **立即生效，不需要重启 DSH**

设置页里能改：启用总开关、音效文件、重复间隔、重复上限、快捷键、两个提醒开关、报告目录、自动打开方式、毛玻璃四项参数。旁边还有 **「试听」** 按钮可以直接验证音效。

侧边栏底部、**设置入口旁边**还有一个小按钮：点它展开/收起本插件的提醒面板（折叠只影响视觉，**不会**停止响铃、不会忽略提醒）。

### 方式二：直接编辑配置文件（需要重启）

`config.yaml`（在插件包根目录）。改完**重启 DSH** 才生效。

保存优先级由高到低：

1. `apply(ctx, config)` 的第二参数（cordis 行 config）
2. **`<DSH_HOME>/dsh-task-alerts.config.yaml`** ← 设置页保存写的就是这里
3. 插件包根 `config.yaml`
4. 内置默认值

> 设置页保存**只会写第 2 个文件**，绝不改写插件自带的 `config.yaml`。
> 所以「设置页改过的值」会覆盖「config.yaml 里的值」；想回到包根默认值，就把第 2 个文件删掉。

---

## 2. 触发条件

| 场景 | 判定 | 动作 |
| --- | --- | --- |
| 程序执行结束 | 一个回合结束（成功或失败） | 响铃（进入循环）+ 轻量 Toast（`program_finish_alert: true` 时） |
| 同一问题尝试 N 次仍未解决 | 同一 `problem_id` 累计 `solved=false` 次数达到 `max_attempts` | 响铃（进入循环）+ 毛玻璃面板 + TXT 报告 + 去重（`alert_on_unresolved: true` 时） |

程序执行结束的判定来自 DSH 宿主事件（`agent/turn-stopping`、`agent/status`、`agent/error`、`agent/request-error`），
经插件的**事件适配层**归一化后驱动计数与提醒。事件系统不可用时适配层仍可工作：
其它插件或脚本可以直接调用宿主服务 `ctx.taskAlerts.recordAttempt(...)` / `ctx.taskAlerts.recordProgramFinish(...)`。

---

## 3. 配置项

```yaml
enabled: true                      # 总开关（见 §3.3）

audio_path: "./alert.wav"          # 提醒音效
report_dir: "./reports"            # TXT 报告目录
max_attempts: 2                    # 同一问题失败几次判定为无法解决
stop_hotkey: "ctrl+alt+s"          # 关闭响铃的快捷键
program_finish_alert: true         # 程序执行结束时提醒
alert_on_unresolved: true          # 无法解决时提醒

repeat_interval: 10                # 秒；没关闭时每隔多久再响一次。0 = 只响一次
repeat_max: 0                      # 最多重复几次；0 = 不限（一直响到关闭）

report_auto_open: "none"           # none | file | folder | browser

ui:
  blur_strength: 10                # 毛玻璃模糊强度 px（0–40）
  primary_color: "#87CEEB"         # 主色（浅蓝）
  border_radius: 20                # 圆角 px（0–48）
  opacity: 0.7                     # 面板不透明度（0.05–1）

log_file: "./plugin.log"           # 日志
```

越界值会被 clamp，不会报错：

| 键 | 规则 |
| --- | --- |
| `max_attempts` | ≥ 1 |
| `repeat_interval` | ≥ 0，保留小数；`0` = 不循环 |
| `repeat_max` | ≥ 0，取整；`0` = 不限 |
| `report_auto_open` | 非法值归 `none` |
| `ui.blur_strength` | 0 – 40 |
| `ui.border_radius` | 0 – 48 |
| `ui.opacity` | 0.05 – 1 |

### 3.1 响铃规则：**没关就不会自动停**

提醒触发后：**立即响一次，之后每 `repeat_interval` 秒再响一次**，直到你主动关闭：

- `/alert-stop` 命令
- 面板的「停止音效 / 停止重复提醒」按钮
- **关闭该提醒**（面板「关闭」、Toast 的关闭）
- 达到 `repeat_max`（仅在你自己设了上限 > 0 时）
- 插件卸载

**没有任何「到时间自动停」的路径**：不因时间流逝、不因 Toast 消失、不因面板折叠而停。
`repeat_interval: 0` 则完全不进循环，只响一次。

> 建议 `repeat_interval` 不小于音效时长，否则每次重复会打断上一次播放。
>
> 响铃循环代表的是「这条提醒还没关闭」这个**状态**：即使 `alert.wav` 缺失（响不出来），
> 面板仍会显示「重复提醒中 · 第 N 次」，`/alert-stop` 与「关闭」都能正常终止它。

### 3.2 快捷键（两层，同一个配置值）

| 层 | 生效范围 | 实现 | 前置条件 |
| --- | --- | --- | --- |
| 应用内 | DSH 窗口聚焦时 | 浏览器 `keydown` 监听 | 无 |
| 全局 | 任意窗口聚焦时（OS 级） | `node-global-key-listener` | 该可选依赖已安装 |

全局层依赖 `node-global-key-listener`（本插件的 `optionalDependencies`，随插件一起安装）。
若安装失败或被移除，插件记一条日志并**静默降级**到应用内层——快捷键仍可用，只是仅在 DSH 窗口聚焦时生效。

写法示例：`ctrl+alt+s`、`ctrl+shift+q`、`alt+f12`。大小写不敏感，`ctrl`/`control` 等价。
设置页里可以直接按组合键捕获。

### 3.3 关闭与再开启：`enabled`

`enabled: false` = **整体静默**：不响铃、不进响铃循环、不弹面板/Toast、不生成报告、不自动打开报告。

**怎么再开启**（这是关键，特意设计成不会把自己锁死）：

- **设置页永远可用** —— `enabled: false` 时它照常完整显示、所有控件都可点，顶部会提示「提醒已关闭…改完直接保存即可重新开启」。把「启用提醒」打开 → 保存即可。
- 侧边栏底部的小按钮也永远可用。
- `/alert-test` 与「试听」按钮**绕过总开关**：关闭状态下点「试听」照常出声、照常弹面板——这正是你用来诊断「音效路径写对没有」的手段。

---

## 4. 在 DSH Web UI 中使用

| 命令 | 作用 |
| --- | --- |
| `/alert-stop` | 停止当前响铃（含循环），不卸载插件 |
| `/alert-test` | 预览提醒：响铃并进入循环，同时让面板与 Toast 显示出来（绕过总开关） |

在输入框里输入命令并发送即可（命令由宿主半注册，不发送给模型）。

面板按钮：

- **停止音效 / 停止重复提醒** → 同 `/alert-stop`；响铃中会强调显示
- **测试提醒** → 同 `/alert-test`
- **打开报告** → 用系统默认程序打开该提醒对应的 TXT（仅当有报告时出现）
- **关闭** → 关闭这条提醒并**立即停止响铃**

响铃中面板显示「重复提醒中 · 第 N 次 · 每 M 秒」和脉冲指示点。

### 4.1 界面说明

提醒 UI 注册在 DSH 的 `shell.overlay` 槽（全框浮动层），因此浮动在任何面板之上：

- 面板固定在**右下角**（距边框 24px），最大宽度 420px
- Toast 固定在**右上角**堆叠
- 该浮动层本身**点击穿透**，只有面板/Toast 本体接收点击——不会挡住下面的界面

视觉参数由 `ui` 段控制，在设置页改完保存**立即生效**（浅色/深色主题都自动适配）。

### 4.2 报告自动打开：`report_auto_open`

| 值 | 行为 |
| --- | --- |
| `none` | 不打开（默认） |
| `file` | 用系统默认程序打开该 `.txt` |
| `folder` | 打开所在文件夹（Windows 下并选中该文件） |
| `browser` | 以 `file://` URL 交给系统默认处理器 |

仅在报告**成功写盘之后**触发；失败只记日志。不做自动打开也随时可用面板上的「打开报告」按钮。

---

## 5. 安装

### 5.1 普通 profile（CLI 可直接管理）

```powershell
dsh plugin --profile web add ./dsh-task-alerts-yuluo
```

### 5.2 DSH 桌面端（desktop profile）

`desktop` profile 由 Electron 独占，CLI 会拒绝写入
（`profile "desktop" is managed exclusively by the Electron application`）。
桌面端自己的插件管理器就是「在 `profiles/desktop` 里跑 `pnpm add` + 把包名追加进
`package.json` 的 `dsh.profile.bundles`」，等价做法：

```powershell
$NODE="$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM="$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
cd "$env:USERPROFILE\.dsh\profiles\desktop"
& $NODE $PNPM add "E:\path\to\dsh-task-alerts-yuluo"
# 再把 "dsh-task-alerts-yuluo" 追加到 package.json 的 dsh.profile.bundles 数组末尾（只加这一项，别动别的）
```

**安装后必须完整重启 DSH**（托盘 → 退出，不只是关窗口）：`dsh.profile.bundles` 只在启动时读一次。

> 安装前先备份 `profiles\<profile>\package.json` 与 `pnpm-lock.yaml`，便于回滚。

### 5.3 卸载 / 回滚

```powershell
$D="$env:USERPROFILE\.dsh\profiles\desktop"
# 1) 用备份还原 package.json 与 pnpm-lock.yaml（比手改安全，不会漏删别人的条目）
# 2) 删链接。必须用 rmdir：Remove-Item -Recurse 会跟进 junction 删掉插件源码目录
cmd /c rmdir "$D\node_modules\dsh-task-alerts-yuluo"
```

### 5.4 从源码构建

```powershell
cd dsh-task-alerts-yuluo
npm run build      # tsc（宿主半）→ tsc（浏览器半）→ 拼接 lib/client.js
npm run check      # 仅类型检查
npm run smoke      # 宿主半冒烟测试
```

用 `link:` 安装时，改完源码只要重新 `npm run build` 即生效，无需重装。

### 5.5 音频文件

仓库**不含** `alert.wav`。放一个音效文件并把 `audio_path` 指向它（也**可以直接在设置页里填路径**）：

```powershell
Copy-Item D:\sounds\done.wav .\alert.wav
```

播放后端按可用性逐级降级，全部失败只记日志、不影响其他功能：

1. `node-wav-player`（若已安装）
2. `play-sound`（若已安装）
3. 操作系统原生播放器：Windows `System.Media.SoundPlayer`／macOS `afplay`／Linux `paplay` → `aplay`

---

## 6. 报告格式

判定为无法解决时，在 `report_dir` 生成 `<时间戳>-<问题ID>.txt`：

```
================================================================
DSH 任务提醒 —— 未解决问题报告
================================================================

生成时间   : 2026-02-14T19:30:12.481Z
问题 ID    : p-7f3a21
问题描述   : 计算某目录下所有文件的哈希并汇总
最终状态   : 未解决（连续 2 次尝试均失败，上限 2）
尝试次数   : 2 / 上限 2

---------------------- 逐次尝试 ----------------------

【尝试 1】
  时间     : 2026-02-14T19:28:03.114Z
  思考内容 : 先枚举文件，再逐个计算 sha256，最后拼接汇总值。
  错误信息 : （无）
  来源     : agent/turn-stopping
```

**去重**：同一个 `problem_id` 只会生成一份报告；已生成集合落盘到 `<report_dir>/.reported.json`，
因此**重启后也不会重复生成**，再次触发提醒时复用既有报告路径。

---

## 7. 目录结构

```
dsh-task-alerts/
├── package.json            # DSH 插件清单（exports / dsh.bundle / dsh.client）
├── tsconfig.json           # 宿主半（Node，NodeNext）
├── tsconfig.client.json    # 浏览器半（无模块语法，classic JSX）
├── cordis.patch.yml        # 宿主行插入（安装时由 DSH 应用）
├── config.yaml             # 出厂默认配置（设置页不会改写它）
├── src/
│   ├── index.ts            # 入口：装配、路由、服务、生命周期
│   ├── config-store.ts     # 可写用户配置：校验 / 序列化 / 原子写
│   ├── types.ts            # 契约类型
│   ├── config.ts           # 配置加载、clamp、路径解析
│   ├── audio.ts            # 音效播放/停止 + 响铃循环
│   ├── opener.ts           # 跨平台「打开文件/文件夹/浏览器」（可注入）
│   ├── hotkey.ts           # OS 级快捷键监听
│   ├── reporter.ts         # TXT 报告生成 + 去重
│   ├── adapter.ts          # DSH 事件 → 提醒语义 适配层
│   └── ui/
│       ├── client.ts       # 浏览器半入口（轮询/控制/主题/槽注册）
│       ├── AlertPanel.tsx  # 毛玻璃面板与 Toast
│       ├── SettingsForm.tsx# 设置页与侧边栏按钮
│       └── styles.css      # 毛玻璃样式
├── scripts/
│   ├── build-client.mjs    # 拼接浏览器半为 lib/client.js（零依赖 + 完备性守卫）
│   ├── smoke-host.mjs      # 宿主半冒烟（212 条断言）
│   └── smoke-client.mjs    # 浏览器半冒烟（115 条断言，无 DOM）
├── docs/CONTRACT.md        # 宿主半 ↔ 浏览器半 接口冻结件
└── lib/                    # 构建产物
```

浏览器半**不使用打包器**：`src/ui/**` 被约束为不含 `import`/`export` 的普通脚本
（classic JSX、经 `window.__DSA__` 命名空间通信），由 `scripts/build-client.mjs` 纯字符串拼接成单个
`window.__ModuleLoader__.load({ id, factory })` 模块。构建链只需 `tsc` + `node`。

### 7.1 两条「改动前必读」的硬规则

**① `PARTS` 是显式有序白名单，不是 glob。**
新增任何 `src/ui/*.tsx` 都必须登记进 `scripts/build-client.mjs` 的 `PARTS`，否则它会被 `tsc`
编译却永远进不了 `lib/client.js`——而且失败是**静默**的（组件在运行时是 `undefined`，
注册方安静跳过，整个界面凭空消失、没有任何报错）。
为此构建脚本带一道 **completeness guard**：`build/client/*.js` 里有文件不在 `PARTS` 中就直接失败退出。

**② 浏览器半是「双层密封」的。**
DSH 把「一个 entry 未激活」视为整个 web boot 的致命失败——**应用会起不来**。
而模块物化（`factory(require)`）与激活（`apply(ctx)`）是**两个独立步骤**，任一步抛出都会击穿 boot。
因此 `lib/client.js` 里这两步都被 try/catch 密封：失败只降级成「空插件 + 一条 console.error」，
**永远不会让 DSH 起不来**。改浏览器半时不要破坏这层密封。

> 关于 `require`：加载器是以**形参**把解析器交给 factory 的
> （`factory: function (require) { … }`，返回值即模块 exports），它不是全局变量。

---

## 8. 排障

| 现象 | 原因与处理 |
| --- | --- |
| **设置里找不到「任务提醒」** | 先刷新 Web UI；再查 `plugin.log` 是否出现 `已注册路由 exact /task-alerts/config`（没有 = 宿主半没加载，需完整重启）。浏览器半的槽注册失败只会 `console.warn`，不影响其他功能。 |
| **应用无法启动**，报 `web boot: 1 entry did not activate` | 浏览器半出错。本插件已对 `factory` 与 `apply` 双层密封，正常不会发生；若仍出现，看崩溃报告 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` 并按 §5.3 回滚。 |
| 面板/Toast 完全不出现 | 确认 Web UI 已刷新；查 `plugin.log` 是否有 `slots` 不可用或 `apply() failed`。宿主半与浏览器半是两个独立加载的一半。 |
| 有面板但没声音 | `audio_path` 指向的文件不存在或不可读；`plugin.log` 会记录实际尝试的后端与失败原因。可在设置页点「试听」当场验证。 |
| 声音一直在响停不下来 | **这是设计行为**（§3.1，没关就不会自动停）。用 `/alert-stop`、面板「停止音效」或「关闭」，或按 `stop_hotkey`。想彻底不循环就把 `repeat_interval` 设为 `0`。 |
| 想彻底关掉提醒 | 设置 → 任务提醒 → 关掉「启用提醒」→ 保存。再开启走同一路径（设置页在关闭状态下照常可用）。 |
| 设置页改了但没生效 | 保存后应当立即生效；若没有，看设置页顶部的错误行与 `plugin.log`。直接改 `config.yaml` 则仍需重启。 |
| 全局快捷键无反应 | `node-global-key-listener` 未安装或被安全软件拦截。查日志；应用内快捷键仍可用。 |
| 没有生成报告 | 同 `problem_id` 已生成过（去重）；或 `report_dir` 不可写（已回退 `<DSH_HOME>/dsh-task-alerts/`，日志会写明实际路径）；或总开关已关闭。 |
| 「打开报告」没反应 | 该提醒没有 `reportPath`（按钮不会出现），或系统默认处理器未关联 `.txt`；`plugin.log` 会记录打开命令与失败原因。 |
| 毛玻璃没效果 | 浏览器不支持 `backdrop-filter`（旧内核）。面板会退化为半透明纯色背景，功能不受影响。 |

日志位置：`log_file`（默认插件包根的 `plugin.log`），不可写时回退 `<DSH_HOME>/dsh-task-alerts/plugin.log`。

### 8.1 维护者提示（测试钩子）

`apply(ctx, config)` 的第二参数接受两个**非契约键**，仅供测试注入，生产配置解析不出函数、零影响：

- `openRunner(path, mode, command, args) => boolean` —— 拦截所有「打开」动作（`mode`: `file` | `folder` | `browser`），
  冒烟测试靠它避免真的弹出窗口。
- `audioProbe(handleOrNull, context) => void` —— 在**转发给真实播放器的那一刻**被调用，
  用来断言「确实没有向播放器发起播放」，而不是只观察插件自己的开关。

另可用环境变量 `DSH_TASK_ALERTS_USER_CONFIG` 覆盖用户配置文件路径（便于测试与多实例）。

---

## 9. 许可证

MIT
