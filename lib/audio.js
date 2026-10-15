/**
 * dsh-task-alerts —— 提醒音效播放器。
 *
 * 职责：按优先级挑一个可用后端，非阻塞地播放一个音频文件，并能随时中断。
 *
 * 关键决策：
 *  1. 后端优先级：`node-wav-player`（动态 import）→ `play-sound`（动态 import）
 *     → 平台原生进程（win32 `Media.SoundPlayer.PlaySync()` / darwin `afplay` /
 *     linux `paplay` 再 `aplay`）。每个候选都在**首次 play() 时**才加载，避免给
 *     apply() 增加启动延迟，也避免 optionalDependency 缺失时抛错。
 *  2. `play()` 一律非阻塞（返回 boolean，不等待播放结束）；原生后端保留子进程句柄，
 *     `stop()` 先 kill 句柄，Windows 再补一刀 `taskkill /PID <pid> /T /F` 兜底
 *     （`pwsh -Command` 会派生真正出声的孙进程）。
 *  3. 文件不存在 / 后端全不可用 → 记日志并返回 false，**绝不 throw**（CONTRACT §9）。
 *  4. 后端的加载失败会被记住（`failed` 集合），不会每次 play() 都重试同一个坏后端。
 *  5. v1.1 响铃循环（CONTRACT §11.3）：`startRepeat(intervalMs, max)` 立即播 1 次，之后每
 *     `intervalMs` 毫秒再播 1 次，直到 `stopRepeat()` / 达到 `max` / `dispose()`。
 *     定时器用 `unref()`（拿不到 unref 也只是保住事件循环，仍可被 stopRepeat 清掉），
 *     因此**不会把宿主进程挂住**。注意 `play()` 内部会先 `stop()` 当前播放句柄，
 *     所以 `stop()` 绝不能顺带清掉循环定时器，否则循环会在第二次播放前自杀。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
/**
 * 响铃循环轮询「是否还在播」的间隔，以及兜底上限。
 *
 * `isPlaying()` 跟随真实子进程的生命周期，实测可靠（win32 原生后端：从 spawn 到
 * 退出全程为真；7.08s 的文件在 ~8.8s 转 false，差额是 PowerShell 启动开销）。
 * 兜底上限是为了「某后端从不上报在播」时不至于永久等待。
 */
const PLAYBACK_POLL_MS = 200;
const PLAYBACK_POLL_CAP_MS = 10 * 60 * 1000;
/**
 * 排一个「不保住事件循环」的定时器。`unref()` 让响铃循环在进程该退出时
 * 不成为阻碍（CONTRACT §11.3「不得让宿主进程被挂住」）；拿不到 `unref`
 * 也只是退化为普通定时器，`stopRepeat()` 依然能清掉它。
 */
function setUnrefTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    if (handle === null || handle === undefined)
        return null;
    try {
        const candidate = handle;
        if (typeof candidate.unref === 'function')
            candidate.unref.call(handle);
    }
    catch {
        /* unref 不可用：循环仍工作，只是可能短暂保住事件循环 */
    }
    return {
        clear: () => {
            try {
                clearTimeout(handle);
            }
            catch {
                /* 已触发或已清理：忽略 */
            }
        },
    };
}
const POWERSHELL_CANDIDATES = [
    'pwsh',
    'powershell.exe',
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
];
export class AudioPlayer {
    file;
    log;
    prefer;
    /** 已确定的后端；null = 还没探测过。 */
    backend = null;
    handle = null;
    /** 探测失败的候选，避免重复付代价。 */
    failed = new Set();
    wavPlayer = null;
    playSound = null;
    // ---- 响铃循环（CONTRACT §11.3）----
    repeatTimer = null;
    repeatActive = false;
    repeatCount = 0;
    repeatIntervalMs = 0;
    repeatMax = 0;
    constructor(options) {
        this.file = options.file;
        this.log = options.log;
        this.prefer = options.prefer;
    }
    /** 当前后端名（未探测时为 'none'），用于状态展示与日志。 */
    get backendName() {
        return this.backend ?? 'none';
    }
    // ---------- 响铃循环 ----------
    /** 当前是否处于响铃循环中（CONTRACT §11.2 的 `repeatActive`）。 */
    isRepeating() {
        return this.repeatActive;
    }
    /** 本轮已重复次数（首次播放不计入；CONTRACT §11.2 的 `repeatCount`）。 */
    get repeatCountValue() {
        return this.repeatCount;
    }
    /**
     * 立即播 1 次，并在 `intervalMs > 0` 时进入响铃循环（CONTRACT §11.3）。
     *
     * 返回值沿用 `play()` 的语义：是否**已发起**首次播放。即使首次播放失败
     * （音频文件缺失 / 后端全不可用），只要配置了间隔循环就依然进入循环——
     * 循环本身是「提醒待关闭」的状态，UI 与 `/alert-stop` 都要能反映并可终止它。
     *
     * @param max 重复次数上限；<= 0 表示不限（一直响到关闭）
     */
    startRepeat(intervalMs, max) {
        this.stopRepeat();
        this.repeatCount = 0;
        this.repeatMax = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
        this.repeatIntervalMs = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : 0;
        const played = this.play();
        if (this.repeatIntervalMs <= 0)
            return played;
        this.repeatActive = true;
        this.scheduleAfterPlayback();
        this.log.debug(`响铃循环已启动：每次播放结束后等 ${this.repeatIntervalMs}ms 再响，上限 ${this.repeatMax === 0 ? '不限' : String(this.repeatMax)}`);
        return played;
    }
    /** 终止响铃循环；返回之前是否确实在循环中。计数保留，便于状态展示。 */
    stopRepeat() {
        const wasActive = this.repeatActive;
        this.repeatActive = false;
        const timer = this.repeatTimer;
        this.repeatTimer = null;
        if (timer !== null) {
            try {
                timer.clear();
            }
            catch (error) {
                this.log.debug(`清理响铃定时器失败：${String(error)}`);
            }
        }
        return wasActive;
    }
    /**
     * 等**本次播放结束**，再等 `intervalMs`，然后进入下一次重复。
     *
     * 间隔从「播放结束」起算，而不是从「上次开始播放」起算（用户要求）：
     * 后者在音频比间隔长时会把每一次播放都打断，即使不打断，实际停顿也只有
     * `间隔 - 时长`。现在停顿严格等于 `intervalMs`。
     *
     * 「结束」以 `isPlaying()` 判定（跟随子进程生命周期，实测可靠）；轮询用
     * `unref()` 定时器，`stopRepeat()` 随时能清掉，不保住事件循环。
     */
    scheduleAfterPlayback() {
        if (!this.repeatActive)
            return;
        const startedAt = Date.now();
        const poll = () => {
            if (!this.repeatActive)
                return;
            let playing = false;
            try {
                playing = this.isPlaying();
            }
            catch {
                playing = false;
            }
            const stillPlaying = playing && Date.now() - startedAt < PLAYBACK_POLL_CAP_MS;
            let timer = null;
            try {
                timer = setUnrefTimeout(stillPlaying ? poll : () => this.onRepeatTick(), stillPlaying ? PLAYBACK_POLL_MS : this.repeatIntervalMs);
            }
            catch (error) {
                this.repeatActive = false;
                this.log.warn(`响铃循环调度失败：${String(error)}`);
                return;
            }
            if (timer === null) {
                this.repeatActive = false;
                this.log.warn('响铃定时器不可用，响铃循环未启动');
                return;
            }
            this.repeatTimer = timer;
        };
        poll();
    }
    /** 一次重复播放；任何异常都只记日志（CONTRACT §9/§11.3）。 */
    onRepeatTick() {
        this.repeatTimer = null;
        if (!this.repeatActive)
            return;
        try {
            this.play();
            this.repeatCount += 1;
            if (this.repeatMax > 0 && this.repeatCount >= this.repeatMax) {
                this.stopRepeat();
                this.log.debug(`响铃循环达到上限 ${this.repeatMax}，已停止`);
                return;
            }
            this.scheduleAfterPlayback();
        }
        catch (error) {
            // 循环回调绝不冒泡；下一轮仍按计划继续。
            this.log.warn(`响铃循环出现异常：${String(error)}`);
            try {
                this.scheduleAfterPlayback();
            }
            catch {
                this.repeatActive = false;
            }
        }
    }
    /** 播放音频；返回是否**已发起**播放。同步返回，不等待结束。 */
    play() {
        try {
            if (!existsSync(this.file)) {
                this.log.warn(`音频文件不存在，跳过播放：${this.file}`);
                return false;
            }
            this.stop();
            const chain = this.buildChain();
            for (const candidate of chain) {
                if (this.failed.has(candidate))
                    continue;
                const started = this.tryBackend(candidate);
                if (started) {
                    this.backend = candidate;
                    return true;
                }
                this.failed.add(candidate);
            }
            this.log.warn(`没有可用的音频后端（候选：${chain.join(' / ') || '无'}）；仅保留 UI 提醒`);
            this.backend = 'none';
            return false;
        }
        catch (error) {
            this.log.error('播放音频时发生异常', error);
            return false;
        }
    }
    /**
     * 停止**当前这次**播放；返回是否确实中断了某个后端。
     * 刻意不动响铃循环：`play()` 内部就是靠它切掉上一次的播放句柄，
     * 若这里顺手清掉循环，循环会在第二轮播放前把自己杀掉。
     * 终止循环请用 `stopRepeat()`。
     */
    stop() {
        const handle = this.handle;
        if (handle === null)
            return false;
        this.handle = null;
        try {
            handle.stop();
            return true;
        }
        catch (error) {
            this.log.warn(`停止音频失败：${String(error)}`);
            return false;
        }
    }
    /** 是否正在播放（库后端只能近似：有活跃句柄即视为播放中）。 */
    isPlaying() {
        if (this.handle !== null)
            return true;
        const player = this.playSound;
        if (player !== null) {
            try {
                const state = player.playing;
                if (typeof state === 'boolean')
                    return state;
            }
            catch {
                /* 探测失败就当作没在播放 */
            }
        }
        return false;
    }
    /** 释放资源：终止响铃循环、停音效并清掉库句柄。 */
    dispose() {
        try {
            this.stopRepeat();
        }
        catch (error) {
            this.log.debug(`释放响铃循环失败：${String(error)}`);
        }
        this.stop();
        this.playSound = null;
        this.wavPlayer = null;
    }
    // ---------- 后端选择 ----------
    buildChain() {
        if (this.prefer !== undefined && this.prefer !== 'none')
            return [this.prefer];
        const chain = ['node-wav-player', 'play-sound'];
        if (process.platform === 'win32')
            chain.push('win32:SoundPlayer');
        else if (process.platform === 'darwin')
            chain.push('darwin:afplay');
        else
            chain.push('linux:paplay', 'linux:aplay');
        return chain;
    }
    tryBackend(name) {
        switch (name) {
            case 'node-wav-player':
                return this.playWithWavPlayer();
            case 'play-sound':
                return this.playWithPlaySound();
            case 'win32:SoundPlayer':
            case 'darwin:afplay':
            case 'linux:paplay':
            case 'linux:aplay':
                return this.playWithNative(name);
            default:
                return false;
        }
    }
    // ---------- 库后端 ----------
    playWithWavPlayer() {
        if (this.wavPlayer === null) {
            const mod = loadEsmModuleSync('node-wav-player');
            const direct = mod;
            const nested = mod === null ? null : mod.default;
            const resolved = isWavPlayer(direct) ? direct : isWavPlayer(nested) ? nested : null;
            if (resolved === null)
                return false;
            this.wavPlayer = resolved;
        }
        const player = this.wavPlayer;
        const file = this.file;
        const log = this.log;
        let active = true;
        this.handle = {
            backend: 'node-wav-player',
            stop: () => {
                active = false;
                try {
                    player.stop();
                }
                catch (error) {
                    log.debug(`node-wav-player.stop 失败：${String(error)}`);
                }
            },
        };
        try {
            const result = player.play({ path: file });
            if (result !== null && typeof result.then === 'function') {
                void result.catch((error) => {
                    if (active)
                        log.warn(`node-wav-player 播放失败：${String(error)}`);
                });
            }
            return true;
        }
        catch (error) {
            this.handle = null;
            this.log.debug(`node-wav-player 启动失败：${String(error)}`);
            return false;
        }
    }
    playWithPlaySound() {
        if (this.playSound === null) {
            const mod = loadEsmModuleSync('play-sound');
            // play-sound 导出的是一个「工厂函数」；不同打包形态也可能把工厂放在 default 上。
            const factory = typeof mod === 'function' ? mod : mod?.default;
            if (typeof factory !== 'function')
                return false;
            try {
                this.playSound = factory();
            }
            catch (error) {
                this.log.debug(`play-sound 初始化失败：${String(error)}`);
                return false;
            }
        }
        const player = this.playSound;
        if (player === null)
            return false;
        const log = this.log;
        let active = true;
        this.handle = {
            backend: 'play-sound',
            stop: () => {
                active = false;
                try {
                    if (typeof player.kill === 'function')
                        player.kill();
                    else if (typeof player.stop === 'function')
                        player.stop();
                }
                catch (error) {
                    log.debug(`play-sound 停止失败：${String(error)}`);
                }
            },
        };
        try {
            player.play(this.file, (error) => {
                if (error !== null && active)
                    log.warn(`play-sound 播放失败：${error.message}`);
            });
            return true;
        }
        catch (error) {
            this.handle = null;
            this.log.debug(`play-sound 启动失败：${String(error)}`);
            return false;
        }
    }
    // ---------- 原生后端 ----------
    nativeSpec(name) {
        if (name === 'win32:SoundPlayer') {
            for (const shell of POWERSHELL_CANDIDATES) {
                if (shell.includes('\\') ? existsSync(shell) : commandExists(shell)) {
                    const escaped = this.file.replace(/'/g, "''");
                    return {
                        backend: name,
                        command: shell,
                        args: [
                            '-NoProfile',
                            '-NonInteractive',
                            '-Command',
                            `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`,
                        ],
                    };
                }
            }
            this.log.warn('未找到 pwsh / powershell.exe，Windows 原生音频后端不可用');
            return null;
        }
        if (name === 'darwin:afplay') {
            return commandExists('afplay') ? { backend: name, command: 'afplay', args: [this.file] } : null;
        }
        if (name === 'linux:paplay') {
            return commandExists('paplay') ? { backend: name, command: 'paplay', args: [this.file] } : null;
        }
        if (name === 'linux:aplay') {
            return commandExists('aplay') ? { backend: name, command: 'aplay', args: ['-q', this.file] } : null;
        }
        return null;
    }
    playWithNative(name) {
        const spec = this.nativeSpec(name);
        if (spec === null)
            return false;
        try {
            const child = spawn(spec.command, spec.args, {
                stdio: 'ignore',
                windowsHide: true,
                detached: false,
            });
            let alive = true;
            child.on('error', (error) => {
                alive = false;
                this.log.debug(`${spec.backend} 子进程错误：${error.message}`);
            });
            child.on('exit', () => {
                alive = false;
                // 比对**这一个**子进程，而不是后端名（见 ActiveHandle.child 的注释）。
                if (this.handle !== null && this.handle.child === child)
                    this.handle = null;
            });
            this.handle = {
                backend: spec.backend,
                child,
                stop: () => {
                    const pid = child.pid;
                    try {
                        child.kill();
                    }
                    catch (error) {
                        this.log.debug(`${spec.backend} kill 失败：${String(error)}`);
                    }
                    // Windows 上 pwsh 会派生出真正出声的孙进程，kill 父进程不一定终止音频。
                    if (process.platform === 'win32' && typeof pid === 'number' && alive) {
                        try {
                            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                        }
                        catch (error) {
                            this.log.debug(`taskkill 失败：${String(error)}`);
                        }
                    }
                },
            };
            return true;
        }
        catch (error) {
            this.log.debug(`${spec.backend} 启动失败：${String(error)}`);
            return false;
        }
    }
}
/** PATH 上是否存在可执行命令（用 where/which 探测，静默）。 */
function commandExists(command) {
    try {
        const probe = process.platform === 'win32' ? 'where' : 'which';
        const result = spawnSync(probe, [command], { stdio: 'ignore', windowsHide: true });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
/** 形状收窄：只有带 play() 的对象才算 wav 后端。 */
function isWavPlayer(value) {
    if (!value || typeof value !== 'object')
        return false;
    return typeof value.play === 'function';
}
/**
 * 用 `createRequire` 从包根解析可选依赖，再 `require` 之。
 * 这些包都是 CJS；ESM 入口下用 require 能拿到它们，且失败可捕获。
 */
function loadEsmModuleSync(specifier) {
    try {
        const require = createRequire(join(process.cwd(), 'noop.cjs'));
        return require(specifier);
    }
    catch {
        return null;
    }
}
/** 供冒烟脚本确认后端常量可枚举。 */
export const AUDIO_BACKENDS = [
    'node-wav-player',
    'play-sound',
    'win32:SoundPlayer',
    'darwin:afplay',
    'linux:paplay',
    'linux:aplay',
];
