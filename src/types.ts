/**
 * dsh-task-alerts —— 共享类型与常量（仅类型/常量，无运行时副作用）。
 *
 * 关键决策：宿主半与浏览器半各自**本地**声明同一套契约类型（见 CONTRACT §3），
 * 两半都不 import 任何 `@deepseek-ai/*`，因此这里只声明自己用得到的结构类型。
 * `CordisContext` 故意把每一项能力都标成可选：能力探测（CONTRACT §9）在类型
 * 层面就成立，调用点必须继续用可选链收窄，而不是靠 `!` 断言。
 */

// ---------- CONTRACT §3 ----------

export type AlertKind = 'unresolved' | 'finish'
export type AlertLevel = 'error' | 'success' | 'info'

/** CONTRACT §11.5：报告写盘后自动打开的方式。 */
export type ReportAutoOpen = 'none' | 'file' | 'folder' | 'browser'

/** 打开器实际打开的目标类别（*folder* 模式下路径是所在目录）。 */
export type OpenMode = 'file' | 'folder' | 'url'

/**
 * CONTRACT §11.4 要求打开器**可注入**，否则冒烟测试会真的弹出窗口。
 * 注入点签名固定为 `(path, mode, command, args) => 是否成功发起`：
 * 前两个参数是「打开了什么、以什么方式」，后两个是真实要跑的命令行。
 */
export type OpenRunner = (path: string, mode: OpenMode, command: string, args: string[]) => boolean

/** 一次打开的完整计划；由 `Opener.plan()` 纯函数产出，便于断言。 */
export interface OpenPlan {
  mode: OpenMode
  /** 被打开的目标绝对路径（url 模式下是 file:// URL） */
  path: string
  command: string
  args: string[]
}

export interface OpenerOptions {
  log: PluginLogger
  /** 缺省时使用 detached spawn 的系统默认处理器 */
  runner?: OpenRunner
  /** 缺省 `process.platform`；仅用于测试不同平台分支 */
  platform?: string
}

export interface UiConfig {
  /** px, 默认 10 */
  blurStrength: number
  /** 默认 '#87CEEB' */
  primaryColor: string
  /** px, 默认 20 */
  borderRadius: number
  /** 0..1, 默认 0.7 */
  opacity: number
}

export interface AlertStateConfig {
  /** 归一化小写 'ctrl+alt+s' */
  hotkey: string
  ui: UiConfig
  programFinishAlert: boolean
  alertOnUnresolved: boolean
  maxAttempts: number
  /** 已解析为绝对路径 */
  reportDir: string
  /** CONTRACT §11.1：两次响铃间隔（秒）；0 = 只响一次 */
  repeatInterval: number
  /** CONTRACT §11.1：最多重复次数；0 = 不限（响到关闭） */
  repeatMax: number
  /** CONTRACT §11.1：报告写盘后自动打开的方式；非法值归 'none' */
  reportAutoOpen: ReportAutoOpen
  /** CONTRACT §13.2：打开/收起提醒面板的快捷键（已归一化小写，如 'ctrl+alt+a'） */
  panelHotkey: string
  /** CONTRACT §13.2：无待处理提醒时是否仍保留一个「收起态」入口 */
  showPill: boolean
}

export interface AlertRecord {
  /** 'al_<n>' */
  id: string
  kind: AlertKind
  level: AlertLevel
  title: string
  message: string
  problemId?: string
  attempts?: number
  maxAttempts?: number
  reportPath?: string
  /** ISO-8601 */
  createdAt: string
  /** 该条提醒是否已触发音效 */
  audio: boolean
  dismissed: boolean
}

export interface AlertState {
  revision: number
  generatedAt: string
  config: AlertStateConfig
  stats: { problems: number; unresolved: number; alerts: number }
  audioPlaying: boolean
  /** CONTRACT §11.2：当前是否处于响铃循环中 */
  repeatActive: boolean
  /** CONTRACT §11.2：本轮已重复次数（首次播放不计入） */
  repeatCount: number
  /**
   * CONTRACT §13.3：宿主每收到一次「打开面板」的全局快捷键就 +1，只增不减。
   * 浏览器半拿它当「展开面板」的信号（记录已见值，不重复展开）。
   */
  panelOpenSeq: number
  /** 最新在前，最多 20 条 */
  alerts: AlertRecord[]
}

// ---------- §12：可写配置 ----------

/**
 * §12.5：设置界面能读能改的全部字段（线上 camelCase；落盘时映射回 §6 的 snake_case）。
 * `logFile` 刻意不在这里（日志基建：改它等于换正在写的文件）。
 * `maxAttempts` 自 v1.4 起**在这里**——早先排除它的理由是「只在下次加载时生效」，但那是错的：
 * 判定用的是活配置（每次尝试都读 `this.config.maxAttempts`），所以热改立即生效。
 */
