/**
 * dsh-task-alerts —— 宿主半入口（Cordis 插件）。
 *
 * 装配顺序：logger → config → 状态仓库 → audio → opener → reporter → adapter → hotkey
 *          → commands（alert-stop / alert-test）→ webServer（两条 exact 路由）
 *          → ctx.taskAlerts 服务 → 清理（ctx.effect 或 ctx.on('dispose')）。
 *
 * 关键决策：
 *  1. 同时满足两种加载形态：命名导出 `name` / `inject` / `apply`，外加 default 对象导出。
 *     `inject = []`：webServer / commands 都走**运行时能力探测**，这样缺 HTTP 服务的
 *     profile 仍能加载并降级为「音效 + 报告」（CONTRACT §4 与 cordis.patch.yml 的注释）。
 *  2. 不 import 任何 `@deepseek-ai/*`：上下文是 `src/types.ts` 里的结构类型，
 *     `ctx.*` 一律可选链 + 类型收窄，缺失只记日志。
 *  3. 状态模型：`alerts` 是**最新在前、最多 20 条**的环形缓冲；按 problemId 维护
 *     尝试计数与尝试明细；`revision` 单调递增，供浏览器半轮询判重。
 *  4. 去重（CONTRACT §9）：同一 problemId 只写一次报告；是否「已报告」由 Reporter 的
 *     内存 Set + `<report_dir>/.reported.json` 决定，所以报告只生成一次，并且**已有的
 *     unresolved 提醒不再重复推送**（revision 因此不会因重复尝试而无意义地增长）。
 *  5. 日志：追加写 `log_file`；写失败降级 `console`，且降级路径不再尝试写盘，
 *     避免「写日志失败 → 记日志 → 又失败」的递归。
 *  6. 所有回调边界（事件监听、HTTP 处理器、命令处理器、快捷键回调）都 try/catch，
 *     异常绝不允许冒泡到宿主进程（CONTRACT §9）。
 *  7. v1.1（CONTRACT §11）：任何「因提醒而播声」的路径（unresolved / 程序结束 /
 *     test-alert）都改为 `audio.startRepeat()`，即立即播 1 次 + 每 `repeat_interval`
 *     秒重播；`/alert-stop`、control `stop-audio`、任何 `dismiss`、插件卸载都终止循环。
 *  8. 打开报告走**可注入的 `Opener`**：正常路径是 detached spawn 系统默认处理器，
 *     冒烟脚本通过 `apply(ctx, config)` 第二参数上的 `openRunner` 函数注入记录用的
 *     runner（YAML/JSON 永远解析不出函数，所以生产配置不受影响），从而不会真的弹窗。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AlertAdapter, adapterEventNames } from './adapter.js'
import { AudioPlayer } from './audio.js'
import { loadConfig, DEFAULTS, normalizeHotkeyText, resolveAgainst, userConfigPath } from './config.js'
import { editableFromHost, mergeEditable, serializeUserConfig, validateConfigPatch, writeUserConfig } from './config-store.js'
import { HotkeyListener, normalizeHotkey, stopAllHotkeys } from './hotkey.js'
import type { HotkeyBinding, HotkeyListenerOptions, HotkeyServerFactory } from './hotkey.js'
import { Opener } from './opener.js'
import { Reporter, sanitizeProblemId } from './reporter.js'
import type {
  AlertRecord,
  AlertState,
  AudioCall,
  AudioHandle,
  AudioObserver,
  CommandDefinitionLike,
  CommandResultLike,
  ConfigUpdateResult,
  ControlRequest,
  CordisContext,
  EditableConfig,
  EditablePatch,
  EffectScope,
  HostConfig,
  OpenRunner,
  PluginLogger,
  ProblemReport,
  RawConfig,
  RecordAttemptInput,
  RecordAttemptResult,
  RecordProgramFinishInput,
  TaskAlertsService,
  WebRequestLike,
  WebResponseLike,
} from './types.js'
// 类型再导出，方便宿主与两半的消费者按需引用契约类型（`types.ts` 是类型-only 模块）。
export type {
  AlertKind,
  AlertLevel,
  AlertRecord,
  AlertState,
  AlertStateConfig,
  AttemptRecord,
  HostConfig,
  OpenMode,
  OpenPlan,
  OpenRunner,
  ProblemReport,
  RecordAttemptInput,
  RecordAttemptResult,
  RecordProgramFinishInput,
  ReportAutoOpen,
  TaskAlertsService,
  UiConfig,
} from './types.js'

export const name = 'task-alerts'
/**
 * 这两个服务**必须声明**，不能靠运行时探测。
 *
 * Cordis 4 在 `ctx.commands` / `ctx.webServer` 这类**服务属性**的 getter 上做硬校验：
 * 未在 `inject` 中声明就直接抛 `cannot get property "x" without inject`
 * （cordis/lib/index.js:676），而且是同步抛出，等于整条宿主行装配失败——
 * 线上实测后果：命令与路由全部没注册，浏览器半永远轮询 404，UI 完全不出现。
 *
 * 注意 Cordis 4 **没有**「可选依赖」这种声明：`Inject` 的对象形式里键名就是服务名、
 * 值是该服务的拦截配置（cordis/lib/types/registry.d.ts:13），所以声明即必需。
 * 真要做可选读取，用 `ctx.get(name)`（reflect.d.ts:14，「without the inject requirement」）。
 */
export const inject: string[] = ['commands', 'webServer']

/** 供冒烟脚本 / 诊断使用：一次性停掉本进程所有 OS 级快捷键监听。 */
export { stopAllHotkeys }

export const PLUGIN_NAME = 'task-alerts'
const MAX_ALERTS = 20
const MAX_ATTEMPT_DETAILS_PER_PROBLEM = 10
const LOG_PREFIX = `[${PLUGIN_NAME}]`

// ---------- 日志 ----------

interface LoggerSink {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/**
 * 统一日志出口：先追加写 `log_file`，失败则永久降级到 console（并只说明一次）。
 */
function createLogger(logFile: string, sink: LoggerSink | null): PluginLogger {
  let fileBroken = false
  let degradedReported = false
  let dirReady = false

  const format = (level: string, message: string): string => `${new Date().toISOString()} [${level}] ${LOG_PREFIX} ${message}`

  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, cause?: unknown): void => {
    const line = cause === undefined ? format(level, message) : format(level, `${message} —— ${describe(cause)}`)
    if (!fileBroken) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(logFile), { recursive: true })
          dirReady = true
        }
        appendFileSync(logFile, `${line}\n`, 'utf8')
      } catch {
        // 写盘失败：降级 console，并停止后续写盘尝试（避免递归报错）。
        fileBroken = true
        if (!degradedReported) {
          degradedReported = true
          emitConsole('warn', `${line} —— 日志文件不可写（${logFile}），后续日志仅输出到 console`)
        }
      }
    }
    emitConsole(level, line)
  }

  const emitConsole = (level: string, line: string): void => {
    const target = sink ?? globalThis.console
    try {
      if (level === 'error') (target.error ?? target.info)?.call(target, line)
      else if (level === 'warn') (target.warn ?? target.info)?.call(target, line)
      else (target.info ?? target.debug)?.call(target, line)
    } catch {
      /* console 也失败就只能放弃 */
    }
  }

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message, cause) => write('error', message, cause),
  }
}

