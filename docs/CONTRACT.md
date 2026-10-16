# dsh-task-alerts — 接口冻结件（Interface Freeze）

本文件是 host 半与 client 半之间的唯一契约。两半由不同执行者并行实现，
**任何一方都不得单方面修改本文件**；需要变更时报给调度者。

---

## 0. 已核实的 DSH 事实（不得再猜）

来源：`C:\Users\24178\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
以及真实第三方插件样例 `C:\Users\24178\.dsh\profiles\desktop\node_modules\dsh-plugin-wallpaper-engine`。

| 事实 | 证据 |
| --- | --- |
| DSH 插件 = Cordis 插件：导出 `apply(ctx)`；可选 `inject`、`name` | `dsh-commands/lib/types/index.d.ts:15,94`；`wallpaper/lib/types/client.d.ts` |
| 宿主半入口 `lib/index.js`，浏览器半入口 `lib/client.js` | `wallpaper/package.json` `exports` |
| `package.json` 用 `dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 声明浏览器半 | `wallpaper/package.json` |
| `cordis.patch.yml` 用 `- insert: - id: <rowId>` + `name: <pkg>` 插入宿主行 | `wallpaper/cordis.patch.yml` |
| 浏览器半是 `window.__ModuleLoader__.load({ id, factory })` 形式的编译产物；factory 返回 `{ inject, apply }`；`react` 经 `require("react")` 取用 | `wallpaper/lib/types/client.d.ts` 全文注释 |
| **`require` 是 factory 的第一个形参，不是全局**；`factory(require)` 的**返回值就是模块 exports** | `dsh-client-modules/lib/client.js:683` → `exports: registered.factory(this.makeRequire(ownerId, edges))`；该包自身产物 `lib/client.js:3` → `factory: (require) => {`；`wallpaper/lib/client.js:23363` → 工厂体内 `const React = require("react")` |
| **factory 未捕获异常 = `1 entry did not activate` = web boot 致命失败，整个 harness 无法启动** | 实测崩溃报告 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-10-15T11-34-59-526Z-web-boot.log`（`dsh-task-alerts: import failed: require is not defined`） |
| `ctx.slots.inject(key, cb)` + `ctx.slots.register(options, component)` 注册 UI；`shell.overlay` 是**全框浮动层 list 槽**，默认点击穿透，条目需自行开启 pointer-events | `dsh-client-ui-renderer/lib/types/client/registry.d.ts:111`；`dsh-client-ui-layout/lib/types/client/index.d.ts:75-88`；`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:148-166` |
| `ctx.theme.overrideTokens(source, tokens)`：`tokens` 为 `token 名 → { light, dark }` 值对；重复调用同 source 会整体替换 | `dsh-client-ui-theme/lib/types/client/index.d.ts:163-178` |
| `ctx.theme` 与 `theme/change` 事件在 client 上下文；`theme/change(snapshot)` | 同上 `:84-96` |
| 宿主命令：`ctx.commands.register({ name, description, handler })` → 返回卸载 disposer；`name` **不带前导斜杠** | `dsh-commands/lib/types/index.d.ts:38-54,94` |
| 宿主 HTTP：`ctx.webServer.register({ kind:'exact'|'prefix', path, handler })` → disposer | `dsh-host-webserver/lib/types/index.d.ts:31-97` |
| 宿主事件：`ctx.on('agent/status' \| 'agent/turn-stopping' \| 'agent/error' \| 'agent/request-error' \| 'agent/created' \| 'agent/disposed', handler)` | `dsh-agent/lib/types/runtime-types.d.ts:227-410` |
| 安装：`dsh plugin --profile web add <dir>`（实为在 profile 目录跑 pnpm）。`desktop` profile 由 Electron 独占，CLI 拒改 | 实测 `dsh plugin --profile desktop --help` → "managed exclusively by the Electron application" |
| **禁止**两半 `import` 任何 `@deepseek-ai/*`：profile 的 node_modules 里不存在这些包，只有 DSH 运行时提供 | `C:\Users\24178\.dsh\profiles\desktop\node_modules\@deepseek-ai` 仅含 `cosmokit`、`schemastery` |

---

## 1. 包身份

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-task-alerts-yuluo` |
| cordis 行 id | `task-alerts` |
| client 模块 id | `dsh-task-alerts-yuluo` |
| 暴露的宿主服务 | `ctx.taskAlerts` |
| slot 注册 id（面板） | `task-alerts.panel` |
| slot 注册 id（Toast） | `task-alerts.toast` |
| 默认快捷键 | `ctrl+alt+s` |

## 2. 文件所有权（禁止越界写）

| 执行者 | 拥有 |
| --- | --- |
| 调度者 | `package.json`、`tsconfig*.json`、`cordis.patch.yml`、`config.yaml`、`README.md`、`docs/CONTRACT.md` |
| 宿主半 | `src/index.ts`、`src/config.ts`、`src/audio.ts`、`src/hotkey.ts`、`src/reporter.ts`、`src/adapter.ts`、`src/types.ts`、`scripts/smoke-host.mjs` |
| 浏览器半 | `src/ui/client.ts`、`src/ui/AlertPanel.tsx`、`src/ui/styles.css`、`scripts/build-client.mjs`、`scripts/smoke-client.mjs`、`lib/client.d.ts` |

`lib/**` 的其余内容是 `tsc` 与 `scripts/build-client.mjs` 的产物，不作为源码交付物。

## 3. 类型契约（两半各自本地声明，不得互相 import）

宿主半写入 `src/types.ts`；浏览器半把同名接口内联在 `src/ui/client.ts`。

```ts
export type AlertKind = 'unresolved' | 'finish'
export type AlertLevel = 'error' | 'success' | 'info'

export interface UiConfig {
  blurStrength: number   // px, 默认 10
  primaryColor: string   // 默认 '#87CEEB'
  borderRadius: number   // px, 默认 20
  opacity: number        // 0..1, 默认 0.7
}

export interface AlertStateConfig {
  hotkey: string            // 归一化小写 'ctrl+alt+s'
  ui: UiConfig
  programFinishAlert: boolean
  alertOnUnresolved: boolean
  maxAttempts: number
  reportDir: string         // 已解析为绝对路径
}

export interface AlertRecord {
  id: string                // 'al_<n>'
  kind: AlertKind
  level: AlertLevel
  title: string
  message: string
  problemId?: string
  attempts?: number
  maxAttempts?: number
  reportPath?: string
  createdAt: string         // ISO-8601
  audio: boolean            // 该条提醒是否已触发音效
  dismissed: boolean
}

export interface AlertState {
  revision: number
  generatedAt: string
  config: AlertStateConfig
  stats: { problems: number; unresolved: number; alerts: number }
  audioPlaying: boolean
  alerts: AlertRecord[]     // 最新在前，最多 20 条
}
```

## 4. HTTP 契约（宿主半提供，浏览器半消费；同源，无鉴权）

### `GET /task-alerts/state`
- 200，`Content-Type: application/json; charset=utf-8`
- body = `AlertState`
- 浏览器半每 **1000ms** 轮询一次；面板打开时改为 **1500ms**。请求带 `?since=<revision>`，
  宿主可返回相同 payload（实现可忽略该参数，但不得因它报错）。
- 失败（网络错、非 200、JSON 解析失败）浏览器半必须静默吞掉，不得抛到 React 树外，
  连续失败 3 次后降级为 5000ms 轮询。

### `POST /task-alerts/control`
- 请求体 JSON：`{ "action": "stop-audio" | "test-alert" | "dismiss", "alertId"?: string }`
- 200，body `{ "ok": true, "state": AlertState }`
- 未知 action → 400，body `{ "ok": false, "error": "unknown action" }`
- `dismiss` 缺少 `alertId` → 400。

两个路由都用 `kind: 'exact'`。路由注册必须容错：`ctx.webServer` 不存在时跳过并写日志，
插件其余功能（音效、快捷键、报告、命令）仍须工作。

## 5. 宿主服务 `ctx.taskAlerts`

```ts
interface TaskAlertsService {
  recordAttempt(input: {
    problemId: string
    description?: string
    thought?: string
    error?: string
    solved: boolean
    source?: string
  }): Promise<{ attempts: number; unresolved: boolean; reportPath?: string }>

  recordProgramFinish(input?: {
    label?: string
    ok?: boolean
    detail?: string
  }): Promise<{ alerted: boolean }>

  stopAudio(): boolean
  test(): Promise<AlertState>
  getState(): AlertState
  dismiss(alertId: string): boolean
}
```

## 6. 配置契约（`config.yaml` 键名固定）

```yaml
audio_path: "./alert.wav"
report_dir: "./reports"
max_attempts: 2
stop_hotkey: "ctrl+alt+s"
program_finish_alert: true
alert_on_unresolved: true
ui:
  blur_strength: 10
  primary_color: "#87CEEB"
  border_radius: 20
  opacity: 0.7
log_file: "./plugin.log"
```

解析优先级（高 → 低）：
1. 宿主 `apply(ctx, config)` 的第二参数（cordis 行 config）
2. `<DSH_HOME>/dsh-task-alerts.config.yaml`
3. 插件包根 `config.yaml`
4. 内置默认值

相对路径解析基准：插件包根目录；若该目录不可写则回退 `<DSH_HOME>/dsh-task-alerts/`。
`max_attempts` clamp 到 `>=1`；`ui.blur_strength` clamp 到 `0..40`；`ui.opacity` clamp 到 `0.05..1`；
`ui.border_radius` clamp 到 `0..48`。

## 7. 浏览器半构建契约（零依赖）

**不用打包器**。`scripts/build-client.mjs` 用纯 Node 完成：

1. `tsc -p tsconfig.client.json` 把 `src/ui/client.ts`、`src/ui/AlertPanel.tsx`
   编译成 `build/client/*.js` 的**普通脚本**（无 ESM 语法、无 import/export）。
2. 脚本按 `client.js` → `AlertPanel.js` 顺序（或反向，以实现自洽为准）拼接，包进：

```js
window.__ModuleLoader__.load({
  id: 'dsh-task-alerts-yuluo',
  factory: function (require) {          // require 是形参，不是全局；缺它 = 致命启动失败
    try {
      return (function () {              // 内层 IIFE 自带 "use strict"：try 块内的指令序言失效
        "use strict";
        var React = require('react');
        window.__DSA__ = window.__DSA__ || {};
        window.__DSA__.css = "…";
        /* ---- concatenated sources ---- */
        var apply = window.__DSA__.apply;
        if (typeof apply !== 'function') throw new Error('browser half did not publish apply');
        return { inject: ['slots'], apply: apply };
      })();
    } catch (error) {
      console.error('[dsh-task-alerts] browser half failed to initialize; DSH boot continues', error);
      return { inject: [], apply: function () {} };   // 仍激活，绝不阻断 boot
    }
  }
})
```

**factory 的返回契约**：返回值**就是** exports（不是 `module.exports` 的封装）。失败路径必须返回
一个能正常激活的空插件，否则加载器判定 `1 entry did not activate` 并**中止整个 web boot**。

3. 输出 `lib/client.js`；同时把 `styles.css` 原文以字符串内联到产物里
   （`window.__DSA__.css = "..."`），保证运行时只加载一个文件。

**拼接是「显式有序白名单」，不是 glob**（`build-client.mjs` 的 `PARTS`）：

- 顺序语义：只**发布**到 `window.__DSA__` 的文件必须在**读取**它的文件之前。
- **新增任何 `src/ui/*.tsx` 都必须登记进 `PARTS`**，否则它会被 `tsc` 编译却永远进不了
  `lib/client.js`——而且失败是**静默**的：它发布的组件在运行时是 `undefined`，
  注册方会安静跳过，整个界面凭空消失且没有任何报错。
- 为此 `build-client.mjs` 带一道 **completeness guard**：`build/client/*.js` 中只要有文件不在
  `PARTS` 里，构建直接以退出码 1 失败并打印「add them to PARTS」。**不要绕过它。**

**浏览器半两条硬性源码约束**（否则拼接方案失效）：
- 不得出现任何 `import` / `export` 语句。
- 顶层通过声明获得全局：`declare const React: any`、`declare const window: any`、
  `declare function require(mod: string): any`。
- JSX 用 classic 运行时（`jsx: "react"`），由 `tsconfig.client.json` 保证。
- 多个文件之间只经 `window.__DSA__` 这一命名空间对象通信，不共享模块作用域。
- **必须**能解析 JSX，否则 `strict` 下 `noImplicitAny` 会因缺少 `JSX.Element` 而报错
  （此环境没有 `@types/react`）：

```ts
declare namespace JSX {
  interface Element { }
  interface ElementClass { }
  interface IntrinsicElements { [elemName: string]: any }
}
```

  **但 `IntrinsicElements` 在整个 tsc program 里只能声明一次**：`src/ui/**` 下所有
  `.tsx` 都在同一个 program 里且都是全局脚本，重复的索引签名会硬报
  `TS2374: Duplicate index signature for type 'string'`。
  因此：`Element` / `ElementClass` 每个文件各自声明（声明合并，互不冲突），
  **`IntrinsicElements` 全 program 只在一处声明**——当前落在 `src/ui/AlertPanel.tsx`，
  `src/ui/SettingsForm.tsx` 靠声明合并共用它。新增 `.tsx` 时照此规则办。

- 每个源文件的顶层声明块统一为：
```ts
declare const React: any
declare const window: any
declare function require(mod: string): any
declare const document: any
```
  运行时由拼装产物的 factory 作用域提供 `React`（`require('react')`）与 `window`；
  `window.__DSA__` 由 `src/ui/client.ts` 在顶层创建：`(window.__DSA__ = window.__DSA__ || {})`。

## 8. 视觉契约（毛玻璃）

CSS 变量名固定，由 `src/ui/styles.css` 定义、由 client 半在运行时按配置覆盖：

```
--dsa-blur      模糊强度 px（默认 10）
--dsa-primary   主色（默认 #87CEEB）
--dsa-radius    圆角 px（默认 20）
--dsa-opacity   面板不透明度（默认 0.7）
--dsa-tint      渐变起始色 #87CEEB
--dsa-tint-soft 渐变结束色 #E0F7FA
```

- 面板根元素类名：`dsa-panel`；Toast 根元素类名：`dsa-toast`；根宿主容器：`dsa-root`。
- 主题适配：宿主容器带 `data-dsa-scheme="light" | "dark"`，两套取值都必须在
  `styles.css` 中给出（浅色下浅蓝更饱和，深色下压暗但保留色相）。
- 所有可点击元素 hover 需有 `transform: scale(1.04)` + 发光，`:active` 需有反馈。
- 必须使用 `backdrop-filter: blur(var(--dsa-blur))`，并带 `-webkit-` 前缀。
- `shell.overlay` 默认点击穿透：`dsa-root` 容器 `pointer-events: none`，
  面板/Toast 本体 `pointer-events: auto`。
- 样式注入方式：client 半在 `document.head` 追加一个 `<style data-dsa-style>`，
  幂等（已存在则复用），卸载时随 disposer 移除。

## 9. 容错契约（不可协商）

- 任何监听器、定时器、路由处理器、命令处理器内部**必须** try/catch；
  异常写日志，绝不允许冒泡导致宿主进程崩溃。
- 音效播放失败、快捷键库缺失、`ctx.webServer` 缺失、报告目录不可写、
  `backdrop-filter` 不支持——全部降级并记日志，不得 throw。
- 报告去重：同一 `problemId` 在进程生命周期内只生成一次报告；已生成集合额外落盘
  `<report_dir>/.reported.json`，重启后仍去重。

## 10. 验收命令（调度者执行）

```
node <bundled-node> node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 宿主半类型检查
node scripts/build-client.mjs                                                   # 产出 lib/client.js
node -e "import('./lib/index.js').then(m=>console.log(typeof m.apply))"          # 宿主半可加载
```

每半的自检必须真实跑过并把原始输出回报；「应该能编译」不算证据。

---

## 11. v1.1 新增功能契约（2026-10-15 冻结）

### 11.1 `AlertStateConfig` 新增字段（`src/types.ts`）

```ts
repeatInterval: number    // 秒；两次响铃间隔。0 = 只响一次
repeatMax: number         // 最多重复次数；0 = 不限（一直响到关闭）
reportAutoOpen: 'none' | 'file' | 'folder' | 'browser'   // 非法值一律归为 'none'
```

### 11.2 `AlertState` 新增字段

```ts
repeatActive: boolean     // 当前是否处于「响铃循环」中
repeatCount: number       // 本轮已重复次数（首次播放不计入）
```

### 11.3 响铃循环语义（不可协商）

- 触发条件：任何**因提醒而播发音效**的路径（`unresolved`、程序结束、`test-alert`）都进入循环。
- 时序：立即播放 1 次 → 每 `repeatInterval` 秒再播 1 次。
- 终止条件（任一即停，且必须停）：`/alert-stop` 命令、control `stop-audio`、
  control `dismiss`（任何 dismiss 都停）、插件卸载、或重复次数达到 `repeatMax`（`repeatMax>0` 时，
  总播放次数 = `1 + repeatMax`）。
- `repeatInterval === 0` → 不进循环，只播 1 次，`repeatActive === false`。
- 每轮必须 try/catch；定时器必须可被 disposer 清理（不得让宿主进程被挂住）。

### 11.4 新增 control action：`open-report`

```
POST /task-alerts/control   { "action": "open-report", "alertId": "al_3" }
200  { "ok": true, "opened": true, "state": AlertState }
400  { "ok": false, "error": "..." }   // 缺 alertId / 未知 alertId / 该 alert 无 reportPath
```

- 用**操作系统默认处理器**打开该 alert 的 `reportPath`：
  win32 `cmd /c start "" "<path>"`、darwin `open "<path>"`、linux `xdg-open "<path>"`。
- 必须 spawn detached、不阻塞、不抛；失败 → 记日志 + `opened: false`。
- **打开器必须可注入**（`Opener({ runner })` 形态），否则冒烟测试会真的弹出窗口。
- 新增服务方法：`openReport(alertId: string): boolean`。

### 11.5 生成报告后自动打开：`report_auto_open`

| 值 | 行为 |
| --- | --- |
| `none` | 不打开（默认） |
| `file` | 用系统默认程序打开该 `.txt` |
| `folder` | 打开所在文件夹（win32 `explorer /select,"<path>"`；darwin `open -R`；linux `xdg-open <dir>`） |
| `browser` | 以 `file://` URL 交给系统默认处理器 |

仅在报告**成功写盘之后**执行；失败只记日志。同样复用可注入的 `Opener`。

### 11.6 UI 新增

- 面板新增「打开报告」按钮，仅当当前 alert 有 `reportPath` 时出现 → POST `open-report`。
- 面板「关闭」语义变更：当前有 alert id 时 POST `{action:'dismiss',alertId}`（同时停止响铃）后再隐藏；
  无 id 时才本地隐藏。
- `repeatActive === true` 时面板显示「重复提醒中 · 第 N 次 · 每 M 秒」，停止按钮强调显示。
- 新增类名 `.dsa-ring`（脉冲指示点）；必须尊重 `prefers-reduced-motion: reduce`，并沿用毛玻璃语言。

### 11.7 追加约束

- 以上全部为**增量**改动：不得改变插件导出形态，不得移除或改签名 `ctx.taskAlerts` 既有方法。
- `src/ui/**` 仍**禁止**任何 `import`/`export`；只经 `window.__DSA__` 通信。
- `lib/client.js` 是构建产物，**不得手改**（由 `scripts/build-client.mjs` 重新生成）。

---

## 12. v1.2：设置界面 + 可写配置 + 响铃不自动停（2026-10-15 冻结）

### 12.1 新增配置键

```yaml
enabled: true     # 总开关。false = 静默：不响铃、不进响铃循环、不弹面板/Toast、
                  # 不生成报告、不自动打开报告。
                  # 仍然可用：设置页、侧边栏入口、/alert-stop、/alert-test（见 §12.8）。
                  # 这就是「关闭后如何再开启」的保证——设置页永不因 enabled=false 而失效。
```

其余键名与语义不变。

### 12.8 总开关的两个语义澄清（2026-10-15 追加裁决）

1. **`/alert-test` 与 control `test-alert` 绕过 `enabled`。** 它们是用户**显式发起**的预览，
   用来验证音效路径/面板/快捷键是否配好——设置页的「试听」按钮就是调它。
   若关闭态下试听无声，用户就无法诊断自己的 `audioPath` 是否写对，这是坏交互。
   因此：`enabled=false` 时 `test-alert` **照常播声、照常进循环、照常弹面板**，
   靠 `/alert-stop` 或关闭提醒终止。
   被 `enabled=false` 短路的是**自动路径**：程序结束提醒、无法解决提醒、报告生成、自动打开。
2. **`enabled=false` 连报告一起停。** 「关掉」就该什么都不做，最不容易让人意外：
   没有新报告、没有自动打开、没有声音、没有面板/Toast。
   重新开启后，后续尝试照常计数并生成报告（历史计数不丢）。

### 12.2 用户配置文件（可写）

- 路径：`<DSH_HOME>/dsh-task-alerts.config.yaml`
- 优先级：仍是 §6 的第 2 档（低于 `apply(ctx, config)`，高于包根 `config.yaml`）
- **PUT 只写这个文件，绝不改写包根 `config.yaml`**
- 写出去的内容必须能被 §6 的最小 YAML 子集解析器**原样读回**（自写自读闭环）

### 12.3 `GET /task-alerts/config`

```
200  { "ok": true, "config": EditableConfig, "state": AlertState }
```

### 12.4 `PUT /task-alerts/config`

- body = **部分** `EditableConfig`（未提供的键保持原值，不是整体替换）
- 200 `{ "ok": true, "applied": true, "config": EditableConfig, "state": AlertState }`
- 校验失败 400 `{ "ok": false, "error": "...", "errors": { "<key>": "理由" } }`
- 持久化失败 500 `{ "ok": false, "error": "..." }`
- 非 PUT/POST → 400
- 成功后**必须立即运行时生效、无需重启**：`audioPath`、`repeatInterval`、`repeatMax`、`hotkey`、
  `programFinishAlert`、`alertOnUnresolved`、`enabled`、`reportDir`、`reportAutoOpen`、`ui.*`
- 运行时生效失败必须**回滚到旧值**并如实报错，不允许「写进去了但没生效」

### 12.5 `EditableConfig`（线上 camelCase）

```ts
interface EditableConfig {
  enabled: boolean
  audioPath: string
  repeatInterval: number     // 秒，>= 0（保留小数）
  repeatMax: number          // >= 0 取整；0 = 不限
  hotkey: string             // normalizeHotkey 归一化后的形如 'ctrl+alt+s'
  programFinishAlert: boolean
  alertOnUnresolved: boolean
  reportDir: string          // 绝对路径
  reportAutoOpen: 'none' | 'file' | 'folder' | 'browser'
  ui: { blurStrength: number; primaryColor: string; borderRadius: number; opacity: number }
}
```

clamp 规则沿用 §6（越界只收敛不报错）；类型错误才 400。

### 12.6 响铃语义（不可协商，用户明确要求「没关就不要自动停止」）

- **未关闭前绝不自动停止**：不因时间流逝、不因 Toast 消失、不因面板折叠而停响。
- 唯一例外：`repeatMax > 0` 达到上限——这是用户显式设定的上限。
- 默认 `repeat_max: 0`，即一直响到用户主动关闭。
- `enabled: false` 时不进循环、不播任何声音。
- 指向 `kind === 'unresolved'` 的提醒**不得**自动消失或被自动 dismissed；只有 `kind === 'finish'` 的 Toast 才自动隐藏。

### 12.7 新增 UI 注册

| 槽 | id | order | label | 作用 |
| --- | --- | --- | --- | --- |
| `settings.section` | `task-alerts` | 500 | `任务提醒` | 完整设置页：全部可编辑项 + 保存/重置 + 试听音效 |
| `sidebar.footer.action` | `task-alerts.settings` | 400 | — | 侧边栏底部（设置入口旁）的小按钮：一键打开设置页 |

- 两个槽都是既有插件声明的 **list 槽**，注册即追加，不遮蔽任何既有条目。
- 注册写法沿用 §0 的官方样例：`ctx.slots.inject(key, () => ctx.slots.register(options, component))`。
- 两个槽都可能**尚未声明** → 必须用 `inject` 等待；`inject` 不可用时只 warn 跳过，
  **不得连累 `shell.overlay` 的既有注册**。
- **设置页在 `enabled: false` 时必须仍然完整可用。**
- 新增 CSS 类名：`.dsa-field`、`.dsa-label`、`.dsa-input`、`.dsa-switch`、`.dsa-save`、`.dsa-hint`、
  `.dsa-sidebar-action`；沿用 §8 的毛玻璃语言。
- 保存成功后客户端必须**立刻重新拉一次 `/task-alerts/state`**，让 `ui.*` 新值即时反映到面板。
- **侧边栏入口的退化语义（2026-10-15 追加）**：实测 DSH 当前**没有任何可用接口**能从
  `sidebar.footer.action` 打开设置面板（该槽 owner props 只有 `{ wide: boolean }`；
  `openSettings()` 只作为 `settings.launcher` 的 owner prop；`openSection(id)` 只属
  `settings.onboarding`；设置外壳的开关状态是私有 client store；`ctx.layout` 只有
  `selectPanel/toggleSidebar/openRightbar/closeRightbar`；`ctx.shortcuts` 不能 invoke-by-id）。
  因此该按钮的**确定性行为是「切换本插件面板的展开/收起」**，保证必有可见反应。
  同时保留 `openSettingsPanel()` 探测（`ctx.settings` / `ctx.settingsPanel` /
  `window.__DSH_SETTINGS__` / `window.dsh.settings` 上找 `openSettings()`/`open()`，
  每次读取都 try/catch，因为 Cordis 对未声明服务会抛），DSH 将来长出接口时自动优先走它。
  折叠只影响视觉：**不 dismiss、不停响**（§12.6），并以「当前 alert id」为键，
  新问题会重新展开。

---

## 13. v1.3：面板关掉之后还能再打开（2026-10-15 冻结）

用户原话：「这个右下角的任务提醒关了，会无法再开启。给个开启的按钮，再给个快捷键。」

### 13.1 根因（已核实）

- `client.ts` 的 `panelVisible()` **只在「存在未 dismissed 的 unresolved 提醒」时为真**。
- `AlertPanel` 在 `closedKey === currentKey` 或提醒已 dismiss 时 `return null`。
- 面板「关闭」→ `dismiss` → 提醒被移除 → **此后没有任何东西能让面板再渲染**。

### 13.2 新增配置键

```yaml
panel_hotkey: "ctrl+alt+a"   # 打开/收起面板；两层（应用内 + OS 级）。非法值回落此默认
show_pill: true              # 无待处理提醒时，仍保留一个「收起态」入口
```

`EditableConfig` / `AlertStateConfig` 新增：`panelHotkey: string`、`showPill: boolean`
（YAML 侧 `panel_hotkey` / `show_pill`；`config-store.ts` 的序列化/解析要覆盖）。

### 13.3 `AlertState` 新增字段

```ts
panelOpenSeq: number   // 宿主每次收到「打开面板」全局快捷键即 +1；只增不减
```

### 13.4 面板两形态（同一个 seat，互斥渲染）

| 形态 | 何时渲染 | 内容 |
| --- | --- | --- |
| **展开态** | `manualOpen` 或「存在未 dismiss 的 unresolved 提醒且未被本地隐藏」 | 现有完整面板（提醒列表 / 停止 / 测试 / 打开报告 / 关闭） |
| **收起态** | 其余情况**且** `showPill !== false` | 右下角一条紧凑毛玻璃把手：状态（空闲 / 有未解决 / **响铃中**，脉冲需尊重 `prefers-reduced-motion`）+「展开」 |

- **收起态常驻**正是「关了还能再开」的机制本身；`showPill: false` 时回到 v1.2 的
  「关了就没」行为。
- 两者**互斥**（同一 seat），因此不存在层级/重叠冲突。
- **关闭 ≠ 收起**：关闭 = `dismiss`（停响）+ `manualOpen = false`；收起 = 只收起视觉，
  **不 dismiss、不停响**。

### 13.5 四个「打开面板」入口（都要）

1. **收起态把手**（点击 → 展开）。
2. **侧边栏按钮** `task-alerts.settings` → 切换 `manualOpen`（与把手等效）。
3. **应用内快捷键**：`client.ts` 的 `keydown` 里再匹配 `config.panelHotkey` → 切换 `manualOpen`，
   命中 `preventDefault`。语义与宿主 `normalizeHotkey` 一致（小写、`+` 连接、`ctrl`/`control` 等价）。
4. **全局快捷键**：宿主 `panel_hotkey` → `panelOpenSeq += 1`；客户端发现 seq 变大 → 展开面板
   （要记录已见 seq，**不得每轮重复展开**）。

### 13.6 宿主：多绑定、单监听器

`HotkeyListener` 当前只持一个 combo，需支持多绑定；但**只能启动一个 OS 监听器**
（`node-global-key-listener` 会派生常驻 `WinKeyServer.exe`，绝不允许因此多起一个）。
`normalizeHotkey` / `matchesHotkey` 的纯函数语义不变。配置热改时沿用 `restartHotkey` 重启为新的两个组合。

### 13.7 视觉

- 新增类名：`.dsa-pill`、`.dsa-pill--idle`、`.dsa-pill--pending`、`.dsa-pill--ring`、`.dsa-empty`。
- 沿用 §8：`backdrop-filter: blur(var(--dsa-blur))`、大圆角、浅蓝柔和阴影、hover `scale(1.04)`+发光、
  `:active` 反馈、`:focus-visible` 描边、深浅色两套；`shell.overlay` 默认点击穿透 →
  **把手本体必须 `pointer-events: auto`**。
- 展开态在无待处理提醒时渲染 `.dsa-empty`（「当前没有待处理提醒，以下是最近提醒」）+ 最近提醒列表。

### 13.8 回归要求

必须有一条断言覆盖用户报的这个 bug：**`state.alerts` 全部 dismissed（无待处理提醒）时，
手动开启后面板仍然渲染，并出现 `.dsa-empty`**。

---

## 14. v1.4：卡住上限可填 + 快捷键合法性（2026-10-15）

### 14.1 用户诉求

> 「这个卡住上限也来个可以填入吧」

`max_attempts`（同一问题连续失败多少次判定为「无法解决」）此前**只能在 YAML 里手改**。

### 14.2 `maxAttempts` 进入可写配置

- `EditableConfig` 新增 `maxAttempts: number`（>= 1，落盘 `max_attempts`），进入 `EDITABLE_KEYS`。
- 早先排除它的理由是「只在下次加载时生效」——**该理由不成立**：判定读的是活配置
  （每次尝试都取 `this.config.maxAttempts`），所以热改立即生效。
- `mergeEditable` 按 `Math.max(1, Math.floor(v))` 收敛（与 §6 的 clamp 同语义，clamp 不算错误）。
- 设置页新增字段「卡住上限（尝试次数）」（`kind: number`，`min: 1`）。
- `logFile` 仍**不**可写：改它等于换正在写的日志文件。

### 14.3 快捷键合法性规则（真值事故驱动）

实况事故：用户配置里落成了 **`stop_hotkey: "clear"`** —— 设置页的捕获把数字键盘 Clear 键
（`event.key === 'Clear'`）当成合法绑定，他的「停止音效」快捷键**静默失效**。旧归一化
`normalizeHotkeyText` 对**任何非空字符串**都放行，因此一个**裸字母**同样能被绑定；而全局的 `a`
会吞掉系统里所有的 a 键输入。

**规则（两半各自实现，必须同步）**：组合键合法 ⟺ **至少一个修饰键**
（`ctrl`/`control`/`alt`/`shift`/`meta`/`win`/`cmd`/`super`）**加一个白名单内的非修饰键**
（`a-z` / `0-9` / `F1-F24` / 具名键如 `space`、`enter`、`arrowup`、`delete`）。

- `isAllowedHotkeyKey` / `isValidHotkeyText` / `normalizeHotkeyText` 由 `config.ts` 导出。
- `normalizeHotkeyText` 把修饰键顺序统一为 `ctrl`→`alt`→`shift`→`meta`；**非法输入一律返回 `fallback``。
- **API 层**（`config-store.ts`）：`hotkey` / `panelHotkey` 非法 → **400** + 字段级错误文案（不静默改值）。
- **加载层**：配置文件里已有的非法值 → 读成默认快捷键，**绝不原样生效**。
- **浏览器半捕获**（`comboFromEvent`）：只按修饰键 / 不在白名单 / 无修饰键 → 一律继续等待，不污染配置。

### 14.4 回归要求

- 纯函数层：`clear`、`a`、`ctrl`、`ctrl+clear`、`delete`、`ctrl+alt+shift`、`f13+f14`、`ctrl+alt+` 全部不合法；
  `ctrl+alt+s`、`control+shift+F5`（→`ctrl+shift+f5`）、` Shift+Control+p `（→`ctrl+shift+p`）、`meta+space` 合法。
- 加载层：`normalizeHotkeyText("clear")` === `"ctrl+alt+s"`；`normalizeHotkeyText("clear", "FALLBACK")` === `"FALLBACK"`。
- API 层（探针已证，见交付说明）：`PUT {hotkey:"clear"}` 与 `{panelHotkey:"clear"}` → 400；
  `PUT {hotkey:"Shift+Control+p"}` → 归一为 `ctrl+shift+p`。
- **`ui` 支持子键部分更新**：`PUT` 的 `ui` 可只带被改的那一个子键，不必整包覆盖
  （避免并发改动被各自的陈旧整包互相覆盖）。
- 新增 CSS 类名清单（纯增量，未改任何既有类）：`.dsa-field`、`.dsa-label`、`.dsa-input`、
  `.dsa-switch`、`.dsa-save`、`.dsa-hint`、`.dsa-sidebar-action`，以及
  `.dsa-inline`、`.dsa-settings`、`.dsa-error`、`.dsa-group`、`.dsa-group-title`、
  `.dsa-status`、`.dsa-fields`、`.dsa-hint--warn|ok|error`、`.dsa-badge--off`、
  `.dsa-sidebar-action-icon|label|hint|--collapsed`。
  注意 `.dsa-root`（`shell.overlay` 的全屏 fixed 容器）**绝不能**嵌进设置弹窗；
  设置页用自己的普通流式容器 `.dsa-inline`，同样声明 §8 的六个变量与 `data-dsa-scheme`。
