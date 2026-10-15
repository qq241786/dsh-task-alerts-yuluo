/**
 * dsh-task-alerts —— 配置加载（CONTRACT §6）。
 *
 * 职责：合并四处来源，产出一份已解析绝对路径、已 clamp 的 `HostConfig`。
 *
 * 关键决策：
 *  1. 优先级 高→低：apply 第二参数 → `<DSH_HOME>/dsh-task-alerts.config.yaml`
 *     → 包根 `config.yaml` → 内置默认值。按整键覆盖（键是扁平的；只有 `ui` 是子对象，
 *     在它内部逐字段覆盖）。
 *  2. `js-yaml` 是 optionalDependency：动态 `import()` 探测，缺失则回落到本文件的
 *     **极简 YAML 子集解析器**（注释 / 标量 / 一层嵌套 map / 引号 / 布尔 / 整数 / 小数），
 *     该子集恰好覆盖契约的 config.yaml 键名，不做完整 YAML。
 *  3. 相对路径基准 = 包根；包根不可写（`access(W_OK)` + 一次真实探测写）则整份路径基准
 *     回退 `<DSH_HOME>/dsh-task-alerts/`。
 *  4. 非法数值（NaN / 非数字）退回默认值再 clamp，绝不静默变成 0。
 *  5. v1.1 新增 `repeat_interval` / `repeat_max` / `report_auto_open`（CONTRACT §11.1）：
 *     前两个 clamp 到 `>= 0`（间隔允许小数），第三个只认四个字面量，非法值归 'none'。
 */

import { accessSync, constants as fsConstants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostConfig, PluginLogger, RawConfig, ReportAutoOpen, UiConfig } from './types.js'

/** 内置默认值（CONTRACT §6 的表格 + §11.1 的三个新键）。 */
export const DEFAULTS: Required<Omit<RawConfig, 'ui'>> & { ui: UiConfig } = {
  audio_path: './alert.wav',
  report_dir: './reports',
  max_attempts: 2,
  stop_hotkey: 'ctrl+alt+s',
  panel_hotkey: 'ctrl+alt+a',
  show_pill: true,
  program_finish_alert: true,
  alert_on_unresolved: true,
  enabled: true,
  log_file: './plugin.log',
  repeat_interval: 10,
  repeat_max: 0,
  report_auto_open: 'none',
  ui: { blurStrength: 10, primaryColor: '#87CEEB', borderRadius: 20, opacity: 0.7 },
}

/** YAML 里 `ui` 用 snake_case，契约 §3 的 `UiConfig` 用 camelCase。 */
const UI_KEY_MAP: ReadonlyArray<readonly [string, keyof UiConfig]> = [
  ['blur_strength', 'blurStrength'],
  ['primary_color', 'primaryColor'],
  ['border_radius', 'borderRadius'],
  ['opacity', 'opacity'],
]

export const CLAMP = {
  maxAttemptsMin: 1,
  /** CONTRACT §11.1：`repeat_interval >= 0`（秒），允许小数以便冒烟用 0.05s */
  repeatIntervalMin: 0,
  /** CONTRACT §11.1：`repeat_max >= 0` 的整数 */
  repeatMaxMin: 0,
  blurStrength: [0, 40] as const,
  borderRadius: [0, 48] as const,
  opacity: [0.05, 1] as const,
}

/** CONTRACT §11.5 的四个合法值；其余（含空串）一律归 'none'。 */
export const REPORT_AUTO_OPEN_VALUES: readonly ReportAutoOpen[] = ['none', 'file', 'folder', 'browser']

/** 递归 map 形状（不必与 RawConfig 完全一致，转成 RawConfig 前会逐键取值）。 */
type YamlValue = string | number | boolean | YamlMap
interface YamlMap {
  [key: string]: YamlValue
}

// ---------- 极简 YAML 子集解析器 ----------

/**
 * 解析 config.yaml 所需的子集：缩进 map、`key: value` 标量、`#` 注释、单/双引号、
 * true/false、整数与小数。不支持序列（`- item`），遇到时该行被忽略而不是报错。
 */
export function parseSimpleYaml(text: string): YamlMap {
  const root: YamlMap = {}
  const stack: Array<{ indent: number; node: YamlMap }> = [{ indent: -1, node: root }]

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine)
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const rest = trimmed.slice(separator + 1).trim()
    if (key.length === 0) continue

    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      if (top === undefined || indent > top.indent) break
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent === undefined) break

    if (rest.length === 0) {
      const child: YamlMap = {}
      parent.node[key] = child
      stack.push({ indent, node: child })
      continue
    }
    parent.node[key] = parseScalar(rest)
  }
  return root
}