/** cordis 的 `ctx.logger` 既可能是实例也可能是 `ctx.logger(name)` 工厂。 */
function pickLoggerSink(ctx: CordisContext): LoggerSink | null {
  const candidate = ctx.logger
  try {
    if (typeof candidate === 'function') {
      const created = (candidate as (scope: string) => unknown).call(ctx, PLUGIN_NAME)
      return asSink(created)
    }
  } catch {
    /* 形状不符：退回 console */
  }
  return asSink(candidate)
}

function asSink(value: unknown): LoggerSink | null {
  if (!value || typeof value !== 'object') return null
  return value as LoggerSink
}

function describe(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------- 状态仓库 + 服务 ----------

interface ProblemEntry {
  description: string
  attempts: number
  attemptDetails: ProblemReport['attempts']
  unresolved: boolean
  reported: boolean
}

/** `pushAlert` / `emitAlert` 共用的入参（两者是同一件事的两个层次：闸内 / 闸外）。 */
interface AlertPushInput {
  kind: AlertRecord['kind']
  level: AlertRecord['level']
  title: string
  message: string
  problemId?: string
  attempts?: number
  reportPath?: string
  api?: RecordAttemptInput
}

interface EmitOptions {
  /** 用户显式路径（§12.8.1 的 test-alert）：绕过 `enabled` 总开关 */
  bypassMasterSwitch?: boolean
  /** 'skip' = 调用方已经自己播过声（test-alert 要先拿到 played 再写文案） */
  audio?: 'play' | 'skip'
}

class AlertsService implements TaskAlertsService {
  /** §12：可写配置就地热改，所以不是 readonly（所有改动都经 `applyEditable`）。 */
  private config: HostConfig
  private readonly log: PluginLogger
  /** §12：`audioPath` 可热替换；未注入观测器时它就是 AudioPlayer 本身。 */
  private audio: AudioHandle | null = null
  /** §12：`reportDir` 可热替换（Reporter.reportDir 是构造期只读字段，只能换实例）。 */
  private reporter: Reporter
  private readonly opener: Opener
  private readonly observeAudio: AudioObserver | null
  private readonly onRevision: () => void
  private readonly problems = new Map<string, ProblemEntry>()
  private alerts: AlertRecord[] = []
  private alertSeq = 0
  private revision = 0
  /**
   * CONTRACT §13.3：全局「打开面板」快捷键的计数器，初始 0、只增不减。
   * 浏览器半把它与已见值比较，变大就展开面板（因此**不能**用 revision 顶替它：
   * 那是提醒内容的变化，语义完全不同）。
   */
  private panelOpenSeq = 0

  constructor(options: {
    config: HostConfig
    log: PluginLogger
    reporter: Reporter
    opener: Opener
    observeAudio: AudioObserver | null
    onRevision: () => void
  }) {
    this.config = options.config
    this.log = options.log
    this.reporter = options.reporter
    this.opener = options.opener
    this.observeAudio = options.observeAudio
    this.onRevision = options.onRevision
    // 音频句柄由服务自己创建：§12 的 audioPath 要能热替换，句柄必须由持有者重建。
    this.audio = this.createAudio(this.config.audioPath)
  }

  /** 记录一次尝试；达到 maxAttempts 且未解决时生成报告并推送提醒。 */
  async recordAttempt(input: RecordAttemptInput): Promise<RecordAttemptResult> {
    const rawId = typeof input.problemId === 'string' ? input.problemId : ''
    const problemId = rawId.trim().length > 0 ? rawId.trim() : 'unknown-problem'
    const solved = input.solved === true
    const prepared = this.reporter.prepareAttempt({
      problemId,
      description: input.description,
      thought: input.thought,
      error: input.error,
      source: input.source,
    })

    const entry = this.problems.get(problemId) ?? {
      description: prepared.description,
      attempts: 0,
      attemptDetails: [],
      unresolved: false,
      reported: false,
    }
    entry.attempts += 1
    if (prepared.description.length > 0 && prepared.description !== '(未提供问题描述)') {
      entry.description = prepared.description
    }
    entry.attemptDetails.push({
      at: prepared.at,
      ...(prepared.thought !== undefined ? { thought: prepared.thought } : {}),
      ...(prepared.error !== undefined ? { error: prepared.error } : {}),
      ...(prepared.source !== undefined ? { source: prepared.source } : {}),
    })
    if (entry.attemptDetails.length > MAX_ATTEMPT_DETAILS_PER_PROBLEM) {
      entry.attemptDetails.splice(0, entry.attemptDetails.length - MAX_ATTEMPT_DETAILS_PER_PROBLEM)
    }

    let reportPath: string | undefined
    let changed = false

    if (solved) {
      if (!entry.unresolved && entry.attempts > 1) {
        changed =
          this.emitAlert({
            kind: 'finish',
            level: 'success',
            title: '问题已解决',
            message: `${problemId} 在第 ${entry.attempts} 次尝试后成功`,
            problemId,
            attempts: entry.attempts,
            api: input,
          }) !== null
      }
      entry.unresolved = false
    } else if (entry.attempts >= this.config.maxAttempts && !entry.reported) {
      entry.unresolved = true
      if (!this.isEnabled()) {
        // §12.8.2：总开关关闭时连报告一起停。**计数照常、`reported` 不置位**，
        // 所以重新开启后同一个问题仍能在下一次尝试时补上报告（历史计数不丢）。
        this.log.info(
          `enabled=false：问题 ${problemId} 已达上限（第 ${entry.attempts} 次），按总开关不生成报告、不提醒、不自动打开`,
        )
      } else {
        const report = this.buildReport(problemId, entry)
        const written = this.reporter.writeReport(report)
        if (written.path !== null) {
          reportPath = written.path
          // CONTRACT §11.5：只在报告**成功写盘之后**自动打开。
          this.autoOpenReport(written.path)
        }
        entry.reported = true
        if (this.config.alertOnUnresolved) {
          changed =
            this.emitAlert({
              kind: 'unresolved',
              level: 'error',
              title: '问题未解决',
              message: `「${problemId}」连续 ${this.config.maxAttempts} 次尝试失败`,
              problemId,
              attempts: entry.attempts,
              reportPath,
              api: input,
            }) !== null
        } else {
          this.log.info(`alert_on_unresolved=false，问题 ${problemId} 仅生成报告不发提醒`)
        }
      }
    } else if (entry.attempts >= this.config.maxAttempts) {
      entry.unresolved = true
    }

    this.problems.set(problemId, entry)
    if (changed) this.touch()

    const result: RecordAttemptResult = {
      attempts: entry.attempts,
      unresolved: entry.unresolved,
    }
    if (reportPath !== undefined) result.reportPath = reportPath
    return result
  }

  /** 记录一次程序/回合结束；按配置决定是否响铃 + 弹 Toast。 */
  async recordProgramFinish(input?: RecordProgramFinishInput): Promise<{ alerted: boolean }> {
    if (!this.config.programFinishAlert) return { alerted: false }
    const ok = input?.ok !== false
    const label = typeof input?.label === 'string' && input.label.length > 0 ? input.label : '任务'
    const detail = typeof input?.detail === 'string' && input.detail.length > 0 ? input.detail : ''
    const alert = this.emitAlert({
      kind: 'finish',
      level: ok ? 'success' : 'error',
      title: ok ? '程序执行完成' : '程序执行失败',
      message: detail.length > 0 ? `${label}：${detail}` : label,
    })
    if (alert === null) return { alerted: false }
    this.touch()
    return { alerted: true }
  }

  stopAudio(): boolean {
    // CONTRACT §11.3：停止音效同时终止响铃循环（`/alert-stop` 与 control stop-audio 共用）。
    const stoppedRepeat = this.stopRepeatSafe()
    const stoppedHandle = this.audio?.stop() === true
    this.touch()
    return stoppedHandle || stoppedRepeat
  }

  /** 诊断入口：停止当前音效（含循环）并推一条 info 提醒，返回最新状态。 */
  async test(): Promise<AlertState> {
    try {
      this.audio?.stop()
    } catch (error) {
      this.log.warn(`测试前停止音效失败：${describe(error)}`)
    }
    // CONTRACT §11.3：test-alert 也必须进循环，用户靠它验证「响到关闭」。
    // §12.8.1：test-alert 是用户**显式发起**的预览，绕过 enabled 总开关（设置页的「试听」按钮
    // 靠它诊断 audioPath）。音频由本方法先发起，所以 emitAlert 用 'skip' 避免重复播放。
    const played = this.startRepeatAudio(true)
    this.emitAlert(
      {
        kind: 'finish',
        level: 'info',
        title: '测试提醒',
        message: played ? '已触发测试提醒并尝试播放音效' : '已触发测试提醒（音效不可用，仅 UI）',
      },
      { bypassMasterSwitch: true, audio: 'skip' },
    )
    this.touch()
    return this.getState()
  }

  getState(): AlertState {
    const unresolved = [...this.problems.values()].filter((entry) => entry.unresolved).length
    let audioPlaying = false
    let repeatActive = false
    let repeatCount = 0
    try {
      audioPlaying = this.audio?.isPlaying() === true
      repeatActive = this.audio?.isRepeating() === true
      repeatCount = this.audio?.repeatCountValue ?? 0
    } catch (error) {
      audioPlaying = false
      repeatActive = false
      repeatCount = 0
      this.log.debug(`读取音频状态失败：${describe(error)}`)
    }
    return {
      revision: this.revision,
      generatedAt: new Date().toISOString(),
      config: {
        hotkey: this.config.hotkey,
        panelHotkey: this.config.panelHotkey,
        showPill: this.config.showPill,
        ui: { ...this.config.ui },
        programFinishAlert: this.config.programFinishAlert,
        alertOnUnresolved: this.config.alertOnUnresolved,
        maxAttempts: this.config.maxAttempts,
        reportDir: this.config.reportDir,
        repeatInterval: this.config.repeatInterval,
        repeatMax: this.config.repeatMax,
        reportAutoOpen: this.config.reportAutoOpen,
      },
      stats: { problems: this.problems.size, unresolved, alerts: this.alerts.length },
      audioPlaying,
      repeatActive,
      repeatCount,
      panelOpenSeq: this.panelOpenSeq,
      alerts: this.alerts.map((alert) => ({ ...alert })),
    }
  }

  /**
   * CONTRACT §13.3/§13.5：宿主收到一次「打开面板」的全局快捷键。
   *
   * 只做计数器 +1（**不改 revision**）：浏览器半每秒轮询 state，发现 `panelOpenSeq`
   * 比已见值大就展开面板。返回新的 seq，便于调用方记日志。
   */
  notifyPanelOpen(): number {
    this.panelOpenSeq += 1
    return this.panelOpenSeq
  }

  /**
   * CONTRACT §11.4：用系统默认处理器打开某条提醒的报告。
   * 缺 alertId / 未知 alertId / 该 alert 无 reportPath / 打开失败都返回 false。
   */
  openReport(alertId: string): boolean {
    const target = this.findAlert(alertId)
    if (target === undefined) return false
    const reportPath = target.reportPath
    if (typeof reportPath !== 'string' || reportPath.length === 0) return false
    const opened = this.opener.openReportFile(reportPath)
    this.log.info(`打开报告 ${alertId}：${reportPath} → ${opened ? '已发起' : '失败'}`)
    return opened
  }

  /**
   * CONTRACT §11.3：**任何** dismiss 都停响铃——即使该 alertId 已经不在缓冲里
   * （用户按下的就是「别响了」），因此先停循环，再判 alert 是否存在。
   */
  dismiss(alertId: string): boolean {
    if (typeof alertId !== 'string' || alertId.length === 0) return false
    const stoppedRepeat = this.stopRepeatSafe()
    const stoppedHandle = this.audio?.stop() === true
    const target = this.alerts.find((alert) => alert.id === alertId)
    if (target === undefined) {
      if (stoppedRepeat || stoppedHandle) this.touch()
      return false
    }
    if (!target.dismissed) {
      target.dismissed = true
      this.touch()
    } else if (stoppedRepeat || stoppedHandle) {
      this.touch()
    }
    return true
  }

  // ---------- §12：可写配置 ----------

  /** 可写配置的当前值（`GET /task-alerts/config` 的 `config`）。 */
  getConfig(): EditableConfig {
    return editableFromHost(this.config)
  }

  /** 总开关。字段缺失（非本插件构造的 HostConfig）按「开」处理，绝不因为缺字段而静默。 */
  private isEnabled(): boolean {
    return this.config.enabled !== false
  }

  /**
   * §12.4：把一份**完整**可写配置应用到运行时。幂等——回滚就是用旧值再调一次。
   *
   * 先做预检（报告目录必须可创建）：预检失败时**一个字段都还没改**，调用方可以放心回滚。
   * 任何异常都收敛成 `{ok:false}`，绝不冒泡（§9）。
   */
  applyEditable(next: EditableConfig): { ok: true } | { ok: false; error: string } {
    try {
      // 预检：报告目录建不出来 = 「配置写进去了但实际不生效」，必须在这里就失败。
      mkdirSync(next.reportDir, { recursive: true })
    } catch (error) {
      return { ok: false, error: `报告目录不可用（${next.reportDir}）：${describe(error)}` }
    }
    try {
      const previous = this.getConfig()
      this.config.audioPath = next.audioPath
      this.config.enabled = next.enabled
      this.config.hotkey = next.hotkey
      this.config.panelHotkey = next.panelHotkey
      this.config.showPill = next.showPill
      this.config.programFinishAlert = next.programFinishAlert
      this.config.alertOnUnresolved = next.alertOnUnresolved
      this.config.reportAutoOpen = next.reportAutoOpen
      this.config.reportDir = next.reportDir
      this.config.repeatInterval = next.repeatInterval
      this.config.repeatMax = next.repeatMax
      this.config.ui = { ...next.ui }
      // audioPath：换掉 AudioPlayer 的目标文件（旧句柄连同它的响铃循环一起释放）。
      if (next.audioPath !== previous.audioPath) this.swapAudio(next.audioPath)
      // reportDir：换掉 Reporter 实例（reportDir 是构造期只读字段）。
      if (next.reportDir !== previous.reportDir) this.swapReporter(next.reportDir)
      // 总开关关闭 → 立刻静音；否则按新参数重排正在进行的响铃循环。
      if (!next.enabled) this.hush()
      else if (next.repeatInterval !== previous.repeatInterval || next.repeatMax !== previous.repeatMax) {
        this.rescheduleRing()
      }
      this.touch()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `应用配置失败：${describe(error)}` }
    }
  }

  /** 建立音频句柄；注入了 `audioProbe` 就包一层观测器（生产不注入 → 零包装）。 */
  private createAudio(file: string): AudioHandle | null {
    try {
      const player = new AudioPlayer({ file, log: this.log })
      return this.observeAudio === null ? player : new ObservedAudio(player, file, this.observeAudio)
    } catch (error) {
      this.log.error('创建音频播放器失败（音效降级）', error)
      return null
    }
  }

  private swapAudio(file: string): void {
    const previous = this.audio
    this.audio = this.createAudio(file)
    try {
      // dispose 内部会终止响铃循环 + 停当前播放。
      previous?.dispose()
    } catch (error) {
      this.log.debug(`释放旧音频句柄失败：${describe(error)}`)
    }
    this.log.info(`音频目标文件已切换：${file}`)
  }

  private swapReporter(reportDir: string): void {
    try {
      this.reporter = new Reporter({ reportDir, log: this.log })
      this.log.info(`报告目录已切换：${reportDir}`)
    } catch (error) {
      this.log.error('切换报告目录失败（沿用旧目录）', error)
    }
  }

  /** §12.6：enabled=false 立刻静音——停当前音效 + 终止响铃循环，不动其它状态。 */
  private hush(): void {
    const stoppedRepeat = this.stopRepeatSafe()
    let stoppedHandle = false
    try {
      stoppedHandle = this.audio?.stop() === true
    } catch (error) {
      this.log.debug(`总开关关闭时停止音效失败：${describe(error)}`)
    }
    this.log.info(`enabled=false：提醒已静默（响铃循环${stoppedRepeat ? '已终止' : '未在运行'}，音效句柄${stoppedHandle ? '已停' : '未在播放'}）`)
  }

  /** repeatInterval / repeatMax 变化时，用新参数重排正在进行的响铃循环。 */
  private rescheduleRing(): void {
    let active = false
    try {
      active = this.audio?.isRepeating() === true
    } catch (error) {
      this.log.debug(`读取响铃循环状态失败：${describe(error)}`)
    }
    if (!active) return
    this.stopRepeatSafe()
    // startRepeat 立刻再播一次并按新间隔排下一轮；计数从 0 重新开始。
    const restarted = this.startRepeatAudio()
    this.log.info(
      `响铃循环已按新参数（${this.config.repeatInterval}s / 上限 ${this.config.repeatMax}）重排：${restarted ? '已重启' : '重启失败'}`,
    )
  }

  /**
   * 「推一条提醒 + 因它播声」的唯一出口：`enabled=false` 的自动路径在这里被统一短路。
   *
   * §12.8.1 的唯一例外是用户显式发起的 test-alert（`bypassMasterSwitch`）。
   */
  private emitAlert(input: AlertPushInput, options: EmitOptions = {}): AlertRecord | null {
    const bypass = options.bypassMasterSwitch === true
    if (!bypass && !this.isEnabled()) {
      this.log.info(`enabled=false，提醒已按总开关静默：${input.title}`)
      return null
    }
    const alert = this.pushAlert(input)
    if (options.audio !== 'skip') this.playAudio(bypass)
    return alert
  }

  dispose(): void {
    try {
      // CONTRACT §11.3：插件卸载必须终止响铃循环（音频播放器 dispose 内部也会停）。
      this.audio?.dispose()
    } catch (error) {
      this.log.debug(`释放音频播放器失败：${describe(error)}`)
    }
  }

  // ---------- 内部 ----------

  private buildReport(problemId: string, entry: ProblemEntry): ProblemReport {
    return {
      problemId,
      description: entry.description,
      finalStatus: `未解决（连续 ${entry.attempts} 次尝试均失败，上限 ${this.config.maxAttempts}）`,
      attempts: [...entry.attemptDetails],
      maxAttempts: this.config.maxAttempts,
    }
  }

  private pushAlert(input: AlertPushInput): AlertRecord {
    this.alertSeq += 1
    const alert: AlertRecord = {
      id: `al_${this.alertSeq}`,
      kind: input.kind,
      level: input.level,
      title: input.title,
      message: input.message,
      createdAt: new Date().toISOString(),
      audio: false,
      dismissed: false,
    }
    if (input.problemId !== undefined) alert.problemId = input.problemId
    if (input.attempts !== undefined) alert.attempts = input.attempts
    alert.maxAttempts = this.config.maxAttempts
    if (input.reportPath !== undefined) alert.reportPath = input.reportPath
    this.alerts.unshift(alert)
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS
    return alert
  }

  private playAudio(bypassMasterSwitch = false): void {
    const alert = this.alerts[0]
    const played = this.startRepeatAudio(bypassMasterSwitch)
    if (alert !== undefined) alert.audio = played
  }

  /**
   * CONTRACT §11.3：所有「因提醒而播声」的路径共用这里——立即播 1 次，
   * 并在 `repeat_interval > 0` 时进入响铃循环（循环由 AudioPlayer 持有定时器）。
   *
   * §12：`bypassMasterSwitch` 只给用户显式路径（test-alert，§12.8.1）；自动路径在 `enabled=false`
   * 时连这一层都进不来——这是「不出声」的第二道闸（第一道在 `emitAlert`）。
   */
  private startRepeatAudio(bypassMasterSwitch = false): boolean {
    if (!bypassMasterSwitch && !this.isEnabled()) {
      this.log.info('enabled=false：不播放音效、不进入响铃循环')
      return false
    }
    try {
      const intervalMs = Math.max(0, this.config.repeatInterval) * 1000
      const played = this.audio?.startRepeat(intervalMs, this.config.repeatMax) === true
      if (!played) this.log.debug('音效未播放（后端不可用或文件缺失）')
      return played
    } catch (error) {
      this.log.warn(`播放音效失败：${describe(error)}`)
      return false
    }
  }

  /** 终止响铃循环；任何异常只记日志。 */
  private stopRepeatSafe(): boolean {
    try {
      return this.audio?.stopRepeat() === true
    } catch (error) {
      this.log.warn(`停止响铃循环失败：${describe(error)}`)
      return false
    }
  }

  private findAlert(alertId: string): AlertRecord | undefined {
    if (typeof alertId !== 'string' || alertId.length === 0) return undefined
    return this.alerts.find((alert) => alert.id === alertId)
  }

  /** CONTRACT §11.5：报告写盘成功后按配置自动打开；失败只记日志。 */
  private autoOpenReport(path: string): void {
    const mode = this.config.reportAutoOpen
    if (mode === 'none') return
    try {
      const opened = this.opener.openAuto(mode, path)
      this.log.info(`报告已写盘，自动打开（${mode}）：${path} → ${opened ? '已发起' : '失败'}`)
    } catch (error) {
      this.log.warn(`自动打开报告失败：${describe(error)}`)
    }
  }

  private touch(): void {
    this.revision += 1
    try {
      this.onRevision()
    } catch (error) {
      this.log.debug(`revision 回调失败：${describe(error)}`)
    }
  }
}

