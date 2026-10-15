/**
 * dsh-task-alerts —— 可写用户配置（任务书 §12；CONTRACT §6 优先级第 2 档）。
 *
 * 职责：把配置 API 的 PUT 变成两件事——① 严格校验、② 一份能被 §6 的极简 YAML 子集解析器
 * **原样读回**的 `<DSH_HOME>/dsh-task-alerts.config.yaml`。
 *
 * 关键决策：
 *  1. 只写用户配置文件，绝不改写包根 `config.yaml`（那是调度者的交付物）。
 *  2. 只发射 §12.5 的 10 个键，键名与 `config.yaml` 完全同形（snake_case + `ui` 子映射），
 *     所以写出的文件既能被内置子集解析器读回，也是合法 YAML（js-yaml 存在时走同一套语义）。
 *  3. 字符串一律双引号并转义 `\` 与 `"`：`"#87CEEB"` 不加引号会被 `#` 注释规则截断，
 *     Windows 路径 `C:\Users\...` 不转义则**不是合法 YAML**（js-yaml 会因 `\U` 报错）。
 *     这两个转义与 `config.ts` 的 `parseScalar` 互为逆运算。
 *  4. 写盘原子：先写 `<path>.tmp-<pid>` 再 rename；任何失败只返回 `{ok:false}`，绝不 throw（§9）。
 *  5. 校验只判**类型与字面量**（错 → 400）；数值越界按 §6 的 clamp 规则收敛（与加载器同语义，
 *     不把 clamp 当错误）；未知键一律忽略（未提供的键保持原值 = 部分更新），这样客户端即便把整份
 *     `state.config` 回传也不会 400。
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CLAMP, REPORT_AUTO_OPEN_VALUES, isValidHotkeyText, normalizeHotkeyText } from './config.js'
import type {
  ConfigErrors,
  ConfigValidation,
  EditableConfig,
  EditablePatch,
  HostConfig,
  PluginLogger,
  ReportAutoOpen,
  UiConfig,
} from './types.js'

/**
 * §14：组合键必须「至少一个修饰键 + 一个白名单键」。
 * 真值事故：用户配置里落成了 `stop_hotkey: "clear"`（数字键盘 Clear 键被当成合法绑定），
 * 他的停止快捷键就静默失效了；而裸字母能被绑定更危险（全局 `a` 会吞掉所有 a 键）。
 */
const HOTKEY_RULE_MESSAGE =
  '无效的组合键：需要至少一个修饰键（ctrl / alt / shift / meta）加一个字母、数字、F1-F24 或具名键，例如 ctrl+alt+s'

/** §12.5 的 10 个可写键 + §13.2 的 2 个新键 + §14 的 `maxAttempts`（也是写入顺序）。 */
export const EDITABLE_KEYS = [
  'audioPath',
  'enabled',
  'hotkey',
  'maxAttempts',
  'panelHotkey',
  'programFinishAlert',
  'alertOnUnresolved',
  'reportDir',
  'reportAutoOpen',
  'repeatInterval',
  'repeatMax',
  'showPill',
  'ui',
] as const

/** 当前生效配置 → 可写视图（`ui` 复制一份，避免调用方改到活对象）。 */
export function editableFromHost(config: HostConfig): EditableConfig {
  return {
    audioPath: config.audioPath,
    enabled: config.enabled,
    hotkey: config.hotkey,
    maxAttempts: config.maxAttempts,
    panelHotkey: config.panelHotkey,
    programFinishAlert: config.programFinishAlert,
    alertOnUnresolved: config.alertOnUnresolved,
    reportDir: config.reportDir,
    reportAutoOpen: config.reportAutoOpen,
    repeatInterval: config.repeatInterval,
    repeatMax: config.repeatMax,
    showPill: config.showPill,
    ui: { ...config.ui },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkText(value: unknown, key: string, errors: ConfigErrors): string | null {
  if (typeof value !== 'string') {
    errors[key] = '必须是字符串'
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    errors[key] = '不能为空'
    return null
  }
  if (/[\r\n]/.test(trimmed)) {
    // 换行会把 YAML 写成两行，读回来就不再是同一个值了——宁可直接拒绝。
    errors[key] = '不能包含换行'
    return null
  }
  return trimmed
}

function checkNumber(value: unknown, key: string, errors: ConfigErrors): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors[key] = '必须是有限数字'
    return null
  }
  return value
}

