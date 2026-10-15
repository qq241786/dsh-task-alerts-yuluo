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
import type { GlobalKeyboardListenerLike, HotkeyCombo, HotkeyEventLike, PluginLogger } from './types.js';
/** 把任意键 token 归一化成可比较的键名。 */
export declare function normalizeKeyName(token: string): string;
/**
 * 归一化快捷键字符串。
 * 非法/空输入 → 返回 `ctrl+alt+s`（契约里的默认值），保证调用方拿到可比较结构。
 */
export declare function normalizeHotkey(input: string): HotkeyCombo;
/**
 * 判断一个事件是否匹配某个已归一化的组合。
 *
 * @param combo - `normalizeHotkey` 的产物。
 * @param event - 浏览器 `KeyboardEvent` 或 node-global-key-listener 事件的兼容视图。
 */
export declare function matchesHotkey(combo: HotkeyCombo, event: HotkeyEventLike | null | undefined): boolean;
/** 把 OS 事件的 isDown 映射摊平成「当前按下的键名」集合。 */
export declare function pressedNamesFromMap(isDown: unknown): Set<string>;
/**
 * 一个绑定：已归一化的组合 + 命中回调。
 *
 * CONTRACT §13.6：同一个 `HotkeyListener` 可以挂**多个**绑定（停止音效 / 打开面板），
 * 但**只启动一个** OS 监听器——`node-global-key-listener` 会派生常驻
 * `WinKeyServer.exe`，多起一个就是多一个常驻进程，因此绑定绝不各自建实例。
 */
export interface HotkeyBinding {
    /** 稳定标识（`stop_hotkey` / `panel_hotkey`），用于日志与断言 */
    id: string;
    combo: HotkeyCombo;
    onMatch: () => void;
}
/**
 * OS 服务工厂（测试注入缝，与 `Opener` 的 `runner`、`audioProbe` 同源）。
 * 默认动态 `import('node-global-key-listener')` 并 new 一个实例；冒烟脚本注入假实现，
 * 于是既能断言「两个绑定只起一个监听器」，又绝不真的派生第二个 `WinKeyServer.exe`。
 * 返回 `null` = 本机不可用（只降级，不抛）。
 */
export type HotkeyServerFactory = () => Promise<GlobalKeyboardListenerLike | null>;
export interface HotkeyListenerOptions {
    log: PluginLogger;
    /** 至少一个绑定；空数组 = 不启动监听器（只记日志） */
    bindings: readonly HotkeyBinding[];
    /** 缺省走真实 `node-global-key-listener`；注入时用注入的实现 */
    serverFactory?: HotkeyServerFactory;
}
/** 停止所有活跃的 OS 级监听器；返回停止数量。 */
export declare function stopAllHotkeys(): number;
/**
 * OS 级全局快捷键监听（**一个实例 = 一个 OS 监听器 = 多个绑定**）。
 *
 * `pressed` 集合由本类维护（库只给单键事件），与 `isDown` 映射合并后交给
 * `matchesHotkey` 判定——因此不需要在两处重复实现匹配逻辑。
 * 绑定按声明顺序匹配，**第一个命中的绑定触发后即返回**（同一事件不触发两次）。
 */
export declare class HotkeyListener {
    private readonly bindings;
    private readonly log;
    private readonly serverFactory;
    private server;
    private listener;
    private readonly held;
    private started;
    constructor(options: HotkeyListenerOptions);
    get isRunning(): boolean;
    /** 绑定数量（断言用：两个快捷键 = 两个绑定，但只有一个监听器）。 */
    get bindingCount(): number;
    /** 归一化后的组合文本（日志用）。 */
    get comboTexts(): string[];
    /**
     * 注册 OS 级监听。
     * @returns 是否成功启动；库缺失/本机不支持/启动抛错都返回 false（只记日志）。
     */
    start(): Promise<boolean>;
    /** 建一个 OS 服务实例；失败只记日志并返回 null。 */
    private createServer;
    /** 注销监听；重复调用安全。 */
    stop(): void;
    private handleEvent;
}