// ---------- HTTP 辅助 ----------

function sendJson(res: WebResponseLike, status: number, payload: unknown): void {
  let body: string
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: `序列化失败：${describe(error)}` })
    status = 500
  }
  try {
    res.statusCode = status
    res.setHeader?.('Content-Type', 'application/json; charset=utf-8')
    res.setHeader?.('Cache-Control', 'no-store')
    res.end?.(body)
  } catch (error) {
    // 响应已发出/连接已断：只记日志，绝不上抛。
    void error
  }
}

/** 读取并解析 JSON 请求体；超限或非法一律解析失败（返回 null）。 */
function readJsonBody(req: WebRequestLike, limitBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      resolveBody(value)
    }
    try {
      req.on('data', (chunk: unknown) => {
        try {
          if (settled) return
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          total += buf.length
          if (total > limitBytes) {
            finish(null)
            return
          }
          chunks.push(buf)
        } catch {
          finish(null)
        }
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          if (text.length === 0) {
            finish({})
            return
          }
          finish(JSON.parse(text))
        } catch {
          finish(null)
        }
      })
      req.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

function parseControlRequest(body: unknown): ControlRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const action = record.action
  const alertId = record.alertId
  const request: ControlRequest = {}
  if (typeof action === 'string') request.action = action as ControlRequest['action']
  if (typeof alertId === 'string') request.alertId = alertId
  return request
}

