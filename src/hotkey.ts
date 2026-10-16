/**
 * dsh-task-alerts —— 快捷键语义基准 + OS 级监听。
 *
 * 职责：
 *  1. `normalizeHotkey` / `matchesHotkey` 是**两半共享的纯函数语义基准**——浏览器半
 *     把 `KeyboardEvent` 套进 `HotkeyEventLike` 复用同一套匹配规则，因此这里不碰
 *     DOM、不碰 Node API，可被单测直接调用。
 *  2. `HotkeyListener` 只在 Node 侧做 OS 级监听（optionalDependency
 *     `node-global-key-listener`）。库缺失或启动失败 → 记日志 + 返回 false，
 *     静默降级（in-app 层由浏览器半独立负责，见 CONTRACT §6 注释）。
 *
 * 关键决策：
 *  1. 组合串里**最后一个非修饰键 token 才是主键**；其余 token 归入修饰键集合。
 *     这样 `ctrl+alt+s`、`alt+ctrl+s` 等价，而 `ctrl+shift+f5` 也能正确解析。
 *  2. 键名归一为「小写 + 去掉非字母数字」：`Page Up`→`pageup`、`/`→``（空则退化为
 *     原 token）。归一后两侧比较，浏览器事件与 OS 事件用同一张别名表。
 *  3. OS 事件是「一次一个键」的，修饰键状态要靠累积集合推导；`matchesHotkey`
 *     因此接受 `pressed` 集合，浏览器事件走 `ctrlKey/altKey/...` 标志位分支。
 *  4. 只在 `state === 'DOWN'`（或未声明 state）时触发，避免 UP 事件重复触发。
 *  5. CONTRACT §13.6：一个 `HotkeyListener` 持**多个绑定**（停止音效 / 打开面板），
 *     但 `start()` 只创建**一个** OS 服务实例——多绑定绝不允许变成多进程。
 *     命中按绑定声明顺序短路，一个事件最多触发一个绑定。
 */

import type {
  GlobalKeyEventLike,
  GlobalKeyboardListenerLike,
  GlobalKeyListenerModule,
  HotkeyCombo,
  HotkeyEventLike,
  ModifierName,
  PluginLogger,
} from './types.js'

const MODIFIER_ORDER: readonly ModifierName[] = ['ctrl', 'alt', 'shift', 'meta']

/** 修饰键别名 → 归一化修饰键名。 */
const MODIFIER_ALIASES: Readonly<Record<string, ModifierName>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
}

/** 主键别名 → 归一化键名（都已小写去非字母数字）。 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  escape: 'escape',
  esc: 'escape',
  return: 'enter',
  enter: 'enter',
  space: 'space',
  spacebar: 'space',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  tab: 'tab',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  pageup: 'pageup',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
  plus: 'plus',
  minus: 'minus',
}

/** 把任意键 token 归一化成可比较的键名。 */
export function normalizeKeyName(token: string): string {
  const lowered = token.trim().toLowerCase()
  if (lowered.length === 0) return ''
  const compact = lowered.replace(/[^a-z0-9]/g, '')
  if (compact.length === 0) {
    // 纯符号键（`/`、`-`、`=`）：保留原字符，但统一到紧凑形式之外的原样比较。
    return lowered
  }
  const alias = KEY_ALIASES[compact]
  return alias ?? compact
}

/**
 * 归一化快捷键字符串。
 * 非法/空输入 → 返回 `ctrl+alt+s`（契约里的默认值），保证调用方拿到可比较结构。
 */
export function normalizeHotkey(input: string): HotkeyCombo {
  const tokens = input
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const modifiers = new Set<ModifierName>()
  const keys: string[] = []
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()]
    if (modifier !== undefined) {
      modifiers.add(modifier)
      continue
    }
    keys.push(normalizeKeyName(token))
  }

  const key = keys.length > 0 ? (keys[keys.length - 1] ?? '') : ''
  if (key.length === 0) {
    if (modifiers.size === 0) return normalizeHotkey('ctrl+alt+s')
    // 只有修饰键：把最后一个修饰键降格成主键（例如 `ctrl+shift` → 键 shift + 修饰 ctrl）。
    const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
    const candidate = ordered[ordered.length - 1]
    if (candidate === undefined) return normalizeHotkey('ctrl+alt+s')
    const rest = new Set(ordered.slice(0, -1))
    return buildCombo(candidate, rest)
  }
  return buildCombo(key, modifiers)
}

