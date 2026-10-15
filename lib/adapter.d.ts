/**
 * dsh-task-alerts —— DSH 事件 → 提醒语义的适配层。
 *
 * 职责：听 `agent/status`（回合开始/结束）、`agent/turn-stopping`（回合结束）、
 * `agent/error`、`agent/request-error`（失败），把它们归一化成对
 * `recordAttempt` / `recordProgramFinish` 的调用。
 *
 * 关键决策：
 *  1. payload 字段名**以 `dsh-agent/lib/types/runtime-types.d.ts` 的实际声明为准**：
 *     `agent/status` → `{ agent, status }`；`agent/turn-stopping` → `{ agent, turn, signal }`；
 *     `agent/error` → `{ agent, turn, step, error }`；
 *     `agent/request-error` → `{ agent, turn, step, provider, failure, retryPolicy, signal }`
 *     （且是 **waterfall**，必须调用 `next()` 才能放行——这点与其余三个事件不同）。
 *     类型里不存在的字段一律走可选链 + 默认值，绝不臆造。
 *  2. `status` 的真实取值来自 `AgentStatus`（`'idle' | 'running'`）：`running` 视作回合开始，
 *     `idle` 视作回合结束。用**按 agent 维护的 turn 序号**合成 problemId，使同一回合的
 *     多次失败聚成一个问题。
 *  3. `Agent` 的形状没有随 runtime-types 一起冻结，因此 `agent` 只按 `unknown` 处理，
 *     仅尝试读取 `id`/`name` 之类的字符串字段；读不到就用 `'agent'` 占位。
 *  4. 事件系统缺失（`ctx.on` 不存在）时适配层照样可用：程序化入口
 *     （`ctx.taskAlerts.recordAttempt` 等）与事件监听完全解耦。
 *  5. 监听器一律 try/catch；waterfall 事件在异常时也必须调用 `next()`，否则会卡住回合。
 */
import type { CordisContext, PluginLogger, RecordAttemptInput } from './types.js';
/** 适配层需要的宿主服务（由 index.ts 注入，避免循环依赖）。 */
export interface AdapterHost {
    recordAttempt(input: RecordAttemptInput): Promise<{
        attempts: number;
        unresolved: boolean;
        reportPath?: string;
    }>;
    recordProgramFinish(input?: {
        label?: string;
        ok?: boolean;
        detail?: string;
    }): Promise<{
        alerted: boolean;
    }>;
}
export interface AlertAdapterOptions {
    host: AdapterHost;
    log: PluginLogger;
    alertOnUnresolved: boolean;
    programFinishAlert: boolean;
}
/** 本适配层监听的事件名（实际 payload 形状见文件头决策 1）。 */
export declare const adapterEventNames: readonly string[];
export declare class AlertAdapter {
    private readonly host;
    private readonly log;
    private readonly alertOnUnresolved;
    private readonly programFinishAlert;
    private attached;
    private ctx;
    /** 已监听的事件名 → 注册返回值（cordis 通常返回 disposer）。 */
    private readonly registered;
    private readonly tracks;
    constructor(options: AlertAdapterOptions);
    get isAttached(): boolean;
    /** 已成功监听到的事件名，供状态与冒烟断言使用。 */
    get listenedEvents(): string[];
    /**
     * 探测并注册事件监听。
     * @returns 是否挂上了至少一个监听器；`ctx.on` 缺失时返回 false（只记日志）。
     */
    attach(ctx: CordisContext): boolean;
    /** 注销全部监听器；重复调用安全。 */
    detach(): void;
    private listen;
    private onAgentStatus;
    private onTurnStopping;
    private onAgentError;
    private onRequestError;
    private beginTurn;
    /** 已结束回合的计数（`tracks` 里被删掉后仍要单调递增）。 */
    private readonly turnCounters;
    private nextTurn;
    private endTurn;
    private problemIdFor;
    private record;
    private finish;
}