export interface EditableConfig {
  /** 已解析的绝对路径 */
  audioPath: string
  enabled: boolean
  /** 归一化小写，如 'ctrl+alt+s' */
  hotkey: string
  /** 同一问题连续失败多少次判定为「无法解决（卡住）」；>= 1 */
  maxAttempts: number
  programFinishAlert: boolean
  alertOnUnresolved: boolean
  /** 已解析的绝对路径 */
  reportDir: string
  reportAutoOpen: ReportAutoOpen
  /** 响铃间隔（秒）；0 = 只响一次 */
  repeatInterval: number
  /** 重复上限；0 = 不限 */
  repeatMax: number
  /** CONTRACT §13.2：打开/收起面板的快捷键（归一化小写） */
  panelHotkey: string
  /** CONTRACT §13.2：是否保留收起态把手（false = 关了就没） */
  showPill: boolean
  ui: UiConfig
}

/** `PUT /task-alerts/config` 的请求体：**部分** EditableConfig，`ui` 自身也可部分。 */
export interface EditablePatch extends Partial<Omit<EditableConfig, 'ui'>> {
  ui?: Partial<UiConfig>
}

/** 校验错误表：`键名 → 理由`（`body` 表示整个请求体不合格）。 */
export interface ConfigErrors {
  [key: string]: string
}

export type ConfigValidation = { ok: true; patch: EditablePatch } | { ok: false; errors: ConfigErrors }

export interface ConfigUpdateSuccess {
  ok: true
  applied: true
  config: EditableConfig
  state: AlertState
}

export interface ConfigUpdateFailure {
  ok: false
  /** 400 = 校验失败；500 = 运行时生效或落盘失败（此时已回滚） */
  status: 400 | 500
  error: string
  errors?: ConfigErrors
}

export type ConfigUpdateResult = ConfigUpdateSuccess | ConfigUpdateFailure

/** CONTRACT §4 的请求体。 */
export interface ControlRequest {
  action?: 'stop-audio' | 'test-alert' | 'dismiss' | 'open-report'
  alertId?: string
}

/** CONTRACT §5：暴露给宿主的服务形状。 */
export interface TaskAlertsService {
  recordAttempt(input: RecordAttemptInput): Promise<RecordAttemptResult>
  recordProgramFinish(input?: RecordProgramFinishInput): Promise<{ alerted: boolean }>
  stopAudio(): boolean
  test(): Promise<AlertState>
  getState(): AlertState
  /** §12：读取可写配置（`GET /task-alerts/config` 的 `config`）。 */
  getConfig(): EditableConfig
  dismiss(alertId: string): boolean
  /** CONTRACT §11.4：用系统默认处理器打开该 alert 的报告。 */
  openReport(alertId: string): boolean
}

export interface RecordAttemptInput {
  problemId: string
  description?: string
  thought?: string
  error?: string
  solved: boolean
  source?: string
}

export interface RecordAttemptResult {
  attempts: number
  unresolved: boolean
  reportPath?: string
}

export interface RecordProgramFinishInput {
  label?: string
  ok?: boolean
  detail?: string
}

// ---------- 宿主半内部数据结构 ----------

/** 报告里的一次尝试记录（内部使用，不是契约类型）。 */
export interface AttemptRecord {
  /** ISO-8601 */
  at: string
  thought?: string
  error?: string
  source?: string
}

/** 一份问题的完整报告载荷。 */
export interface ProblemReport {
  problemId: string
  description: string
  finalStatus: string
  attempts: AttemptRecord[]
  maxAttempts: number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 宿主半统一日志出口；实现必须自己吞掉写盘异常（CONTRACT §9）。 */
export interface PluginLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string, cause?: unknown): void
}

// ---------- 配置（CONTRACT §6） ----------

/** 扁平键名的原始配置片段（YAML / JSON / cordis 行 config 三处同形）。 */
export interface RawConfig {
  audio_path?: string
  report_dir?: string
  max_attempts?: number
  stop_hotkey?: string
  program_finish_alert?: boolean
  alert_on_unresolved?: boolean
  /** §12：总开关。false = 不出声、不进响铃循环、不弹面板/Toast（报告照常写盘） */
  enabled?: boolean
  log_file?: string
  /** CONTRACT §11.1：响铃间隔（秒） */
  repeat_interval?: number
  /** CONTRACT §11.1：重复上限，0 = 不限 */
  repeat_max?: number
  /** CONTRACT §11.5：none | file | folder | browser */
  report_auto_open?: string
  /** CONTRACT §13.2：打开/收起提醒面板的快捷键 */
  panel_hotkey?: string
  /** CONTRACT §13.2：是否保留收起态把手 */
  show_pill?: boolean
  ui?: Partial<UiConfig> | Record<string, unknown>
}

/**
 * `loadConfig()` 的返回形状：`AlertStateConfig` 的字段原样保留（可直接进 `AlertState.config`），
 * 再加宿主半自己需要的路径与非契约开关。
 */
export interface HostConfig extends AlertStateConfig {
  /** §12：总开关。false = 提醒声/面板/Toast 全部静默（报告与 HTTP 接口照常） */
  enabled: boolean
  /** 已解析的绝对路径（文件可能不存在 → 记录日志并静默降级） */
  audioPath: string
  /** 已解析的绝对路径 */
  logFile: string
  /** 已解析的绝对路径；可写判定失败时回退到 <DSH_HOME>/dsh-task-alerts */
  baseDir: string
  /** 原始 hotkey 字符串，便于日志里对照用户输入 */
  programFinishAlertRaw: boolean
  /** 解析过程说明（实际命中的配置来源），写进启动日志 */
  sources: string[]
}