function buildCombo(key: string, modifiers: ReadonlySet<ModifierName>): HotkeyCombo {
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
  return { key, modifiers: ordered, text: [...ordered, key].join('+') }
}

/** node-global-key-listener / 浏览器都用得到的修饰键名 → 归一化修饰键。 */
function modifierOfName(rawName: string): ModifierName | null {
  const lowered = rawName.trim().toLowerCase()
  // 'LEFT CTRL' / 'RIGHT SHIFT'：去掉左右前缀后按别名表判定。
  const withoutSide = lowered.replace(/^(left|right)\s+/, '')
  if (withoutSide === 'ctrl' || withoutSide === 'control') return 'ctrl'
  if (withoutSide === 'alt') return 'alt'
  if (withoutSide === 'shift') return 'shift'
  if (withoutSide === 'meta' || withoutSide === 'win' || withoutSide === 'cmd' || withoutSide === 'command') return 'meta'
  return MODIFIER_ALIASES[withoutSide] ?? null
}

/** 事件侧的主键名（浏览器 `key`/`code` 与 OS 事件 `name` 都覆盖）。 */
function eventKeyName(event: HotkeyEventLike): string {
  if (typeof event.name === 'string' && event.name.length > 0) {
    // OS 事件的 name 可能是 'S' / 'LEFT CTRL' / 'RETURN'。
    if (modifierOfName(event.name) !== null) return ''
    return normalizeKeyName(event.name)
  }
  if (typeof event.key === 'string' && event.key.length > 0) {
    // 单字母大写（shift 组合）与符号在这里一并归一。
    const normalized = normalizeKeyName(event.key)
    if (normalized.length > 0) return normalized
  }
  if (typeof event.code === 'string' && event.code.startsWith('Key')) {
    return normalizeKeyName(event.code.slice(3))
  }
  if (typeof event.code === 'string' && event.code.length > 0) {
    return normalizeKeyName(event.code.replace(/^(Digit|Numpad)/, ''))
  }
  return ''
}

/** 事件侧当前按下的修饰键集合。 */
function eventModifiers(event: HotkeyEventLike): Set<ModifierName> {
  const active = new Set<ModifierName>()
  if (event.ctrlKey === true) active.add('ctrl')
  if (event.altKey === true) active.add('alt')
  if (event.shiftKey === true) active.add('shift')
  if (event.metaKey === true) active.add('meta')

  const pressed = event.pressed
  if (pressed !== undefined) {
    const names: readonly string[] = Array.isArray(pressed)
      ? (pressed as readonly string[])
      : pressed instanceof Set
        ? [...(pressed as ReadonlySet<string>)]
        : []
    for (const name of names) {
      const modifier = modifierOfName(name)
      if (modifier !== null) active.add(modifier)
    }
    if (typeof event.name === 'string') {
      const modifier = modifierOfName(event.name)
      if (modifier !== null && event.state !== 'UP') active.add(modifier)
    }
  }
  return active
}

/**
 * 判断一个事件是否匹配某个已归一化的组合。
 *
 * @param combo - `normalizeHotkey` 的产物。
 * @param event - 浏览器 `KeyboardEvent` 或 node-global-key-listener 事件的兼容视图。
 */
export function matchesHotkey(combo: HotkeyCombo, event: HotkeyEventLike | null | undefined): boolean {
  if (!event) return false
  if (typeof event.state === 'string' && event.state.toUpperCase() === 'UP') return false
  const key = eventKeyName(event)
  if (key.length === 0) return false
  if (key !== combo.key) return false

  const active = eventModifiers(event)
  if (active.size !== combo.modifiers.length) return false
  for (const modifier of combo.modifiers) {
    if (!active.has(modifier)) return false
  }
  return true
}