function normalizeConfig(raw: unknown): RawConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as RawConfig
}

/**
 * 测试注入缝（CONTRACT §11.4 要求打开器可注入，否则冒烟会真的弹窗）：
 * 只认 `apply(ctx, config)` 第二参数上的 `openRunner` **函数**。
 * YAML / JSON / cordis 行 config 里永远解析不出函数，因此生产配置完全不受影响。
 */
function pickInjectedOpenRunner(raw: unknown): OpenRunner | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = (raw as { openRunner?: unknown }).openRunner
  return typeof candidate === 'function' ? (candidate as OpenRunner) : null
}

/**
 * 音频句柄的观测包装（§12 的测试注入缝：`apply(ctx, config)` 第二参数上的 `audioProbe` 函数）。
 *
 * 记录发生在**转发给真实 AudioPlayer 的那一刻**，所以「没有 startRepeat 记录」等价于
 * 「没有向播放器发起播放」——这正是 `enabled=false`（以及 §12.8.1 的绕过）要断言的事实。
 * 生产不注入 probe → 直接用 AudioPlayer，零包装零开销。
 */
class ObservedAudio implements AudioHandle {
  private readonly inner: AudioPlayer
  private readonly file: string
  private readonly observe: AudioObserver

  constructor(inner: AudioPlayer, file: string, observe: AudioObserver) {
    this.inner = inner
    this.file = file
    this.observe = observe
  }