function checkBoolean(value: unknown, key: string, errors: ConfigErrors): boolean | null {
  if (typeof value !== 'boolean') {
    errors[key] = '必须是布尔值'
    return null
  }
  return value
}

/**
 * 只做**类型与字面量**校验（不 clamp、不看旧值），因此是纯函数，便于单独测试。
 * 未知键被忽略；提供了但非法的键进 `errors`。
 */
export function validateConfigPatch(raw: unknown): ConfigValidation {
  const errors: ConfigErrors = {}
  if (!isPlainObject(raw)) {
    errors.body = '请求体必须是 JSON 对象'
    return { ok: false, errors }
  }

  const patch: EditablePatch = {}

  if ('enabled' in raw) {
    const value = checkBoolean(raw.enabled, 'enabled', errors)
    if (value !== null) patch.enabled = value
  }
  if ('programFinishAlert' in raw) {
    const value = checkBoolean(raw.programFinishAlert, 'programFinishAlert', errors)
    if (value !== null) patch.programFinishAlert = value
  }
  if ('alertOnUnresolved' in raw) {
    const value = checkBoolean(raw.alertOnUnresolved, 'alertOnUnresolved', errors)
    if (value !== null) patch.alertOnUnresolved = value
  }
  if ('audioPath' in raw) {
    const value = checkText(raw.audioPath, 'audioPath', errors)
    if (value !== null) patch.audioPath = value
  }
  if ('reportDir' in raw) {
    const value = checkText(raw.reportDir, 'reportDir', errors)
    if (value !== null) patch.reportDir = value
  }
  if ('hotkey' in raw) {
    const value = checkText(raw.hotkey, 'hotkey', errors)
    if (value !== null) {
      if (isValidHotkeyText(value)) patch.hotkey = normalizeHotkeyText(value)
      else errors.hotkey = HOTKEY_RULE_MESSAGE
    }
  }
  // §13.2：与 hotkey 同构，并且**同样**要求「修饰键 + 白名单键」（§14）。
  if ('panelHotkey' in raw) {
    const value = checkText(raw.panelHotkey, 'panelHotkey', errors)
    if (value !== null) {
      if (isValidHotkeyText(value)) patch.panelHotkey = normalizeHotkeyText(value)
      else errors.panelHotkey = HOTKEY_RULE_MESSAGE
    }
  }
  if ('showPill' in raw) {
    const value = checkBoolean(raw.showPill, 'showPill', errors)
    if (value !== null) patch.showPill = value
  }
  if ('reportAutoOpen' in raw) {
    const value = typeof raw.reportAutoOpen === 'string' ? raw.reportAutoOpen.trim().toLowerCase() : ''
    const match = REPORT_AUTO_OPEN_VALUES.find((candidate) => candidate === value)
    if (match === undefined) errors.reportAutoOpen = `必须是 ${REPORT_AUTO_OPEN_VALUES.join(' | ')} 之一`
    else patch.reportAutoOpen = match
  }
  if ('repeatInterval' in raw) {
    const value = checkNumber(raw.repeatInterval, 'repeatInterval', errors)
    if (value !== null) patch.repeatInterval = value
  }
  if ('repeatMax' in raw) {
    const value = checkNumber(raw.repeatMax, 'repeatMax', errors)
    if (value !== null) patch.repeatMax = value
  }
  if ('maxAttempts' in raw) {
    const value = checkNumber(raw.maxAttempts, 'maxAttempts', errors)
    if (value !== null) patch.maxAttempts = value
  }
  if ('ui' in raw) {
    if (!isPlainObject(raw.ui)) {
      errors.ui = '必须是对象'
    } else {
      const source = raw.ui
      const ui: Partial<UiConfig> = {}
      if ('blurStrength' in source) {
        const value = checkNumber(source.blurStrength, 'ui.blurStrength', errors)
        if (value !== null) ui.blurStrength = value
      }
      if ('primaryColor' in source) {
        const value = checkText(source.primaryColor, 'ui.primaryColor', errors)
        if (value !== null) ui.primaryColor = value
      }
      if ('borderRadius' in source) {
        const value = checkNumber(source.borderRadius, 'ui.borderRadius', errors)
        if (value !== null) ui.borderRadius = value
      }
      if ('opacity' in source) {
        const value = checkNumber(source.opacity, 'ui.opacity', errors)
        if (value !== null) ui.opacity = value
      }
      patch.ui = ui
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, patch }
}

function clampNumber(value: number | undefined, fallback: number, range: readonly [number, number]): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(range[1], Math.max(range[0], value))
}