/** 把 OS 事件的 isDown 映射摊平成「当前按下的键名」集合。 */
export function pressedNamesFromMap(isDown: unknown): Set<string> {
  const names = new Set<string>()
  if (!isDown || typeof isDown !== 'object') return names
  for (const [name, down] of Object.entries(isDown as Record<string, unknown>)) {
    if (down === true) names.add(name)
  }
  return names
}

/**
 * 一个绑定：已归一化的组合 + 命中回调。
 *
 * CONTRACT §13.6：同一个 `HotkeyListener` 可以挂**多个**绑定（停止音效 / 打开面板），
 * 但**只启动一个** OS 监听器——`node-global-key-listener` 会派生常驻
 * `WinKeyServer.exe`，多起一个就是多一个常驻进程，因此绑定绝不各自建实例。
 */
export interface HotkeyBinding {
  /** 稳定标识（`stop_hotkey` / `panel_hotkey`），用于日志与断言 */
  id: string
  combo: HotkeyCombo
  onMatch: () => void
}

/**
 * OS 服务工厂（测试注入缝，与 `Opener` 的 `runner`、`audioProbe` 同源）。
 * 默认动态 `import('node-global-key-listener')` 并 new 一个实例；冒烟脚本注入假实现，
 * 于是既能断言「两个绑定只起一个监听器」，又绝不真的派生第二个 `WinKeyServer.exe`。
 * 返回 `null` = 本机不可用（只降级，不抛）。
 */
export type HotkeyServerFactory = () => Promise<GlobalKeyboardListenerLike | null>

export interface HotkeyListenerOptions {
  log: PluginLogger
  /** 至少一个绑定；空数组 = 不启动监听器（只记日志） */
  bindings: readonly HotkeyBinding[]
  /** 缺省走真实 `node-global-key-listener`；注入时用注入的实现 */
  serverFactory?: HotkeyServerFactory
}

/**
 * 进程内活跃监听器登记表。
 * `node-global-key-listener` 会派生常驻子进程，句柄若无人持有会让进程挂住；
 * 这里保留一份引用，`stopAllHotkeys()` 可一次性收尾（供冒烟脚本与诊断使用）。
 */
const activeListeners = new Set<HotkeyListener>()

/** 停止所有活跃的 OS 级监听器；返回停止数量。 */
export function stopAllHotkeys(): number {
  const snapshot = [...activeListeners]
  let stopped = 0
  for (const listener of snapshot) {
    try {
      listener.stop()
      stopped += 1
    } catch {
      /* 单个失败不影响其余 */
    }
  }
  activeListeners.clear()
  return stopped
}

/**
 * OS 级全局快捷键监听（**一个实例 = 一个 OS 监听器 = 多个绑定**）。
 *
 * `pressed` 集合由本类维护（库只给单键事件），与 `isDown` 映射合并后交给
 * `matchesHotkey` 判定——因此不需要在两处重复实现匹配逻辑。
 * 绑定按声明顺序匹配，**第一个命中的绑定触发后即返回**（同一事件不触发两次）。
 */
export class HotkeyListener {
  private readonly bindings: readonly HotkeyBinding[]
  private readonly log: PluginLogger
  private readonly serverFactory: HotkeyServerFactory | null
  private server: GlobalKeyboardListenerLike | null = null
  private listener: ((event: GlobalKeyEventLike, isDown: unknown) => void | Promise<void>) | null = null
  private readonly held = new Set<string>()
  private started = false

  constructor(options: HotkeyListenerOptions) {
    this.bindings = options.bindings
    this.log = options.log
    this.serverFactory = options.serverFactory ?? null
  }

  get isRunning(): boolean {
    return this.started
  }

  /** 绑定数量（断言用：两个快捷键 = 两个绑定，但只有一个监听器）。 */
  get bindingCount(): number {
    return this.bindings.length
  }

  /** 归一化后的组合文本（日志用）。 */
  get comboTexts(): string[] {
    return this.bindings.map((binding) => binding.combo.text)
  }

