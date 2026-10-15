/**
 * dsh-task-alerts —— 「交给系统默认处理器打开」的打开器（CONTRACT §11.4 / §11.5）。
 *
 * 关键决策：
 *  1. **可注入**：真正的进程启动只发生在 `OpenRunner` 里，缺省 runner 是 detached
 *     spawn。冒烟测试注入一个只记录调用的 runner，因此**不会真的弹出窗口/浏览器**。
 *     注入点签名是 `(path, mode, command, args) => 是否成功发起`。
 *  2. `plan()` 是纯函数：平台 → (命令, 参数, 目标) 的映射集中在一处，测试可以只断言
 *     计划而不启动任何进程。
 *  3. 平台分支严格照契约：win32 `cmd /c start "" "<path>"`（folder 用
 *     `explorer /select,"<path>"`）、darwin `open`（folder 用 `open -R`）、
 *     其余按 linux 走 `xdg-open`。
 *  4. 任何失败（未知/不支持的平台、spawn 抛错、runner 抛错、返回非 true）都只记日志
 *     并返回 false，绝不 throw（CONTRACT §9）。
 */
import type { OpenPlan, OpenerOptions, PluginLogger, ReportAutoOpen } from './types.js';
/** 缺省 runner：detached / stdio ignore / 不等待 / 不抛；失败只记日志。 */
export declare function spawnDetached(command: string, args: string[], log: PluginLogger): boolean;
export declare class Opener {
    private readonly log;
    private readonly runner;
    private readonly platform;
    constructor(options: OpenerOptions);
    /**
     * 纯函数：把「模式 + 报告路径」翻译成一次打开计划。
     * `mode === 'none'` 或路径为空 → null（调用方据此什么都不做）。
     */
    plan(mode: ReportAutoOpen, filePath: string): OpenPlan | null;
    /** 执行一个计划；runner 抛错或返回非 `true` 都算失败。 */
    run(plan: OpenPlan): boolean;
    /** CONTRACT §11.5 入口：按配置的 `report_auto_open` 打开报告。 */
    openAuto(mode: ReportAutoOpen, filePath: string): boolean;
    /** CONTRACT §11.4：用系统默认程序打开报告文件。 */
    openReportFile(filePath: string): boolean;
}