/** 把校验过的补丁落到当前值上；数值按 §6 的 clamp 规则收敛（相对路径的解析由调用方做）。 */
export function mergeEditable(current: EditableConfig, patch: EditablePatch): EditableConfig {
  return {
    audioPath: patch.audioPath ?? current.audioPath,
    enabled: patch.enabled ?? current.enabled,
    hotkey: patch.hotkey ?? current.hotkey,
    maxAttempts:
      patch.maxAttempts === undefined ? current.maxAttempts : Math.max(1, Math.floor(patch.maxAttempts)),
    panelHotkey: patch.panelHotkey ?? current.panelHotkey,
    showPill: patch.showPill ?? current.showPill,
    programFinishAlert: patch.programFinishAlert ?? current.programFinishAlert,
    alertOnUnresolved: patch.alertOnUnresolved ?? current.alertOnUnresolved,
    reportDir: patch.reportDir ?? current.reportDir,
    reportAutoOpen: patch.reportAutoOpen ?? current.reportAutoOpen,
    repeatInterval:
      patch.repeatInterval === undefined
        ? current.repeatInterval
        : Math.max(CLAMP.repeatIntervalMin, patch.repeatInterval),
    repeatMax: patch.repeatMax === undefined ? current.repeatMax : Math.max(CLAMP.repeatMaxMin, Math.floor(patch.repeatMax)),
    ui: {
      blurStrength: clampNumber(patch.ui?.blurStrength, current.ui.blurStrength, CLAMP.blurStrength),
      primaryColor: patch.ui?.primaryColor ?? current.ui.primaryColor,
      borderRadius: clampNumber(patch.ui?.borderRadius, current.ui.borderRadius, CLAMP.borderRadius),
      opacity: clampNumber(patch.ui?.opacity, current.ui.opacity, CLAMP.opacity),
    },
  }
}

/** 一个 YAML 标量：布尔/数字裸写，字符串双引号 + 转义（见文件头决策 3）。 */
function scalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const USER_CONFIG_HEADER = [
  '# dsh-task-alerts —— 用户配置（由配置 API 写入，键名与包根 config.yaml 同形）',
  '# 优先级：apply(ctx, config) > 本文件 > 包根 config.yaml > 内置默认值。',
]

/** 可写配置 → 用户配置文件全文（snake_case + `ui` 子映射）。 */
export function serializeUserConfig(config: EditableConfig): string {
  const flat: Array<[string, string | number | boolean]> = [
    ['audio_path', config.audioPath],
    ['enabled', config.enabled],
    ['stop_hotkey', config.hotkey],
    ['panel_hotkey', config.panelHotkey],
    ['show_pill', config.showPill],
    ['program_finish_alert', config.programFinishAlert],
    ['alert_on_unresolved', config.alertOnUnresolved],
    ['max_attempts', config.maxAttempts],
    ['report_dir', config.reportDir],
    ['report_auto_open', config.reportAutoOpen],
    ['repeat_interval', config.repeatInterval],
    ['repeat_max', config.repeatMax],
  ]
  const ui: Array<[string, string | number | boolean]> = [
    ['blur_strength', config.ui.blurStrength],
    ['primary_color', config.ui.primaryColor],
    ['border_radius', config.ui.borderRadius],
    ['opacity', config.ui.opacity],
  ]
  return [
    ...USER_CONFIG_HEADER,
    ...flat.map(([key, value]) => `${key}: ${scalar(value)}`),
    'ui:',
    ...ui.map(([key, value]) => `  ${key}: ${scalar(value)}`),
    '',
  ].join('\n')
}

export interface WriteResult {
  ok: boolean
  error?: string
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** 原子写用户配置文件。任何失败（含父目录不可建）只返回 `{ok:false}`，绝不 throw。 */
export function writeUserConfig(path: string, text: string): WriteResult {
  const temporary = `${path}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
    return { ok: true }
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* 清临时文件失败不影响结论 */
    }
    return { ok: false, error: describeError(error) }
  }
}

/** 归一化用户输入的快捷键（写盘与运行时都用同一结果）。 */
export function normalizeEditableHotkey(value: string): string {
  return normalizeHotkeyText(value)
}