/** 去掉行尾注释；引号内的 `#` 与紧贴非空白字符的 `#` 都不算注释。 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#') {
      const prev = i > 0 ? line[i - 1] : ' '
      if (prev === undefined || /\s/.test(prev)) return line.slice(0, i)
    }
  }
  return line
}

function parseScalar(value: string): string | number | boolean {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value === 'true' || value === 'True' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === 'False' || value === 'no' || value === 'off') return false
  if (/^[+-]?\d+$/.test(value)) {
    const n = Number.parseInt(value, 10)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) {
    const n = Number.parseFloat(value)
    if (Number.isFinite(n)) return n
  }
  return value
}

// ---------- 读盘 ----------

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

interface JsYamlModule {
  load(text: string): unknown
}

/**
 * 把动态 import 的结果收窄成 `{ load() }`。
 * `js-yaml` 自带类型且本仓库没装 `@types/js-yaml`，所以这里只做结构收窄，不依赖它的类型。
 */
function asYamlModule(value: unknown): JsYamlModule | null {
  if (!value || typeof value !== 'object') return null
  const direct = value as { load?: unknown }
  if (typeof direct.load === 'function') return value as JsYamlModule
  const fallback = (value as { default?: { load?: unknown } }).default
  if (fallback && typeof fallback.load === 'function') return fallback as JsYamlModule
  return null
}

/** 探测 optionalDependency `js-yaml`；缺失或形状不符一律返回 null。 */
async function tryJsYaml(): Promise<JsYamlModule | null> {
  try {
    // js-yaml 是 optionalDependency 且本仓库没有它的类型声明，形状由 asYamlModule 收窄。
    const mod: unknown = await import('js-yaml' as string)
    return asYamlModule(mod)
  } catch {
    /* optionalDependency 缺失：静默降级到内置子集解析器 */
    return null
  }
}

function toRawConfig(parsed: unknown): RawConfig | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as RawConfig
}

/** 解析一段配置文本：先 JSON（`{` 开头），再 js-yaml，最后内置子集解析器。 */
async function parseConfigText(text: string, label: string, log?: PluginLogger): Promise<RawConfig | null> {
  if (text.trim().startsWith('{')) {
    try {
      return toRawConfig(JSON.parse(text))
    } catch (error) {
      log?.warn(`配置 ${label} 不是合法 JSON，忽略：${describeError(error)}`)
      return null
    }
  }
  const yaml = await tryJsYaml()
  if (yaml) {
    try {
      return toRawConfig(yaml.load(text))
    } catch (error) {
      log?.warn(`js-yaml 解析 ${label} 失败，改用内置子集解析器：${describeError(error)}`)
    }
  }
  try {
    return parseSimpleYaml(text) as unknown as RawConfig
  } catch (error) {
    log?.warn(`解析 ${label} 失败，忽略：${describeError(error)}`)
    return null
  }
}

// ---------- 路径 ----------

/**
 * `<DSH_HOME>`；未设置时回退 `os.homedir()/.dsh`。
 *
 * **绝不能用 `process.cwd()` 兜底，且结果必须缓存。** 实测在真实应用里同一个进程内
 * 读与写解析出了不同路径：
 *   13:11:01 配置来源 → `C:\Users\...\.dsh\dsh-task-alerts.config.yaml`
 *   13:13:08 可写配置 → `E:\deepseek work\.dsh\dsh-task-alerts.config.yaml`
 * 原因是应用运行中会 `chdir`（先在工作区之外、后在 `E:\deepseek work`），而
 * `DSH_HOME`/`USERPROFILE`/`HOME` 在那个宿主环境里都不可见，于是回退到 cwd 的旧实现
 * 会随 cwd 漂移。后果是「设置页保存写进 A，下次启动却去读 B」——配置静默失效。
 * `os.homedir()` 走操作系统 API（不依赖环境变量），再配合一次缓存，路径就恒定了。
 */
let cachedDshHome: string | null = null

export function dshHome(): string {
  if (cachedDshHome !== null) return cachedDshHome
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    cachedDshHome = resolve(fromEnv.trim())
    return cachedDshHome
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  cachedDshHome = resolve(home, '.dsh')
  return cachedDshHome
}