  startRepeat(intervalMs: number, max: number): boolean {
    this.report({ method: 'startRepeat', file: this.file, intervalMs, max })
    return this.inner.startRepeat(intervalMs, max)
  }

  stop(): boolean {
    this.report({ method: 'stop', file: this.file })
    return this.inner.stop()
  }

  stopRepeat(): boolean {
    this.report({ method: 'stopRepeat', file: this.file })
    return this.inner.stopRepeat()
  }

  isPlaying(): boolean {
    return this.inner.isPlaying()
  }

  isRepeating(): boolean {
    return this.inner.isRepeating()
  }

  get repeatCountValue(): number {
    return this.inner.repeatCountValue
  }

  dispose(): void {
    this.report({ method: 'dispose', file: this.file })
    this.inner.dispose()
  }

  private report(call: AudioCall): void {
    try {
      this.observe(call)
    } catch {
      /* 观测器自身的异常绝不允许影响音频 */
    }
  }
}

/** 与 `openRunner` 同源的测试注入缝：只认 apply 第二参数上的**函数** `audioProbe`。 */
function pickInjectedAudioObserver(raw: unknown): AudioObserver | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = (raw as { audioProbe?: unknown }).audioProbe
  return typeof candidate === 'function' ? (candidate as AudioObserver) : null
}

/**
 * 第三个同源注入缝（CONTRACT §13.6）：apply 第二参数上的 `hotkeyServerFactory` 函数。
 *
 * 有了它，冒烟脚本可以在**不派生第二个 `WinKeyServer.exe`** 的前提下，真实驱动宿主那
 * 两个绑定，从而断言「两个快捷键 = 两个绑定 = 一个 OS 监听器」，以及「panel_hotkey 命中
 * → `panelOpenSeq` +1」。生产注入不了函数，因此走真实 `node-global-key-listener`。
 */
function pickInjectedHotkeyServer(raw: unknown): HotkeyServerFactory | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = (raw as { hotkeyServerFactory?: unknown }).hotkeyServerFactory
  return typeof candidate === 'function' ? (candidate as HotkeyServerFactory) : null
}

/**
 * §12.4：配置 API 的事务控制器 —— 校验 → 运行时生效 → 落盘；任一步失败即回滚旧值。
 *
 * 关键决策：
 *  1. 顺序固定「先运行时、后落盘」：落盘失败时运行时已经改过，所以必须回滚；反过来先落盘会留下
 *     「文件里是新值、进程里是旧值」的分裂状态。
 *  2. 回滚不做逐键撤销：`service.applyEditable(previous)` 是幂等的整份应用，用旧值再调一次即可；
 *     快捷键同理切回旧组合。回滚自身只记日志，绝不把失败升级成新异常。
 *  3. 事件适配层只在两个布尔开关变化时重建：AlertAdapter 把它们拷贝成只读字段，陈旧值会让事件
 *     被**静默丢弃**（adapter.ts:277）。
 */
class ConfigController {
  private readonly service: AlertsService
  private readonly log: PluginLogger
  private readonly baseDir: string
  private readonly filePath: string
  /**
   * CONTRACT §13.6：一次重启要同时喂两个组合（停止音效 / 打开面板），因为它们共用
   * **同一个** OS 监听器——分开重启就会变成「停一个、起一个」，中间还可能短暂并存两个。
   */
  private readonly restartHotkeys: (stopCombo: string, panelCombo: string) => Promise<void>
  private readonly rebuildAdapter: () => void

  constructor(options: {
    service: AlertsService
    log: PluginLogger
    baseDir: string
    editableConfigPath: string
    restartHotkeys: (stopCombo: string, panelCombo: string) => Promise<void>
    rebuildAdapter: () => void
  }) {
    this.service = options.service
    this.log = options.log
    this.baseDir = options.baseDir
    this.filePath = options.editableConfigPath
    this.restartHotkeys = options.restartHotkeys
    this.rebuildAdapter = options.rebuildAdapter
  }

  /** §12.4：局部更新。成功 = 已运行时生效**且**已落盘；失败 = 什么也没留下（回滚完毕）。 */
  async update(rawPatch: unknown): Promise<ConfigUpdateResult> {
    const previous = this.service.getConfig()
    const validation = validateConfigPatch(rawPatch)
    if (!validation.ok) {
      this.log.warn(`配置校验失败：${JSON.stringify(validation.errors)}`)
      return { ok: false, status: 400, error: 'invalid config', errors: validation.errors }
    }
    const next = this.buildNext(previous, validation.patch)
    const applied = this.service.applyEditable(next)
    if (!applied.ok) {
      await this.rollback(next, previous)
      return { ok: false, status: 500, error: applied.error }
    }
    // §13.6：任一个快捷键变化（stop_hotkey / panel_hotkey）都要按新组合重启同一个监听器。
    if (next.hotkey !== previous.hotkey || next.panelHotkey !== previous.panelHotkey) {
      await this.restartHotkeys(next.hotkey, next.panelHotkey)
    }
    const written = writeUserConfig(this.filePath, serializeUserConfig(next))
    if (!written.ok) {
      await this.rollback(next, previous)
      return {
        ok: false,
        status: 500,
        error: `写入用户配置失败（${this.filePath}）：${written.error ?? 'unknown'}`,
      }
    }
    if (
      next.alertOnUnresolved !== previous.alertOnUnresolved ||
      next.programFinishAlert !== previous.programFinishAlert
    ) {
      this.rebuildAdapter()
    }
    this.log.info(`配置已更新并立即生效，已写入 ${this.filePath}`)
    return { ok: true, applied: true, config: this.service.getConfig(), state: this.service.getState() }
  }

