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
import type { HostConfig, PluginLogger, RawConfig, ReportAutoOpen, UiConfig } from './types.js';
/** 内置默认值（CONTRACT §6 的表格 + §11.1 的三个新键）。 */
export declare const DEFAULTS: Required<Omit<RawConfig, 'ui'>> & {
    ui: UiConfig;
};
export declare const CLAMP: {
    maxAttemptsMin: number;
    /** CONTRACT §11.1：`repeat_interval >= 0`（秒），允许小数以便冒烟用 0.05s */
    repeatIntervalMin: number;
    /** CONTRACT §11.1：`repeat_max >= 0` 的整数 */
    repeatMaxMin: number;
    blurStrength: readonly [0, 40];
    borderRadius: readonly [0, 48];
    opacity: readonly [0.05, 1];
};
/** CONTRACT §11.5 的四个合法值；其余（含空串）一律归 'none'。 */
export declare const REPORT_AUTO_OPEN_VALUES: readonly ReportAutoOpen[];
/** 递归 map 形状（不必与 RawConfig 完全一致，转成 RawConfig 前会逐键取值）。 */
type YamlValue = string | number | boolean | YamlMap;
interface YamlMap {
    [key: string]: YamlValue;
}
/**
 * 解析 config.yaml 所需的子集：缩进 map、`key: value` 标量、`#` 注释、单/双引号、
 * true/false、整数与小数。不支持序列（`- item`），遇到时该行被忽略而不是报错。
 */
export declare function parseSimpleYaml(text: string): YamlMap;
export declare function dshHome(): string;
/** 覆盖用户配置文件路径的环境变量（冒烟/多 profile 隔离用；设了它就**只认这个文件**）。 */
export declare const USER_CONFIG_ENV = "DSH_TASK_ALERTS_USER_CONFIG";
/**
 * §6 第 2 档来源的路径：`<DSH_HOME>/dsh-task-alerts.config.yaml`。
 * 设了 `DSH_TASK_ALERTS_USER_CONFIG` 就只用那一个文件——便于测试注入，避免碰真实用户配置。
 */
export declare function userConfigPath(home?: string): string;
/**
 * 包根：优先 `DSH_TASK_ALERTS_PACKAGE_ROOT`（冒烟脚本用），否则从 `lib/config.js`
 * 开始上溯寻找含 `package.json` 的目录；都失败则退回 `process.cwd()`。
 */
export declare function packageRoot(): string;
/** 目录可写判定：先 `access(W_OK)`，再做一次真实探测写以排除只读挂载的假阳性。 */
export declare function isDirWritable(dir: string): boolean;
/** 相对路径以 base 为基准；绝对路径原样保留。 */
export declare function resolveAgainst(base: string, value: string): string;
/** 单个**非修饰键**是否在白名单内：`a-z` / `0-9` / `F1-F24` / 具名键。 */
export declare function isAllowedHotkeyKey(key: string): boolean;
/** 组合键文案是否合法：**至少一个修饰键 + 一个白名单内的非修饰键**。 */
export declare function isValidHotkeyText(value: string): boolean;
/**
 * 归一化为 `ctrl+alt+s` 形态（修饰键顺序固定为 ctrl/alt/shift/meta）。
 *
 * **非法输入一律返回 `fallback`** —— 绝不把垃圾写进活配置（`"clear"` 那个 bug 的教训）。
 */
export declare function normalizeHotkeyText(value: string, fallback?: string): string;
/**
 * 按 CONTRACT §6 合成 `HostConfig`。任何读盘/解析失败都只降级：本函数不 throw。
 *
 * @param ctxConfig - cordis 行 `config`，或同形状的 YAML/JSON 文本。
 * @param log - 可选日志出口；缺省时静默。
 */
export declare function loadConfig(ctxConfig?: unknown, log?: PluginLogger): Promise<HostConfig>;
export {};
