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
import { stopAllHotkeys } from './hotkey.js';
import type { CordisContext } from './types.js';
export type { AlertKind, AlertLevel, AlertRecord, AlertState, AlertStateConfig, AttemptRecord, HostConfig, OpenMode, OpenPlan, OpenRunner, ProblemReport, RecordAttemptInput, RecordAttemptResult, RecordProgramFinishInput, ReportAutoOpen, TaskAlertsService, UiConfig, } from './types.js';
export declare const name = "task-alerts";
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
export declare const inject: string[];
/** 供冒烟脚本 / 诊断使用：一次性停掉本进程所有 OS 级快捷键监听。 */
export { stopAllHotkeys };
export declare const PLUGIN_NAME = "task-alerts";
/**
 * Cordis 插件入口。任何内部失败都只记日志——`apply` 本身不 throw。
 */
export declare function apply(ctx: CordisContext, rawConfig?: unknown): Promise<void>;
/** 统一默认导出：`import pkg from 'dsh-task-alerts'` 与命名导出两种形态都可用。 */
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