  /** 校验过的补丁 → 完整配置：解析相对路径、归一化快捷键（clamp 已在 mergeEditable 里）。 */
  private buildNext(current: EditableConfig, patch: EditablePatch): EditableConfig {
    const merged = mergeEditable(current, patch)
    return {
      ...merged,
      audioPath: resolveAgainst(this.baseDir, merged.audioPath),
      reportDir: resolveAgainst(this.baseDir, merged.reportDir),
      hotkey: normalizeHotkeyText(merged.hotkey),
      panelHotkey: normalizeHotkeyText(merged.panelHotkey, DEFAULTS.panel_hotkey),
    }
  }

  /** 用旧值再应用一次（幂等），并把快捷键切回旧组合。 */
  private async rollback(next: EditableConfig, previous: EditableConfig): Promise<void> {
    try {
      const restored = this.service.applyEditable(previous)
      if (!restored.ok) {
        this.log.error(`回滚运行时配置失败：${restored.error}`)
        return
      }
      this.log.warn('配置未能生效，运行时状态已回滚到旧值')
      if (next.hotkey !== previous.hotkey || next.panelHotkey !== previous.panelHotkey) {
        await this.restartHotkeys(previous.hotkey, previous.panelHotkey)
      }
    } catch (error) {
      this.log.error('回滚运行时配置异常', error)
    }
  }
}

// ---------- 入口 ----------

/**
 * Cordis 插件入口。任何内部失败都只记日志——`apply` 本身不 throw。
 */
export async function apply(ctx: CordisContext, rawConfig?: unknown): Promise<void> {
  try {
    await boot(ctx, rawConfig)
  } catch (error) {
    // 最后一道防线：把配置/装配期的意外异常收在这里，而不是让宿主崩掉。
    try {
      globalThis.console?.error?.(`${LOG_PREFIX} 插件装配失败：${describe(error)}`)
    } catch {
      /* ignore */
    }
  }
}

async function boot(ctx: CordisContext, rawConfig: unknown): Promise<void> {
  const context: CordisContext = ctx ?? ({} as CordisContext)

  // 1) 配置（日志文件在配置里，所以先用 console 兜底，配置好了再换正式 logger）
  const bootstrapLogger = createLogger('<configured later>', pickLoggerSink(context))
  const config = await loadConfig(normalizeConfig(rawConfig), bootstrapLogger)
  const log = createLogger(config.logFile, pickLoggerSink(context))
  log.info(`插件启动：包根=${config.baseDir}，报告目录=${config.reportDir}，日志=${config.logFile}`)
  log.info(`配置来源：${config.sources.length > 0 ? config.sources.join(' → ') : '内置默认值'}`)

  let stopping = false
  const disposers: Array<{ label: string; run: () => void }> = []
  const addDisposer = (label: string, run: () => void): void => {
    disposers.push({ label, run })
  }

  const disposeAll = (): void => {
    if (stopping) return
    stopping = true
    for (const entry of disposers.reverse()) {
      try {
        entry.run()
      } catch (error) {
        log.error(`清理 ${entry.label} 失败`, error)
      }
    }
    log.info('插件已卸载')
  }

  // 2) 状态仓库 + 3) 音频 + 4) 报告 + 5) 打开器
  const reporter = new Reporter({ reportDir: config.reportDir, log })
  const injectedRunner = pickInjectedOpenRunner(rawConfig)
  const opener = new Opener(injectedRunner === null ? { log } : { log, runner: injectedRunner })
  if (injectedRunner !== null) log.info('已注入自定义 openRunner（测试模式：不会真的打开系统窗口）')
  const injectedAudioObserver = pickInjectedAudioObserver(rawConfig)
  if (injectedAudioObserver !== null) log.info('已注入 audioProbe（测试模式：只记录音频调用）')
  // 音频句柄不在装配期创建：§12 的 `audioPath` 要能热替换，句柄必须由持有它的服务自己重建。
  const service = new AlertsService({
    config,
    log,
    reporter,
    opener,
    observeAudio: injectedAudioObserver,
    onRevision: () => {
      // revision 变化本身不做事，留给浏览器半轮询；保留钩子便于以后推送。
    },
  })
  // CONTRACT §11.3：插件卸载必须终止响铃循环（否则卸载后定时器还在按点播放）。
  addDisposer('音频与响铃循环', () => service.dispose())

  // 6) 事件适配层（ctx.on 缺失时静默降级，程序化入口照常）
  const hostBridge = {
    recordAttempt: (input: RecordAttemptInput): Promise<RecordAttemptResult> => service.recordAttempt(input),
    recordProgramFinish: (input: RecordProgramFinishInput): Promise<{ alerted: boolean }> =>
      service.recordProgramFinish(input),
  }
  const createAdapter = (): AlertAdapter =>
    new AlertAdapter({
      host: hostBridge,
      log,
      alertOnUnresolved: service.getConfig().alertOnUnresolved,
      programFinishAlert: service.getConfig().programFinishAlert,
    })
  let adapter = createAdapter()
  if (adapter.attach(context)) {
    addDisposer('事件监听', () => {
      try {
        adapter.detach()
      } catch (error) {
        log.debug(`卸载事件监听失败：${describe(error)}`)
      }
    })
    log.info(`已监听 DSH 事件：${adapterEventNames.join(', ')}`)
  }
  /**
   * §12：`alertOnUnresolved` / `programFinishAlert` 被 AlertAdapter 拷贝成只读字段，
   * 热改配置后必须重建适配层——陈旧的值会让事件被**静默丢弃**（adapter.ts:277）。
   */
  const rebuildAdapter = (): void => {
    try {
      adapter.detach()
    } catch (error) {
      log.warn(`卸载旧事件监听失败：${describe(error)}`)
    }
    adapter = createAdapter()
    if (adapter.attach(context)) log.info('事件监听已按新配置重建')
    else log.warn('事件监听重建失败（降级为程序化入口）')
  }

  // 7) OS 级快捷键（库缺失/启动失败都只降级）
  //
  // §13.6：**一个监听器挂两个绑定** —— stop_hotkey → 停止音效；panel_hotkey → panelOpenSeq+1。
  // 绝不为了两个组合各起一个监听器：`node-global-key-listener` 每个实例都会派生一个常驻
  // `WinKeyServer.exe`，两个实例就是两个常驻进程。§12 的热改路径按新组合重启**同一个**监听器。
  const injectedHotkeyServer = pickInjectedHotkeyServer(rawConfig)
  if (injectedHotkeyServer !== null) {
    log.info('已注入 hotkeyServerFactory（测试模式：不会真的派生 WinKeyServer.exe）')
  }
  let hotkey: HotkeyListener | null = null
  const startHotkey = async (stopComboText: string, panelComboText: string): Promise<void> => {
    const stopText = normalizeHotkey(stopComboText).text
    const panelText = normalizeHotkey(panelComboText).text
    const bindings: HotkeyBinding[] = [
      {
        id: 'stop_hotkey',
        combo: normalizeHotkey(stopComboText),
        onMatch: (): void => {
          try {
            const stopped = service.stopAudio()
            log.info(stopped ? '快捷键已停止音效' : '快捷键触发，但当前没有在播放的音效')
          } catch (error) {
            log.error('快捷键回调异常', error)
          }
        },
      },
      {
        id: 'panel_hotkey',
        combo: normalizeHotkey(panelComboText),
        onMatch: (): void => {
          try {
            const seq = service.notifyPanelOpen()
            log.info(`全局快捷键：打开/收起提醒面板（panelOpenSeq=${seq}）`)
          } catch (error) {
            log.error('面板快捷键回调异常', error)
          }
        },
      },
    ]
    const options: HotkeyListenerOptions =
      injectedHotkeyServer === null
        ? { log, bindings }
        : { log, bindings, serverFactory: injectedHotkeyServer }
    const listener = new HotkeyListener(options)
    hotkey = listener
    try {
      await listener.start()
      log.info(`全局快捷键监听已就绪：停止=${stopText}，面板=${panelText}（1 个监听器 / 2 个绑定）`)
    } catch (error) {
      log.warn(`全局快捷键启动异常（已降级）：${describe(error)}`)
    }
  }
  const restartHotkeys = async (stopComboText: string, panelComboText: string): Promise<void> => {
    const previous = hotkey
    hotkey = null
    try {
      previous?.stop()
    } catch (error) {
      log.warn(`停止旧快捷键监听失败：${describe(error)}`)
    }
    // 这一行原文保留：冒烟脚本按它证明「旧监听已停 + 按新组合重启」。
    log.info(`快捷键变更，重启全局监听：${normalizeHotkey(stopComboText).text}`)
    log.info(`面板快捷键同步：${normalizeHotkey(panelComboText).text}`)
    await startHotkey(stopComboText, panelComboText)
  }
  addDisposer('全局快捷键', () => {
    try {
      hotkey?.stop()
    } catch (error) {
      log.debug(`停止快捷键监听失败：${describe(error)}`)
    }
    hotkey = null
  })
  await startHotkey(config.hotkey, config.panelHotkey)

  // 8) 斜杠命令（name 不带前导斜杠）
  registerCommands(context, log, service, addDisposer)

  // 9) HTTP 路由（三条 exact：state / control / config）
  //    可写配置的事务控制器：校验 → 运行时生效 → 落盘，失败回滚（§12.4）。
  const editableConfigPath = userConfigPath()
  const controller = new ConfigController({
    service,
    log,
    baseDir: config.baseDir,
    editableConfigPath,
    restartHotkeys,
    rebuildAdapter,
  })
  log.info(`可写配置 API 就绪：用户配置文件 ${editableConfigPath}`)
  registerRoutes(context, log, service, controller, addDisposer)

  // 10) 服务：优先 ctx.set，否则直接赋值
  exposeService(context, log, service, addDisposer)

  // 11) 清理
  installDispose(context, log, disposeAll)
}