// ---------- 音频 ----------

export type AudioBackendName =
  | 'node-wav-player'
  | 'play-sound'
  | 'win32:SoundPlayer'
  | 'darwin:afplay'
  | 'linux:paplay'
  | 'linux:aplay'
  | 'none'

export interface AudioPlayerOptions {
  file: string
  log: PluginLogger
  /** 强制指定后端，仅用于诊断；正常路径走自动探测 */
  prefer?: AudioBackendName
}

/** `AlertsService` 需要的音频能力；`AudioPlayer` 结构上满足，因此能被观测器包一层而不改 audio.ts。 */
export interface AudioHandle {
  startRepeat(intervalMs: number, max: number): boolean
  stop(): boolean
  stopRepeat(): boolean
  isPlaying(): boolean
  isRepeating(): boolean
  readonly repeatCountValue: number
  dispose(): void
}

/** 音频边界的观测记录（`audioProbe` 测试注入用，与 §11.4 的 `openRunner` 是同一类缝）。 */
export interface AudioCall {
  method: 'startRepeat' | 'stop' | 'stopRepeat' | 'dispose'
  /** 当时的目标音频文件（`PUT audioPath` 后立即反映新值） */
  file: string
  intervalMs?: number
  max?: number
}

export type AudioObserver = (call: AudioCall) => void

// ---------- 快捷键 ----------

export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta'

export interface HotkeyCombo {
  /** 归一化后的键名（小写、无空格别名），如 's'、'f5'、'space' */
  key: string
  modifiers: ModifierName[]
  /** 归一化回写形式，如 'ctrl+alt+s' */
  text: string
}

/** `matchesHotkey` 接受的事件形状：浏览器 keydown 与 node-global-key-listener 事件都能套上。 */
export interface HotkeyEventLike {
  key?: string
  code?: string
  /** node-global-key-listener 的 `name`（'LEFT CTRL' / 'S' / ...） */
  name?: string
  /** node-global-key-listener 的 `state` */
  state?: string
  /** 浏览器修饰键标志 */
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  /** 累积按下集合（node-global-key-listener 侧由 HotkeyListener 维护） */
  pressed?: ReadonlySet<string> | readonly string[]
}

// ---------- 动态加载的第三方模块（结构性声明，避免 import 不存在的包） ----------

export interface WavPlayerModule {
  play(options: { path: string }): Promise<void> | void
  stop(): void
}

export interface PlaySoundPlayer {
  play(file: string, callback?: (err: Error | null) => void): unknown
  kill?(): void
  stop?(): void
}

export interface PlaySoundModule {
  (file: string, callback?: (err: Error | null) => void): PlaySoundPlayer
  default?: PlaySoundModule
}

export interface GlobalKeyListenerModule {
  GlobalKeyboardListener?: new (config?: unknown) => GlobalKeyboardListenerLike
}

export interface GlobalKeyboardListenerLike {
  addListener(listener: (event: GlobalKeyEventLike, isDown: unknown) => void | Promise<void>): Promise<void>
  removeListener(listener: (event: GlobalKeyEventLike, isDown: unknown) => void | Promise<void>): void
  kill(): void
}

export interface GlobalKeyEventLike {
  vKey?: number
  name?: string
  state?: 'DOWN' | 'UP' | string
  _raw?: string
  rawKey?: { _nameRaw?: string; name?: string }
}

// ---------- Cordis / DSH 上下文（结构类型） ----------

export interface CommandInvocationLike {
  commandId?: unknown
  agent?: unknown
  rawInput?: string
  attachments?: readonly unknown[]
  signal?: AbortSignal
}

/** 与 dsh-commands 的 `CommandResult` 同形（`{kind:'success'|'error', text?}`）。 */
export type CommandResultLike =
  | { kind: 'success'; text?: string; sourceEventSeq?: unknown }
  | { kind: 'error'; text: string }

export interface CommandDefinitionLike {
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
  recordInput?: boolean
  handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

export interface CommandRuntimeLike {
  register(definition: CommandDefinitionLike): () => void
}

/** 与 dsh-host-webserver 的 `WebRoute` 同形。 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: WebRequestLike, res: WebResponseLike) => void | Promise<void>
}

export interface WebRequestLike {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface WebResponseLike {
  statusCode: number
  setHeader?(name: string, value: string): void
  end?(chunk?: string): void
  write?(chunk?: string): unknown
}

export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

export interface CordisContext {
  logger?: unknown
  commands?: CommandRuntimeLike
  webServer?: WebServerLike
  on?(name: string, listener: (...args: unknown[]) => unknown): unknown
  effect?(callback: () => void | Promise<void>): unknown
  set?(name: string, value: unknown): unknown
  taskAlerts?: unknown
  [key: string]: unknown
}

/** `ctx.effect` 回调收到的 disposer 服务。 */
export interface EffectScope {
  collect?: (dispose: () => void) => void
}
