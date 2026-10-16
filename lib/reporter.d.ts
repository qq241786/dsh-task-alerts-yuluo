/**
 * dsh-task-alerts —— 未解决问题报告生成（CONTRACT §9 去重条款）。
 *
 * 职责：把一个 `problemId` 的逐次尝试写成一份固定格式的 TXT，并保证同一 id 只写一次。
 *
 * 关键决策：
 *  1. 去重是**双层**的：内存 `Set`（进程内快路径）+ `<report_dir>/.reported.json`
 *     落盘（重启后仍然去重）。落盘集合懒加载——首次真正要写报告时才读，避免给
 *     apply() 增加 IO；读取失败按「空集合」处理并记日志。
 *  2. 原子写：先写 `<name>.tmp-<pid>`，再 `rename`；`.reported.json` 同理。
 *     崩溃只会留下临时文件，不会留下半截报告。
 *  3. 目录递归创建；任何 IO 失败都返回 null + 日志，**绝不 throw**（CONTRACT §9）。
 *  4. 文件名 `<yyyyMMdd-HHmmss>-<sanitized problemId>.txt`，problemId 清洗为
 *     `[A-Za-z0-9._-]`；重名时追加 `-2`、`-3` 直到不冲突，确保旧报告不被覆盖。
 */
import type { AttemptRecord, PluginLogger, ProblemReport } from './types.js';
export interface ReporterOptions {
    reportDir: string;
    log: PluginLogger;
}
export interface PreparedAttempt {
    problemId: string;
    description: string;
    at: string;
    thought?: string;
    error?: string;
    source?: string;
}
export declare class Reporter {
    private readonly reportDir;
    private readonly log;
    private readonly reported;
    private loaded;
    private loadedFrom;
    constructor(options: ReporterOptions);
    get directory(): string;
    /** 该 problemId 是否已经生成过报告（含落盘历史）。 */
    isReported(problemId: string): boolean;
    /**
     * 校验并规范化一次尝试输入。完全不抛错：非法输入被替换成安全默认值。
     */
    prepareAttempt(input: {
        problemId?: unknown;
        description?: unknown;
        thought?: unknown;
        error?: unknown;
        source?: unknown;
        at?: unknown;
    }): PreparedAttempt;
    /**
     * 写报告。已报告过则返回 `{ path: null, alreadyReported: true }`。
     *
     * @param report - 完整报告载荷。
     * @returns 绝对路径；失败或已存在时为 null。
     */
    writeReport(report: ProblemReport): {
        path: string | null;
        alreadyReported: boolean;
    };
    /** 把 problemId 记入内存 + 落盘去重集合。 */
    markReported(problemId: string): void;
    private get reportedFilePath();
    private ensureLoaded;
    private persistReported;
    /** 索引文件不可写时的兜底：追加一行，至少留下痕迹。 */
    private appendFallback;
    /** 生成不覆盖既有文件的路径。 */
    private uniquePath;
}
/** 固定版式：标题 / 生成时间 / 问题 ID / 问题描述 / 最终状态 / 尝试次数 / 逐次尝试 / 结尾说明。 */
export declare function renderReport(report: ProblemReport): string;
/** problemId 清洗：只保留 `[A-Za-z0-9._-]`，其余替换为 `-`。 */
export declare function sanitizeProblemId(problemId: string): string;
/** `yyyyMMdd-HHmmss`（本地时间，便于人工按时间排序阅读）。 */
export declare function formatStamp(date: Date): string;
/** 供调用方构造 `ProblemReport` 的小工具（避免各处重复拼装）。 */
export declare function buildProblemReport(input: {
    problemId: string;
    description: string;
    finalStatus: string;
    attempts: readonly AttemptRecord[];
    maxAttempts: number;
}): ProblemReport;
