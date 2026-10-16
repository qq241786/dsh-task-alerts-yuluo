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
import type { ConfigValidation, EditableConfig, EditablePatch, HostConfig } from './types.js';
/** §12.5 的 10 个可写键 + §13.2 的 2 个新键 + §14 的 `maxAttempts`（也是写入顺序）。 */
export declare const EDITABLE_KEYS: readonly ["audioPath", "enabled", "hotkey", "maxAttempts", "panelHotkey", "programFinishAlert", "alertOnUnresolved", "reportDir", "reportAutoOpen", "repeatInterval", "repeatMax", "showPill", "ui"];
/** 当前生效配置 → 可写视图（`ui` 复制一份，避免调用方改到活对象）。 */
export declare function editableFromHost(config: HostConfig): EditableConfig;
/**
 * 只做**类型与字面量**校验（不 clamp、不看旧值），因此是纯函数，便于单独测试。
 * 未知键被忽略；提供了但非法的键进 `errors`。
 */
export declare function validateConfigPatch(raw: unknown): ConfigValidation;
/** 把校验过的补丁落到当前值上；数值按 §6 的 clamp 规则收敛（相对路径的解析由调用方做）。 */
export declare function mergeEditable(current: EditableConfig, patch: EditablePatch): EditableConfig;
/** 可写配置 → 用户配置文件全文（snake_case + `ui` 子映射）。 */
export declare function serializeUserConfig(config: EditableConfig): string;
export interface WriteResult {
    ok: boolean;
    error?: string;
}
/** 原子写用户配置文件。任何失败（含父目录不可建）只返回 `{ok:false}`，绝不 throw。 */
export declare function writeUserConfig(path: string, text: string): WriteResult;
/** 归一化用户输入的快捷键（写盘与运行时都用同一结果）。 */
export declare function normalizeEditableHotkey(value: string): string;