/**
 * 读取一个 Cordis 服务，绝不让守卫异常穿出去。
 *
 * Cordis 4 对**未在 `inject` 中声明**的服务属性会在 getter 上直接抛
 * `cannot get property "x" without inject`（cordis/lib/index.js:676）。这个抛发生在
 * 「先判断 undefined 再降级」之前，所以 `?.` 与 `=== undefined` 都拦不住，必须 try/catch。
 * 声明已写在文件顶部，这里只是第二道保险。
 */
function readService<T>(read: () => T, log: PluginLogger, label: string): T | undefined {
  try {
    return read()
  } catch (error) {
    log.warn(`读取 ctx.${label} 被 Cordis 拒绝（inject 未声明？）：${describe(error)}`)
    return undefined
  }
}

function registerCommands(
  ctx: CordisContext,
  log: PluginLogger,
  service: AlertsService,
  addDisposer: (label: string, run: () => void) => void,
): void {
  const commands = readService(() => ctx.commands, log, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    log.warn('ctx.commands 不存在，/alert-stop 与 /alert-test 未注册')
    return
  }

  const definitions: Array<{ definition: CommandDefinitionLike; label: string }> = [
    {
      label: '/alert-stop',
      definition: {
        name: 'alert-stop',
        description: '停止当前正在播放的任务提醒音效（不卸载插件）',
        handler: (): CommandResultLike => {
          try {
            const stopped = service.stopAudio()
            return {
              kind: 'success',
              text: stopped ? '已停止提醒音效。' : '当前没有在播放的提醒音效。',
            }
          } catch (error) {
            log.error('/alert-stop 处理异常', error)
            return { kind: 'error', text: `停止音效失败：${describe(error)}` }
          }
        },
      },
    },
    {
      label: '/alert-test',
      definition: {
        name: 'alert-test',
        description: '触发一次测试提醒（响铃 + 面板/Taost 预览）',
        handler: async (): Promise<CommandResultLike> => {
          try {
            const state = await service.test()
            return {
              kind: 'success',
              text: `已触发测试提醒：提醒数 ${state.stats.alerts}，音效${state.audioPlaying ? '正在播放' : '未播放'}。`,
            }
          } catch (error) {
            log.error('/alert-test 处理异常', error)
            return { kind: 'error', text: `测试提醒失败：${describe(error)}` }
          }
        },
      },
    },
  ]

  for (const entry of definitions) {
    try {
      const dispose = commands.register(entry.definition)
      addDisposer(`命令 ${entry.definition.name}`, () => {
        if (typeof dispose === 'function') dispose()
      })
      log.info(`已注册命令 ${entry.label}`)
    } catch (error) {
      log.warn(`注册命令 ${entry.label} 失败：${describe(error)}`)
    }
  }
}