/** 覆盖用户配置文件路径的环境变量（冒烟/多 profile 隔离用；设了它就**只认这个文件**）。 */
export const USER_CONFIG_ENV = 'DSH_TASK_ALERTS_USER_CONFIG'

/**
 * §6 第 2 档来源的路径：`<DSH_HOME>/dsh-task-alerts.config.yaml`。
 * 设了 `DSH_TASK_ALERTS_USER_CONFIG` 就只用那一个文件——便于测试注入，避免碰真实用户配置。
 */
export function userConfigPath(home: string = dshHome()): string {
  const override = process.env[USER_CONFIG_ENV]
  if (override !== undefined && override.trim().length > 0) return resolve(override.trim())
  return join(home, 'dsh-task-alerts.config.yaml')
}

/**
 * 包根：优先 `DSH_TASK_ALERTS_PACKAGE_ROOT`（冒烟脚本用），否则从 `lib/config.js`
 * 开始上溯寻找含 `package.json` 的目录；都失败则退回 `process.cwd()`。
 */
export function packageRoot(): string {
  const override = process.env.DSH_TASK_ALERTS_PACKAGE_ROOT
  if (override !== undefined && override.trim().length > 0) return resolve(override.trim())
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    if (readText(join(dir, 'package.json')) !== null) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/** 目录可写判定：先 `access(W_OK)`，再做一次真实探测写以排除只读挂载的假阳性。 */
export function isDirWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK)
  } catch {
    return false
  }
  const probe = join(dir, `.dsh-task-alerts-write-probe-${process.pid}`)
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** 相对路径以 base 为基准；绝对路径原样保留。 */
export function resolveAgainst(base: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return base
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed)
}

// ---------- 取值工具 ----------

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'true' || lowered === 'yes' || lowered === 'on' || lowered === '1') return true
    if (lowered === 'false' || lowered === 'no' || lowered === 'off' || lowered === '0') return false
  }
  return fallback
}

/**
 * CONTRACT §11.5：`report_auto_open` 只认四个字面量，其余（大小写、引号外的空白、
 * 任意垃圾值、非字符串）一律归 `'none'`——绝不因为一个错别字让报告自动弹窗。
 */
function asReportAutoOpen(value: unknown, fallback: ReportAutoOpen = 'none'): ReportAutoOpen {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    const match = REPORT_AUTO_OPEN_VALUES.find((candidate) => candidate === lowered)
    if (match !== undefined) return match
    return fallback
  }
  return fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function pickSection(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  return source as Record<string, unknown>
}

/**
 * 'ctrl + Alt + S' → 'ctrl+alt+s'；语义归一在 hotkey.ts，这里只做键盘串规范化。
 *
 * @param fallback - 空串/纯空白时回落的值。默认是 stop_hotkey 的默认值（既有调用方的语义），
 *   `panel_hotkey` 传入自己的默认值，这样两个键各自「非法值回落自己那一个默认」。
 */
/*
 * 全局快捷键的按键白名单，以及「必须带修饰键」这条规则。
 *
 * 两个真实缺陷促成了它（都在实况里被观察到）：
 *   1) 用户的配置里落成了 `stop_hotkey: "clear"` —— 设置页的捕获把数字键盘的 Clear 键
 *      （`event.key === 'Clear'`）当成了合法绑定，于是他的「停止音效」快捷键静默失效。
 *   2) 旧的归一化把**任何非空字符串**都放行，因此一个裸字母也能被绑定为全局快捷键 ——
 *      全局的 `a` 会吞掉系统里所有的 a 键输入。
 *
 * 两半各自实现同一条规则（浏览器半有等价镜像；两半无法共享代码，改动时请同步）。
 */
const HOTKEY_MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'meta',
  win: 'meta',
  cmd: 'meta',
  super: 'meta',
}

const HOTKEY_NAMED_KEYS = new Set([
  'space',
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'up',
  'down',
  'left',
  'right',
  'comma',
  'period',
  'slash',
  'semicolon',
  'quote',
  'bracketleft',
  'bracketright',
  'backslash',
  'minus',
  'equal',
  'backquote',
])

function splitHotkey(value: string): string[] {
  return value
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
}

/** 单个**非修饰键**是否在白名单内：`a-z` / `0-9` / `F1-F24` / 具名键。 */
export function isAllowedHotkeyKey(key: string): boolean {
  if (/^[a-z0-9]$/.test(key)) return true
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return true
  return HOTKEY_NAMED_KEYS.has(key)
}

