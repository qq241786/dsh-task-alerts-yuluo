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
import type { AudioBackendName, AudioPlayerOptions } from './types.js';
export declare class AudioPlayer {
    private readonly file;
    private readonly log;
    private readonly prefer;
    /** 已确定的后端；null = 还没探测过。 */
    private backend;
    private handle;
    /** 探测失败的候选，避免重复付代价。 */
    private readonly failed;
    private wavPlayer;
    private playSound;
    private repeatTimer;
    private repeatActive;
    private repeatCount;
    private repeatIntervalMs;
    private repeatMax;
    constructor(options: AudioPlayerOptions);
    /** 当前后端名（未探测时为 'none'），用于状态展示与日志。 */
    get backendName(): AudioBackendName;
    /** 当前是否处于响铃循环中（CONTRACT §11.2 的 `repeatActive`）。 */
    isRepeating(): boolean;
    /** 本轮已重复次数（首次播放不计入；CONTRACT §11.2 的 `repeatCount`）。 */
    get repeatCountValue(): number;
    /**
     * 立即播 1 次，并在 `intervalMs > 0` 时进入响铃循环（CONTRACT §11.3）。
     *
     * 返回值沿用 `play()` 的语义：是否**已发起**首次播放。即使首次播放失败
     * （音频文件缺失 / 后端全不可用），只要配置了间隔循环就依然进入循环——
     * 循环本身是「提醒待关闭」的状态，UI 与 `/alert-stop` 都要能反映并可终止它。
     *
     * @param max 重复次数上限；<= 0 表示不限（一直响到关闭）
     */
    startRepeat(intervalMs: number, max: number): boolean;
    /** 终止响铃循环；返回之前是否确实在循环中。计数保留，便于状态展示。 */
    stopRepeat(): boolean;
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
    private scheduleAfterPlayback;
    /** 一次重复播放；任何异常都只记日志（CONTRACT §9/§11.3）。 */
    private onRepeatTick;
    /** 播放音频；返回是否**已发起**播放。同步返回，不等待结束。 */
    play(): boolean;
    /**
     * 停止**当前这次**播放；返回是否确实中断了某个后端。
     * 刻意不动响铃循环：`play()` 内部就是靠它切掉上一次的播放句柄，
     * 若这里顺手清掉循环，循环会在第二轮播放前把自己杀掉。
     * 终止循环请用 `stopRepeat()`。
     */
    stop(): boolean;
    /** 是否正在播放（库后端只能近似：有活跃句柄即视为播放中）。 */
    isPlaying(): boolean;
    /** 释放资源：终止响铃循环、停音效并清掉库句柄。 */
    dispose(): void;
    private buildChain;
    private tryBackend;
    private playWithWavPlayer;
    private playWithPlaySound;
    private nativeSpec;
    private playWithNative;
}
/** 供冒烟脚本确认后端常量可枚举。 */
export declare const AUDIO_BACKENDS: readonly AudioBackendName[];