function registerRoutes(
  ctx: CordisContext,
  log: PluginLogger,
  service: AlertsService,
  controller: ConfigController,
  addDisposer: (label: string, run: () => void) => void,
): void {
  const webServer = readService(() => ctx.webServer, log, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log.warn('ctx.webServer 不存在，/task-alerts/* 三条路由未注册（其余功能照常）')
    return
  }

  const stateRoute = {
    kind: 'exact' as const,
    path: '/task-alerts/state',
    handler: (req: WebRequestLike, res: WebResponseLike): void => {
      try {
        // NOTE: the browser half polls this endpoint once per second. An earlier
        // revision logged every request, producing one log line per second forever
        // (~9 MB/day of pure noise) and swamping plugin.log. `?since=` is part of
        // the contract (§4) and needs no logging at all.
        sendJson(res, 200, service.getState())
      } catch (error) {
        log.error('GET /task-alerts/state 处理异常', error)
        sendJson(res, 500, { ok: false, error: 'internal error' })
      }
    },
  }

  const controlRoute = {
    kind: 'exact' as const,
    path: '/task-alerts/control',
    handler: async (req: WebRequestLike, res: WebResponseLike): Promise<void> => {
      try {
        if (typeof req.method === 'string' && req.method.toUpperCase() !== 'POST') {
          sendJson(res, 400, { ok: false, error: 'unknown action' })
          return
        }
        const body = await readJsonBody(req)
        const request = parseControlRequest(body)
        const action = request?.action
        switch (action) {
          case 'stop-audio': {
            const stopped = service.stopAudio()
            sendJson(res, 200, { ok: true, stopped, state: service.getState() })
            return
          }
          case 'test-alert': {
            const state = await service.test()
            sendJson(res, 200, { ok: true, state })
            return
          }
          case 'dismiss': {
            const alertId = request?.alertId
            if (typeof alertId !== 'string' || alertId.length === 0) {
              sendJson(res, 400, { ok: false, error: 'alertId required' })
              return
            }
            const dismissed = service.dismiss(alertId)
            sendJson(res, 200, { ok: true, dismissed, state: service.getState() })
            return
          }
          case 'open-report': {
            // CONTRACT §11.4：缺 alertId / 未知 alertId / 该 alert 无 reportPath → 400。
            const alertId = request?.alertId
            if (typeof alertId !== 'string' || alertId.length === 0) {
              sendJson(res, 400, { ok: false, error: 'alertId required' })
              return
            }
            const target = service.getState().alerts.find((entry) => entry.id === alertId)
            if (target === undefined) {
              sendJson(res, 400, { ok: false, error: 'unknown alertId' })
              return
            }
            const targetPath = target.reportPath
            if (typeof targetPath !== 'string' || targetPath.length === 0) {
              sendJson(res, 400, { ok: false, error: 'reportPath missing' })
              return
            }
            // 打开失败（spawn/runner 报错）不算请求错误：200 + opened:false，客户端据状态轮询。
            const opened = service.openReport(alertId)
            sendJson(res, 200, { ok: true, opened, state: service.getState() })
            return
          }
          default: {
            sendJson(res, 400, { ok: false, error: 'unknown action' })
          }
        }
      } catch (error) {
        log.error('POST /task-alerts/control 处理异常', error)
        sendJson(res, 500, { ok: false, error: 'internal error' })
      }
    },
  }

  /**
   * §12.3 / §12.4：可写配置。
   *
   * 一条 exact 路由按方法分发：GET → 读；PUT/POST → 局部更新（校验 400 / 运行时与落盘失败 500）；
   * 其余方法 → 400。设置页在 `enabled=false` 时也照常可用，这正是「关掉后还能开回来」的保证。
   */
  const configRoute = {
    kind: 'exact' as const,
    path: '/task-alerts/config',
    handler: async (req: WebRequestLike, res: WebResponseLike): Promise<void> => {
      try {
        const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, config: service.getConfig(), state: service.getState() })
          return
        }
        if (method !== 'PUT' && method !== 'POST') {
          sendJson(res, 400, {
            ok: false,
            error: 'method not allowed',
            errors: { method: '仅支持 GET / PUT / POST' },
          })
          return
        }
        const body = await readJsonBody(req)
        const result = await controller.update(body)
        if (!result.ok) {
          const payload: Record<string, unknown> = { ok: false, error: result.error }
          if (result.errors !== undefined) payload.errors = result.errors
          sendJson(res, result.status, payload)
          return
        }
        sendJson(res, 200, { ok: true, applied: true, config: result.config, state: result.state })
      } catch (error) {
        log.error('GET/PUT /task-alerts/config 处理异常', error)
        sendJson(res, 500, { ok: false, error: 'internal error' })
      }
    },
  }

  for (const route of [stateRoute, controlRoute, configRoute]) {
    try {
      const dispose = webServer.register(route)
      addDisposer(`路由 ${route.path}`, () => {
        if (typeof dispose === 'function') dispose()
      })
      log.info(`已注册路由 ${route.kind} ${route.path}`)
    } catch (error) {
      log.warn(`注册路由 ${route.path} 失败：${describe(error)}`)
    }
  }
}

function exposeService(
  ctx: CordisContext,
  log: PluginLogger,
  service: AlertsService,
  addDisposer: (label: string, run: () => void) => void,
): void {
  // `ctx.provide(name, value)` 才是「以本 fiber 的身份注册一个服务」
  // （cordis/lib/types/reflect.d.ts:41）；`ctx.set` 只允许覆盖**已经 provide 过**的
  // 服务，对未提供过的名字会抛（同文件 :26 —— "setting an unprovided name throws"），
  // 所以这里绝不能用 set。返回值是注销 disposer，随 fiber 卸载自动回收。
  const provide = readService(() => (ctx as { provide?: unknown }).provide, log, 'provide')
  if (typeof provide === 'function') {
    try {
      const dispose = (provide as (name: string, value: unknown) => () => void).call(ctx, 'taskAlerts', service)
      log.info('已通过 ctx.provide("taskAlerts", ...) 暴露服务')
      if (typeof dispose === 'function') {
        // 绝不能写成 `ctx.effect(() => { dispose() })`：Cordis 的 effect() 会**立刻调用**
        // 传入的回调以取得 disposer，那样等于当场注销刚注册的服务。
        // 实测复现：provide 后服务 present，被 ctx.effect 包裹后立刻 MISSING。
        // 注销只交给自己的 disposer 列表，并加一次性闩锁，避免与 fiber 自动回收重复调用。
        let released = false
        addDisposer('taskAlerts 服务', () => {
          if (released) return
          released = true
          try {
            dispose()
          } catch (error) {
            log.debug(`注销 taskAlerts 服务失败：${describe(error)}`)
          }
        })
      }
      return
    } catch (error) {
      log.warn(`ctx.provide("taskAlerts", ...) 失败：${describe(error)}`)
    }
  } else {
    log.warn('ctx.provide 不可用，ctx.taskAlerts 服务未暴露（其余功能照常）')
  }
}

function installDispose(ctx: CordisContext, log: PluginLogger, disposeAll: () => void): void {
  if (typeof ctx.effect === 'function') {
    try {
      // 两种 cordis 形态都兼容：回调拿到带 `collect()` 的 scope 就登记；没有 collect 则
      // 把 disposer 作为返回值交出去（宿主据此收集）。这里因此对返回值做一次显式擦除。
      const effectCallback = ((scope?: unknown): (() => void) => {
        const candidate = scope as EffectScope | undefined
        try {
          if (candidate !== null && candidate !== undefined && typeof candidate.collect === 'function') {
            candidate.collect(disposeAll)
          }
        } catch (error) {
          log.debug(`effect scope.collect 失败（不影响卸载）：${describe(error)}`)
        }
        return disposeAll
      }) as unknown as () => void | Promise<void>
      ctx.effect(effectCallback)
      return
    } catch (error) {
      log.warn(`注册 ctx.effect 失败，改用 dispose 事件：${describe(error)}`)
    }
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        try {
          disposeAll()
        } catch (error) {
          log.error('dispose 处理器异常', error)
        }
      })
      return
    } catch (error) {
      log.warn(`注册 dispose 事件失败：${describe(error)}`)
    }
  }
  log.warn('ctx.effect 与 ctx.on 都不可用，插件卸载时不会自动清理（音效/快捷键/路由）')
}

/** 统一默认导出：`import pkg from 'dsh-task-alerts'` 与命名导出两种形态都可用。 */
export default { name, inject, apply }