  /**
   * 注册 OS 级监听。
   * @returns 是否成功启动；库缺失/本机不支持/启动抛错都返回 false（只记日志）。
   */
  async start(): Promise<boolean> {
    if (this.started) return true
    if (this.bindings.length === 0) {
      this.log.warn('没有配置任何全局快捷键绑定，OS 级监听已跳过')
      return false
    }

    const server = await this.createServer()
    if (server === null) return false

    try {
      const listener = (event: GlobalKeyEventLike, isDown: unknown): void => {
        try {
          this.handleEvent(event, isDown)
        } catch (error) {
          this.log.error('全局快捷键处理器异常', error)
        }
      }
      await server.addListener(listener)
      this.server = server
      this.listener = listener
      this.started = true
      activeListeners.add(this)
      this.log.info(`OS 级快捷键已监听（1 个监听器 / ${this.bindings.length} 个绑定）：${this.comboTexts.join(' + ')}`)
      return true
    } catch (error) {
      this.log.warn(`OS 级快捷键启动失败（已降级为仅窗口内快捷键）：${describe(error)}`)
      this.server = null
      this.listener = null
      this.started = false
      return false
    }
  }

  /** 建一个 OS 服务实例；失败只记日志并返回 null。 */
  private async createServer(): Promise<GlobalKeyboardListenerLike | null> {
    if (this.serverFactory !== null) {
      try {
        const injected = await this.serverFactory()
        if (injected === null) {
          this.log.warn('注入的快捷键服务工厂返回空，OS 级快捷键已跳过')
          return null
        }
        return injected
      } catch (error) {
        this.log.warn(`注入的快捷键服务工厂异常（OS 级快捷键已跳过）：${describe(error)}`)
        return null
      }
    }

    let ctor: (new (config?: unknown) => GlobalKeyboardListenerLike) | undefined
    try {
      const mod = (await import('node-global-key-listener')) as unknown as GlobalKeyListenerModule
      ctor = mod?.GlobalKeyboardListener
    } catch (error) {
      this.log.warn(`node-global-key-listener 不可用，OS 级快捷键已跳过（仅保留窗口内快捷键）：${describe(error)}`)
      return null
    }
    if (typeof ctor !== 'function') {
      this.log.warn('node-global-key-listener 导出形状不符，OS 级快捷键已跳过')
      return null
    }
    try {
      return new ctor()
    } catch (error) {
      this.log.warn(`创建全局快捷键服务失败（OS 级快捷键已跳过）：${describe(error)}`)
      return null
    }
  }

  /** 注销监听；重复调用安全。 */
  stop(): void {
    const server = this.server
    const listener = this.listener
    this.server = null
    this.listener = null
    this.started = false
    this.held.clear()
    activeListeners.delete(this)
    if (server === null) return
    try {
      if (listener !== null && typeof server.removeListener === 'function') server.removeListener(listener)
    } catch (error) {
      this.log.debug(`移除全局快捷键监听失败：${describe(error)}`)
    }
    try {
      server.kill()
    } catch (error) {
      this.log.debug(`关闭全局快捷键服务失败：${describe(error)}`)
    }
  }

  private handleEvent(event: GlobalKeyEventLike, isDown: unknown): void {
    const name = typeof event.name === 'string' ? event.name : ''
    if (name.length > 0) {
      if (event.state === 'DOWN') this.held.add(name)
      else if (event.state === 'UP') this.held.delete(name)
    }
    const merged = pressedNamesFromMap(isDown)
    for (const held of this.held) merged.add(held)

    const like: HotkeyEventLike = {
      name: name.length > 0 ? name : event.rawKey?.name,
      state: event.state,
      pressed: merged,
    }
    for (const binding of this.bindings) {
      if (!matchesHotkey(binding.combo, like)) continue
      try {
        binding.onMatch()
      } catch (error) {
        this.log.error(`快捷键回调异常（${binding.id}）`, error)
      }
      // 一个事件只触发第一个命中的绑定：两个组合撞车时不会同时停响 + 开面板。
      return
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
