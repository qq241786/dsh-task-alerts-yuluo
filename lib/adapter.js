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
const STATUS_RUNNING = 'running';
const STATUS_IDLE = 'idle';
/** 本适配层监听的事件名（实际 payload 形状见文件头决策 1）。 */
export const adapterEventNames = [
    'agent/status',
    'agent/turn-stopping',
    'agent/error',
    'agent/request-error',
];
export class AlertAdapter {
    host;
    log;
    alertOnUnresolved;
    programFinishAlert;
    attached = false;
    ctx = null;
    /** 已监听的事件名 → 注册返回值（cordis 通常返回 disposer）。 */
    registered = [];
    tracks = new Map();
    constructor(options) {
        this.host = options.host;
        this.log = options.log;
        this.alertOnUnresolved = options.alertOnUnresolved;
        this.programFinishAlert = options.programFinishAlert;
    }
    get isAttached() {
        return this.attached;
    }
    /** 已成功监听到的事件名，供状态与冒烟断言使用。 */
    get listenedEvents() {
        return this.registered.map((entry) => entry.event);
    }
    /**
     * 探测并注册事件监听。
     * @returns 是否挂上了至少一个监听器；`ctx.on` 缺失时返回 false（只记日志）。
     */
    attach(ctx) {
        if (this.attached)
            return true;
        const on = ctx.on;
        if (typeof on !== 'function') {
            this.log.warn('ctx.on 不存在，事件适配层未启用；程序化入口（ctx.taskAlerts.*）仍可用');
            this.ctx = ctx;
            return false;
        }
        this.ctx = ctx;
        // agent/status：唯一能同时观测「回合开始」与「优雅结束」的事件。
        this.listen('agent/status', (payload) => {
            this.onAgentStatus(payload);
        });
        this.listen('agent/turn-stopping', (payload) => {
            this.onTurnStopping(payload);
        });
        // agent/error 是 emit（单向）；agent/request-error 是 waterfall（必须 next()）。
        this.listen('agent/error', (payload) => {
            this.onAgentError(payload);
        });
        this.listen('agent/request-error', (payload, next) => {
            this.onRequestError(payload, next);
        });
        this.attached = this.registered.length > 0;
        return this.attached;
    }
    /** 注销全部监听器；重复调用安全。 */
    detach() {
        for (const entry of this.registered) {
            const dispose = entry.dispose;
            if (typeof dispose !== 'function')
                continue;
            try {
                ;
                dispose();
            }
            catch (error) {
                this.log.debug(`注销 ${entry.event} 监听失败：${describe(error)}`);
            }
        }
        this.registered.length = 0;
        this.attached = false;
        this.tracks.clear();
    }
    // ---------- 注册 ----------
    listen(event, handler) {
        const ctx = this.ctx;
        const on = ctx?.on;
        if (typeof on !== 'function')
            return;
        try {
            const wrapped = (payload, next) => {
                try {
                    handler(payload, next);
                }
                catch (error) {
                    this.log.error(`${event} 处理器异常`, error);
                    // waterfall 事件：异常也必须放行，否则回合会永久挂起。
                    if (typeof next === 'function') {
                        try {
                            ;
                            next();
                        }
                        catch {
                            /* ignore */
                        }
                    }
                }
            };
            const dispose = on.call(ctx, event, wrapped);
            this.registered.push({ event, dispose });
        }
        catch (error) {
            this.log.warn(`注册 ${event} 监听失败：${describe(error)}`);
        }
    }
    // ---------- 事件归一化 ----------
    onAgentStatus(payload) {
        const record = asRecord(payload);
        if (record === null)
            return;
        const agentKey = agentKeyOf(record.agent);
        const status = typeof record.status === 'string' ? record.status : '';
        if (status === STATUS_RUNNING) {
            this.beginTurn(agentKey, '');
            return;
        }
        if (status === STATUS_IDLE) {
            const track = this.tracks.get(agentKey);
            const failed = track?.failed === true;
            this.endTurn(agentKey, failed ? 'failed' : 'ok');
            return;
        }
        this.log.debug(`agent/status 未知 status=${status}，已忽略`);
    }
    onTurnStopping(payload) {
        const record = asRecord(payload);
        if (record === null)
            return;
        const agentKey = agentKeyOf(record.agent);
        const turn = typeof record.turn === 'number' ? record.turn : 0;
        const track = this.tracks.get(agentKey);
        // 若 status 事件没先到，用 turn-stopping 补一个回合起点，保证序号单调。
        if (track === undefined || turn > track.turn) {
            this.beginTurn(agentKey, `回合 ${turn}`);
        }
        const current = this.tracks.get(agentKey);
        this.endTurn(agentKey, current?.failed === true ? 'failed' : 'ok');
    }
    onAgentError(payload) {
        const record = asRecord(payload);
        if (record === null)
            return;
        const agentKey = agentKeyOf(record.agent);
        const turn = typeof record.turn === 'number' && record.turn > 0 ? record.turn : null;
        const step = typeof record.step === 'number' && record.step > 0 ? record.step : null;
        const track = this.beginTurn(agentKey, turn === null ? '' : `回合 ${turn}`);
        track.failed = true;
        const problemId = this.problemIdFor(agentKey, track, turn);
        const message = describe(record.error);
        void this.record({
            problemId,
            description: `回合 ${track.turn}${step === null ? '' : ` / 步骤 ${step}`} 执行失败`,
            error: message,
            solved: false,
            source: 'agent/error',
        });
    }
    onRequestError(payload, next) {
        try {
            const record = asRecord(payload);
            if (record !== null) {
                const agentKey = agentKeyOf(record.agent);
                const turn = typeof record.turn === 'number' && record.turn > 0 ? record.turn : null;
                const step = typeof record.step === 'number' && record.step > 0 ? record.step : null;
                const provider = typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : 'unknown';
                const track = this.beginTurn(agentKey, turn === null ? '' : `回合 ${turn}`);
                track.failed = true;
                const problemId = this.problemIdFor(agentKey, track, turn);
                const message = describe(record.failure);
                void this.record({
                    problemId,
                    description: `模型请求失败（provider=${provider}${step === null ? '' : `，步骤 ${step}`}）`,
                    error: message,
                    solved: false,
                    source: 'agent/request-error',
                });
            }
        }
        finally {
            // waterfall：无论适配层做什么，都必须放行，让 DSH 的默认重试策略继续生效。
            if (typeof next === 'function') {
                try {
                    ;
                    next();
                }
                catch (error) {
                    this.log.debug(`request-error next() 抛错：${describe(error)}`);
                }
            }
        }
    }
    // ---------- 内部 ----------
    beginTurn(agentKey, label) {
        const existing = this.tracks.get(agentKey);
        if (existing !== undefined) {
            // 已在 running：重复的 running 事件不应重置回合号。
            return existing;
        }
        const track = { turn: this.nextTurn(agentKey), failed: false, startedAt: Date.now() };
        this.tracks.set(agentKey, track);
        if (label.length > 0)
            this.log.debug(`${agentKey} 回合开始（${label}）`);
        return track;
    }
    /** 已结束回合的计数（`tracks` 里被删掉后仍要单调递增）。 */
    turnCounters = new Map();
    nextTurn(agentKey) {
        const current = this.turnCounters.get(agentKey) ?? 0;
        const next = current + 1;
        this.turnCounters.set(agentKey, next);
        return next;
    }
    endTurn(agentKey, outcome) {
        const track = this.tracks.get(agentKey);
        this.tracks.delete(agentKey);
        if (this.programFinishAlert) {
            void this.finish({
                label: track === undefined ? agentKey : `${agentKey} 回合 ${track.turn}`,
                ok: outcome === 'ok',
                detail: outcome === 'ok' ? '回合正常结束' : '回合以失败结束',
            });
            return;
        }
        this.log.debug(`program_finish_alert=false，跳过第 ${track?.turn ?? 0} 回合的结束提醒`);
    }
    problemIdFor(agentKey, track, explicitTurn) {
        const turn = explicitTurn ?? track.turn;
        return `${agentKey}-turn-${turn}`;
    }
    async record(input) {
        try {
            const result = await this.host.recordAttempt(input);
            if (result.reportPath !== undefined)
                this.log.info(`问题 ${input.problemId} 报告已生成：${result.reportPath}`);
        }
        catch (error) {
            this.log.error('记录失败尝试时发生异常', error);
        }
    }
    async finish(input) {
        try {
            await this.host.recordProgramFinish(input);
        }
        catch (error) {
            this.log.error('记录回合结束时发生异常', error);
        }
    }
}
// ---------- 结构收窄工具（无 any） ----------
function asRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    return value;
}
/** agent 形状未冻结 → 只读一个字符串标识；读不到就用 'agent'。 */
function agentKeyOf(agent) {
    const record = asRecord(agent);
    if (record !== null) {
        for (const field of ['id', 'name', 'agentId']) {
            const value = record[field];
            if (typeof value === 'string' && value.trim().length > 0)
                return sanitizeKey(value);
        }
        const meta = asRecord(record.meta);
        if (meta !== null) {
            const id = meta.sessionId ?? meta.id;
            if (typeof id === 'string' && id.trim().length > 0)
                return sanitizeKey(id);
        }
    }
    if (typeof agent === 'string' && agent.trim().length > 0)
        return sanitizeKey(agent);
    return 'agent';
}
function sanitizeKey(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-');
    return cleaned.slice(0, 60);
}
function describe(value) {
    if (value === undefined || value === null)
        return '(无错误详情)';
    if (value instanceof Error)
        return `${value.name}: ${value.message}`;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    const record = asRecord(value);
    if (record !== null) {
        for (const field of ['message', 'reason', 'detail', 'description', 'code', 'kind']) {
            const entry = record[field];
            if (typeof entry === 'string' && entry.length > 0)
                return entry;
        }
        const nested = record.error;
        if (nested !== undefined && nested !== value)
            return describe(nested);
    }
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