/** 组合键文案是否合法：**至少一个修饰键 + 一个白名单内的非修饰键**。 */
export function isValidHotkeyText(value: string): boolean {
  const parts = splitHotkey(value)
  if (parts.length < 2) return false
  const key = parts[parts.length - 1] as string
  if (!isAllowedHotkeyKey(key)) return false
  return parts.slice(0, -1).some((part) => HOTKEY_MODIFIER_ALIASES[part] !== undefined)
}

/**
 * 归一化为 `ctrl+alt+s` 形态（修饰键顺序固定为 ctrl/alt/shift/meta）。
 *
 * **非法输入一律返回 `fallback`** —— 绝不把垃圾写进活配置（`"clear"` 那个 bug 的教训）。
 */
export function normalizeHotkeyText(value: string, fallback: string = DEFAULTS.stop_hotkey): string {
  if (!isValidHotkeyText(value)) return fallback
  const parts = splitHotkey(value)
  const key = parts[parts.length - 1] as string
  const mods: string[] = []
  for (const part of parts.slice(0, -1)) {
    const mod = HOTKEY_MODIFIER_ALIASES[part]
    if (mod !== undefined && mods.indexOf(mod) < 0) mods.push(mod)
  }
  const order = ['ctrl', 'alt', 'shift', 'meta']
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return mods.concat([key]).join('+')
}

// ---------- 主入口 ----------

/**
 * 按 CONTRACT §6 合成 `HostConfig`。任何读盘/解析失败都只降级：本函数不 throw。
 *
 * @param ctxConfig - cordis 行 `config`，或同形状的 YAML/JSON 文本。
 * @param log - 可选日志出口；缺省时静默。
 */
export async function loadConfig(ctxConfig?: unknown, log?: PluginLogger): Promise<HostConfig> {
  const root = packageRoot()
  const home = dshHome()
  const dataDir = join(home, 'dsh-task-alerts')
  const rootWritable = isDirWritable(root)
  const baseDir = rootWritable ? root : dataDir
  const sources: string[] = []

  // 1) 包根 config.yaml（最低优先级来源）
  const pkgPath = join(root, 'config.yaml')
  let pkgRaw: RawConfig = {}
  const pkgText = readText(pkgPath)
  if (pkgText !== null) {
    const parsed = await parseConfigText(pkgText, pkgPath, log)
    if (parsed !== null) {
      pkgRaw = parsed
      sources.push(pkgPath)
    }
  }

  // 2) <DSH_HOME>/dsh-task-alerts.config.{yaml,yml,json}
  //    §12 的配置 API 只写 `.yaml`，而 `.yaml` 排在候选表最前，所以「API 写进去 → 下次加载读得到」
  //    始终成立（即便是老用户已存在 `.yml`/`.json` 的情况）。设了 DSH_TASK_ALERTS_USER_CONFIG
  //    则只认那一个文件，不再回退到默认候选。
  let homeRaw: RawConfig = {}
  const userConfigOverride = (process.env[USER_CONFIG_ENV] ?? '').trim().length > 0
  const homeCandidates = userConfigOverride
    ? [userConfigPath(home)]
    : [
        join(home, 'dsh-task-alerts.config.yaml'),
        join(home, 'dsh-task-alerts.config.yml'),
        join(home, 'dsh-task-alerts.config.json'),
      ]
  for (const candidate of homeCandidates) {
    const text = readText(candidate)
    if (text === null) continue
    const parsed = await parseConfigText(text, candidate, log)
    if (parsed !== null) {
      homeRaw = parsed
      sources.push(candidate)
    }
    break
  }

  // 3) apply 第二参数（最高优先级来源）
  let ctxRaw: RawConfig = {}
  if (typeof ctxConfig === 'string') {
    const parsed = await parseConfigText(ctxConfig, 'apply(ctx, config)', log)
    if (parsed !== null) {
      ctxRaw = parsed
      sources.push('apply() 第二参数（文本）')
    }
  } else if (ctxConfig !== undefined && ctxConfig !== null) {
    const parsed = toRawConfig(ctxConfig)
    if (parsed !== null) {
      ctxRaw = parsed
      sources.push('apply() 第二参数')
    } else {
      log?.warn('apply() 第二参数不是对象，已忽略')
    }
  }

  const pkg = pkgRaw as Record<string, unknown>
  const homeLevel = homeRaw as Record<string, unknown>
  const ctxLevel = ctxRaw as Record<string, unknown>

  /** 三个来源按优先级取第一个有值的；都没有则用内置默认值。 */
  const pick = (key: string): unknown =>
    firstDefined(ctxLevel[key], homeLevel[key], pkg[key], (DEFAULTS as unknown as Record<string, unknown>)[key])

  const uiCtx = pickSection(ctxRaw.ui)
  const uiHome = pickSection(homeRaw.ui)
  const uiPkg = pickSection(pkgRaw.ui)
  const pickUi = (key: keyof UiConfig): unknown => {
    const snake = UI_KEY_MAP.find(([, camel]) => camel === key)?.[0] ?? key
    return firstDefined(uiCtx[key], uiCtx[snake], uiHome[key], uiHome[snake], uiPkg[key], uiPkg[snake], DEFAULTS.ui[key])
  }

  const ui: UiConfig = {
    blurStrength: clampNumber(pickUi('blurStrength'), CLAMP.blurStrength[0], CLAMP.blurStrength[1], DEFAULTS.ui.blurStrength),
    primaryColor: asString(pickUi('primaryColor'), DEFAULTS.ui.primaryColor),
    borderRadius: clampNumber(pickUi('borderRadius'), CLAMP.borderRadius[0], CLAMP.borderRadius[1], DEFAULTS.ui.borderRadius),
    opacity: clampNumber(pickUi('opacity'), CLAMP.opacity[0], CLAMP.opacity[1], DEFAULTS.ui.opacity),
  }

  const rawMax = clampNumber(pick('max_attempts'), CLAMP.maxAttemptsMin, Number.MAX_SAFE_INTEGER, DEFAULTS.max_attempts)
  const maxAttempts = Math.max(CLAMP.maxAttemptsMin, Math.floor(rawMax))
  const programFinishAlert = asBoolean(pick('program_finish_alert'), DEFAULTS.program_finish_alert)
  const hotkey = normalizeHotkeyText(asString(pick('stop_hotkey'), DEFAULTS.stop_hotkey))
  // CONTRACT §13.2：面板快捷键与停止快捷键各自独立回落，非法/空值 → 'ctrl+alt+a'。
  const panelHotkey = normalizeHotkeyText(asString(pick('panel_hotkey'), DEFAULTS.panel_hotkey), DEFAULTS.panel_hotkey)
  const showPill = asBoolean(pick('show_pill'), DEFAULTS.show_pill)

  // CONTRACT §11.1：两个新数值键都 clamp 到 >= 0；间隔保留小数（冒烟用 0.05s），上限取整。
  const repeatInterval = clampNumber(
    pick('repeat_interval'),
    CLAMP.repeatIntervalMin,
    Number.MAX_SAFE_INTEGER,
    DEFAULTS.repeat_interval,
  )
  const repeatMax = Math.max(
    CLAMP.repeatMaxMin,
    Math.floor(clampNumber(pick('repeat_max'), CLAMP.repeatMaxMin, Number.MAX_SAFE_INTEGER, DEFAULTS.repeat_max)),
  )
  const reportAutoOpen = asReportAutoOpen(pick('report_auto_open'))

  // 回退到数据目录时，先把该目录建出来（失败只记日志，reporter 写入时还会再试）。
  if (!rootWritable) {
    for (const dir of [dataDir, dirname(resolveAgainst(baseDir, asString(pick('log_file'), DEFAULTS.log_file)))]) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        log?.warn(`创建目录失败 ${dir}：${describeError(error)}`)
      }
    }
  }

  return {
    hotkey,
    panelHotkey,
    showPill,
    ui,
    programFinishAlert,
    alertOnUnresolved: asBoolean(pick('alert_on_unresolved'), DEFAULTS.alert_on_unresolved),
    enabled: asBoolean(pick('enabled'), DEFAULTS.enabled),
    maxAttempts,
    reportDir: resolveAgainst(baseDir, asString(pick('report_dir'), DEFAULTS.report_dir)),
    audioPath: resolveAgainst(baseDir, asString(pick('audio_path'), DEFAULTS.audio_path)),
    logFile: resolveAgainst(baseDir, asString(pick('log_file'), DEFAULTS.log_file)),
    repeatInterval,
    repeatMax,
    reportAutoOpen,
    baseDir,
    programFinishAlertRaw: programFinishAlert,
    sources,
  }
}
